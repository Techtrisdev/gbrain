/**
 * granola.ts — the Granola meeting-notes SaaSConnector.
 *
 * POLL-ONLY. Granola has no webhooks, so this connector has no inbound trigger; the
 * periodic poll job (poll.ts) drives backfill() on a schedule. Auth is a STATIC API key
 * (`Bearer grn_...`) read from config.connectors.granola.api_key (per-source) or env
 * GRANOLA_API_KEY (global fallback) — NOT OAuth (no refresh token), so there is no
 * custody registration, no onConnect, and no events.watch channel. verifyWebhook always
 * fails closed and accountFromPayload returns null (the generic /webhooks/:provider
 * receiver must never drive this connector).
 *
 * ── PRIVACY (load-bearing): SUMMARY-ONLY, TRANSCRIPT NEVER INGESTED ──────────────────
 *
 * The operator constraint is explicit: do NOT dump raw transcripts into Brain. The
 * Granola API gates the transcript behind an opt-in `include=transcript` query param; the
 * AI `summary` is returned without it. This connector:
 *   - requests note detail WITHOUT `include=transcript` (getNote never sets it), and
 *   - reads ONLY `summary` + structural metadata from the response — it never touches a
 *     `transcript` field even if the API were to return one.
 * The summary rides as `item.summary` (kept + masked by the `docs` profile + strip());
 * there is NO `item.body`, so the transcript can never enter a NormalizedRecord and thus
 * never reaches a candidate column. The candidate is still human-reviewed before any
 * promotion. So the worst case is a redacted AI summary in a pending candidate — never a
 * raw transcript, in logs, a candidate, or a Brain page.
 *
 * ── Incremental cursor ───────────────────────────────────────────────────────────────
 *
 * The List Notes endpoint filters by `created_after` (ISO-8601 UTC) and paginates via an
 * opaque `cursor`. We persist a `watermark` (the newest note created_at seen) under
 * config.connectors.granola.watermark via a surgical jsonb_set. Because the API only
 * surfaces a note ONCE its AI summary exists (a note created at T may be summarized at
 * T+minutes), each poll queries `created_after = watermark - lookback` so late-summarized
 * notes in the trailing window are still picked up; the framework's
 * (source_id, source_record_id, version) idempotency makes the re-scan a no-op for
 * already-landed notes. lookback defaults to 48h, overridable via
 * config.connectors.granola.lookback_hours.
 */

import {
  registerConnector,
  type SaaSConnector,
  type NormalizedRecord,
  type ConnectorSource,
} from './base.ts';
import type { ConnectorCandidateItem } from './candidate.ts';
import type { BrainEngine } from '../engine.ts';

// ── Granola API shapes (the subset we read) ──────────────────────────────────────

/** A note as it appears in the List Notes response (metadata only — no summary/transcript). */
export interface GranolaNoteListItem {
  id?: string;
  title?: string;
  created_at?: string;
  updated_at?: string;
}

/** A List Notes response page. */
export interface GranolaNotesListPage {
  notes?: GranolaNoteListItem[];
  hasMore?: boolean;
  cursor?: string;
}

/**
 * A note's detail (Get Note WITHOUT include=transcript). We read summary + metadata ONLY.
 * `transcript` is intentionally absent from this type so it can never be referenced — the
 * privacy invariant is enforced at the type level, not just by omitting the query param.
 */
export interface GranolaNoteDetail {
  id?: string;
  title?: string;
  owner?: { name?: string; email?: string };
  summary?: string;
  created_at?: string;
  updated_at?: string;
  url?: string;
}

// ── Constants ────────────────────────────────────────────────────────────────────

const PROVIDER = 'granola';
/** Poll-only: no inbound webhook. A sentinel header so the SaaSConnector shape is satisfied;
 *  the generic receiver never drives this connector (verifyWebhook fails closed). */
export const GRANOLA_SIGNATURE_HEADER = 'x-granola-unused';

const GRANOLA_API_BASE = 'https://public-api.granola.ai/v1';
const API_KEY_ENV = 'GRANOLA_API_KEY';
/** A kept title is a structural LABEL, not free content — cap it (mirrors calendar/linear). */
const MAX_TITLE_LEN = 200;
/** A kept summary is curated AI content (the value), but still cap it so a runaway summary
 *  can't bloat a candidate; strip() masks any PII/secret regex-detectable within it. */
