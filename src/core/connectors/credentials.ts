/**
 * credentials.ts — TECH-2033 outbound-OAuth credential custody primitive.
 *
 * The provider-agnostic custody layer for outbound (server-to-SaaS) OAuth
 * grants. It owns:
 *   - the encrypted at-rest store (`connector_tokens`),
 *   - an AES-256-GCM envelope ({kid, iv, ciphertext, tag}) sealed by a MASTER
 *     KEY from env (GBRAIN_CONNECTOR_MASTER_KEY) that NEVER touches the DB,
 *   - single-flight, advisory-lock-serialized refresh-token rotation with
 *     reuse-revocation (RFC 9700),
 *   - the source predicate on every read (cross-source token read is denied),
 *   - fail-closed `needs_reauth` marking on decrypt failure or refresh reuse.
 *
 * Provider OAuth specifics (authorize URL, code exchange, refresh) live in the
 * CONNECTORS, not here. Connectors register an `OAuthProviderConfig` at module
 * load via `registerOAuthProvider`; this layer drives it. That decoupling lets
 * TECH-2035 (and any future connector) build provider modules in parallel
 * against the stable `getValidAccessToken` / `storeToken` surface below.
 *
 * Ported (logic only — no Cloudflare Durable Object import; gbrain is a
 * Bun/Node service) from Forge's incident-hardened auth-rotation pattern:
 * NEVER call the provider refresh endpoint unless the rotated single-use token
 * can be durably persisted FIRST — "never burn a token you can't write back".
 * The persist of the rotated envelope happens inside the same advisory-locked
 * transaction as the read, and the new token is committed before it is returned
 * to the caller. A merge-preserving UPDATE keeps untouched columns intact.
 */

import { createCipheriv, createDecipheriv, randomBytes, timingSafeEqual } from 'node:crypto';
import type { BrainEngine } from '../engine.ts';

// ── Public contract (TECH-2035 imports getValidAccessToken — keep stable) ────

/** A provider access/refresh grant, plaintext, as it lives in process memory only. */
export interface StoredToken {
  accessToken: string;
  refreshToken?: string | null;
  expiresAt?: Date | null;
  scope?: string | null;
  account: string;
}

/** Thrown when a token cannot be produced (no row, needs_reauth, refresh failed). */
export class ConnectorAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConnectorAuthError';
  }
}

/** A provider's OAuth config, registered by its connector module at load time. */
export interface OAuthProviderConfig {
  authorizeUrl(state: string, redirectUri: string): string;
  exchangeCode(code: string, redirectUri: string): Promise<StoredToken>;
  refresh(refreshToken: string): Promise<StoredToken>;
}

// ── Provider registry (populated by connector modules; driven by routes) ─────

const OAUTH_PROVIDERS = new Map<string, OAuthProviderConfig>();

/** Register a provider's OAuth config. Called at module load by each connector. */
export function registerOAuthProvider(provider: string, cfg: OAuthProviderConfig): void {
  OAUTH_PROVIDERS.set(provider, cfg);
}

/** Resolve a provider's OAuth config, or undefined if none is registered. */
export function getOAuthProvider(provider: string): OAuthProviderConfig | undefined {
  return OAUTH_PROVIDERS.get(provider);
}

// ── AES-256-GCM envelope (master key never persisted) ────────────────────────

/**
 * The on-disk envelope. All binary fields are hex TEXT so they survive a plain
 * TEXT column round-trip on both engines without bytea encoding quirks.
 *   - kid:        master-key generation id (so a rotation can re-wrap)
 *   - iv:         12-byte GCM nonce (24 hex chars)
 *   - ciphertext: the sealed JSON token blob
 *   - tag:        16-byte GCM auth tag (32 hex chars)
 */
export interface TokenEnvelope {
  kid: string;
  iv: string;
  ciphertext: string;
  tag: string;
}

const MASTER_KEY_ENV = 'GBRAIN_CONNECTOR_MASTER_KEY';
const IV_BYTES = 12;
/**
 * kid of the CURRENT master key — what every fresh `sealToken` stamps. The `kid`
 * column is real and load-bearing on READ: `openToken` resolves the key BY the
 * envelope's kid (via `keyForKid`) and fails closed on an unknown kid, so a
 * future rotation is a forward-compatible extension — add the new key under a
 * new kid to `keyForKid`, bump CURRENT_KID, and old rows still decrypt under
 * their own kid until re-wrapped. TODAY only one key (`v1`) is configured via
 * env; there is intentionally no multi-key map until a rotation actually ships.
 */
