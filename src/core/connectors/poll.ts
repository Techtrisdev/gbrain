/**
 * poll.ts — the `connector_poll` Minion job's pure core + the autopilot
 * connector-dispatch selection logic (TECH-2038).
 *
 * Three concerns, all pure / engine-injected so they unit-test without a DB:
 *
 *   1. SELECTION (autopilot branch) — `selectEnabledConnectorSources` picks the
 *      sources the autopilot loop should `connector_poll`: a source is eligible
 *      iff it has NO `local_path` (connectors have no git checkout — the git-sync
 *      branch owns local_path sources) AND at least one connector entry under
 *      `config.connectors.<provider>` with `enabled === true`. Each eligible
 *      source yields one (source_id, provider) poll target per enabled provider.
 *
 *   2. KILL-SWITCH — `connectorAutomationDisabled` is the single gate the
 *      autopilot branch consults before fanning out ANY connector poll. It trips
 *      on the env var `GBRAIN_CONNECTORS_KILLSWITCH` (truthy) OR a per-source
 *      config flag `config.connectors_killswitch === true`. Default-off automation
 *      (each connector is `enabled:false` until an operator runs `connector enable`)
 *      is the primary safety; the kill-switch is the operator's "stop everything NOW"
 *      override that needs no per-connector toggling.
 *
 *   3. RECONCILIATION (poll handler) — `computeTombstoneCandidates` diffs the set
 *      of upstream record ids a poll still sees against the set previously landed
 *      as candidates. A record that has VANISHED upstream gets a TOMBSTONE
 *      candidate (a `connector_candidate` marking it gone) — NEVER a direct delete
 *      of a page or candidate. Tombstones ride the same table-only redaction path
 *      (toRow / landRecords) as every other candidate.
 *
 * The poll handler itself (`runConnectorPoll`) is the thin orchestrator: resolve
 * the connector by provider, call its `backfill(engine, source)` (idempotent —
 * landRecords' ON CONFLICT makes a re-fetch a safe no-op), then — when the
 * connector can report the still-present upstream id set — emit tombstones for the
 * vanished remainder. Safe to re-run: backfill is idempotent and a tombstone is
 * itself a versioned candidate (ON CONFLICT DO NOTHING).
 */

import type { BrainEngine } from '../engine.ts';
import { getConnector, type ConnectorSource } from './base.ts';
import { toRow, type ConnectorCandidateItem } from './candidate.ts';

// ── Config shapes (read-only views over sources.config) ──────────────────────

/** A source row as the poll/selection logic reads it. `config` may be a parsed
 *  object (Postgres) or a JSON string (PGLite) — `parseSourceConfigObject`
 *  tolerates both. `local_path` gates connector-eligibility: a connector source
 *  has none (the git-sync branch owns local_path sources). */
export interface ConnectorSourceRow {
  id: string;
  local_path?: string | null;
  config: Record<string, unknown> | string | null;
}

/** Per-source per-provider connector config (sources.config.connectors.<provider>).
 *  Every field beyond `enabled` is optional and surfaced for the AC3 recognized-fields
 *  contract; the selection logic only reads `enabled`. */
export interface ConnectorEntryConfig {
  /** Off by default — a configured-but-not-enabled connector is never polled. */
  enabled?: boolean;
  /** Provider key (defaults to the map key when absent). */
  provider?: string;
  /** Pagination cursor / watermark — the connector's resume anchor. */
  cursor?: string;
  watermark?: string;
  /** Minimum seconds between polls (advisory; autopilot freshness owns cadence today). */
  poll_interval?: number;
  /** Retention policy hint for landed candidates. */
  retention_policy?: string;
  /** Redaction source-class profile hint. */
  redaction_profile?: string;
  /** Provider workspace/account id this source maps to. */
  account?: string;
}

/** One poll target the autopilot connector-dispatch branch fans out. */
export interface ConnectorPollTarget {
  sourceId: string;
  provider: string;
}

const KILLSWITCH_ENV = 'GBRAIN_CONNECTORS_KILLSWITCH';
/** Per-source config flag that disables connector automation for that source. */
const KILLSWITCH_CONFIG_FLAG = 'connectors_killswitch';

// ── Pure config helpers ──────────────────────────────────────────────────────

/** Parse sources.config to a plain object regardless of driver shape (string|object|null). */
export function parseSourceConfigObject(config: unknown): Record<string, unknown> {
  if (typeof config === 'string') {
    try {
      const parsed = JSON.parse(config) as unknown;
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : {};
    } catch {
      return {};
    }
  }
  if (config && typeof config === 'object' && !Array.isArray(config)) {
    return config as Record<string, unknown>;
  }
  return {};
}

/** Read the `connectors` map from a (parsed) source config, defensive against non-objects. */
export function readConnectorsConfig(
  config: unknown,
): Record<string, ConnectorEntryConfig> {
  const parsed = parseSourceConfigObject(config);
  const connectors = parsed.connectors;
  if (connectors && typeof connectors === 'object' && !Array.isArray(connectors)) {
    return connectors as Record<string, ConnectorEntryConfig>;
  }
  return {};
}