const MAX_SUMMARY_LEN = 8000;
/** Default trailing re-scan window covering AI-summary lag (override: lookback_hours). */
const DEFAULT_LOOKBACK_MS = 48 * 60 * 60 * 1000;
/** Page size cap for List Notes (the API may cap lower). */
const LIST_PAGE_SIZE = 100;
/** Hard bound on pagination pages per backfill. An opaque cursor carries no monotonicity
 *  guarantee (unlike Google's pageToken), so a buggy/cycling cursor must not wedge the
 *  unattended poll job. At LIST_PAGE_SIZE=100 this is 100k notes — far beyond any real
 *  Brain — so it only ever trips on a runaway cursor. Exported for the regression test. */
export const MAX_BACKFILL_PAGES = 1000;

// ── Helpers: defensive payload access ────────────────────────────────────────────

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

async function safeText(res: Response): Promise<string> {
  try {
    return (await res.text()).slice(0, 256);
  } catch {
    return '(unreadable body)';
  }
}

/** A short structural summary HEADLINE for a note — the title only (the AI summary is the
 *  body content, carried separately as item.summary). Titleless → a structural label. */
function headlineForNote(note: GranolaNoteDetail): string {
  const rawTitle = str(note.title);
  const title = rawTitle ? rawTitle.slice(0, MAX_TITLE_LEN) : undefined;
  const id = str(note.id) ?? 'note';
  return title ?? `Granola note ${id}`;
}

/** The metadata we keep — only fields the `docs` profile allowlists
 *  (title / author / url / doc_id / created_at / updated_at). author is the owner EMAIL
 *  only (strip() masks it to [REDACTED]); the owner NAME is never emitted (a real name is
 *  outside strip's v1 regex and would survive verbatim — same finding as calendar). */
function metadataForNote(note: GranolaNoteDetail): Record<string, unknown> {
  const md: Record<string, unknown> = {};
  if (note.id) md.doc_id = note.id;
  // str() guard (NOT a bare truthiness check): the runtime JSON is `as`-cast, not validated,
  // so a structured/non-string title would throw on .slice() and abort the whole page —
  // mirror headlineForNote's str() handling.
  const title = str(note.title);
  if (title) md.title = title.slice(0, MAX_TITLE_LEN);
  const ownerEmail = str(note.owner?.email);
  if (ownerEmail) md.author = ownerEmail;
  const url = str(note.url);
  if (url) md.url = url;
  const createdAt = str(note.created_at);
  if (createdAt) md.created_at = createdAt;
  const updatedAt = str(note.updated_at);
  if (updatedAt) md.updated_at = updatedAt;
  return md;
}

/** Build the proposed_markdown summary block for a note: a structural headline plus the
 *  AI summary (capped). NEVER the transcript. minimize('docs') keeps item.summary; strip()
 *  masks PII/secrets. */
function summaryBlockForNote(note: GranolaNoteDetail): string {
  const headline = headlineForNote(note);
  const aiSummary = str(note.summary);
  if (!aiSummary) return headline;
  const capped = aiSummary.slice(0, MAX_SUMMARY_LEN);
  return `${headline}\n\n${capped}`;
}

// ── The connector ─────────────────────────────────────────────────────────────────

