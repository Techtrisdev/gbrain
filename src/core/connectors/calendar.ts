/**
 * calendar.ts — the Google Calendar SaaSConnector (TECH-2040).
 *
 * Turns Google Calendar events into table-only `connector_candidates` rows via the
 * framework's landRecords redaction choke point — NEVER pages, never a promotion.
 * Candidates are METADATA-ONLY: an event's free-form `description`/notes are STRIPPED
 * before anything is written (AC3). The `calendar` redaction profile keeps only
 * structural metadata (event_id / organizer / start / end / status / attendee_count /
 * url) and a short structural summary line; the description rides as `item.body`, which
 * minimize() ALWAYS drops. So a private meeting note never reaches a candidate column.
 *
 * ── Inbound trigger: a DEDICATED /webhooks/calendar route, NOT the generic receiver ──
 *
 * Google Calendar push notifications (events.watch channels) are STRUCTURALLY UNLIKE
 * every HMAC-signed webhook the generic /webhooks/:provider receiver handles:
 *
 *   - The POST body is EMPTY. There is no JSON payload, so `accountFromPayload` (which
 *     the generic receiver calls to resolve the source) has nothing to read.
 *   - The channel is identified by HEADERS: X-Goog-Channel-ID, X-Goog-Channel-Token,
 *     X-Goog-Resource-State, X-Goog-Resource-ID.
 *   - There is NO HMAC. Google authenticates the delivery with a per-channel TOKEN
 *     (the `token` we passed to events.watch), echoed back verbatim in
 *     X-Goog-Channel-Token. We constant-time-compare it to the per-source secret.
 *
 * SECURITY TRADEOFF (documented per AC2): the channel-token scheme is WEAKER than
 * GitHub/Linear HMAC. HMAC binds the signature to the request BODY (a tamper changes
 * the digest); a channel token is a static bearer string with no body binding. Anyone
 * who learns the token can forge a "something changed" ping. The blast radius is bounded:
 * a forged ping only triggers an incremental events.list against the REAL Google API
 * using OUR OAuth token — an attacker cannot inject event data, only cause us to re-poll.
 * Still, the token must be a high-entropy secret, kept off any logging path, and rotated
 * if leaked. This is an inherent property of the Calendar push protocol, not a shortcut.
 *
 * The dedicated route (src/commands/serve-http.ts `/webhooks/calendar`) therefore:
 *   1. rate-limits (mirrors the github/connector limiters),
 *   2. reads X-Goog-Channel-ID + X-Goog-Channel-Token from headers,
 *   3. resolves the source by channel-id with a DB query (stored in
 *      config.connectors.calendar.channel_id when the watch was created),
 *   4. constant-time-compares the channel token to config.connectors.calendar.secret,
 *   5. on X-Goog-Resource-State: 'exists', runs incrementalSync (events.list with the
 *      stored syncToken; a 410 Gone drops the syncToken and does a full resync),
 *   6. normalizes each event to a metadata-only candidate via landRecords.
 *
 * AUTH ORDERING (no pre-DB-auth gate — do not claim one): unlike a body-HMAC scheme, the
 * channel token authenticates a CHANNEL, not a request body, and the channel is resolved
 * by the channel-id header. So the source-lookup DB query (step 3) + config parse run
 * BEFORE the constant-time token compare (step 4). An unauthenticated probe therefore
 * DOES touch the DB (one indexed lookup), exactly as the /webhooks/github precedent does;
 * the rate limiter is the probe-traffic backstop. This is inherent to header-routed push.
 *
 * The connector still implements the full SaaSConnector shape — verifyWebhook (channel
 * token compare, reused by the dedicated route), normalize/toCandidate (event → metadata
 * candidate), backfill (initial events.list), and onConnect (events.watch channel
 * creation + channel-id/secret persistence — the wiring that makes the inbound push live
 * end-to-end) — so the OAuth flow and the periodic poll job work through the same
 * primitives. Only the INBOUND trigger differs.
 *
 * OAuth (AC2): Google OAuth with scope `calendar.readonly`, registered with the custody
 * module (TECH-2033) at module load. getValidAccessToken returns a BARE token; this
 * module prepends `Bearer `. After the OAuth /callback persists the grant via storeToken,
 * it invokes calendar.onConnect, which creates the events.watch push channel and writes
 * its channel-id + a freshly-generated high-entropy channel token (the per-source push
 * secret) into the source config — the row the dedicated route's channel-id lookup
 * matches. Without this hook nothing would write channel_id/secret and the route's
 * `WHERE …channel_id=$1` lookup could never match (the push path would be dead in prod).
 */

