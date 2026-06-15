/**
 * slack.ts — the Slack SaaSConnector (TECH-2039).
 *
 * The second real connector, modelled on linear.ts. It turns Slack Events API
 * deliveries (a `message` posted to a SELECTED public channel) into table-only
 * connector_candidates rows via the framework's landRecords redaction choke point —
 * NEVER pages, never a promotion. Slack message text is comms-class free prose, so it
 * is NEVER carried verbatim: the raw `text` is dropped to the body field (minimize's
 * `body:dropped` trail) and the candidate's summary is a short, field-minimized
 * structural line under the `comms` profile (NO raw bodies).
 *
 * Webhook auth (AC3): Slack signs the raw body with its per-app SIGNING SECRET and sends
 * `X-Slack-Signature` = `v0=` + HMAC-SHA256(signing_secret, `v0:{ts}:{rawBody}`), with the
 * unix-seconds timestamp in the `X-Slack-Request-Timestamp` header. verifyWebhook enforces
 * BOTH a constant-time HMAC compare (reusing hmacSha256Verify, after stripping the `v0=`
 * prefix and rebuilding the `v0:ts:body` base string ourselves) AND a ±300s timestamp
 * window, so a replayed-but-validly-signed delivery outside the window is rejected. Unlike
 * Linear, the anti-replay timestamp rides in a HEADER (seconds), not the JSON body.
 *
 * Channel opt-in (AC4): a `message` is normalized ONLY when its channel id is in the
 * per-source opt-in list at sources.config.connectors.slack.channels[]. DM events
 * (channel_type `im`/`mpim`) are ALWAYS ignored — no DM scopes are ever requested.
 *
 * OAuth + backfill (AC2): granular bot scopes `channels:read`, `channels:history` on
 * opt-in public channels only (NO DM scopes), via Slack OAuth v2 (`oauth.v2.access`),
 * registered with the custody module (TECH-2033) at module load. backfill() pages
 * `conversations.history` with a cursor per opt-in channel, persisting the watermark
 * under sources.config.connectors.slack.backfill_cursor (newest message `ts` seen) so a
 * resumed run yields no duplicates (and landRecords' ON CONFLICT makes a re-fetch a safe
 * no-op).
 *
 * Tests mock getValidAccessToken + the Slack Web API (recorded fixtures) — no real
 * custody module or network required.
 */

import {
  hmacSha256Verify,
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
  type StoredToken,
} from './credentials.ts';

// ── Slack payload shapes (the subset we read) ───────────────────────────────────

/** A Slack Events API delivery envelope (`event_callback` type). */
export interface SlackEventEnvelope {
  /** Envelope type: `event_callback` | `url_verification` | … */
  type?: string;
  /** Workspace/team id — the account anchor. */
  team_id?: string;
  /** API app id (informational). */
  api_app_id?: string;
  /** The inner event (a message, etc.). */
  event?: SlackMessageEvent;
  /** Delivery id (NOT used for idempotency — non-deterministic). */
  event_id?: string;
  /** Delivery time (epoch seconds; NOT the signing timestamp). */
  event_time?: number;
}

/** The inner `message` event (the subset we read). */
export interface SlackMessageEvent {
  /** Event type: `message`. */
  type?: string;
  /** Message subtype (e.g. `message_changed`, `bot_message`) — undefined for a plain post. */
  subtype?: string;
  /** Channel id the message was posted to. */
  channel?: string;
  /** Channel class: `channel` (public) | `group` (private) | `im` (DM) | `mpim` (group DM). */
  channel_type?: string;
  /** Author user id. */
  user?: string;
  /** Bot id (set for bot posts). */
  bot_id?: string;
  /** Message text — comms free prose; ALWAYS dropped, never carried verbatim. */
  text?: string;
  /** Message timestamp ("1700000000.000100") — the per-channel idempotency anchor. */
  ts?: string;
  /** Parent thread ts when this is a threaded reply. */
  thread_ts?: string;
}

// ── Constants ───────────────────────────────────────────────────────────────────

const PROVIDER = 'slack';
const SIGNATURE_HEADER = 'x-slack-signature'; // lowercase — Node lowercases header keys
const TIMESTAMP_HEADER = 'x-slack-request-timestamp';
/** Slack's `v0` signature scheme version prefix. */
const SIGNATURE_VERSION = 'v0';
/** Anti-replay window for X-Slack-Request-Timestamp (AC3): 300 seconds. */
const TIMESTAMP_WINDOW_SECONDS = 300;
/** comms source class — drops bodies, allowlists channel/author/ts/permalink/etc. */
const PROFILE = 'comms';

