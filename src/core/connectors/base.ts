/**
 * base.ts — the SaaSConnector contract + the redaction-choke-point landing path
 * shared by the /webhooks/:provider receiver and (later) outbound backfill (TECH-2034).
 *
 * A connector turns provider data (an inbound webhook now, an outbound backfill once
 * TECH-2033 credentials land) into `connector_candidates` rows — NEVER pages. Every
 * record flows through `landRecords`, which is the single place redaction happens:
 * it minimizes the item (drops bodies, per-source-class allowlist) and strips the
 * proposed markdown BEFORE `toRow`. This satisfies redact.ts's WIRING CONTRACT — a
 * connector cannot accidentally bypass redaction, because it never calls toRow itself.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';

import type { BrainEngine } from '../engine.ts';
import { isAvailable } from '../ai/gateway.ts';
import { toRow, captureConsolidated, type ConnectorCandidateItem } from './candidate.ts';
import { minimize, strip, type RawConnectorItem } from './redact.ts';
import { recordConsolidationDecision } from './consolidation-decisions.ts';
import type { ConsolidationClassifyResult } from './consolidate.ts';

// ── Types ───────────────────────────────────────────────────────────────────────

/** A source row carrying this connector's per-source config under config.connectors[provider].
 *  `config` may arrive as a parsed object or a JSON string (the DB column is jsonb but
 *  some engine paths hand it back stringified — readConnectorConfig tolerates both). */
export interface ConnectorSource {
  id: string;
  config: Record<string, unknown> | string;
}

/** Per-source connector configuration (sources.config.connectors[provider]). */
export interface ConnectorConfig {
  /** Off by default — a configured-but-not-enabled connector is inert. */
  enabled: boolean;
  /** Webhook signing secret (HMAC). */
  secret?: string;
  /** The provider account/workspace/team id this source maps to. */
  account?: string;
}

/**
 * A normalized provider record, pre-redaction. `item` carries the raw
 * metadata/summary/body; the framework redacts it before it becomes a candidate.
 */
export interface NormalizedRecord {
  /** Stable upstream id — the idempotency anchor (source_record_id). */
  sourceRecordId: string;
  /** Redaction source-class profile (comms/crm/docs/calendar/code/generic). */
  profile: string;
  /** Raw fields; bodies are dropped + everything stripped by the framework. */
  item: RawConnectorItem;
  /** Proposed brain slug (stripped by the framework). */
  proposedSlug?: string;
}