import { randomBytes } from 'node:crypto';

import {
  registerConnector,
  type SaaSConnector,
  type NormalizedRecord,
  type ConnectorSource,
} from './base.ts';
import type { ConnectorCandidateItem } from './candidate.ts';
import type { BrainEngine } from '../engine.ts';
import {
  getValidAccessToken,
  registerOAuthProvider,
  safeStateEqual,
  withInProcessLock,
  type StoredToken,
} from './credentials.ts';

// ── Google Calendar payload shapes (the subset we read) ──────────────────────────

/** A single Google Calendar event resource (the subset we keep). */
export interface CalendarEvent {
  id?: string;
  status?: string; // confirmed | tentative | cancelled
  htmlLink?: string;
  summary?: string; // event TITLE (structural; kept, stripped) — NOT the description
  description?: string; // free-form notes — ALWAYS DROPPED (metadata-only candidate)
  organizer?: { email?: string; displayName?: string; self?: boolean };
  start?: { dateTime?: string; date?: string };
  end?: { dateTime?: string; date?: string };
  attendees?: unknown[];
  updated?: string; // RFC3339 last-modified — the take/dedupe stamp
}

/** An events.list response page. */
export interface CalendarEventsListPage {
  items?: CalendarEvent[];
  nextPageToken?: string;
  nextSyncToken?: string;
}

// ── Constants ───────────────────────────────────────────────────────────────────

const PROVIDER = 'calendar';
/**
 * The header Google echoes the per-channel token in. Lowercase — Node lowercases all
 * header keys. Used as the SaaSConnector.signatureHeader so the generic receiver's
 * presence short-circuit still has a header to gate on, AND read by the dedicated route.
 */
export const CHANNEL_TOKEN_HEADER = 'x-goog-channel-token';
/** The header carrying the channel id (resolves the source on the dedicated route). */
export const CHANNEL_ID_HEADER = 'x-goog-channel-id';
/** The header carrying the resource-state (sync | exists | not_exists). */
export const RESOURCE_STATE_HEADER = 'x-goog-resource-state';

/** Google OAuth + Calendar API endpoints. Read-only calendar scope (AC2). */
const GOOGLE_OAUTH_AUTHORIZE_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_OAUTH_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const CALENDAR_API_BASE = 'https://www.googleapis.com/calendar/v3';
const CALENDAR_SCOPE = 'https://www.googleapis.com/auth/calendar.readonly';
/** Google access tokens are ~1h; used when the token response omits expires_in. */
const GOOGLE_TOKEN_TTL_MS = 60 * 60 * 1000;
const LIST_PAGE_SIZE = 250;
/** A kept title/name is a structural LABEL, not free content — cap it (mirrors linear). */
const MAX_TITLE_LEN = 200;
/**
 * The public base URL the events.watch push channel posts back to. Google requires an
 * HTTPS, publicly-reachable, domain-verified address, so this MUST be the brain's public
 * URL (env GBRAIN_PUBLIC_URL). onConnect refuses to create a watch if it is unset or not
 * https — a watch pointed at localhost would silently never deliver.
 */
const PUBLIC_URL_ENV = 'GBRAIN_PUBLIC_URL';
/** The dedicated push receiver path (must match the route in serve-http.ts). */
const CALENDAR_WEBHOOK_PATH = '/webhooks/calendar';

// ── OAuth provider registration (scope calendar.readonly, refresh-token grant) ───

/** Map a Google OAuth token response onto the custody StoredToken shape. */
function tokenFromOAuthResponse(json: Record<string, unknown>): StoredToken {
  const accessToken = typeof json.access_token === 'string' ? json.access_token : '';
  const refreshToken = typeof json.refresh_token === 'string' ? json.refresh_token : undefined;
  const expiresInSec = typeof json.expires_in === 'number' ? json.expires_in : GOOGLE_TOKEN_TTL_MS / 1000;
  const scope = typeof json.scope === 'string' ? json.scope : CALENDAR_SCOPE;
  return {
    accessToken,
    refreshToken,
    expiresAt: new Date(Date.now() + expiresInSec * 1000),
    scope,
    // account is set by exchangeCode (userinfo/calendar id) on first connect; on refresh
    // it is left empty and the custody layer merge-preserves the existing account.
    account: '',
  };
}