/** Slack OAuth v2 + Web API endpoints. */
const SLACK_OAUTH_AUTHORIZE_URL = 'https://slack.com/oauth/v2/authorize';
const SLACK_OAUTH_ACCESS_URL = 'https://slack.com/api/oauth.v2.access';
const SLACK_CONVERSATIONS_HISTORY_URL = 'https://slack.com/api/conversations.history';
/**
 * Granular BOT scopes (AC2): read public-channel metadata + history on opt-in channels.
 * NO DM scopes (`im:*`, `mpim:*`) are EVER requested — DM ingestion is structurally off.
 */
const SLACK_OAUTH_SCOPES = ['channels:read', 'channels:history'] as const;
const BACKFILL_PAGE_SIZE = 100;

// ── OAuth provider registration (Slack OAuth v2, granular bot scopes) ────────────

/**
 * Map a Slack `oauth.v2.access` response onto the custody StoredToken shape. Slack
 * returns the BOT token under `access_token` with `token_type: "bot"`, the workspace
 * under `team.id`, and (for token rotation) optionally `refresh_token` + `expires_in`.
 * Workspaces without token rotation enabled get a non-expiring bot token (no
 * refresh_token / expires_in) — we leave expiresAt null so custody never tries to refresh.
 */
function tokenFromOAuthResponse(json: Record<string, unknown>): StoredToken {
  const accessToken = typeof json.access_token === 'string' ? json.access_token : '';
  const refreshToken = typeof json.refresh_token === 'string' ? json.refresh_token : undefined;
  const expiresInSec = typeof json.expires_in === 'number' ? json.expires_in : undefined;
  const scope = typeof json.scope === 'string' ? json.scope : SLACK_OAUTH_SCOPES.join(',');
  const team = asRecord(json.team);
  const account = str(team?.id) ?? '';
  return {
    accessToken,
    refreshToken,
    // Only set an expiry when Slack issued one (token-rotation workspaces). A non-rotating
    // bot token never expires → leave null so custody returns it without a refresh attempt.
    expiresAt: expiresInSec !== undefined ? new Date(Date.now() + expiresInSec * 1000) : null,
    scope,
    // account (team id) is set on connect (exchangeCode); on refresh Slack omits team, so
    // we return '' and the custody layer merge-preserves the existing workspace id.
    account,
  };
}

/** POST an x-www-form-urlencoded body to a Slack endpoint and assert `ok: true`. */
async function postSlackForm(url: string, body: Record<string, string>): Promise<Record<string, unknown>> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body).toString(),
  });
  if (!res.ok) {
    throw new Error(`slack ${url} ${res.status}: ${await safeText(res)}`);
  }
  const json = (await res.json()) as Record<string, unknown>;
  // Slack returns HTTP 200 with `{ ok: false, error: "..." }` on logical failure.
  if (json.ok !== true) {
    throw new Error(`slack ${url} error: ${str(json.error) ?? 'unknown'}`);
  }
  return json;
}

/**
 * Register Slack's OAuth v2 config with the custody module. Side-effecting at module load
 * (mirrors registerConnector). The client id/secret come from the environment.
 */