/** The contract every SaaS connector implements. */
export interface SaaSConnector {
  /** Provider key — matches the :provider route param and config.connectors[provider]. */
  readonly provider: string;
  /** Primary signature header name, for the receiver's pre-DB presence short-circuit
   *  (mirrors github's `X-Hub-Signature-256` D3 gate). A request without it is rejected
   *  401 before any source lookup, so probe traffic never touches the DB. */
  readonly signatureHeader: string;
  /** Constant-time webhook signature verification against the per-source secret.
   *  `headers` keys are LOWERCASE — Node lowercases all incoming header names, and the
   *  receiver flattens them as-is. Read the signature header by its lowercase name
   *  (e.g. `headers['x-slack-signature']`); a capitalized lookup returns undefined and
   *  fails closed. Use `hmacSha256Verify` for the constant-time compare. */
  verifyWebhook(rawBody: Buffer, headers: Record<string, string | undefined>, secret: string): boolean;
  /** Extract the account/workspace id from a parsed payload, used to resolve the source. */
  accountFromPayload(payload: unknown): string | null;
  /**
   * Optional UNSIGNED handshake hook, consulted by the receiver BEFORE the signature
   * gate. Some providers (Slack's Events API `url_verification`) post an unsigned
   * one-time challenge to prove endpoint ownership; that request carries no usable
   * signature, so it must be answered before HMAC verification or the provider can
   * never finish wiring the webhook. A connector returns `{ challenge }` to echo, or
   * null/undefined when the payload is not a handshake (the normal signed path then
   * proceeds). The receiver only ever echoes the challenge string — no DB touched, no
   * record landed. Connectors WITHOUT a handshake omit this; the receiver skips it.
   */
  handshake?(payload: unknown): { challenge: string } | null;
  /**
   * Normalize a verified payload into 0+ records (pre-redaction). Receives the resolved
   * `source` so a connector can apply per-source config (e.g. Slack's opt-in channel
   * allowlist at config.connectors[provider].channels[]). The receiver passes the
   * already-resolved source; connectors that ingest everything (e.g. Linear) simply
   * ignore it.
   */
  normalize(payload: unknown, source: ConnectorSource): NormalizedRecord[];
  /** Map a (minimized) record to a candidate item. The framework forwards this to
   *  toRow, which re-redacts the page-body-bound output fields (proposed_markdown,
   *  proposed_slug, rationale_ref) at the write boundary. NOTE: if the returned item
   *  sets `version`, it MUST be deterministic per upstream record — the idempotency
   *  key is (source_id, source_record_id, version), so a non-deterministic version
   *  (timestamp, delivery id) defeats duplicate-delivery dedupe. Omit it to default to '1'. */
  toCandidate(record: NormalizedRecord, sourceId: string): ConnectorCandidateItem;
  /** Outbound backfill (initial/periodic sync). Declared here; implemented per-connector
   *  once connector_tokens / OAuth (TECH-2033) lands. Uses the same landRecords path. */
  backfill?(engine: BrainEngine, source: ConnectorSource): Promise<number>;
  /** Optional post-connect hook, invoked by the OAuth /callback AFTER storeToken
   *  persists the grant (TECH-2040). A connector whose inbound trigger requires
   *  provider-side setup beyond the token grant (e.g. Google Calendar's
   *  events.watch push channel — which must be created with the fresh token and
   *  whose channel-id + channel-token must be persisted into the source config so
   *  the dedicated /webhooks/calendar route can resolve + authenticate later
   *  deliveries) implements this. Connectors with a self-contained webhook (linear,
   *  slack — the provider already knows the endpoint + secret) omit it. Optional, so
   *  adding it is non-breaking. The callback awaits it and surfaces a failure as a
   *  502, so a watch-creation error does not silently leave the push path dead. */
  onConnect?(engine: BrainEngine, sourceId: string, account: string): Promise<void>;
}

// ── Registry ────────────────────────────────────────────────────────────────────

const REGISTRY = new Map<string, SaaSConnector>();

/** Register a connector implementation (called at module load by each connector). */
export function registerConnector(connector: SaaSConnector): void {
  REGISTRY.set(connector.provider, connector);
}

/** Resolve a connector by provider key, or undefined if none is registered. */
export function getConnector(provider: string): SaaSConnector | undefined {
  return REGISTRY.get(provider);
}

/** Read this provider's per-source connector config, tolerating string-encoded JSON. */
export function readConnectorConfig(source: ConnectorSource, provider: string): ConnectorConfig | null {
  const raw = typeof source.config === 'string' ? safeParse(source.config) : source.config;
  const connectors = (raw?.connectors ?? null) as Record<string, ConnectorConfig> | null;
  return connectors?.[provider] ?? null;
}

// ── HMAC helper (constant-time) ─────────────────────────────────────────────────

/**
 * Constant-time HMAC-SHA256 verification. `signatureHex` is the provider-sent hex
 * digest (prefix already stripped by the caller). Length-mismatch is rejected without
 * a comparison (timingSafeEqual throws on unequal lengths). Connectors reuse this in
 * verifyWebhook so the compare is uniform and tamper-safe.
 */
export function hmacSha256Verify(rawBody: Buffer, secret: string, signatureHex: string): boolean {
  if (!secret || !signatureHex) return false;
  const expected = createHmac('sha256', secret).update(rawBody).digest();
  let provided: Buffer;
  try {
    provided = Buffer.from(signatureHex, 'hex');
  } catch {
    return false;
  }
  if (provided.length !== expected.length || provided.length === 0) return false;
  return timingSafeEqual(provided, expected);
}

// ── Landing path — the redaction choke point ────────────────────────────────────

export interface LandResult {
  written: number;
  total: number;
}

/** Options for {@link landRecords}. */
export interface LandRecordsOptions {
  /**
   * POLL-ONLY consolidation gate (KTD4). The Memory Consolidation Engine runs an
   * LLM (extract → classify) per record, so it is permitted ONLY when the caller
   * is on the latency-tolerant POLL/backfill path and passes `consolidate: true`.
   * The synchronous webhook receiver (serve-http `/webhooks/:provider`, the
   * calendar push handler) NEVER passes it, so the webhook path is structurally
   * exempt — LLM latency can never blow a webhook timeout — regardless of the
   * per-connector config flag. Absent/false → today's byte-identical raw
   * passthrough, and the consolidation machinery is not even loaded.
   */
  consolidate?: boolean;
}