/**
 * The kill-switch gate. Returns true when connector automation must NOT run for
 * this source. Tripped by:
 *   - env `GBRAIN_CONNECTORS_KILLSWITCH` being truthy (global "stop everything"),
 *   - the per-source config flag `connectors_killswitch === true`.
 *
 * `env` is injected so tests don't mutate process.env. Default-off enabling is the
 * primary safety; this is the operator override that suppresses ALL connector
 * automation without un-enabling each connector.
 */
export function connectorAutomationDisabled(
  source: Pick<ConnectorSourceRow, 'config'>,
  env: Record<string, string | undefined> = process.env,
): boolean {
  const raw = env[KILLSWITCH_ENV];
  if (raw !== undefined && raw !== '' && raw !== '0' && raw.toLowerCase() !== 'false') {
    return true;
  }
  const parsed = parseSourceConfigObject(source.config);
  return parsed[KILLSWITCH_CONFIG_FLAG] === true;
}

/**
 * Is this source an enabled CONNECTOR source for autopilot dispatch?
 *
 * Eligibility (AC2):
 *   - NO `local_path` (connectors have no git checkout — git-sync owns local_path), AND
 *   - at least one `config.connectors.<provider>.enabled === true`, AND
 *   - the kill-switch is not tripped (env or per-source flag).
 *
 * A source with a `local_path` is ALWAYS excluded here so the git-sync branch and
 * the connector branch never both claim the same source.
 */
export function isEnabledConnectorSource(
  source: ConnectorSourceRow,
  env: Record<string, string | undefined> = process.env,
): boolean {
  if (source.local_path) return false; // git-sync owns local_path sources
  if (connectorAutomationDisabled(source, env)) return false;
  const connectors = readConnectorsConfig(source.config);
  return Object.values(connectors).some((c) => c?.enabled === true);
}

/**
 * Select the connector poll targets the autopilot branch should dispatch.
 *
 * For every source that `isEnabledConnectorSource` accepts, emit one
 * (source_id, provider) target per ENABLED provider entry. Sources with a
 * `local_path`, no enabled connectors, or a tripped kill-switch yield nothing.
 *
 * Deterministic order: sources in input order, providers sorted by key — so the
 * fan-out cap (when applied by the caller) is stable across ticks.
 */
export function selectEnabledConnectorSources(
  sources: ConnectorSourceRow[],
  env: Record<string, string | undefined> = process.env,
): ConnectorPollTarget[] {
  const targets: ConnectorPollTarget[] = [];
  for (const source of sources) {
    if (!isEnabledConnectorSource(source, env)) continue;
    const connectors = readConnectorsConfig(source.config);
    for (const provider of Object.keys(connectors).sort()) {
      const entry = connectors[provider];
      if (entry?.enabled !== true) continue;
      // The map key is authoritative for the provider; entry.provider is only a
      // redundant echo (AC3 recognizes it but key wins to avoid a spoofed mismatch).
      targets.push({ sourceId: source.id, provider });
    }
  }
  return targets;
}

// ── Reconciliation — tombstone candidates for vanished upstream records ───────

/** Marks a tombstone candidate in its redactions trail + a deterministic suffix on
 *  the version so it never collides with the live record's candidate row. */
export const TOMBSTONE_VERSION_SUFFIX = 'tombstone';
const TOMBSTONE_REDACTION = { field: 'record', action: 'tombstone' } as const;

/**
 * Diff the set of upstream record ids a poll STILL sees against the set previously
 * landed as candidates, and build a TOMBSTONE candidate for each id that has
 * vanished upstream. Pure: no I/O. The caller (`runConnectorPoll`) writes the
 * result through `toRow` (the redaction choke point) — NEVER a direct delete.
 *
 * A tombstone is a normal `connector_candidate` whose:
 *   - version is `<recordVersion>:tombstone` so it cannot collide with the live
 *     candidate's (source, record, version) key — both rows coexist, and the
 *     promotion bridge later reads the tombstone as "this record went away",
 *   - proposed_markdown is a short structural note (no body — there is no upstream
 *     body to carry, the record is gone),
 *   - redactions trail carries a `record:tombstone` marker.
 *
 * `seenRecordIds` and `knownRecordIds` are compared as sets; a known id absent from
 * the seen set is a vanish. Ids present in `seen` but not `known` are NEW records —
 * backfill already landed them, so they are not this function's concern.
 */
export function computeTombstoneCandidates(args: {
  sourceId: string;
  provider: string;
  knownRecordIds: Iterable<string>;
  seenRecordIds: Iterable<string>;
}): ConnectorCandidateItem[] {
  const seen = new Set(args.seenRecordIds);
  const tombstones: ConnectorCandidateItem[] = [];
  const emitted = new Set<string>();
  for (const recordId of args.knownRecordIds) {
    if (seen.has(recordId)) continue; // still present upstream — not a vanish
    if (emitted.has(recordId)) continue; // de-dupe a repeated known id
    emitted.add(recordId);
    tombstones.push({
      source_id: args.sourceId,
      source_record_id: recordId,
      version: `1:${TOMBSTONE_VERSION_SUFFIX}`,
      provider: args.provider,
      proposed_slug: `${args.provider}-tombstone-${recordId}`,
      // Structural note only — the upstream record is GONE, so there is no body to
      // carry. toRow strips this at the write boundary regardless.
      proposed_markdown: `[tombstone] upstream record ${recordId} vanished from ${args.provider}`,
      confidence: 1,
      redactions: [TOMBSTONE_REDACTION],
    });
  }
  return tombstones;
}