/** POST an x-www-form-urlencoded body to Google's token endpoint. */
async function postTokenForm(body: Record<string, string>): Promise<StoredToken> {
  const res = await fetch(GOOGLE_OAUTH_TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body).toString(),
  });
  if (!res.ok) {
    throw new Error(`google oauth token endpoint ${res.status}: ${await safeText(res)}`);
  }
  return tokenFromOAuthResponse((await res.json()) as Record<string, unknown>);
}

/**
 * Register Google's OAuth config with the custody module. Side-effecting at module load
 * (mirrors registerConnector). The client id/secret come from the environment.
 */
export function registerCalendarOAuth(): void {
  registerOAuthProvider(PROVIDER, {
    authorizeUrl: (state, redirectUri) => {
      const params = new URLSearchParams({
        client_id: process.env.GOOGLE_CLIENT_ID ?? '',
        redirect_uri: redirectUri,
        response_type: 'code',
        scope: CALENDAR_SCOPE,
        state,
        // offline + consent so Google returns a refresh_token (it omits it on a
        // re-consent unless prompt=consent is forced).
        access_type: 'offline',
        prompt: 'consent',
      });
      return `${GOOGLE_OAUTH_AUTHORIZE_URL}?${params.toString()}`;
    },
    exchangeCode: async (code, redirectUri) => {
      const token = await postTokenForm({
        grant_type: 'authorization_code',
        code,
        redirect_uri: redirectUri,
        client_id: process.env.GOOGLE_CLIENT_ID ?? '',
        client_secret: process.env.GOOGLE_CLIENT_SECRET ?? '',
      });
      // First connect: resolve the primary calendar id (the account attribute).
      return { ...token, account: await primaryCalendarId(token.accessToken) };
    },
    refresh: (refreshToken) =>
      // Google's refresh grant does NOT re-issue a refresh_token; the custody layer
      // merge-preserves the prior one (getValidAccessToken merges refreshToken).
      postTokenForm({
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        client_id: process.env.GOOGLE_CLIENT_ID ?? '',
        client_secret: process.env.GOOGLE_CLIENT_SECRET ?? '',
      }),
  });
}

/** Resolve the primary calendar id for the connected token — stored as the account
 *  attribute. Best-effort: returns 'primary' on any failure (account is informational;
 *  getValidAccessToken keys on source_id+provider, not account). */
async function primaryCalendarId(accessToken: string): Promise<string> {
  try {
    const res = await fetch(`${CALENDAR_API_BASE}/calendars/primary`, {
      headers: { authorization: `Bearer ${accessToken}` },
    });
    if (!res.ok) return 'primary';
    const json = (await res.json()) as { id?: string };
    return typeof json.id === 'string' ? json.id : 'primary';
  } catch {
    return 'primary';
  }
}

async function safeText(res: Response): Promise<string> {
  try {
    return (await res.text()).slice(0, 256);
  } catch {
    return '(unreadable body)';
  }
}

// ── Helpers: payload field access (defensive against unknown) ────────────────────

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

/** A short structural summary line for a calendar event — title + time, NEVER the
 *  description. Titleless (no summary field) → a structural "Event <id>" label. The
 *  title is a structural label (capped); strip() in the landing path masks any
 *  regex-detectable PII/secret that rides in it. */
function summaryForEvent(ev: CalendarEvent): string {
  const rawTitle = str(ev.summary);
  const title = rawTitle ? rawTitle.slice(0, MAX_TITLE_LEN) : undefined;
  const start = str(ev.start?.dateTime) ?? str(ev.start?.date);
  const id = str(ev.id) ?? 'event';
  if (title && start) return `${title} @ ${start}`;
  if (title) return title;
  return `Event ${id}`;
}

/** The metadata we keep — only structural fields the `calendar` profile allowlists.
 *  attendee_count is a NUMBER (never the attendee list). */