const CURRENT_KID = 'v1';

/**
 * Resolve the 32-byte master key for a given kid (hex from env). Fails LOUD — a
 * misconfigured key, or an envelope stamped with a kid we don't have a key for,
 * must never silently degrade to a weaker/absent path. An unknown kid is a
 * decrypt failure (→ caller marks needs_reauth), not a fall-through to a
 * default key.
 *
 * Single-key today: only CURRENT_KID maps to GBRAIN_CONNECTOR_MASTER_KEY. To
 * rotate later, register additional kid→env-var pairs here.
 */
function keyForKid(kid: string): Buffer {
  if (kid !== CURRENT_KID) {
    throw new ConnectorAuthError(
      `no master key registered for kid='${kid}' (current kid='${CURRENT_KID}')`,
    );
  }
  const hex = process.env[MASTER_KEY_ENV];
  if (!hex) {
    throw new ConnectorAuthError(
      `${MASTER_KEY_ENV} is not set — connector token custody requires a 32-byte hex master key`,
    );
  }
  let key: Buffer;
  try {
    key = Buffer.from(hex, 'hex');
  } catch {
    throw new ConnectorAuthError(`${MASTER_KEY_ENV} is not valid hex`);
  }
  if (key.length !== 32) {
    throw new ConnectorAuthError(
      `${MASTER_KEY_ENV} must decode to 32 bytes (got ${key.length}) for AES-256-GCM`,
    );
  }
  return key;
}

/**
 * Seal a StoredToken into an envelope under the CURRENT kid. A fresh random
 * 12-byte IV per call (GCM nonce-reuse under a fixed key is catastrophic, so
 * never derive it).
 */
export function sealToken(token: StoredToken): TokenEnvelope {
  const key = keyForKid(CURRENT_KID);
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const plaintext = Buffer.from(JSON.stringify(serializeToken(token)), 'utf8');
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    kid: CURRENT_KID,
    iv: iv.toString('hex'),
    ciphertext: ciphertext.toString('hex'),
    tag: tag.toString('hex'),
  };
}

/**
 * Open an envelope back to a StoredToken. Resolves the key by the envelope's own
 * kid. Throws on an unknown kid, on any tamper, or on a wrong key (GCM auth-tag
 * failure) — the caller treats a throw as decrypt failure and marks the row
 * needs_reauth (fail-closed).
 */
export function openToken(env: TokenEnvelope): StoredToken {
  const key = keyForKid(env.kid);
  const iv = Buffer.from(env.iv, 'hex');
  const ciphertext = Buffer.from(env.ciphertext, 'hex');
  const tag = Buffer.from(env.tag, 'hex');
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return deserializeToken(JSON.parse(plaintext.toString('utf8')));
}

/** JSON-safe wire shape (Date → ISO string). */
function serializeToken(t: StoredToken): Record<string, unknown> {
  return {
    accessToken: t.accessToken,
    refreshToken: t.refreshToken ?? null,
    expiresAt: t.expiresAt ? t.expiresAt.toISOString() : null,
    scope: t.scope ?? null,
    account: t.account,
  };
}

function deserializeToken(o: Record<string, unknown>): StoredToken {
  return {
    accessToken: String(o.accessToken),
    refreshToken: o.refreshToken == null ? null : String(o.refreshToken),
    expiresAt: o.expiresAt == null ? null : new Date(String(o.expiresAt)),
    scope: o.scope == null ? null : String(o.scope),
    account: String(o.account),
  };
}

// ── Row shape ────────────────────────────────────────────────────────────────

interface ConnectorTokenRow {
  id: number;
  source_id: string;
  provider: string;
  account: string;
  kid: string;
  iv: string;
  ciphertext: string;
  tag: string;
  expires_at: Date | string | null;
  status: 'active' | 'needs_reauth' | 'revoked';
}

