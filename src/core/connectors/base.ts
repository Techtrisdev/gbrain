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
import { minimize, strip, type RawConnectorItem } from './redact.ts';

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
  /** Constant-time webhook signature verification against the per-source secret. */
  verifyWebhook(rawBody: Buffer, headers: Record<string, string | undefined>, secret: string): boolean;
  /** Extract the account/workspace id from a parsed payload, used to resolve the source. */
  accountFromPayload(payload: unknown): string | null;
  /** Normalize a verified payload into 0+ records (pre-redaction). */
  normalize(payload: unknown): NormalizedRecord[];
  /** Map a (redacted) record to a candidate item. The framework calls this AFTER
   *  redaction, so it only ever sees minimized/stripped fields. */
  toCandidate(record: NormalizedRecord, sourceId: string): ConnectorCandidateItem;
  /** Outbound backfill (initial/periodic sync). Declared here; implemented per-connector
   *  once connector_tokens / OAuth (TECH-2033) lands. Uses the same landRecords path. */
  backfill?(engine: BrainEngine, source: ConnectorSource): Promise<number>;
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
    const min = minimize(record.item, record.profile);
    const redacted: NormalizedRecord = {
      sourceRecordId: record.sourceRecordId,
      profile: record.profile,
      item: { sourceRecordId: min.sourceRecordId, metadata: min.metadata, summary: min.summary },
      proposedSlug: record.proposedSlug ? strip(record.proposedSlug) : undefined,
    };
    const raw = connector.toCandidate(redacted, sourceId);
    // Defense-in-depth: proposed_markdown is the field that could become a served page
    // body, so strip it again here regardless of what the connector built.
    const candidate: ConnectorCandidateItem = {
      ...raw,
      source_id: sourceId,
      source_record_id: record.sourceRecordId,
      provider: raw.provider ?? connector.provider,
      proposed_markdown:
        raw.proposed_markdown !== undefined ? strip(raw.proposed_markdown) : raw.proposed_markdown,
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