function metadataForEvent(ev: CalendarEvent): Record<string, unknown> {
  const md: Record<string, unknown> = {};
  if (ev.id) md.event_id = ev.id;
  // organizer: use the EMAIL only, never the displayName. A real person's NAME is
  // outside redact's v1 regex boundary, so a displayName would survive into the
  // candidate verbatim (review finding 4). An email, by contrast, IS scrubbed to
  // [REDACTED] by strip() in the landing path — so emitting the email keeps a structural
  // anchor while guaranteeing the personal identifier is masked, not leaked.
  const organizer = ev.organizer?.email;
  if (organizer) md.organizer = organizer;
  const start = str(ev.start?.dateTime) ?? str(ev.start?.date);
  if (start) md.start = start;
  const end = str(ev.end?.dateTime) ?? str(ev.end?.date);
  if (end) md.end = end;
  if (ev.status) md.status = ev.status;
  if (Array.isArray(ev.attendees)) md.attendee_count = ev.attendees.length;
  if (ev.htmlLink) md.url = ev.htmlLink;
  return md;
}

// ── The connector ────────────────────────────────────────────────────────────────

export const calendarConnector: SaaSConnector = {
  provider: PROVIDER,
  signatureHeader: CHANNEL_TOKEN_HEADER,

  /**
   * AC2: Google Calendar push has NO HMAC. Authentication is a per-channel TOKEN echoed
   * in X-Goog-Channel-Token, constant-time-compared to the per-source secret. The
   * `rawBody` argument is IGNORED — the push body is empty and carries no signing
   * material. This is the documented weaker-than-HMAC scheme (see module header).
   *
   * Fail-closed: a missing/empty/mismatched token → false.
   */
  verifyWebhook(_rawBody, headers, secret): boolean {
    const token = headers[CHANNEL_TOKEN_HEADER];
    if (!token || !secret) return false;
    // Constant-time UTF-8 compare (reuses the custody primitive). safeStateEqual
    // returns false on length mismatch / empty, so a malformed token fails closed.
    return safeStateEqual(token, secret);
  },

  /**
   * The push body is EMPTY and header-authenticated, so there is no payload account to
   * read. The dedicated /webhooks/calendar route resolves the source by channel-id
   * header instead. Returning null here means the GENERIC /webhooks/:provider receiver
   * would 400 'missing_account' for calendar — which is correct: calendar must NOT use
   * the generic receiver. accountFromPayload remains for the SaaSConnector contract and
   * for any future payload-bearing path; on the dedicated route it is never consulted.
   */
  accountFromPayload(): string | null {
    return null;
  },

  /**
   * AC3/AC4: normalize Calendar events into METADATA-ONLY candidates. Accepts either a
   * single event or an events.list page ({ items: [...] }). The free-form `description`
   * rides as `item.body`, which minimize() ALWAYS drops — so notes never reach a column.
   * A cancelled event still lands (status='cancelled' metadata records the deletion).
   */
  normalize(payload): NormalizedRecord[] {
    const p = asRecord(payload);
    if (!p) return [];
    // Accept an events.list page or a single event.
    const events: CalendarEvent[] = Array.isArray(p.items)
      ? (p.items as CalendarEvent[])
      : [p as CalendarEvent];

    const records: NormalizedRecord[] = [];
    for (const ev of events) {
      const id = str(ev.id);
      if (!id) continue;
      records.push({
        sourceRecordId: id,
        profile: PROVIDER, // the `calendar` redaction profile
        item: {
          sourceRecordId: id,
          summary: summaryForEvent(ev),
          metadata: metadataForEvent(ev),
          // body is carried ONLY so minimize() records the `body:dropped` trail; it is
          // ALWAYS dropped and never reaches a candidate column (AC3 metadata-only).
          body: str(ev.description),
        },
        proposedSlug: `calendar-event-${id}`,
      });
    }
    return records;
  },

  /**
   * Map a (already-minimized) record to a candidate. version omitted → defaults to '1'
   * (deterministic idempotency key (source, source_record_id, 1)). The body was already
   * dropped by minimize; proposed_markdown is the redacted structural summary.
   */
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
   * AC2: outbound backfill / initial sync. A full events.list (no syncToken) that pages
   * via nextPageToken, landing each page through landRecords. Persists the terminal
   * nextSyncToken under sources.config.connectors.calendar.sync_token so the next
   * incremental sync (triggered by a push ping) resumes from it.
   */
  async backfill(engine: BrainEngine, source: ConnectorSource): Promise<number> {
    const { landRecords } = await import('./base.ts');
    const token = await getValidAccessToken(engine, source.id, PROVIDER);
    const calendarId = readCalendarId(source);

    let pageToken: string | null = null;
    let landed = 0;
    let syncToken: string | null = null;

    do {
      const page = await listEvents(token, calendarId, { pageToken });
      const records = this.normalize(page, source);
      const result = await landRecords(engine, source.id, this, records);
      landed += result.written;
      pageToken = page.nextPageToken ?? null;
      // The sync token only appears on the LAST page of a full list.
      if (page.nextSyncToken) syncToken = page.nextSyncToken;
    } while (pageToken);

    if (syncToken) await writeSyncToken(engine, source, syncToken);
    return landed;
  },

  /**
   * TECH-2040 review fix (finding 1): make the inbound push live END-TO-END. The OAuth
   * /callback invokes this AFTER storeToken persists the grant. Nothing else writes
   * channel_id/secret, so without this the route's `WHERE …channel_id=$1` lookup could
   * never match and the push path would be dead in prod.
   *
   * Steps:
   *   1. mint a FRESH high-entropy channel id + channel token (32 random bytes hex each).
   *      The token is the per-source push secret — the ONLY thing authenticating inbound
   *      deliveries (weaker than HMAC; see module header). A fresh value per connect means
   *      a reconnect rotates it.
   *   2. events.watch the calendar, pointing the channel at <GBRAIN_PUBLIC_URL>/webhooks/
   *      calendar with that token. Google requires https + a domain-verified public host;
   *      we refuse (throw) on a missing/non-https public URL so a misconfig surfaces as a
   *      502 at /callback rather than a silently-dead push.
   *   3. persist channel_id + secret (+ resource_id/expiration for later channel renewal)
   *      into config.connectors.calendar via a surgical jsonb_set, leaving sibling keys
   *      (enabled/account/sync_token) intact.
   *
   * Fail-loud: any error propagates to the /callback, which returns 502. The grant is
   * already stored, so an operator can retry the watch without re-authing.
   */
  async onConnect(engine: BrainEngine, sourceId: string, account: string): Promise<void> {
    const publicUrl = (process.env[PUBLIC_URL_ENV] ?? '').trim().replace(/\/+$/, '');
    if (!publicUrl || !/^https:\/\//i.test(publicUrl)) {
      throw new Error(
        `calendar onConnect: ${PUBLIC_URL_ENV} must be an https public URL to receive Google ` +
          `Calendar push (events.watch rejects non-https / non-public addresses)`,
      );
    }
    const token = await getValidAccessToken(engine, sourceId, PROVIDER);
    const calendarId = account || 'primary';
    const channelId = randomBytes(32).toString('hex');
    const channelToken = randomBytes(32).toString('hex');
    const address = `${publicUrl}${CALENDAR_WEBHOOK_PATH}`;

    const watch = await watchEvents(token, calendarId, { channelId, channelToken, address });
    await writeWatchChannel(engine, sourceId, {
      channelId,
      channelToken,
      resourceId: watch.resourceId,
      expiration: watch.expiration,
    });
  },
};