export function registerSlackOAuth(): void {
  registerOAuthProvider(PROVIDER, {
    authorizeUrl: (state, redirectUri) => {
      const params = new URLSearchParams({
        client_id: process.env.SLACK_CLIENT_ID ?? '',
        redirect_uri: redirectUri,
        // OAuth v2 puts BOT scopes on `scope` (NOT `user_scope`). No DM scopes here.
        scope: SLACK_OAUTH_SCOPES.join(','),
        state,
      });
      return `${SLACK_OAUTH_AUTHORIZE_URL}?${params.toString()}`;
    },
    exchangeCode: async (code, redirectUri) => {
      const json = await postSlackForm(SLACK_OAUTH_ACCESS_URL, {
        grant_type: 'authorization_code',
        code,
        redirect_uri: redirectUri,
        client_id: process.env.SLACK_CLIENT_ID ?? '',
        client_secret: process.env.SLACK_CLIENT_SECRET ?? '',
      });
      return tokenFromOAuthResponse(json);
    },
    refresh: async (refreshToken) => {
      // Token-rotation refresh (only reached for workspaces that issued a refresh_token).
      const json = await postSlackForm(SLACK_OAUTH_ACCESS_URL, {
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        client_id: process.env.SLACK_CLIENT_ID ?? '',
        client_secret: process.env.SLACK_CLIENT_SECRET ?? '',
      });
      return tokenFromOAuthResponse(json);
    },
  });
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

/** A DM/group-DM channel class — ALWAYS ignored (no DM scopes, never ingested). */
function isDmChannelType(channelType: string | undefined): boolean {
  return channelType === 'im' || channelType === 'mpim';
}

/**
 * Read the opt-in public-channel id list from sources.config.connectors.slack.channels[].
 * A channel must be EXPLICITLY listed to be ingested (fail-closed: an absent/empty list
 * ingests nothing). Tolerates a string-encoded config (the DB column is jsonb but some
 * engine paths return it stringified).
 */
export function readOptInChannels(source: ConnectorSource): string[] {
  const raw = typeof source.config === 'string' ? safeParseConfig(source.config) : source.config;
  const connectors = asRecord(raw?.connectors);
  const slack = asRecord(connectors?.[PROVIDER]);
  const channels = slack?.channels;
  if (!Array.isArray(channels)) return [];
  return channels.filter((c): c is string => typeof c === 'string');
}

/**
 * A short, structural summary line for a Slack message. NEVER body-derived: the raw
 * `text` is dropped by minimize (and strip() does not catch the names/addresses a chat
 * message can contain — its documented v1 boundary). So the summary is a structural
 * "Message in <channel> by <author>" label anchored on the channel + author + ts —
 * never any text-derived content.
 */
function summaryForMessage(event: SlackMessageEvent): string {
  const channel = str(event.channel) ?? 'unknown-channel';
  const author = str(event.user) ?? str(event.bot_id) ?? 'unknown';
  const ts = str(event.ts) ?? '';
  const threadMarker = event.thread_ts && event.thread_ts !== event.ts ? ' (thread reply)' : '';
  return `Message in ${channel} by ${author}${threadMarker} @ ${ts}`;
}

/**
 * Build a NormalizedRecord for a single Slack message. Shared by the inbound webhook
 * (normalize) and outbound backfill so both land an identical candidate shape. The raw
 * `text` is carried ONLY so minimize records the `body:dropped` trail; it is ALWAYS
 * dropped and never reaches a candidate column.
 */
function recordForMessage(event: SlackMessageEvent): NormalizedRecord {
  const channel = str(event.channel) ?? 'unknown-channel';
  const ts = str(event.ts) ?? '';
  // Per-channel idempotency anchor: a Slack message `ts` is unique within a channel, so
  // the channel+ts pair is globally stable (and deterministic — a duplicate delivery of
  // the same message yields the same key → ON CONFLICT no-op).
  const sourceRecordId = `${channel}:${ts}`;
  return {
    sourceRecordId,
    profile: PROFILE,
    item: {
      sourceRecordId,
      summary: summaryForMessage(event),
      // text is dropped by minimize; carried only for the redaction trail.
      body: str(event.text),
    },
    proposedSlug: `slack-message-${channel}-${ts}`,
  };
}

// ── The connector ────────────────────────────────────────────────────────────────

export const slackConnector: SaaSConnector = {
  provider: PROVIDER,
  signatureHeader: SIGNATURE_HEADER,

  /**
   * AC3: Slack `v0` signing-secret verification. `X-Slack-Signature` is
   * `v0=` + HMAC-SHA256(signing_secret, `v0:{X-Slack-Request-Timestamp}:{rawBody}`).
   * We strip the `v0=` prefix, rebuild the `v0:ts:body` base string ourselves, and
   * constant-time compare via hmacSha256Verify — PLUS a ±300s timestamp window on the
   * HEADER timestamp (seconds). Both must pass. Fail-closed on any missing header / shape
   * error. Requires BOTH `x-slack-signature` and `x-slack-request-timestamp`.
   */
  verifyWebhook(rawBody, headers, secret): boolean {
    const signature = headers[SIGNATURE_HEADER];
    const tsHeader = headers[TIMESTAMP_HEADER];
    if (!signature || !tsHeader) return false;

    // The signature MUST carry the v0 version prefix; reject anything else (a bare hex
    // digest, or a future scheme version we don't implement).
    const prefix = `${SIGNATURE_VERSION}=`;
    if (!signature.startsWith(prefix)) return false;
    const signatureHex = signature.slice(prefix.length);

    // Anti-replay: the timestamp is unix SECONDS in a header. Reject a non-integer or a
    // delivery outside ±300s of now. Checked BEFORE the HMAC so a stale-but-valid replay
    // is rejected even if an attacker re-signs (they can't — but the window is the gate).
    const ts = Number(tsHeader);
    if (!Number.isFinite(ts) || !Number.isInteger(ts)) return false;
    const nowSeconds = Math.floor(Date.now() / 1000);
    if (Math.abs(nowSeconds - ts) > TIMESTAMP_WINDOW_SECONDS) return false;

    // Rebuild Slack's base string `v0:{ts}:{rawBody}` and HMAC it with the signing secret.
    // hmacSha256Verify takes the SIGNED BYTES as a Buffer; concatenate the prefix + raw
    // body so we sign exactly what Slack signed (the verbatim, unparsed body bytes).
    const baseString = Buffer.concat([
      Buffer.from(`${SIGNATURE_VERSION}:${tsHeader}:`, 'utf8'),
      rawBody,
    ]);
    return hmacSha256Verify(baseString, secret, signatureHex);
  },

  /** AC4: resolve the workspace/team id the source is mapped to. */
  accountFromPayload(payload): string | null {
    const p = asRecord(payload);
    return p ? (str(p.team_id) ?? null) : null;
  },

  /**
   * AC4: a `message` in a SELECTED public channel → a single field-minimized summary
   * candidate (NO raw body). DM events (`im`/`mpim`) and non-opt-in channels are IGNORED
   * (return []). Non-`message` events, message subtypes (edits/joins/bot noise), and
   * url_verification envelopes are also ignored — only a plain channel post is ingested.
   *
   * The opt-in channel list is resolved from the SOURCE config, which normalize() does not
   * receive — so normalize takes an OPTIONAL second arg carrying it. The framework's
   * landRecords → toCandidate path calls normalize(payload) with one arg; for inbound
   * webhooks the receiver must pass the opt-in list. Where the list is absent (the generic
   * one-arg call), we fail CLOSED and ingest nothing, because an un-gated message could
   * carry a non-opt-in channel. (Backfill calls normalizeMessage directly per opt-in
   * channel, so it never relies on this path.)
   */
  normalize(payload: unknown, optInChannels?: readonly string[]): NormalizedRecord[] {
    const env = (asRecord(payload) ?? {}) as SlackEventEnvelope;
    if (env.type !== 'event_callback') return [];
    const event = env.event;
    if (!event || event.type !== 'message') return [];
    // Ignore message subtypes (edits, joins, bot_message, etc.) — only a plain post.
    if (event.subtype) return [];
    // ALWAYS ignore DM / group-DM events (no DM scopes, never ingested).
    if (isDmChannelType(event.channel_type)) return [];
    const channel = str(event.channel);
    const ts = str(event.ts);
    if (!channel || !ts) return [];
    // Opt-in gate: the channel MUST be in the per-source list. Fail-closed when the list
    // is absent (generic one-arg call) — ingest nothing rather than an un-gated channel.
    const allowed = optInChannels ?? [];
    if (!allowed.includes(channel)) return [];

    return [recordForMessage(event)];
  },

  /**
   * AC4: map a (already-minimized) record to a high-confidence candidate. version omitted
   * → defaults to '1' (the idempotency key is (source, source_record_id, 1); the
   * channel:ts source_record_id is already globally unique + deterministic).
   */
  toCandidate(record, sourceId): ConnectorCandidateItem {
    return {
      source_id: sourceId,
      source_record_id: record.sourceRecordId,
      provider: PROVIDER,
      proposed_slug: record.proposedSlug,
      // The body (text) was already dropped by minimize; the summary is the structural line.
      proposed_markdown: record.item.summary,
      confidence: 0.85,
    };
  },

  /**
   * AC2: outbound backfill. For each opt-in public channel, pages
   * `conversations.history` with cursor pagination, landing each page through the SAME
   * landRecords redaction path. Advances a single global watermark (the newest message
   * `ts` seen across all channels) in sources.config.connectors.slack.backfill_cursor;
   * `oldest` is set to it so a resumed run re-fetches nothing (and landRecords' ON
   * CONFLICT makes any overlap a safe no-op).
   */
  async backfill(engine: BrainEngine, source: ConnectorSource): Promise<number> {
    const { landRecords } = await import('./base.ts');
    const token = await getValidAccessToken(engine, source.id, PROVIDER);
    const channels = readOptInChannels(source);
    const watermark = readBackfillWatermark(source);

    let landed = 0;
    let newestTs = watermark;

    for (const channel of channels) {
      let cursor: string | null = null;
      do {
        const page = await fetchHistoryPage(token, channel, watermark, cursor);
        const records: NormalizedRecord[] = [];
        for (const msg of page.messages) {
          // Skip subtypes (edits/joins/bot noise) on backfill too — only plain posts.
          if (str(msg.subtype)) continue;
          const event: SlackMessageEvent = { ...msg, channel };
          records.push(recordForMessage(event));
          const t = str(msg.ts);
          if (t && (!newestTs || compareTs(t, newestTs) > 0)) newestTs = t;
        }
        const result = await landRecords(engine, source.id, this, records);
        landed += result.written;
        cursor = page.hasMore ? page.nextCursor : null;
      } while (cursor);
    }

    // Persist the advanced watermark so the next run resumes after the newest message.
    if (newestTs && newestTs !== watermark) {
      await writeBackfillWatermark(engine, source, newestTs);
    }

    return landed;
  },
};

/**
 * Compare two Slack message `ts` values ("1700000000.000100"). They are decimal-string
 * unix timestamps with microsecond fraction; numeric comparison orders them chronologically.
 * Returns >0 when `a` is newer than `b`, <0 when older, 0 when equal.
 */
function compareTs(a: string, b: string): number {
  const na = Number(a);
  const nb = Number(b);
  if (Number.isFinite(na) && Number.isFinite(nb)) return na - nb;
  // Fallback to string compare for malformed ts (defensive — keeps ordering deterministic).
  return a < b ? -1 : a > b ? 1 : 0;
}

// ── Backfill watermark persistence (sources.config.connectors.slack.*) ───────────

/** Read the persisted `ts` watermark, or null on first run. */
export function readBackfillWatermark(source: ConnectorSource): string | null {
  const raw = typeof source.config === 'string' ? safeParseConfig(source.config) : source.config;
  const connectors = asRecord(raw?.connectors);
  const slack = asRecord(connectors?.[PROVIDER]);
  return str(slack?.backfill_cursor) ?? null;
}

/**
 * Persist ONLY the watermark via a surgical `jsonb_set` against the CURRENT row, so a
 * concurrent sibling config write (e.g. a secret rotation between our read and write) is
 * not clobbered by a whole-config UPDATE from a stale snapshot. `jsonb_set` with
 * `create_missing = true` mutates only the {connectors,slack,backfill_cursor} path; the
 * parent objects must exist (connector enable always creates connectors.slack first).
 */
export async function writeBackfillWatermark(
  engine: BrainEngine,
  source: ConnectorSource,
  watermark: string,
): Promise<void> {
  await engine.executeRaw(
    `UPDATE sources
        SET config = jsonb_set(config, '{connectors,slack,backfill_cursor}', to_jsonb($1::text), true)
      WHERE id = $2`,
    [watermark, source.id],
  );
}

function safeParseConfig(s: string): Record<string, unknown> | null {
  try {
    return JSON.parse(s) as Record<string, unknown>;
  } catch {
    return null;
  }
}

// ── Slack conversations.history backfill query ──────────────────────────────────

interface SlackHistoryPage {
  messages: SlackMessageEvent[];
  hasMore: boolean;
  nextCursor: string | null;
}

/**
 * Fetch one page of a channel's history, newest-first, with cursor pagination. `token`
 * is a BARE bot token (no scheme); this function prepends `Bearer `. When `oldest` is set
 * (the watermark), Slack returns only messages strictly newer (we pass
 * `inclusive=false`), so a resumed run re-fetches nothing. Pure HTTP via fetch (mockable
 * in tests).
 */
export async function fetchHistoryPage(
  token: string,
  channel: string,
  oldest: string | null,
  cursor: string | null,
): Promise<SlackHistoryPage> {
  const body: Record<string, string> = {
    channel,
    limit: String(BACKFILL_PAGE_SIZE),
    inclusive: 'false',
  };
  if (oldest) body.oldest = oldest;
  if (cursor) body.cursor = cursor;

  const res = await fetch(SLACK_CONVERSATIONS_HISTORY_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      // Contract: getValidAccessToken returns a BARE access token; we add `Bearer `.
      authorization: `Bearer ${token}`,
    },
    body: new URLSearchParams(body).toString(),
  });
  if (!res.ok) {
    throw new Error(`slack conversations.history ${res.status}: ${await safeText(res)}`);
  }
  const json = (await res.json()) as {
    ok?: boolean;
    error?: string;
    messages?: SlackMessageEvent[];
    has_more?: boolean;
    response_metadata?: { next_cursor?: string };
  };
  if (json.ok !== true) {
    throw new Error(`slack conversations.history error: ${json.error ?? 'unknown'}`);
  }
  const nextCursor = json.response_metadata?.next_cursor;
  return {
    messages: json.messages ?? [],
    hasMore: json.has_more === true,
    // Slack signals "no more pages" with an empty-string next_cursor; normalize to null.
    nextCursor: nextCursor && nextCursor.length > 0 ? nextCursor : null,
  };
}

// ── Registration (side-effecting at module load) ─────────────────────────────────

registerConnector(slackConnector);
registerSlackOAuth();