/** How close to expiry (ms) we proactively refresh, so an in-flight call doesn't 401. */
const REFRESH_SKEW_MS = 60_000;

// ── In-process single-flight mutex (per source:provider) ─────────────────────

/**
 * Two complementary serializers, by scope:
 *
 *   - In-process async mutex (`withInProcessLock`): the ONLY in-process guard on
 *     REAL Postgres, where `engine.transaction()` opens a SEPARATE pooled
 *     backend per concurrent caller — those backends genuinely interleave, so
 *     without this mutex two same-process callers could both read, both refresh,
 *     and double-burn the single-use refresh token. (On PGlite the engine
 *     additionally serializes every transaction through its own internal mutex,
 *     so there the in-process mutex is belt-and-suspenders, not load-bearing —
 *     but it must stay, because Postgres is the real target.)
 *
 *   - Postgres advisory xact lock (`takeAdvisoryLock`): the CROSS-process /
 *     cross-instance guard. `pg_advisory_xact_lock` held inside the transaction
 *     serializes refresh across separate backends on different VMs. No-op on
 *     PGlite (it has no separate-backend concurrency to guard).
 *
 * SINGLE-INSTANCE ASSUMPTION (TECH-2033): `refreshLocks` is per-Node-process.
 * gbrain runs single-instance today, so the in-process mutex covers every
 * in-process caller and the advisory lock covers the (currently absent)
 * multi-instance case. A future multi-instance deployment relies on the
 * advisory lock as the SOLE cross-instance single-flight — which is correct,
 * but means the in-process mutex no longer sees peers on other instances.
 */
const refreshLocks = new Map<string, Promise<unknown>>();

function lockKey(sourceId: string, provider: string): string {
  return `${sourceId} ${provider}`;
}

/** Run `fn` under the per-(source,provider) in-process mutex. */
async function withInProcessLock<T>(sourceId: string, provider: string, fn: () => Promise<T>): Promise<T> {
  const key = lockKey(sourceId, provider);
  const prior = refreshLocks.get(key) ?? Promise.resolve();
  // Chain onto the prior holder; swallow its rejection so one failure doesn't
  // poison the queue for the next waiter.
  const run = prior.catch(() => undefined).then(fn);
  refreshLocks.set(key, run);
  try {
    return await run;
  } finally {
    // Only clear if we're still the tail (no newer waiter chained on).
    if (refreshLocks.get(key) === run) refreshLocks.delete(key);
  }
}

/** Postgres SQLSTATE for `undefined_function` — the ONLY legitimate fail-open. */
const SQLSTATE_UNDEFINED_FUNCTION = '42883';

/** Read a SQLSTATE code off a thrown DB error (postgres.js + PGlite both set `.code`). */
function sqlState(err: unknown): string | undefined {
  if (err && typeof err === 'object' && 'code' in err) {
    const c = (err as { code?: unknown }).code;
    if (typeof c === 'string') return c;
  }
  return undefined;
}

/**
 * Take the postgres advisory transaction lock keyed by a stable hash of
 * source:provider. No-op on pglite. The lock is xact-scoped: it releases
 * automatically when the surrounding `engine.transaction()` commits or rolls
 * back.
 *
 * FAIL-CLOSED on acquisition error. `pg_advisory_xact_lock` + `hashtextextended`
 * are core Postgres builtins, so on the real target the only errors are
 * TRANSIENT (pooler blip, statement_timeout). Swallowing them and proceeding
 * lock-less would let two processes both refresh and double-burn the single-use
 * refresh token → RFC 9700 reuse-revocation kills the connection. Aborting (the
 * caller fails loud and retries) is strictly safer than a silent double-burn.
 * The ONLY tolerated case is SQLSTATE 42883 (undefined_function) — which cannot
 * occur on either engine (both have the builtins), but is handled for safety so
 * a hypothetical builtin-less server degrades to in-process-mutex-only rather
 * than wedging all token reads.
 */
async function takeAdvisoryLock(engine: BrainEngine, sourceId: string, provider: string): Promise<void> {
  if (engine.kind !== 'postgres') return;
  try {
    await engine.executeRaw(
      `SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`,
      [`connector_tokens:${sourceId}:${provider}`],
    );
  } catch (err) {
    if (sqlState(err) === SQLSTATE_UNDEFINED_FUNCTION) return; // legitimate fail-open
    throw err; // transient/other → abort the refresh; never proceed lock-less
  }
}