// ── Incremental sync (driven by the dedicated /webhooks/calendar route) ──────────

/**
 * AC2: incremental sync triggered by a push ping. Lists events changed since the stored
 * syncToken, landing each as a metadata-only candidate. A 410 Gone means the syncToken
 * expired (Google's documented signal): we DROP the stored syncToken and do a FULL
 * resync (backfill) to re-establish a fresh token. Returns the number of candidates
 * landed. Exposed (not a connector method) because the dedicated route calls it directly.
 *
 * SERIALIZATION (review finding 2): the read-list-write of the syncToken cursor runs
 * under the SAME per-(source,provider) in-process single-flight mutex `getValidAccessToken`
 * uses (`withInProcessLock`). Without it, two concurrent Google pushes for one source
 * could interleave their read→list→write and REGRESS the cursor — silently dropping a
 * change Google later expires (ON CONFLICT heals duplicate writes but NOT a cursor that
 * moves backwards). The mutex makes each source's cursor advance strictly sequential.
 * (Single-instance assumption — see the withInProcessLock note in credentials.ts.)
 */
export async function incrementalSync(engine: BrainEngine, source: ConnectorSource): Promise<number> {
  return withInProcessLock(source.id, PROVIDER, () => incrementalSyncLocked(engine, source));
}

/** The read-list-write body, run under the single-flight mutex by incrementalSync. */
async function incrementalSyncLocked(engine: BrainEngine, source: ConnectorSource): Promise<number> {
  const { landRecords } = await import('./base.ts');
  const token = await getValidAccessToken(engine, source.id, PROVIDER);
  const calendarId = readCalendarId(source);
  const syncToken = readSyncToken(source);

  // No stored syncToken (first push before any backfill) → full resync.
  if (!syncToken) {
    return calendarConnector.backfill!(engine, source);
  }

  let pageToken: string | null = null;
  let landed = 0;
  let nextSyncToken: string | null = null;

  do {
    let page: CalendarEventsListPage;
    try {
      page = await listEvents(token, calendarId, { syncToken, pageToken });
    } catch (err) {
      // 410 Gone: the syncToken is stale. Drop it and full-resync (Google's contract).
      if (err instanceof CalendarGoneError) {
        await clearSyncToken(engine, source);
        return calendarConnector.backfill!(engine, { ...source, config: dropSyncTokenInSnapshot(source) });
      }
      throw err;
    }
    const records = calendarConnector.normalize(page, source);
    const result = await landRecords(engine, source.id, calendarConnector, records);
    landed += result.written;
    pageToken = page.nextPageToken ?? null;
    if (page.nextSyncToken) nextSyncToken = page.nextSyncToken;
  } while (pageToken);

  if (nextSyncToken) await writeSyncToken(engine, source, nextSyncToken);
  return landed;
}