export const granolaConnector: SaaSConnector = {
  provider: PROVIDER,
  signatureHeader: GRANOLA_SIGNATURE_HEADER,

  /** Poll-only: Granola sends no webhooks, so there is no inbound delivery to verify.
   *  Fail closed unconditionally — nothing should ever drive this connector via the
   *  generic receiver. */
  verifyWebhook(): boolean {
    return false;
  },

  /** No webhook payload → no account to resolve. The generic receiver would 400; correct,
   *  because Granola is poll-only and must not use it. */
  accountFromPayload(): string | null {
    return null;
  },

  /**
   * Map note DETAILS into candidates. Accepts a single note detail or `{ notes: [...] }`.
   * The summary rides as item.summary (kept by the `docs` profile + masked by strip()).
   * There is NO item.body — the transcript is never fetched or referenced, so it can never
   * reach a candidate column.
   */
  normalize(payload): NormalizedRecord[] {
    const p = asRecord(payload);
    if (!p) return [];
    const notes: GranolaNoteDetail[] = Array.isArray(p.notes)
      ? (p.notes as GranolaNoteDetail[])
      : [p as GranolaNoteDetail];

    const records: NormalizedRecord[] = [];
    for (const note of notes) {
      const id = str(note.id);
      if (!id) continue;
      records.push({
        sourceRecordId: id,
        profile: 'docs', // title/author/url/doc_id/dates + summary
        item: {
          sourceRecordId: id,
          summary: summaryBlockForNote(note),
          metadata: metadataForNote(note),
          // NO body — the transcript is never carried (privacy invariant).
        },
        proposedSlug: `granola-note-${id}`,
      });
    }
    return records;
  },

  /** Map a (minimized) record to a candidate. version omitted → defaults to '1'
   *  (deterministic idempotency key). proposed_markdown is the redacted summary block. */
  toCandidate(record, sourceId): ConnectorCandidateItem {
    return {
      source_id: sourceId,
      source_record_id: record.sourceRecordId,
      provider: PROVIDER,
      proposed_slug: record.proposedSlug,
      proposed_markdown: record.item.summary,
      confidence: 0.9,
    };
  },

  /**
   * Poll backfill: list notes created since (watermark - lookback), fetch each note's
   * detail WITHOUT the transcript, land it as a summary candidate, then advance the
   * watermark to the newest created_at seen. Idempotency makes the trailing-window re-scan
   * a no-op for already-landed notes.
   */
  async backfill(engine: BrainEngine, source: ConnectorSource): Promise<number> {
    const { landRecords } = await import('./base.ts');
    const apiKey = readApiKey(source);
    if (!apiKey) {
      throw new Error(
        `granola backfill: no API key — set config.connectors.granola.api_key or env ${API_KEY_ENV}`,
      );
    }

    const createdAfter = readQueryWatermark(source);
    // Track the watermark as a parsed INSTANT (ms), not a raw string: lexicographic compare
    // diverges from real-instant ordering when created_at carries non-Z offsets, which would
    // silently advance the watermark past unseen notes (permanent skip). Seed from the prior
    // watermark so we never regress it; persist a normalized UTC ISO string.
    const priorMs = Date.parse(readWatermark(source) ?? '');
    let newestMs = Number.isNaN(priorMs) ? -Infinity : priorMs;
    let cursor: string | null = null;
    let landed = 0;
    const seenCursors = new Set<string>();
    let pages = 0;

    do {
      const page = await listNotes(apiKey, { createdAfter, cursor });
      const listed = Array.isArray(page.notes) ? page.notes : [];
      const details: GranolaNoteDetail[] = [];
      for (const item of listed) {
        const id = str(item.id);
        if (!id) continue;
        // Sequential fetch keeps us well under the 5 req/s sustained rate limit at the low
        // meeting-note volumes this connector sees; a huge initial backfill is slow but
        // correct. getNote NEVER requests the transcript.
        const detail = await getNote(apiKey, id);
        if (!detail) continue;
        details.push(detail);
        const created = str(detail.created_at) ?? str(item.created_at);
        const ms = created ? Date.parse(created) : NaN;
        if (!Number.isNaN(ms) && ms > newestMs) newestMs = ms;
      }
      const records = this.normalize({ notes: details }, source);
      const result = await landRecords(engine, source.id, this, records);
      landed += result.written;

      // Pagination safety: bound total pages AND break on a repeated cursor. The notes on
      // each page are already landed (idempotently), so breaking loses no work — it just
      // stops a runaway cursor from looping forever and hammering the API.
      pages += 1;
      const next = page.hasMore && page.cursor ? page.cursor : null;
      if (next && (seenCursors.has(next) || pages >= MAX_BACKFILL_PAGES)) {
        console.warn(
          `granola backfill: stopping pagination early (source=${source.id} pages=${pages} ` +
            `repeatedCursor=${seenCursors.has(next)}) — possible API cursor loop`,
        );
        cursor = null;
      } else {
        if (next) seenCursors.add(next);
        cursor = next;
      }
    } while (cursor);

    if (Number.isFinite(newestMs)) {
      await writeWatermark(engine, source, new Date(newestMs).toISOString());
    }
    return landed;
  },
};