/**
 * Redact each record and write it as a table-only candidate. THE single redaction
 * point: minimize the item (drops bodies + non-allowlisted metadata) and strip the
 * proposed markdown before `toRow`. Never writes a page. Idempotent via toRow's
 * ON CONFLICT DO NOTHING, so duplicate webhook deliveries are safe no-ops.
 *
 * When `opts.consolidate` is set (the POLL/backfill path only), each record is
 * additionally routed through the consolidation pipeline (extract → classify →
 * pre-compute the promotion target on the row), per-connector-flag-gated and
 * per-record-isolated (any throw degrades THAT record to raw passthrough — one
 * poison capture can't abort the batch). See {@link LandRecordsOptions.consolidate}.
 */
export async function landRecords(
  engine: BrainEngine,
  sourceId: string,
  connector: SaaSConnector,
  records: NormalizedRecord[],
  opts: LandRecordsOptions = {},
): Promise<LandResult> {
  // POLL-ONLY structural gate: load the consolidation deps + this source's config
  // ONCE, lazily, and ONLY when the caller opted in. The webhook path (no opts)
  // never loads the LLM machinery and is byte-identical to before U3. Loading is
  // dynamic to keep the static import graph acyclic (consolidate.ts →
  // consolidation-config.ts → poll.ts → base.ts). A LOAD failure (the
  // `SELECT config` read or a dynamic import) degrades the WHOLE batch to today's
  // raw passthrough — KTD4 promises that ANY runtime throw falls back to
  // passthrough, and this read runs OUTSIDE the per-record try/catch, so an
  // unguarded throw here would otherwise abort the entire poll.
  let consolidation: ConsolidationDeps | null = null;
  if (opts.consolidate) {
    try {
      consolidation = await loadConsolidation(engine, sourceId);
    } catch {
      consolidation = null;
    }
  }

  let written = 0;
  for (const record of records) {
    // Minimize the connector record: drop the body, keep only allowlisted +
    // stripped metadata/summary. The candidate OUTPUT fields (proposed_markdown,
    // proposed_slug, rationale_ref) are redacted authoritatively at the write
    // boundary in candidate.ts::toRow — which every caller goes through — so a
    // connector's toCandidate output cannot smuggle an un-redacted field past it.
    const min = minimize(record.item, record.profile);
    const redacted: NormalizedRecord = {
      sourceRecordId: record.sourceRecordId,
      profile: record.profile,
      item: { sourceRecordId: min.sourceRecordId, metadata: min.metadata, summary: min.summary },
      proposedSlug: record.proposedSlug,
    };
    const raw = connector.toCandidate(redacted, sourceId);
    const candidate: ConnectorCandidateItem = {
      ...raw,
      source_id: sourceId,
      source_record_id: record.sourceRecordId,
      provider: raw.provider ?? connector.provider,
      redactions: [...(raw.redactions ?? []), ...min.redactions],
    };

    // The consolidation path may FAN OUT one capture into N candidate rows, so it
    // returns the COUNT it wrote (not a boolean); the raw passthrough writes one.
    if (consolidation) {
      written += await landOneConsolidated(engine, sourceId, connector, candidate, consolidation);
    } else if ((await toRow(engine, candidate)).written) {
      written += 1;
    }
  }
  return { written, total: records.length };
}

// ── Consolidation seam (U3) — POLL-only; degrade-to-passthrough by construction ──

/** The lazily-loaded consolidation runtime + this poll's source config. */
interface ConsolidationDeps {
  /** The raw `sources.config` for this poll's source (object | JSON string | null). */
  sourceConfig: unknown;
  extract: typeof import('./consolidate.ts').extractConsolidationFacts;
  classify: typeof import('./consolidate.ts').classifyConsolidationFacts;
  enabled: typeof import('./consolidation-config.ts').consolidationEnabled;
  /** U2 surfacing gate: the min confidence an ADD/UPDATE needs to land `pending`
   *  (surfaced) rather than `rejected`/`low_confidence` (held back). Read ONCE per
   *  batch here, not per record (matching the once-per-batch source-config load). */
  surfaceMinConfidence: number;
}