// ── Calendar API: events.list (incremental + full) ───────────────────────────────

/** Thrown when events.list returns 410 Gone (stale syncToken → full resync). */
export class CalendarGoneError extends Error {
  constructor() {
    super('calendar events.list returned 410 Gone (syncToken expired)');
    this.name = 'CalendarGoneError';
  }
}

/**
 * Fetch one page of events. With `syncToken` it is an incremental list (only changes
 * since the token); without it, a full list. `token` is a BARE access token; this
 * function prepends `Bearer `. A 410 throws CalendarGoneError so the caller can
 * full-resync. Pure HTTP via fetch (mockable in tests).
 */
export async function listEvents(
  token: string,
  calendarId: string,
  opts: { syncToken?: string | null; pageToken?: string | null } = {},
): Promise<CalendarEventsListPage> {
  const params = new URLSearchParams({ maxResults: String(LIST_PAGE_SIZE), showDeleted: 'true' });
  if (opts.syncToken) params.set('syncToken', opts.syncToken);
  if (opts.pageToken) params.set('pageToken', opts.pageToken);
  // singleEvents=true expands recurring events; only valid on a FULL list (Google
  // rejects it alongside syncToken), so set it only when not doing an incremental sync.
  if (!opts.syncToken) params.set('singleEvents', 'true');

  const url = `${CALENDAR_API_BASE}/calendars/${encodeURIComponent(calendarId)}/events?${params.toString()}`;
  const res = await fetch(url, {
    method: 'GET',
    // Contract: getValidAccessToken returns a BARE token; the connector adds `Bearer `.
    headers: { authorization: `Bearer ${token}` },
  });
  if (res.status === 410) {
    throw new CalendarGoneError();
  }
  if (!res.ok) {
    throw new Error(`calendar events.list ${res.status}: ${await safeText(res)}`);
  }
  return (await res.json()) as CalendarEventsListPage;
}

/**
 * Create (or refresh) a Calendar push channel via events.watch. Returns the channel's
 * resourceId/expiration. The caller persists channelId + the per-channel token (the
 * push secret) under config.connectors.calendar so the dedicated route can resolve +
 * authenticate later deliveries. `token` is a BARE access token. Provided for the
 * connect flow; the per-channel `channelToken` MUST be a high-entropy secret (it is the
 * only thing authenticating inbound pushes — weaker than HMAC, see module header).
 */
export async function watchEvents(
  token: string,
  calendarId: string,
  opts: { channelId: string; channelToken: string; address: string },
): Promise<{ resourceId?: string; expiration?: string }> {
  const url = `${CALENDAR_API_BASE}/calendars/${encodeURIComponent(calendarId)}/events/watch`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      id: opts.channelId,
      type: 'web_hook',
      address: opts.address,
      token: opts.channelToken,
    }),
  });
  if (!res.ok) {
    throw new Error(`calendar events.watch ${res.status}: ${await safeText(res)}`);
  }
  const json = (await res.json()) as { resourceId?: string; expiration?: string };
  return { resourceId: json.resourceId, expiration: json.expiration };
}