// ── Persistence helpers (source predicate enforced on every read) ────────────

/** Read the single active-or-recoverable row for (source, provider). Source predicate is mandatory. */
async function readRow(engine: BrainEngine, sourceId: string, provider: string): Promise<ConnectorTokenRow | null> {
  const rows = await engine.executeRaw<ConnectorTokenRow>(
    `SELECT id, source_id, provider, account, kid, iv, ciphertext, tag, expires_at, status
       FROM connector_tokens
      WHERE source_id = $1 AND provider = $2`,
    [sourceId, provider],
  );
  return rows[0] ?? null;
}

/** Mark the connection needs_reauth (fail-closed). Best-effort; never throws. */
async function markNeedsReauth(engine: BrainEngine, sourceId: string, provider: string): Promise<void> {
  try {
    await engine.executeRaw(
      `UPDATE connector_tokens
          SET status = 'needs_reauth', updated_at = now()
        WHERE source_id = $1 AND provider = $2`,
      [sourceId, provider],
    );
  } catch {
    // swallow — marking is best-effort; the throw to the caller is what matters
  }
}

function toExpiry(v: Date | string | null): Date | null {
  if (v == null) return null;
  return v instanceof Date ? v : new Date(v);
}

// ── storeToken: encrypt + persist (merge-preserving upsert) ──────────────────

/**
 * Encrypt `token` and persist it for (source, provider). Used after a
 * connect/callback code exchange or after a refresh. Re-activates the row
 * (status → 'active'). Identity is (source_id, provider) — ONE account per
 * (source, provider); the account is stored as an attribute and the upsert
 * replaces the envelope (and account) in place. ON CONFLICT therefore targets
 * (source_id, provider), matching the unique constraint.
 */
export async function storeToken(
  engine: BrainEngine,
  sourceId: string,
  provider: string,
  token: StoredToken,
): Promise<void> {
  const env = sealToken(token);
  const expiresAt = token.expiresAt ? token.expiresAt.toISOString() : null;
  await engine.executeRaw(
    `INSERT INTO connector_tokens
       (source_id, provider, account, kid, iv, ciphertext, tag, expires_at, status, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'active', now())
     ON CONFLICT (source_id, provider) DO UPDATE SET
       account    = EXCLUDED.account,
       kid        = EXCLUDED.kid,
       iv         = EXCLUDED.iv,
       ciphertext = EXCLUDED.ciphertext,
       tag        = EXCLUDED.tag,
       expires_at = EXCLUDED.expires_at,
       status     = 'active',
       updated_at = now()`,
    [sourceId, provider, token.account, env.kid, env.iv, env.ciphertext, env.tag, expiresAt],
  );
}

// ── getValidAccessToken: the read surface TECH-2035 consumes ─────────────────

/**
 * Return a valid (refreshed-if-needed) access token for (source, provider).
 *
 * Flow:
 *   1. In-process mutex + (postgres) advisory xact lock serialize concurrent
 *      callers per (source, provider) — single-flight refresh.
 *   2. Read the row under the source predicate (cross-source read impossible).
 *   3. Decrypt the envelope; a failure marks needs_reauth and throws.
 *   4. If not near expiry, return the cached access token.
 *   5. Otherwise refresh: persist the rotated envelope FIRST (inside the same
 *      locked transaction), then return — "never burn a token you can't write
 *      back". A refresh that the provider rejects as a reused/revoked token
 *      marks needs_reauth and throws (RFC 9700 reuse-revocation).
 *
 * Throws ConnectorAuthError on any unrecoverable failure; the connection is
 * left in needs_reauth so an operator can re-run the connect flow.
 */