/**
 * Dynamically load the consolidation runtime (cycle-safe) + this source's config,
 * ONCE per `landRecords` call. The dynamic imports resolve the already-evaluated
 * singletons after first use (cheap), and keep the static import graph acyclic.
 *
 * The U2 surfacing threshold is read here too — once per batch — so the gate costs
 * one config read for the whole poll, not one per record. A malformed/missing value
 * falls back to the default inside the reader (never throws); only a hard engine
 * read failure propagates, and that already degrades the WHOLE batch to raw
 * passthrough at the `landRecords` call site (same contract as the source-config
 * read above), so the surfacing gate can never crash a poll.
 */
async function loadConsolidation(engine: BrainEngine, sourceId: string): Promise<ConsolidationDeps> {
  const [consolidate, config] = await Promise.all([
    import('./consolidate.ts'),
    import('./consolidation-config.ts'),
  ]);
  const [rows, surfaceMinConfidence] = await Promise.all([
    engine.executeRaw<{ config: unknown }>(`SELECT config FROM sources WHERE id = $1`, [sourceId]),
    config.consolidationSurfaceMinConfidence(engine),
  ]);
  return {
    sourceConfig: rows[0]?.config ?? null,
    extract: consolidate.extractConsolidationFacts,
    classify: consolidate.classifyConsolidationFacts,
    enabled: config.consolidationEnabled,
    surfaceMinConfidence,
  };
}

/**
 * Land ONE record through the consolidation pipeline. Returns the COUNT of NEW
 * rows written for this record — `0` when skipped (idempotent re-poll), `1` for a
 * raw passthrough or a single-verdict capture, and N for a multi-topic capture
 * that FANS OUT into N targeted proposals (one per page it touches). Degrade
 * contract (KTD4): the per-connector flag off / chat unavailable / U1 returns null
 * → today's raw passthrough (1); ANY non-abort throw before persistence (a poison
 * capture, a transient backend hiccup) is caught and degrades THIS record to raw
 * passthrough so the batch continues. AbortError propagates (graceful shutdown —
 * never land mid-shutdown).
 */
