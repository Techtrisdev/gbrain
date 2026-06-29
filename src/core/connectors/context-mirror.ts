/**
 * context-mirror.ts — the Context Mirror SaaSConnector.
 *
 * POLL-ONLY, INTERNAL. This connector has no external API and no webhook: it feeds the
 * Brain's OWN `capture-events` source pages back into the Memory Consolidation pipeline.
 * The periodic poll job (poll.ts) drives backfill() on a schedule; there is no inbound
 * trigger, no auth, and no custody registration. verifyWebhook always fails closed and
 * accountFromPayload returns null (the generic /webhooks/:provider receiver must never
 * drive this connector) — exactly like the Granola connector it mirrors.
 *
 * ── What it reads, what it lands ─────────────────────────────────────────────────────
 *
 * backfill READS pages from `source.id` (the capture-events source) via engine.listPages
 * and LANDS one candidate per page UNDER THE SAME `source.id`. That is correct and
 * intended: capture-events is both the read source (the raw captures) and the candidate
 * home (the consolidation proposals derived from them). Each capture page becomes one
 * NormalizedRecord whose `item.summary` carries the page's compiled truth (+ timeline when
 * present); the body field is never set (bodies are always dropped by the framework), so
 * the capture text rides as `summary` and nothing else can leak through.
 *
 * ── Consolidation (default OFF) ──────────────────────────────────────────────────────
 *
 * backfill calls landRecords(..., { consolidate: true }) — the latency-tolerant poll path.
 * The Memory Consolidation Engine (extract → classify) then runs per record IFF
 * config.connectors.context_mirror.consolidation_enabled === true (default OFF, set by an
 * operator via SQL — NEVER by this connector). With it off, landRecords is today's
 * byte-identical raw passthrough: one candidate row per capture page, human-PR-gated.
 *
 * ── Incremental cursor ───────────────────────────────────────────────────────────────
 *
 * A `watermark` (the newest page updated_at landed) is persisted under
 * config.connectors.context_mirror.watermark via a surgical jsonb_set. Each poll lists
 * pages with `updated_after = watermark` (strict >) sorted updated_asc, so only pages
 * touched since the last run are re-listed. Capture pages are immutable (one per message,
 * never rewritten), so no lookback window is needed — the exact watermark is read.
 * The framework's (source_id, source_record_id, version) idempotency makes any overlap a
 * no-op. The watermark advances to the newest page in the batch and never regresses:
 * `updated_after` is strict, so every returned page is strictly newer than the watermark.
 */

import {
  registerConnector,
  type SaaSConnector,
  type NormalizedRecord,
  type ConnectorSource,
} from './base.ts';
import type { ConnectorCandidateItem } from './candidate.ts';
import type { BrainEngine } from '../engine.ts';
import type { Page } from '../types.ts';

// ── Constants ────────────────────────────────────────────────────────────────────

const PROVIDER = 'context_mirror';
/** Poll-only: no inbound webhook. A sentinel header so the SaaSConnector shape is satisfied;
 *  the generic receiver never drives this connector (verifyWebhook fails closed). */
export const CONTEXT_MIRROR_SIGNATURE_HEADER = 'x-context-mirror-unused';

// ── Helpers: defensive payload access ────────────────────────────────────────────

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

/**
 * The capture text that becomes the candidate body: the page's compiled truth, plus the
 * timeline (separated by a blank line) ONLY when the timeline is non-empty. Defensive
 * against a non-string / absent compiled_truth or timeline (the runtime Page is `as`-cast
 * by some engine paths, not validated).
 */
function captureText(page: Page): string {
  const compiled = str(page.compiled_truth) ?? '';
  const timeline = str(page.timeline) ?? '';
  return timeline.trim().length > 0 ? `${compiled}\n\n${timeline}` : compiled;
}

/**
 * Map capture-events pages into pre-redaction records (one per page). MODULE-LEVEL (not a
 * `this`-bound method) on purpose: poll.ts invokes a connector's `backfill` through an
 * UNBOUND function reference (`const backfill = connector.backfill; await backfill(...)`),
 * so inside backfill `this` is undefined — any `this.normalize(...)` would throw. backfill
 * therefore calls this free function directly, and the connector's `normalize` method (kept
 * for SaaSConnector interface compliance / the unused webhook path) just delegates here.
 *
 * The capture text rides as `item.summary` (kept by the `generic` profile + masked by
 * strip()); there is NO `item.body`, so nothing but the summary can reach a candidate.
 */
function normalizePages(pages: Page[], _source: ConnectorSource): NormalizedRecord[] {
  const list = Array.isArray(pages) ? pages : [];
  const records: NormalizedRecord[] = [];
  for (const page of list) {
    const slug = str(page?.slug);
    if (!slug) continue;
    records.push({
      sourceRecordId: slug,
      profile: 'generic', // url/id/updated_at + summary
      item: {
        sourceRecordId: slug,
        summary: captureText(page),
        metadata: { updated_at: page.updated_at },
        // NO body — only the summary is ever carried into a candidate.
      },
      proposedSlug: slug,
    });
  }
  return records;
}

// ── The connector ─────────────────────────────────────────────────────────────────