// ── Per-source config (sources.config.connectors.calendar.*) ─────────────────────

function safeParseConfig(s: string): Record<string, unknown> | null {
  try {
    return JSON.parse(s) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function calendarConfig(source: ConnectorSource): Record<string, unknown> | null {
  const raw = typeof source.config === 'string' ? safeParseConfig(source.config) : source.config;
  const connectors = asRecord(raw?.connectors);
  return asRecord(connectors?.[PROVIDER]);
}

/** The calendar id to list (the connected account), defaulting to 'primary'. */
export function readCalendarId(source: ConnectorSource): string {
  return str(calendarConfig(source)?.account) ?? 'primary';
}

/** Read the persisted incremental-sync token, or null on first run. */
export function readSyncToken(source: ConnectorSource): string | null {
  return str(calendarConfig(source)?.sync_token) ?? null;
}

/**
 * Persist ONLY the syncToken via a surgical jsonb_set against the CURRENT row, leaving
 * every sibling config key intact — same lost-update-safe pattern as Linear's watermark
 * write. (The parent objects connectors.calendar must exist; the connect/enable flow
 * always creates them before a sync can run.)
 */
export async function writeSyncToken(
  engine: BrainEngine,
  source: ConnectorSource,
  syncToken: string,
): Promise<void> {
  await engine.executeRaw(
    `UPDATE sources
        SET config = jsonb_set(config, '{connectors,calendar,sync_token}', to_jsonb($1::text), true)
      WHERE id = $2`,
    [syncToken, source.id],
  );
}

/**
 * Persist the events.watch channel binding (review finding 1). Merges channel_id +
 * secret (+ resource_id/expiration) INTO config.connectors.calendar with the jsonb `||`
 * concat operator, which is a shallow merge that PRESERVES existing keys (enabled,
 * account, sync_token) and overwrites only the channel fields — so a reconnect rotates
 * the channel without clobbering siblings. `jsonb_set(..., true)` first guarantees the
 * connectors.calendar object exists before the merge (coalescing a null/absent path to
 * '{}'), then `||` writes the channel fields onto it.
 *
 * NOTE: secret is written server-side here and never logged. It IS a high-entropy random
 * value (randomBytes(32) hex), so it is not PII/secret-shaped that strip() would mask —
 * and it must round-trip verbatim (the route constant-time-compares it), so it is stored
 * raw in config exactly like the github webhook_secret.
 */
export async function writeWatchChannel(
  engine: BrainEngine,
  sourceId: string,
  channel: { channelId: string; channelToken: string; resourceId?: string; expiration?: string },
): Promise<void> {
  const patch: Record<string, unknown> = {
    channel_id: channel.channelId,
    secret: channel.channelToken,
  };
  if (channel.resourceId) patch.resource_id = channel.resourceId;
  if (channel.expiration) patch.channel_expiration = channel.expiration;
  await engine.executeRaw(
    `UPDATE sources
        SET config = jsonb_set(
              COALESCE(config, '{}'::jsonb),
              '{connectors,calendar}',
              COALESCE(config->'connectors'->'calendar', '{}'::jsonb) || $1::jsonb,
              true)
      WHERE id = $2`,
    [JSON.stringify(patch), sourceId],
  );
}

/** Drop the stored syncToken (a 410 invalidated it) so the next run starts a full sync. */
export async function clearSyncToken(engine: BrainEngine, source: ConnectorSource): Promise<void> {
  await engine.executeRaw(
    `UPDATE sources
        SET config = config #- '{connectors,calendar,sync_token}'
      WHERE id = $1`,
    [source.id],
  );
}

/** Return a config snapshot with the syncToken removed (for the in-memory full-resync
 *  pass after a 410, so backfill doesn't re-read the now-cleared token). */
function dropSyncTokenInSnapshot(source: ConnectorSource): Record<string, unknown> {
  const raw = typeof source.config === 'string' ? safeParseConfig(source.config) : source.config;
  const cloned = JSON.parse(JSON.stringify(raw ?? {})) as Record<string, unknown>;
  const connectors = asRecord(cloned.connectors);
  const cal = asRecord(connectors?.[PROVIDER]);
  if (cal) delete cal.sync_token;
  return cloned;
}

// ── Registration (side-effecting at module load) ─────────────────────────────────

registerConnector(calendarConnector);
registerCalendarOAuth();