export async function getValidAccessToken(
  engine: BrainEngine,
  sourceId: string,
  provider: string,
): Promise<string> {
  return withInProcessLock(sourceId, provider, async () => {
    // The read→refresh→persist window runs inside ONE transaction so the
    // advisory xact lock is held across it and the rotated token is committed
    // before we return it. The transaction returns a discriminated outcome
    // rather than throwing: a `needs_reauth` outcome must be marked on the
    // OUTER engine AFTER the transaction, because throwing inside the
    // transaction would roll the marking back with everything else.
    type Outcome =
      | { kind: 'ok'; accessToken: string }
      | { kind: 'error'; message: string }
      | { kind: 'needs_reauth'; message: string };

    const outcome = await engine.transaction(async (tx): Promise<Outcome> => {
      await takeAdvisoryLock(tx, sourceId, provider);

      const row = await readRow(tx, sourceId, provider);
      if (!row) {
        return { kind: 'error', message: `no connector token for source='${sourceId}' provider='${provider}'` };
      }
      if (row.status !== 'active') {
        return {
          kind: 'error',
          message: `connector token for source='${sourceId}' provider='${provider}' is ${row.status}`,
        };
      }

      // Decrypt. Any failure (tamper, wrong key) → fail-closed needs_reauth.
      let current: StoredToken;
      try {
        current = openToken({ kid: row.kid, iv: row.iv, ciphertext: row.ciphertext, tag: row.tag });
      } catch {
        return {
          kind: 'needs_reauth',
          message: `decrypt failed for source='${sourceId}' provider='${provider}' — marked needs_reauth`,
        };
      }

      const expiresAt = toExpiry(row.expires_at);
      const needsRefresh = expiresAt != null && expiresAt.getTime() - Date.now() <= REFRESH_SKEW_MS;
      if (!needsRefresh) {
        return { kind: 'ok', accessToken: current.accessToken };
      }

      // Refresh path. We must have a refresh token to proceed.
      if (!current.refreshToken) {
        return {
          kind: 'needs_reauth',
          message: `token expired and no refresh_token for source='${sourceId}' provider='${provider}' — marked needs_reauth`,
        };
      }

      const cfg = getOAuthProvider(provider);
      if (!cfg) {
        // Can't refresh without a registered provider; do NOT mark needs_reauth
        // (the grant itself is fine — the process just lacks the provider module).
        return { kind: 'error', message: `no OAuth provider registered for '${provider}'` };
      }

      let rotated: StoredToken;
      try {
        rotated = await cfg.refresh(current.refreshToken);
      } catch (err) {
        // RFC 9700 reuse-revocation: a provider that rejects the refresh token
        // (reused / revoked / invalid_grant) is a terminal, fail-closed event.
        const msg = err instanceof Error ? err.message : String(err);
        return {
          kind: 'needs_reauth',
          message: `refresh rejected for source='${sourceId}' provider='${provider}' (${msg}) — marked needs_reauth`,
        };
      }

      // "Never burn a token you can't write back": persist the rotated envelope
      // BEFORE returning, inside this same locked transaction. Merge-preserve
      // account (provider may omit it on refresh) and the refresh token (some
      // providers don't re-issue one on refresh — keep the prior so the next
      // rotation still has a credential).
      const merged: StoredToken = {
        accessToken: rotated.accessToken,
        refreshToken: rotated.refreshToken ?? current.refreshToken,
        expiresAt: rotated.expiresAt ?? null,
        scope: rotated.scope ?? current.scope ?? null,
        account: rotated.account || current.account || row.account,
      };
      await storeToken(tx, sourceId, provider, merged);
      return { kind: 'ok', accessToken: merged.accessToken };
    });

    if (outcome.kind === 'ok') return outcome.accessToken;
    if (outcome.kind === 'needs_reauth') {
      // Commit the fail-closed marking on the outer engine (the transaction
      // that observed the failure has already committed/returned cleanly).
      await markNeedsReauth(engine, sourceId, provider);
    }
    throw new ConnectorAuthError(outcome.message);
  });
}

/**
 * Detect a stable conflict (reuse) signal a provider may surface. Exposed for
 * connector refresh implementations + tests that want the canonical predicate
 * rather than string-matching themselves.
 */
export function isRefreshReuseError(err: unknown): boolean {
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
  return msg.includes('invalid_grant') || msg.includes('reuse') || msg.includes('revoked');
}

/** Constant-time string compare helper for connectors verifying OAuth `state`. */
export function safeStateEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ab.length !== bb.length || ab.length === 0) return false;
  return timingSafeEqual(ab, bb);
}