// ── The poll handler core ────────────────────────────────────────────────────

export interface ConnectorPollParams {
  /** Target source id. */
  sourceId: string;
  /** Provider key (resolves the connector + the config.connectors.<provider> entry). */
  provider: string;
  /**
   * Upstream record ids the caller observed THIS poll, used for reconciliation.
   * When omitted, reconciliation is skipped (backfill-only) — a connector that
   * cannot enumerate its full current set must not emit spurious tombstones.
   */
  seenRecordIds?: string[];
}

export interface ConnectorPollResult {
  sourceId: string;
  provider: string;
  /** Number of candidates landed by the connector's backfill this run. */
  landed: number;
  /** Number of tombstone candidates written for vanished records. */
  tombstoned: number;
  /** Set when the poll short-circuited (no source, no connector, no backfill). */
  skippedReason?:
    | 'source_not_found'
    | 'connector_not_registered'
    | 'connector_not_enabled'
    | 'backfill_unsupported';
}

/**
 * Run one `connector_poll`. Idempotent + safe to re-run (AC1):
 *   1. Load the source row; bail cleanly if gone (queue replay against a deleted source).
 *   2. Resolve the connector by provider; bail if unregistered.
 *   3. Verify the connector is still ENABLED for this source (config.connectors.<p>.enabled).
 *      A poll for a since-disabled connector is a clean no-op, not a failure.
 *   4. Call `connector.backfill(engine, source)` — the connector lands candidates via
 *      the framework's landRecords redaction path; ON CONFLICT makes a re-fetch a no-op.
 *   5. Reconciliation: if the caller supplied `seenRecordIds`, diff against the known
 *      candidate record ids for (source, provider) and write a TOMBSTONE candidate for
 *      each vanished id (never a delete).
 *
 * Throws only on an unexpected engine/connector error (so the Minion worker retries
 * with backoff); expected "nothing to do" cases return a `skippedReason`.
 */
export async function runConnectorPoll(
  engine: BrainEngine,
  params: ConnectorPollParams,
): Promise<ConnectorPollResult> {
  const { sourceId, provider } = params;
  const base: ConnectorPollResult = { sourceId, provider, landed: 0, tombstoned: 0 };

  const rows = await engine.executeRaw<{ id: string; config: Record<string, unknown> | string }>(
    `SELECT id, config FROM sources WHERE id = $1`,
    [sourceId],
  );
  const row = rows[0];
  if (!row) return { ...base, skippedReason: 'source_not_found' };

  const connector = getConnector(provider);
  if (!connector) return { ...base, skippedReason: 'connector_not_registered' };

  // Re-check enablement at run time: a connector disabled between dispatch and
  // claim must not poll. Default-off respected — an absent entry is not enabled.
  const entry = readConnectorsConfig(row.config)[provider];
  if (entry?.enabled !== true) return { ...base, skippedReason: 'connector_not_enabled' };

  if (typeof connector.backfill !== 'function') {
    return { ...base, skippedReason: 'backfill_unsupported' };
  }

  const source: ConnectorSource = { id: row.id, config: row.config };
  const landed = await connector.backfill(engine, source);

  let tombstoned = 0;
  if (params.seenRecordIds !== undefined) {
    const known = await readKnownRecordIds(engine, sourceId, provider);
    const tombstones = computeTombstoneCandidates({
      sourceId,
      provider,
      knownRecordIds: known,
      seenRecordIds: params.seenRecordIds,
    });
    for (const t of tombstones) {
      // toRow is the single redaction + table-only write boundary (never a page,
      // never a delete). ON CONFLICT DO NOTHING makes a re-run a safe no-op.
      const { written } = await toRow(engine, t);
      if (written) tombstoned += 1;
    }
  }

  return { ...base, landed, tombstoned };
}

/**
 * Read the distinct upstream record ids previously landed as LIVE candidates for
 * (source, provider) — i.e. excluding tombstone rows, so a tombstone's own record id
 * doesn't re-qualify as "known but vanished" and resurrect itself every poll.
 */
async function readKnownRecordIds(
  engine: BrainEngine,
  sourceId: string,
  provider: string,
): Promise<string[]> {
  const rows = await engine.executeRaw<{ source_record_id: string }>(
    `SELECT DISTINCT source_record_id
       FROM connector_candidates
      WHERE source_id = $1
        AND provider = $2
        AND version NOT LIKE $3`,
    [sourceId, provider, `%:${TOMBSTONE_VERSION_SUFFIX}`],
  );
  return rows.map((r) => r.source_record_id);
}