async function landOneConsolidated(
  engine: BrainEngine,
  sourceId: string,
  connector: SaaSConnector,
  candidate: ConnectorCandidateItem,
  deps: ConsolidationDeps,
): Promise<number> {
  const provider = candidate.provider ?? connector.provider;
  const version = strip(candidate.version ?? '1');
  const passthrough = async (): Promise<number> => ((await toRow(engine, candidate)).written ? 1 : 0);
  try {
    // Gate: per-connector flag (default false) + chat reachable. Either off →
    // today's raw passthrough (no DB pre-check, no LLM). The POLL-only structural
    // gate already held at the call site; this is the per-connector + availability
    // layer. extractConsolidationFacts re-checks both internally (defense in depth).
    if (!deps.enabled(provider, deps.sourceConfig) || !isAvailable('chat')) {
      return await passthrough();
    }

    // KTD2 invariant guard. The fan-out key `<captureId>::<target>` AND the
    // prefix-based re-poll idempotency both ASSUME `::` never appears in a
    // captureId. Granola note ids are opaque tokens (safe), but sibling connectors
    // build colon-delimited ids (Linear `id:take:…`, Slack `channel:ts`) — enabling
    // consolidation for one without this guard could collide two captures on one
    // key, or cause a false idempotency hit (a silently-skipped, permanently-lost
    // capture). Fail-safe: a captureId containing `::` degrades to raw passthrough
    // (no fan-out keying, no prefix idempotency). Enforces the invariant the review
    // flagged as unguarded; pairs with enabling any second connector.
    if (candidate.source_record_id.includes('::')) {
      console.error(
        `[consolidation] captureId contains '::' for ${sourceId}/${provider} — ` +
          `degrading to raw passthrough (fan-out keying requires no '::' in the capture id)`,
      );
      return await passthrough();
    }

    // Idempotency pre-check (KTD3, fan-out-aware): a re-poll of an already-
    // consolidated CAPTURE must NOT re-pay the LLM. Under fan-out the capture lands
    // under `<captureId>::<target>` rows (not the bare id), so this checks BOTH the
    // bare-id row AND the `<captureId>::` prefix. A hit → skip entirely (no
    // extraction, no new row, not counted); the first poll's verdicts + decision
    // log stand.
    if (await captureConsolidated(engine, sourceId, candidate.source_record_id, version)) {
      return 0;
    }

    // U1 → U2. extract reads the REDACTED capture summary (proposed_markdown,
    // strip()'d so a secret in the capture never reaches the LLM input either).
    const captureText = candidate.proposed_markdown ? strip(candidate.proposed_markdown) : '';
    const extracted = await deps.extract({ captureText, provider, sourceConfig: deps.sourceConfig, engine });
    if (!extracted) {
      // U1 degrade (flag off / chat down / empty / malformed) → raw passthrough.
      return await passthrough();
    }
    const verdicts = await deps.classify({
      facts: extracted.facts,
      extractionConfidence: extracted.confidence,
      provider,
      sourceConfig: deps.sourceConfig,
      engine,
    });
    if (!verdicts) {
      // Only the disabled-connector entry gate returns null here (already gated
      // above) — defensive: degrade to raw passthrough.
      return await passthrough();
    }

    const { written, threw } = await persistConsolidated(
      engine, sourceId, candidate, version, verdicts, deps.surfaceMinConfidence,
    );
    if (written > 0) return written;
    // Nothing landed. Preserve via raw passthrough ONLY when the capture genuinely got
    // nothing persisted: empty verdicts (no durable facts → land the idempotency marker
    // so a re-poll skips it) or a verdict that THREW (its INSERT failed). If verdicts
    // existed and ALL merely CONFLICTED (no throw), a concurrent poll already
    // consolidated this capture — return 0, do NOT write a spurious bare-id raw
    // candidate (review finding 3: the all-conflict fallback double-write under a race).
    if (verdicts.length === 0 || threw) return await passthrough();
    return 0;
  } catch (err) {
    if (isAbortError(err)) throw err; // graceful shutdown — propagate, don't land.
    // KTD4 degrade: any other throw isolates to THIS record. Throws reach here only
    // from the PRE-persist steps (pre-check / extract / classify) — no consolidated
    // row was written — so this raw candidate genuinely lands (idempotent), the
    // capture is not lost, and the batch continues. Per-verdict persistence throws
    // are contained INSIDE persistConsolidated (a poison verdict degrades only
    // itself), and the decision-log write is non-fatal there, so neither re-degrades
    // an already-persisted consolidated row to a raw passthrough.
    return await passthrough();
  }
}

/**
 * Persist a classified capture by FANNING OUT its verdicts: each verdict becomes
 * its own candidate row with a distinct, collision-free `source_record_id` (KTD2),
 * its own single-writer-per-page guard, and its own decision-log row. Returns the
 * COUNT of rows actually inserted across the fan-out.
 *
 * A single-verdict capture keeps today's BARE captureId (byte-compatible with v1 +
 * the common single-topic case); a multi-topic capture keys each row
 * `<captureId>::<target>`. Per-verdict isolation: a poison verdict (a toRow throw)
 * degrades only itself — its siblings still land. AbortError propagates.
 */
