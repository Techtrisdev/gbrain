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
import { toRow, type ConnectorCandidateItem } from './candidate.ts';
import { minimize, type RawConnectorItem } from './redact.ts';

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

/**
 * Redact each record and write it as a table-only candidate. THE single redaction
 * point: minimize the item (drops bodies + non-allowlisted metadata) and strip the
 * proposed markdown before `toRow`. Never writes a page. Idempotent via toRow's
 * ON CONFLICT DO NOTHING, so duplicate webhook deliveries are safe no-ops.
 */
export async function landRecords(
  engine: BrainEngine,
  sourceId: string,
  connector: SaaSConnector,
  records: NormalizedRecord[],
): Promise<LandResult> {
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
    const { written: didWrite } = await toRow(engine, candidate);
    if (didWrite) written += 1;
  }
  return { written, total: records.length };
}

function safeParse(value: string): Record<string, unknown> | null {
  try {
    return JSON.parse(value) as Record<string, unknown>;
  } catch {
    return null;
  }
}
