/**
 * github-app-jwt.ts — GitHub App RS256 JWT minting (pure node:crypto leaf).
 *
 * Extracted from github.ts so it has ZERO connector-graph imports. Both the github_kb
 * connector (github.ts) and the TECH-2037 promotion bridge (promotion.ts) import mintAppJwt
 * from here. This breaks a module-eval cycle: promotion.ts importing github.ts directly
 * pulled github.ts's top-level `registerConnector(githubConnector)` side effect into the
 * serve boot graph, and when that ran before base.ts initialised its `REGISTRY` map the
 * server crashed at startup with a temporal-dead-zone error ("Cannot access 'REGISTRY'
 * before initialization"). A pure-crypto leaf has no such side effect, so neither importer
 * can trigger it. Pure crypto, no network, no logging.
 */
import { createSign } from 'node:crypto';

/** Env var name surfaced in the PKCS#8 guidance error (kept in sync with the connector copies). */
const APP_PRIVATE_KEY_ENV = 'GBRAIN_GITHUB_APP_PRIVATE_KEY';

/** Base64url-encode a Buffer/string (no padding) — the JWT segment encoding. */
function base64url(input: Buffer | string): string {
  const buf = typeof input === 'string' ? Buffer.from(input, 'utf8') : input;
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * Mint a short-lived (9 min) RS256 App JWT signed with the App private key (PKCS#8 PEM).
 * `iss` is the App id; `iat` is backdated 60s for clock-skew tolerance (GitHub's
 * recommendation). `exp` is `now + 540` — a 60s haircut off GitHub's 10-minute ceiling so a
 * host clock running a few seconds ahead of GitHub's (normal NTP drift) or in-flight latency
 * can't push the observed exp past the ceiling and earn an intermittent 401 on token mint.
 * Pure crypto, no network. Throws loud on a missing/invalid key so a misconfig surfaces
 * rather than silently producing an unsigned token.
 */
export function mintAppJwt(privateKeyPem: string, appId: string): string {
  if (privateKeyPem.includes('BEGIN RSA PRIVATE KEY')) {
    throw new Error(
      `${APP_PRIVATE_KEY_ENV} must be PKCS#8 ("BEGIN PRIVATE KEY"). Convert with: ` +
        `openssl pkcs8 -topk8 -inform PEM -outform PEM -nocrypt -in gh-app.pem`,
    );
  }
  const now = Math.floor(Date.now() / 1000);
  const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  // exp = now + 540 (9 min), NOT now + 600: GitHub rejects an App JWT whose exp is > 600s
  // ahead of ITS clock, so pinning the ceiling means a host clock a few seconds fast (or
  // in-flight + validation latency) intermittently 401s. The 60s margin absorbs that.
  const payload = base64url(JSON.stringify({ iat: now - 60, exp: now + 540, iss: appId }));
  const signingInput = `${header}.${payload}`;
  const signature = createSign('RSA-SHA256').update(signingInput).sign(privateKeyPem);
  return `${signingInput}.${base64url(signature)}`;
}