async function persistConsolidated(
  engine: BrainEngine,
  sourceId: string,
  candidate: ConnectorCandidateItem,
  version: string,
  verdicts: ConsolidationClassifyResult[],
  surfaceMinConfidence: number,
): Promise<{ written: number; threw: boolean }> {
  const captureId = candidate.source_record_id;
  const fanOut = verdicts.length > 1;
  let written = 0;
  let threw = false;
  for (const [index, verdict] of verdicts.entries()) {
    try {
      written += await persistOneVerdict(
        engine, sourceId, candidate, captureId, version, verdict, index, fanOut, surfaceMinConfidence,
      );
    } catch (err) {
      if (isAbortError(err)) throw err; // graceful shutdown still propagates.
      // Per-verdict isolation: this verdict's row INSERT threw — log + skip it; the
      // sibling verdicts (already written or still to come) are unaffected.
      // KNOWN LIMITATION (review finding 2): a thrown verdict is NOT retried — once a
      // sibling lands, the per-capture prefix idempotency treats the whole capture as
      // consolidated, so the failed partition is stranded. Rare (a transient row-INSERT
      // throw), the human still sees the other partitions, and the loud log is the
      // alert. A full fix (per-partition completion tracking / transactional fan-out)
      // is a deferred follow-up.
      threw = true;
      console.error(
        `[consolidation] fan-out verdict persist failed for ` +
          `${sourceId}/${fanoutRecordId(captureId, verdict, index, fanOut)} (${verdict.classification}): ` +
          `${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  return { written, threw };
}

/**
 * Persist ONE fanned-out verdict: derive its per-target `source_record_id` (KTD2),
 * map the verdict onto the row columns (KTD6), enforce single-writer-per-page for
 * UPDATE (KTD9), and write the per-target decision-log row. The merged body /
 * timeline line flow through toRow's strip() (redaction invariant). Returns 1 if a
 * new row was inserted, else 0 (ON CONFLICT — e.g. a duplicate target key).
 */
async function persistOneVerdict(
  engine: BrainEngine,
  sourceId: string,
  candidate: ConnectorCandidateItem,
  captureId: string,
  version: string,
  verdict: ConsolidationClassifyResult,
  index: number,
  fanOut: boolean,
  surfaceMinConfidence: number,
): Promise<number> {
  const recordId = fanoutRecordId(captureId, verdict, index, fanOut);
  // Re-key the per-target row only when fanning out (recordId === captureId for a
  // single-verdict capture → reuse the base item unchanged, byte-identical to v1).
  const base: ConnectorCandidateItem =
    recordId === captureId ? candidate : { ...candidate, source_record_id: recordId };

  let final = verdict;
  // Resolve the classifier's target SLUG → the receiver repo path (`<slug>.md`),
  // only for a clean single-target UPDATE.
  const resolvedPath =
    verdict.classification === 'UPDATE' && verdict.target_path
      ? slugToRepoPath(verdict.target_path)
      : null;

  // Single-writer-per-page (KTD9 inverse): if another pending-or-accepted
  // update_page already targets this page, downgrade THIS verdict to NEEDS_REVIEW so
  // two clean merges sharing one base_compiled_hash can't clobber each other. The
  // lookup is non-indexed + non-atomic, but SAFE for the sequential poller (a prior
  // row is committed + visible to a later check); the receiver's base_compiled_hash
  // guard backstops the rare concurrent-poll double-writer. The guard is per TARGET,
  // so two captures racing one page collapse to one, while a fan-out's distinct
  // targets each proceed independently.
  if (resolvedPath && (await hasInflightUpdatePage(engine, resolvedPath))) {
    final = { ...verdict, classification: 'NEEDS_REVIEW' };
  }

  const item = buildConsolidatedItem(base, final, resolvedPath, surfaceMinConfidence);
  // FU2: a transient row-INSERT throw must not strand this partition. `toRow` is an
  // idempotent INSERT … ON CONFLICT DO NOTHING (a duplicate key returns written:false,
  // it never throws), so a retry is safe — a throw here is a transient backend hiccup
  // (connection blip / timeout). Retry with small backoff before letting it propagate
  // to persistConsolidated's per-verdict catch, which strands + loudly logs THIS
  // partition only. A PERMANENT error (exhausts the retries) still ends there — that
  // residual single-partition loss is the documented known-limitation.
  let written = false;
  for (let attempt = 1; ; attempt++) {
    try {
      ({ written } = await toRow(engine, item));
      break;
    } catch (err) {
      if (isAbortError(err) || attempt >= 3) throw err;
      await new Promise((resolve) => setTimeout(resolve, attempt * 150));
    }
  }

  // Durable decision log (audit + Tier-1 calibration), keyed on the per-target
  // (source_id, source_record_id, version) tuple + classification (idempotent).
  // Records the FINAL classification — what the row actually became, including a
  // single-writer downgrade.
  //
  // NON-FATAL: the consolidated candidate row above is ALREADY committed. A
  // decision-log failure must NOT propagate to persistConsolidated's per-verdict
  // catch, which would otherwise log it as a "verdict persist failure" even though
  // the candidate row landed fine. Worst case on failure is a lost audit row —
  // never a re-degraded or duplicated candidate. (AbortError still propagates.)
  try {
    await recordConsolidationDecision(engine, {
      sourceId,
      sourceRecordId: recordId,
      version,
      classification: final.classification,
      confidence: final.confidence,
      targetPath: resolvedPath ?? final.target_path,
      tier1Cosine: final.tier1_cosine,
      model: final.model,
    });
  } catch (err) {
    if (isAbortError(err)) throw err; // graceful shutdown still propagates.
    console.error(
      `[consolidation] decision-log write failed for ${sourceId}/${recordId} ` +
        `(${final.classification}) — candidate row persisted, audit row dropped: ` +
        `${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (fanOut && !written) {
    // Swallowed ON CONFLICT inside a fan-out (review finding 4): the model named one
    // page in two partitions → both derive the same `<captureId>::<slug>` key →
    // ON CONFLICT DO NOTHING drops the second body. The decision-log row above still
    // records it; this makes the silent drop visible.
    console.warn(
      `[consolidation] fan-out verdict for ${sourceId}/${recordId} (${final.classification}) ` +
        `conflicted on an existing key — body dropped (duplicate target in one capture)`,
    );
  }
  return written ? 1 : 0;
}

/**
 * The per-target `source_record_id` for a fanned-out verdict (KTD2) — the keying
 * spine that makes the `(source_id, source_record_id, version)` unique constraint,
 * the decision-log tuple, AND the receiver's branch name
 * `sha256(source_id|source_record_id)` all distinct per target, so N verdicts from
 * one capture become N independent, independently-promotable proposals with NO
 * receiver change (KTD4).
 *
 *  - Single-verdict capture (`!fanOut`) → today's BARE captureId (byte-identical to
 *    v1; also the `= '<captureId>'` idempotency anchor in {@link captureConsolidated}).
 *  - Fan-out → `<captureId>::<discriminator>`: the page slug for a placed verdict
 *    (UPDATE, or a NEEDS_REVIEW the model placed), else the partition INDEX for a
 *    placeless verdict (ADD / NOOP / unplaced). The `::` separator never occurs in a
 *    real provider captureId (record ids are opaque tokens) or a Brain slug
 *    (path-like `[a-z0-9/_.-]`, no colon) — so the key is unambiguous.
 */
function fanoutRecordId(
  captureId: string,
  verdict: ConsolidationClassifyResult,
  index: number,
  fanOut: boolean,
): string {
  if (!fanOut) return captureId;
  const slug = verdict.target_path?.trim();
  const discriminator = slug && slug.length > 0 ? slug : String(index);
  return `${captureId}::${discriminator}`;
}

/** TTL for a SURFACED (pending) consolidation candidate — 30 days (U3/KTD3). An
 *  un-acted confident proposal auto-expires rather than guilt-piling forever. */
const CONSOLIDATION_PENDING_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/** TTL for a HELD-BACK consolidation candidate (NOOP / NEEDS_REVIEW / low_confidence)
 *  — 7 days. Logged-and-hidden audit rows clean themselves up quickly. */
const CONSOLIDATION_HELD_BACK_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** The `expires_at` to stamp on a consolidation candidate (U3). `now` is injectable
 *  for deterministic tests; defaults to wall-clock. Held-back rows get the short TTL,
 *  surfaced pending rows the long one. */
function consolidationExpiry(heldBack: boolean, now: number = Date.now()): Date {
  return new Date(now + (heldBack ? CONSOLIDATION_HELD_BACK_TTL_MS : CONSOLIDATION_PENDING_TTL_MS));
}

/**
 * Map a classifier verdict onto the candidate row columns (KTD6 + U1/U2/U3). Only
 * confident, unambiguous proposals reach the human; everything else is logged +
 * persisted for audit but lands off the pending queue with a short self-cleaning TTL:
 *   - NOOP → status='rejected' + status_reason='NOOP' (off the pending queue).
 *   - NEEDS_REVIEW (U1) → status='rejected' + status_reason='NEEDS_REVIEW' — the
 *             system absorbs the ambiguity; the human never triages it. Still recorded
 *             in the decision log by `persistConsolidated` (audit + Tier-1 calibration).
 *   - ADD / UPDATE with confidence < `surfaceMinConfidence` (U2) → status='rejected' +
 *             status_reason='low_confidence'. The classification + UPDATE target fields
 *             are KEPT (audit / later recovery); only the status (and TTL) change.
 *   - ADD / UPDATE with confidence >= threshold → SURFACED as a pending candidate.
 * Every consolidation row carries an `expires_at` (U3): 30 days surfaced, 7 days held back.
 */
function buildConsolidatedItem(
  base: ConnectorCandidateItem,
  verdict: ConsolidationClassifyResult,
  resolvedPath: string | null,
  surfaceMinConfidence: number,
): ConnectorCandidateItem {
  switch (verdict.classification) {
    case 'NOOP':
      return {
        ...base,
        classification: 'NOOP',
        status: 'rejected',
        status_reason: 'NOOP',
        confidence: verdict.confidence,
        expires_at: consolidationExpiry(true),
      };
    case 'NEEDS_REVIEW':
      // U1: NEEDS_REVIEW leaves the pending queue (mirrors NOOP). A downgraded
      // single-writer UPDATE arrives here too — correctly also off-queue.
      return {
        ...base,
        classification: 'NEEDS_REVIEW',
        status: 'rejected',
        status_reason: 'NEEDS_REVIEW',
        confidence: verdict.confidence,
        expires_at: consolidationExpiry(true),
      };
    case 'UPDATE': {
      // U2: hold back a low-confidence UPDATE off the pending queue. Keep the full
      // pre-computed target (path + body + timeline + base hash) for audit/recovery —
      // only the status + TTL change.
      const heldBack = verdict.confidence < surfaceMinConfidence;
      return {
        ...base,
        classification: 'UPDATE',
        confidence: verdict.confidence,
        // merged body → proposed_markdown; strip()'d at the toRow write boundary.
        proposed_markdown: verdict.merged_body ?? base.proposed_markdown,
        target_kind: 'update_page',
        target_path: resolvedPath,
        timeline_entry: verdict.timeline_entry,
        // base_compiled_hash is the KTD8 staleness guard. On a held-back
        // (rejected/low_confidence) UPDATE it is RETAINED but INERT today — nothing
        // reopens a rejected candidate. Any future "reopen rejected" admin action MUST
        // re-validate this hash against current compiled-truth before promoting: the
        // target page may have moved on while the row sat held-back/expiring.
        base_compiled_hash: verdict.base_compiled_hash,
        ...(heldBack ? { status: 'rejected' as const, status_reason: 'low_confidence' } : {}),
        expires_at: consolidationExpiry(heldBack),
      };
    }
    case 'ADD': {
      // U2: a low-confidence ADD is held back the same way (no target fields to keep).
      const heldBack = verdict.confidence < surfaceMinConfidence;
      return {
        ...base,
        classification: 'ADD',
        confidence: verdict.confidence,
        ...(heldBack ? { status: 'rejected' as const, status_reason: 'low_confidence' } : {}),
        expires_at: consolidationExpiry(heldBack),
      };
    }
  }
}

/**
 * Resolve a classifier target SLUG (the page identity, e.g. `integrations/toast`)
 * to the receiver repo path (`integrations/toast.md`). The inverse of
 * techtris-brain's `stage1_seed_shared_pages.py:slug_for` (slug = repo path minus
 * `.md`), so U4/U5 consume `target_path` directly. Idempotent on an already-`.md`
 * slug.
 */
function slugToRepoPath(slug: string): string {
  return slug.endsWith('.md') ? slug : `${slug}.md`;
}

/** Is a pending-or-accepted `update_page` candidate already in flight for this
 *  target page? (KTD9 single-writer-per-page; non-indexed, sequential-poller-safe.) */
async function hasInflightUpdatePage(engine: BrainEngine, targetPath: string): Promise<boolean> {
  const rows = await engine.executeRaw<{ one: number }>(
    `SELECT 1 AS one FROM connector_candidates
      WHERE target_kind = 'update_page' AND target_path = $1
        AND status IN ('pending', 'accepted')
      LIMIT 1`,
    [targetPath],
  );
  return rows.length > 0;
}

/** True when `err` is (or reads as) an AbortError — re-thrown for graceful
 *  shutdown. Mirrors consolidate.ts's isAbort. */
function isAbortError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  return err.name === 'AbortError' || /aborted|cancell?ed/i.test(err.message);
}

function safeParse(value: string): Record<string, unknown> | null {
  try {
    return JSON.parse(value) as Record<string, unknown>;
  } catch {
    return null;
  }
}