export const contextMirrorConnector: SaaSConnector = {
  provider: PROVIDER,
  signatureHeader: CONTEXT_MIRROR_SIGNATURE_HEADER,

  /** Poll-only/internal: nothing sends a webhook, so there is no inbound delivery to
   *  verify. Fail closed unconditionally. */
  verifyWebhook(): boolean {
    return false;
  },

  /** No webhook payload → no account to resolve. The generic receiver would 400; correct,
   *  because Context Mirror is poll-only and must not use it. */
  accountFromPayload(): string | null {
    return null;
  },

  /**
   * SaaSConnector interface compliance. Unlike a webhook connector, the input is the `Page[]`
   * backfill fetched from the source (NOT a webhook payload). Delegates to the module-level
   * {@link normalizePages} (see its note on why the real logic is not a `this`-bound method).
   * The poll-only receiver never calls this; backfill uses normalizePages directly.
   */
  normalize(pages: Page[], source: ConnectorSource): NormalizedRecord[] {
    return normalizePages(pages, source);
  },

  /** Map a (minimized) record to a candidate. version is fixed at '1' — capture pages are
   *  immutable (one per message, never rewritten), so the (source_id, source_record_id,
   *  version) idempotency key is stable. proposed_markdown is the redacted capture text. */
  toCandidate(record, sourceId): ConnectorCandidateItem {
    return {
      source_id: sourceId,
      source_record_id: record.sourceRecordId,
      version: '1',
      provider: PROVIDER,
      proposed_slug: record.proposedSlug,
      proposed_markdown: record.item.summary,
      confidence: 0.9,
    };
  },

  /**
   * Poll backfill: list capture-events pages updated since the watermark (sorted oldest →
   * newest), land each as a consolidation candidate, then advance the watermark to the
   * newest page seen. Idempotency makes any overlap a no-op; `updated_after` is strict so
   * the watermark never regresses.
   */
  async backfill(engine: BrainEngine, source: ConnectorSource): Promise<number> {
    const { landRecords } = await import('./base.ts');

    // Live scheduling: when config.connectors.context_mirror.distill_before_poll is true,
    // distill COMPLETED raw sessions into distilled/ pages BEFORE consolidating, so the
    // scheduled connector poll runs the full live pipeline (distill → consolidate). A
    // distillation failure must NOT block consolidating distilled/ pages that already exist;
    // an AbortError (shutdown) propagates.
    const cmCfg = contextMirrorConfig(source);
    if (cmCfg?.distill_before_poll === true) {
      try {
        const { distillCaptureSessions } = await import('./distill.ts');
        await distillCaptureSessions(engine, {
          sourceId: source.id,
          idleHours: typeof cmCfg.distill_idle_hours === 'number' ? cmCfg.distill_idle_hours : 6,
        });
      } catch (err) {
        if (err instanceof Error && err.name === 'AbortError') throw err;
        console.error(
          `[context_mirror] distill_before_poll failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    const since = readWatermark(source);
    const slugPrefix = readSlugPrefix(source);
    const pages = await engine.listPages({
      sourceId: source.id,
      updated_after: since ?? undefined,
      // When set (e.g. 'distilled/'), consolidate ONLY distilled session memories — never
      // raw per-turn captures (which would flood the review queue one-candidate-per-turn).
      slugPrefix,
      sort: 'updated_asc',
    });
    if (!pages.length) return 0;

    // NOTE: poll.ts calls backfill through an UNBOUND reference, so `this` is undefined here.
    // Use the module-level normalizePages + the named connector const (NOT `this`).
    const records = normalizePages(pages, source);
    // POLL-only consolidation (KTD4): backfill is the latency-tolerant poll path, so it
    // opts in via `consolidate: true`. The Memory Consolidation Engine then runs per record
    // IFF config.connectors.context_mirror.consolidation_enabled is set (default OFF). This
    // is the connector's only landRecords call site (poll-only, no webhook path).
    const { written } = await landRecords(engine, source.id, contextMirrorConnector, records, {
      consolidate: true,
    });

    // pages are sorted updated_asc, so the last is the newest; persist a normalized UTC ISO
    // string. `updated_after` is strict, so newest is strictly > `since` — never a regression.
    const newest = pages[pages.length - 1].updated_at;
    await writeWatermark(engine, source, new Date(newest).toISOString());
    return written;
  },
};

// ── Per-source config (sources.config.connectors.context_mirror.*) ───────────────

function safeParseConfig(s: string): Record<string, unknown> | null {
  try {
    return JSON.parse(s) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function contextMirrorConfig(source: ConnectorSource): Record<string, unknown> | null {
  const raw = typeof source.config === 'string' ? safeParseConfig(source.config) : source.config;
  const connectors = asRecord(raw?.connectors);
  return asRecord(connectors?.[PROVIDER]);
}

/** The persisted watermark (newest page updated_at landed), or null on first run. */
export function readWatermark(source: ConnectorSource): string | null {
  return str(contextMirrorConfig(source)?.watermark) ?? null;
}

/** Optional slug-prefix filter. When set (e.g. 'distilled/'), backfill lists ONLY pages whose
 *  slug starts with it, so the connector consolidates distilled session memories and NEVER raw
 *  per-turn captures (one-candidate-per-turn flood). Unset → all pages in the source (back-compat). */
export function readSlugPrefix(source: ConnectorSource): string | undefined {
  return str(contextMirrorConfig(source)?.read_slug_prefix) ?? undefined;
}

/**
 * Persist ONLY the watermark via a surgical jsonb_set, leaving sibling config keys intact
 * (lost-update-safe, same pattern as granola's writeWatermark). A COALESCE guarantees the
 * connectors.context_mirror path is created if absent.
 */
export async function writeWatermark(
  engine: BrainEngine,
  source: ConnectorSource,
  watermark: string,
): Promise<void> {
  await engine.executeRaw(
    `UPDATE sources
        SET config = jsonb_set(
              COALESCE(config, '{}'::jsonb),
              '{connectors,context_mirror,watermark}',
              to_jsonb($1::text),
              true)
      WHERE id = $2`,
    [watermark, source.id],
  );
}

// ── Registration (side-effecting at module load) ─────────────────────────────────

registerConnector(contextMirrorConnector);
