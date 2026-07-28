/**
 * rate-limit-key.ts — per-principal keying for the HTTP server's rate limiters.
 *
 * WHY THIS EXISTS
 *
 * express-rate-limit keys on `req.ip` by default. `req.ip` is only the real
 * client when Express's `trust proxy` setting matches the actual deployment
 * topology. When it does not, every caller collapses into ONE shared bucket
 * and the limiter inverts its own purpose:
 *
 *   - one abusive caller exhausts the window and locks out everybody else;
 *   - an attacker spread across many source addresses is not limited
 *     per-source at all, which is precisely what a brute-force cap is for.
 *
 * That is not hypothetical here. gbrain's documented production topology runs
 * it behind an in-container reverse proxy on loopback, itself behind a
 * platform edge. With `trust proxy: 'loopback'` the edge hop is untrusted, so
 * `req.ip` resolves to the edge address (or to 127.0.0.1 when no
 * X-Forwarded-For survives) — shared across every real user.
 *
 * THE FIX IS DEFENSE IN DEPTH, NOT A REPLACEMENT. Getting `trust proxy` right
 * is still the primary correctness lever. This helper ensures that when IP
 * attribution fails anyway, limiters degrade to PER-PRINCIPAL rather than
 * GLOBAL — a bounded, honest failure instead of a silent one.
 *
 * KEY PRECEDENCE, most specific first:
 *   1. authenticated client id  — post-auth routes; the strongest identity
 *   2. HTTP Basic username      — /token with client_secret_basic. Read from
 *                                 the header deliberately: the /token limiter
 *                                 runs BEFORE express.urlencoded(), so the
 *                                 form body is not yet parsed and a
 *                                 client_secret_post client_id is genuinely
 *                                 unavailable at this point. Reordering the
 *                                 middleware to expose it would mean parsing
 *                                 bodies before rate limiting, which trades a
 *                                 real DoS protection for a marginal keying
 *                                 improvement. Not worth it.
 *   3. req.ip                   — the ordinary path when trust proxy is right
 *   4. 'unattributed'           — explicit, greppable last resort
 *
 * Every key is namespaced by its source (`cid:`, `basic:`, `ip:`) so two
 * principals cannot collide across tiers — an attacker must not be able to
 * pick a client_id that matches somebody else's IP-derived key.
 */

/** Minimal shape we need; avoids coupling this module to Express types. */
export interface RateLimitKeyRequest {
  ip?: string;
  auth?: { clientId?: string } | undefined;
  headers?: Record<string, string | string[] | undefined> | undefined;
  get?: (name: string) => string | undefined;
}

/** Cap so a hostile header cannot bloat the limiter's in-memory key store. */
const MAX_KEY_LEN = 128;

function header(req: RateLimitKeyRequest, name: string): string | undefined {
  if (typeof req.get === 'function') {
    const v = req.get(name);
    if (typeof v === 'string') return v;
  }
  const raw = req.headers?.[name.toLowerCase()];
  if (typeof raw === 'string') return raw;
  if (Array.isArray(raw) && typeof raw[0] === 'string') return raw[0];
  return undefined;
}

/**
 * Extract the client_id from an HTTP Basic Authorization header.
 * Returns undefined for any malformed input rather than throwing — a bad
 * header must degrade the KEY, never fail the REQUEST.
 */
export function basicAuthClientId(authorization: string | undefined): string | undefined {
  if (!authorization) return undefined;
  const m = /^Basic\s+(.+)$/i.exec(authorization.trim());
  if (!m || !m[1]) return undefined;
  let decoded: string;
  try {
    decoded = Buffer.from(m[1], 'base64').toString('utf8');
  } catch {
    return undefined;
  }
  // RFC 7617: user-id is everything before the FIRST colon. A client_id may
  // not contain ':', but a secret certainly can, so never split on the last.
  const idx = decoded.indexOf(':');
  const id = idx === -1 ? decoded : decoded.slice(0, idx);
  const trimmed = id.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Resolve the rate-limit bucket key for a request.
 *
 * Guarantees, in order of importance:
 *   - NEVER returns the same key for two distinct authenticated principals.
 *   - NEVER returns a constant for everyone; the worst case ('unattributed')
 *     is reached only when there is no identity AND no IP at all.
 *   - Never throws. A limiter that throws is a limiter that is not limiting.
 */
export function rateLimitKey(req: RateLimitKeyRequest): string {
  const clientId = req.auth?.clientId;
  if (typeof clientId === 'string' && clientId.trim().length > 0) {
    return `cid:${clientId.trim()}`.slice(0, MAX_KEY_LEN);
  }

  const basicId = basicAuthClientId(header(req, 'authorization'));
  if (basicId) return `basic:${basicId}`.slice(0, MAX_KEY_LEN);

  const ip = typeof req.ip === 'string' ? req.ip.trim() : '';
  if (ip.length > 0) return `ip:${ip}`.slice(0, MAX_KEY_LEN);

  return 'unattributed';
}

/**
 * Resolve Express's `trust proxy` setting from the environment.
 *
 * The correct value is deployment-specific and cannot be inferred from inside
 * the process: it is the number of proxy hops in FRONT of this server. The
 * default is left at 'loopback' deliberately — changing it silently would
 * alter IP attribution for every existing deployment, and a wrong hop count
 * is worse than a conservative one because it lets a caller spoof
 * X-Forwarded-For.
 *
 * GBRAIN_TRUST_PROXY accepts:
 *   a positive integer  -> trust exactly that many hops (typical: 1, or 2
 *                          behind a platform edge plus a local proxy)
 *   'loopback'          -> default; trust only 127.0.0.1/::1
 *   'false' | '0'       -> trust nothing; req.ip is always the socket peer
 *   any other string    -> passed through to Express (IP / CIDR list)
 */
export function resolveTrustProxy(env: Record<string, string | undefined>): number | string | boolean {
  const raw = env.GBRAIN_TRUST_PROXY?.trim();
  if (!raw) return 'loopback';
  if (raw === 'false') return false;
  if (/^\d+$/.test(raw)) {
    const n = Number(raw);
    return Number.isFinite(n) ? n : 'loopback';
  }
  return raw;
}