// ── Granola API: List Notes + Get Note ────────────────────────────────────────────

/** One page of List Notes. `createdAfter` filters by creation time; `cursor` paginates. */
export async function listNotes(
  apiKey: string,
  opts: { createdAfter?: string | null; cursor?: string | null } = {},
): Promise<GranolaNotesListPage> {
  const params = new URLSearchParams({ limit: String(LIST_PAGE_SIZE) });
  if (opts.createdAfter) params.set('created_after', opts.createdAfter);
  if (opts.cursor) params.set('cursor', opts.cursor);
  const url = `${GRANOLA_API_BASE}/notes?${params.toString()}`;
  const res = await fetch(url, {
    method: 'GET',
    headers: { authorization: `Bearer ${apiKey}` },
  });
  if (!res.ok) {
    throw new Error(`granola list notes ${res.status}: ${await safeText(res)}`);
  }
  return (await res.json()) as GranolaNotesListPage;
}

/**
 * Fetch a single note's detail — SUMMARY + metadata only. NEVER sets include=transcript,
 * and the GranolaNoteDetail type has no transcript field, so a transcript can never be
 * referenced. Returns null on a 404 (note no longer summarized/accessible) so the backfill
 * skips it rather than aborting the whole page.
 */
export async function getNote(apiKey: string, id: string): Promise<GranolaNoteDetail | null> {
  const url = `${GRANOLA_API_BASE}/notes/${encodeURIComponent(id)}`;
  const res = await fetch(url, {
    method: 'GET',
    headers: { authorization: `Bearer ${apiKey}` },
  });
  if (res.status === 404) return null;
  if (!res.ok) {
    throw new Error(`granola get note ${res.status}: ${await safeText(res)}`);
  }
  return (await res.json()) as GranolaNoteDetail;
}

// ── Per-source config (sources.config.connectors.granola.*) ──────────────────────

function safeParseConfig(s: string): Record<string, unknown> | null {
  try {
    return JSON.parse(s) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function granolaConfig(source: ConnectorSource): Record<string, unknown> | null {
  const raw = typeof source.config === 'string' ? safeParseConfig(source.config) : source.config;
  const connectors = asRecord(raw?.connectors);
  return asRecord(connectors?.[PROVIDER]);
}

/** The static API key: per-source config wins, env GRANOLA_API_KEY is the global fallback.
 *  Returns null if neither is set (backfill throws a clear error). Never logged. */
export function readApiKey(source: ConnectorSource): string | null {
  return str(granolaConfig(source)?.api_key) ?? (process.env[API_KEY_ENV] || null);
}

/** The persisted watermark (newest note created_at seen), or null on first run. */
export function readWatermark(source: ConnectorSource): string | null {
  return str(granolaConfig(source)?.watermark) ?? null;
}

/** The lookback in ms (config.connectors.granola.lookback_hours, default 48h). */
function readLookbackMs(source: ConnectorSource): number {
  const raw = granolaConfig(source)?.lookback_hours;
  const hours = typeof raw === 'number' && Number.isFinite(raw) && raw >= 0 ? raw : null;
  return hours != null ? hours * 60 * 60 * 1000 : DEFAULT_LOOKBACK_MS;
}

/**
 * The `created_after` value to QUERY with: watermark minus lookback, so late-summarized
 * notes in the trailing window are re-listed (idempotency dedupes). null on first run
 * (full backfill of all summarized notes).
 */
export function readQueryWatermark(source: ConnectorSource): string | null {
  const watermark = readWatermark(source);
  if (!watermark) return null;
  const t = Date.parse(watermark);
  if (Number.isNaN(t)) return null;
  return new Date(t - readLookbackMs(source)).toISOString();
}

/**
 * Persist ONLY the watermark via a surgical jsonb_set, leaving sibling config keys intact
 * (lost-update-safe, same pattern as calendar's writeSyncToken). The parent objects
 * connectors.granola must exist (the enable flow creates them before a poll runs); a
 * COALESCE guarantees the path is created if absent.
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
              '{connectors,granola,watermark}',
              to_jsonb($1::text),
              true)
      WHERE id = $2`,
    [watermark, source.id],
  );
}

// ── Registration (side-effecting at module load) ─────────────────────────────────

registerConnector(granolaConnector);
