/**
 * Tests for the gbrain side of the TECH-2110 promotion STATUS callback —
 * handlePromotionCallback (the inbound machine endpoint behind
 * POST /internal/promotion-callback).
 *
 * ⚠️ TICKET-vs-REALITY (the deliberate, documented deviation):
 *   The TECH-2110 ticket spec'd an inbound wire of
 *     { candidate_id, artifact_hash, …, signed_at, nonce } + header X-Promotion-Signature
 *     + artifact_hash ownership + nonce/clock-skew replay protection.
 *   The MERGED techtris-brain bridge (PR #101 `emit_status`) actually sends
 *     { status, branch, pr_url, source_record_id_hash } + header X-Brain-Signature
 *     + status∈{opened,failed} with NO replay token.
 *   gbrain matches the merged reality: ownership is by source_record_id_hash, replay-safety
 *   is by idempotency (re-applying the same writeback is a no-op).
 *
 * The handler is driven directly with a real PGLite engine + a synthetically signed body —
 * no Express boot, no real network. The signed body mirrors the Brain's
 *   json.dumps(payload, sort_keys=True).encode()  →  keys alphabetical:
 *   branch, pr_url, source_record_id_hash, status  →  hex HMAC-SHA256 over those exact bytes.
 *
 * Canonical PGLite block: one engine per file, beforeEach resets data, afterAll disconnects.
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach } from 'bun:test';
import { createHmac, createHash } from 'node:crypto';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { toRow } from '../src/core/connectors/candidate.ts';
import type { ConnectorCandidateRow } from '../src/core/connectors/candidate.ts';
import {
  handlePromotionCallback,
  sourceRecordIdHash16,
  type PromotionCallbackResult,
} from '../src/core/connectors/promotion.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 60_000);

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  await resetPgliteState(engine);
});

const SECRET = 'test-promotion-hmac-secret-0123456789';

// ── Helpers ─────────────────────────────────────────────────────────────────────

/**
 * Build the EXACT bytes the Brain signs: json.dumps(payload, sort_keys=True). We emit the 4
 * keys in alphabetical order (branch, pr_url, source_record_id_hash, status) with no
 * insignificant whitespace — matching Python's default separators when sort_keys=True. Then
 * sign with hex HMAC-SHA256 over those bytes.
 */
function signedBody(body: {
  status: string;
  branch: string;
  pr_url: string;
  source_record_id_hash: string;
}): { rawBody: Buffer; signature: string } {
  // Explicit alphabetical key order so the serialized bytes match the Brain's sort_keys=True.
  const canonical = JSON.stringify({
    branch: body.branch,
    pr_url: body.pr_url,
    source_record_id_hash: body.source_record_id_hash,
    status: body.status,
  });
  const rawBody = Buffer.from(canonical, 'utf8');
  const signature = createHmac('sha256', SECRET).update(rawBody).digest('hex');
  return { rawBody, signature };
}

/**
 * Seed a candidate and move it into the dispatched-and-awaiting-callback state:
 * status='accepted' AND artifact_hash IS NOT NULL (the exact set the handler's SELECT scopes
 * to). Returns the row id + the wire hash the Brain would send for it.
 */
async function seedDispatched(sourceRecordId: string, opts?: { provider?: string }): Promise<{
  id: number;
  hash16: string;
}> {
  const { row } = await toRow(engine, {
    source_id: 'default',
    source_record_id: sourceRecordId,
    provider: opts?.provider ?? 'crunchbase',
    proposed_markdown: `# ${sourceRecordId}`,
  });
  await engine.executeRaw(
    `UPDATE connector_candidates
        SET status = 'accepted',
            acted_by = 'admin',
            acted_at = now(),
            target_kind = 'inbox',
            target_path = '',
            artifact_hash = $2
      WHERE id = $1`,
    [row.id, `hash-${sourceRecordId}`],
  );
  return { id: row.id, hash16: sourceRecordIdHash16(sourceRecordId) };
}

async function readRow(id: number): Promise<ConnectorCandidateRow> {
  const [row] = await engine.executeRaw<ConnectorCandidateRow>(
    `SELECT * FROM connector_candidates WHERE id = $1`,
    [id],
  );
  return row;
}

const PR_URL = 'https://github.com/Techtrisdev/techtris-brain/pull/42';
const BRANCH = 'promote/crunchbase-rec-abc';

// ─────────────────────────────────────────────────────────────────
// sourceRecordIdHash16 — matches the Brain's sha256[:16]
// ─────────────────────────────────────────────────────────────────
describe('sourceRecordIdHash16', () => {
  test('is the first 16 lowercase hex chars of sha256(source_record_id)', () => {
    const id = 'rec-abc-123';
    const expected = createHash('sha256').update(id, 'utf8').digest('hex').slice(0, 16);
    expect(sourceRecordIdHash16(id)).toBe(expected);
    expect(sourceRecordIdHash16(id)).toHaveLength(16);
    expect(sourceRecordIdHash16(id)).toMatch(/^[0-9a-f]{16}$/);
  });
});

// ─────────────────────────────────────────────────────────────────
// Signature gate — verify before parse
// ─────────────────────────────────────────────────────────────────
describe('signature gate (verify before parse)', () => {
  test('forged signature → 401 with ZERO DB writes (row unchanged)', async () => {
    const { id, hash16 } = await seedDispatched('rec-forged');
    const before = await readRow(id);
    const { rawBody } = signedBody({ status: 'opened', branch: BRANCH, pr_url: PR_URL, source_record_id_hash: hash16 });

    const result = await handlePromotionCallback({
      rawBody,
      signatureHeader: 'deadbeef'.repeat(8), // valid hex, wrong MAC
      secret: SECRET,
      engine,
    });
    expect(result.ok).toBe(false);
    expect((result as Extract<PromotionCallbackResult, { ok: false }>).status).toBe(401);

    const after = await readRow(id);
    expect(after.promotion_status).toBe(before.promotion_status); // null → null
    expect(after.promotion_status).toBeNull();
    expect(after.promotion_pr_url).toBeNull();
    expect(after.promoted_at).toBeNull();
  });

  test('missing signature header → 401, no write', async () => {
    const { id, hash16 } = await seedDispatched('rec-nosig');
    const { rawBody } = signedBody({ status: 'opened', branch: BRANCH, pr_url: PR_URL, source_record_id_hash: hash16 });
    const result = await handlePromotionCallback({ rawBody, signatureHeader: undefined, secret: SECRET, engine });
    expect((result as Extract<PromotionCallbackResult, { ok: false }>).status).toBe(401);
    expect((await readRow(id)).promotion_status).toBeNull();
  });

  test('garbage (non-hex) signature → 401, no write', async () => {
    const { id, hash16 } = await seedDispatched('rec-garbage');
    const { rawBody } = signedBody({ status: 'opened', branch: BRANCH, pr_url: PR_URL, source_record_id_hash: hash16 });
    const result = await handlePromotionCallback({ rawBody, signatureHeader: 'not-hex-!!!', secret: SECRET, engine });
    expect((result as Extract<PromotionCallbackResult, { ok: false }>).status).toBe(401);
    expect((await readRow(id)).promotion_status).toBeNull();
  });

  test('missing secret → 500 fail-closed (no write, body never parsed)', async () => {
    const { id, hash16 } = await seedDispatched('rec-nosecret');
    const { rawBody, signature } = signedBody({ status: 'opened', branch: BRANCH, pr_url: PR_URL, source_record_id_hash: hash16 });
    const result = await handlePromotionCallback({ rawBody, signatureHeader: signature, secret: undefined, engine });
    expect((result as Extract<PromotionCallbackResult, { ok: false }>).status).toBe(500);
    expect((await readRow(id)).promotion_status).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────
// Body validation — strict 4-key shape
// ─────────────────────────────────────────────────────────────────
describe('body validation (strict 4-key shape)', () => {
  // Sign whatever bytes we hand it, so the body reaches the validator (not the sig gate).
  function signRaw(raw: string): { rawBody: Buffer; signature: string } {
    const rawBody = Buffer.from(raw, 'utf8');
    return { rawBody, signature: createHmac('sha256', SECRET).update(rawBody).digest('hex') };
  }

  test('missing key → 400, no write', async () => {
    const { id, hash16 } = await seedDispatched('rec-missing');
    // drop pr_url
    const { rawBody, signature } = signRaw(JSON.stringify({ branch: BRANCH, source_record_id_hash: hash16, status: 'opened' }));
    const result = await handlePromotionCallback({ rawBody, signatureHeader: signature, secret: SECRET, engine });
    expect((result as Extract<PromotionCallbackResult, { ok: false }>).status).toBe(400);
    expect((await readRow(id)).promotion_status).toBeNull();
  });

  test('extra/unknown key → 400, no write', async () => {
    const { id, hash16 } = await seedDispatched('rec-extra');
    const { rawBody, signature } = signRaw(JSON.stringify({
      branch: BRANCH, pr_url: PR_URL, source_record_id_hash: hash16, status: 'opened', nonce: 'x',
    }));
    const result = await handlePromotionCallback({ rawBody, signatureHeader: signature, secret: SECRET, engine });
    expect((result as Extract<PromotionCallbackResult, { ok: false }>).status).toBe(400);
    expect((await readRow(id)).promotion_status).toBeNull();
  });

  test('unknown status value → 400, no write', async () => {
    const { id, hash16 } = await seedDispatched('rec-badstatus');
    const { rawBody, signature } = signRaw(JSON.stringify({
      branch: BRANCH, pr_url: PR_URL, source_record_id_hash: hash16, status: 'indexed',
    }));
    const result = await handlePromotionCallback({ rawBody, signatureHeader: signature, secret: SECRET, engine });
    expect((result as Extract<PromotionCallbackResult, { ok: false }>).status).toBe(400);
    expect((await readRow(id)).promotion_status).toBeNull();
  });

  test('wrong type (status not a string) → 400, no write', async () => {
    const { id, hash16 } = await seedDispatched('rec-wrongtype');
    const { rawBody, signature } = signRaw(JSON.stringify({
      branch: BRANCH, pr_url: PR_URL, source_record_id_hash: hash16, status: 5,
    }));
    const result = await handlePromotionCallback({ rawBody, signatureHeader: signature, secret: SECRET, engine });
    expect((result as Extract<PromotionCallbackResult, { ok: false }>).status).toBe(400);
    expect((await readRow(id)).promotion_status).toBeNull();
  });

  test('malformed JSON → 400, no write', async () => {
    const { id } = await seedDispatched('rec-malformed');
    const { rawBody, signature } = signRaw('{not json');
    const result = await handlePromotionCallback({ rawBody, signatureHeader: signature, secret: SECRET, engine });
    expect((result as Extract<PromotionCallbackResult, { ok: false }>).status).toBe(400);
    expect((await readRow(id)).promotion_status).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────
// opened → pr_opened (mapping is load-bearing)
// ─────────────────────────────────────────────────────────────────
describe('status mapping: opened → pr_opened', () => {
  test('writes pr_opened + pr_url + branch + promoted_at', async () => {
    const { id, hash16 } = await seedDispatched('rec-opened');
    const { rawBody, signature } = signedBody({ status: 'opened', branch: BRANCH, pr_url: PR_URL, source_record_id_hash: hash16 });

    const result = await handlePromotionCallback({ rawBody, signatureHeader: signature, secret: SECRET, engine });
    expect(result.ok).toBe(true);
    const ok = result as Extract<PromotionCallbackResult, { ok: true }>;
    expect(ok.status).toBe(200);
    expect(ok.candidateId).toBe(id);
    expect(ok.mappedStatus).toBe('pr_opened');

    const after = await readRow(id);
    // 'opened' is NOT a valid promotion_status — the mapping to 'pr_opened' is load-bearing.
    expect(after.promotion_status).toBe('pr_opened');
    expect(after.promotion_pr_url).toBe(PR_URL);
    expect(after.promotion_branch).toBe(BRANCH);
    expect(after.promoted_at).not.toBeNull();
    // the accept decision is untouched.
    expect(after.status).toBe('accepted');
  });
});

// ─────────────────────────────────────────────────────────────────
// failed → 'failed', status stays 'accepted'
// ─────────────────────────────────────────────────────────────────
describe('status mapping: failed → failed (status stays accepted)', () => {
  test("sets promotion_status='failed' and leaves status='accepted' (NOT rejected)", async () => {
    const { id, hash16 } = await seedDispatched('rec-failed');
    // On failure the Brain sends empty branch + pr_url.
    const { rawBody, signature } = signedBody({ status: 'failed', branch: '', pr_url: '', source_record_id_hash: hash16 });

    const result = await handlePromotionCallback({ rawBody, signatureHeader: signature, secret: SECRET, engine });
    expect(result.ok).toBe(true);
    expect((result as Extract<PromotionCallbackResult, { ok: true }>).mappedStatus).toBe('failed');

    const after = await readRow(id);
    expect(after.promotion_status).toBe('failed');
    expect(after.status).toBe('accepted'); // ← NOT 'rejected'
    // 'failed' patch sets ONLY promotion_status — pr_url/branch/promoted_at stay untouched.
    expect(after.promotion_pr_url).toBeNull();
    expect(after.promotion_branch).toBeNull();
    expect(after.promoted_at).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────
// Identity by source_record_id_hash — right row, neighbours untouched
// ─────────────────────────────────────────────────────────────────
describe('identity by source_record_id_hash', () => {
  test('matches the RIGHT row and leaves a non-matching candidate untouched', async () => {
    const target = await seedDispatched('rec-target');
    const other = await seedDispatched('rec-other');

    const { rawBody, signature } = signedBody({ status: 'opened', branch: BRANCH, pr_url: PR_URL, source_record_id_hash: target.hash16 });
    const result = await handlePromotionCallback({ rawBody, signatureHeader: signature, secret: SECRET, engine });
    expect(result.ok).toBe(true);
    expect((result as Extract<PromotionCallbackResult, { ok: true }>).candidateId).toBe(target.id);

    const matched = await readRow(target.id);
    expect(matched.promotion_status).toBe('pr_opened');

    const neighbour = await readRow(other.id);
    expect(neighbour.promotion_status).toBeNull();
    expect(neighbour.promotion_pr_url).toBeNull();
    expect(neighbour.promoted_at).toBeNull();
  });

  test('no dispatched candidate matches the hash → 404, no write', async () => {
    const { id } = await seedDispatched('rec-present');
    // A hash that no seeded candidate produces.
    const orphanHash = sourceRecordIdHash16('rec-never-dispatched');
    const { rawBody, signature } = signedBody({ status: 'opened', branch: BRANCH, pr_url: PR_URL, source_record_id_hash: orphanHash });
    const result = await handlePromotionCallback({ rawBody, signatureHeader: signature, secret: SECRET, engine });
    expect((result as Extract<PromotionCallbackResult, { ok: false }>).status).toBe(404);
    expect((await readRow(id)).promotion_status).toBeNull();
  });

  test('a candidate not in the dispatched set (status=pending) is never matched → 404', async () => {
    // Seed a PENDING candidate (no accept, no artifact_hash) — outside the SELECT scope.
    const { row } = await toRow(engine, { source_id: 'default', source_record_id: 'rec-pending', provider: 'crunchbase', proposed_markdown: '# p' });
    const hash16 = sourceRecordIdHash16('rec-pending');
    const { rawBody, signature } = signedBody({ status: 'opened', branch: BRANCH, pr_url: PR_URL, source_record_id_hash: hash16 });
    const result = await handlePromotionCallback({ rawBody, signatureHeader: signature, secret: SECRET, engine });
    expect((result as Extract<PromotionCallbackResult, { ok: false }>).status).toBe(404);
    expect((await readRow(row.id)).promotion_status).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────
// Allowlist — no other column / row mutated
// ─────────────────────────────────────────────────────────────────
describe('allowlisted writeback (no other column or row mutated)', () => {
  test('opened touches ONLY the 4 promotion columns on the matched row', async () => {
    const { id, hash16 } = await seedDispatched('rec-allow', { provider: 'crunchbase' });
    const before = await readRow(id);

    const { rawBody, signature } = signedBody({ status: 'opened', branch: BRANCH, pr_url: PR_URL, source_record_id_hash: hash16 });
    await handlePromotionCallback({ rawBody, signatureHeader: signature, secret: SECRET, engine });
    const after = await readRow(id);

    // Identity / content / decision columns are byte-for-byte unchanged.
    expect(after.source_id).toBe(before.source_id);
    expect(after.source_record_id).toBe(before.source_record_id);
    expect(after.provider).toBe(before.provider);
    expect(after.proposed_markdown).toBe(before.proposed_markdown);
    expect(after.proposed_slug).toBe(before.proposed_slug);
    expect(after.status).toBe(before.status); // 'accepted'
    expect(after.status_reason).toBe(before.status_reason);
    expect(after.target_kind).toBe(before.target_kind);
    expect(after.target_path).toBe(before.target_path);
    expect(after.artifact_hash).toBe(before.artifact_hash);
    expect(after.version).toBe(before.version);

    // ONLY these changed.
    expect(after.promotion_status).toBe('pr_opened');
    expect(after.promotion_pr_url).toBe(PR_URL);
    expect(after.promotion_branch).toBe(BRANCH);
    expect(after.promoted_at).not.toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────
// Idempotency — duplicate delivery is a no-op
// ─────────────────────────────────────────────────────────────────
describe('idempotency (replay-safe)', () => {
  test('duplicate opened delivery → same 200, same values, no double-mutate', async () => {
    const { id, hash16 } = await seedDispatched('rec-dup');
    const { rawBody, signature } = signedBody({ status: 'opened', branch: BRANCH, pr_url: PR_URL, source_record_id_hash: hash16 });

    const first = await handlePromotionCallback({ rawBody, signatureHeader: signature, secret: SECRET, engine });
    expect(first.ok).toBe(true);
    const afterFirst = await readRow(id);

    // Re-deliver the IDENTICAL signed body.
    const second = await handlePromotionCallback({ rawBody, signatureHeader: signature, secret: SECRET, engine });
    expect(second.ok).toBe(true);
    expect((second as Extract<PromotionCallbackResult, { ok: true }>).status).toBe(200);
    const afterSecond = await readRow(id);

    // Same terminal values (the writeback is a no-op on replay).
    expect(afterSecond.promotion_status).toBe('pr_opened');
    expect(afterSecond.promotion_pr_url).toBe(afterFirst.promotion_pr_url);
    expect(afterSecond.promotion_branch).toBe(afterFirst.promotion_branch);
    expect(afterSecond.status).toBe('accepted');
  });
});

// ─────────────────────────────────────────────────────────────────
// Monotonic guard (stale 'opened' replay) + >1-match fail-closed
// ─────────────────────────────────────────────────────────────────
describe('monotonic guard + ambiguous match', () => {
  test("a stale 'opened' replayed after 'failed' is ignored — no downgrade, no promoted_at re-stamp", async () => {
    const { id, hash16 } = await seedDispatched('rec-stale');

    // The Brain first reports failure → promotion_status='failed'.
    const failed = signedBody({ status: 'failed', branch: '', pr_url: '', source_record_id_hash: hash16 });
    const r1 = await handlePromotionCallback({ rawBody: failed.rawBody, signatureHeader: failed.signature, secret: SECRET, engine });
    expect(r1.ok).toBe(true);
    expect((await readRow(id)).promotion_status).toBe('failed');

    // An OLD 'opened' delivery (still a valid MAC — no nonce/expiry) is replayed.
    const opened = signedBody({ status: 'opened', branch: BRANCH, pr_url: PR_URL, source_record_id_hash: hash16 });
    const r2 = await handlePromotionCallback({ rawBody: opened.rawBody, signatureHeader: opened.signature, secret: SECRET, engine });
    expect(r2.ok).toBe(true);
    expect((r2 as Extract<PromotionCallbackResult, { ok: true }>).status).toBe(200);

    // The row stays 'failed' — the stale 'opened' did NOT revert it or re-stamp promoted_at.
    const after = await readRow(id);
    expect(after.promotion_status).toBe('failed');
    expect(after.promotion_pr_url).toBeNull();
    expect(after.promoted_at).toBeNull();
    expect(after.status).toBe('accepted');
  });

  test('>1 dispatched candidates share a source_record_id → fail closed (409, ZERO writes)', async () => {
    const srid = 'rec-multiversion';
    const a = await toRow(engine, { source_id: 'default', source_record_id: srid, version: '1', provider: 'crunchbase', proposed_markdown: '# a' });
    const b = await toRow(engine, { source_id: 'default', source_record_id: srid, version: '2', provider: 'crunchbase', proposed_markdown: '# b' });
    // Both dispatched (accepted + artifact_hash) and share the same source_record_id hash.
    await engine.executeRaw(`UPDATE connector_candidates SET status='accepted', artifact_hash='h1', acted_at='2026-06-01T00:00:00Z' WHERE id=$1`, [a.row.id]);
    await engine.executeRaw(`UPDATE connector_candidates SET status='accepted', artifact_hash='h2', acted_at='2026-06-10T00:00:00Z' WHERE id=$1`, [b.row.id]);

    const { rawBody, signature } = signedBody({ status: 'opened', branch: BRANCH, pr_url: PR_URL, source_record_id_hash: sourceRecordIdHash16(srid) });
    const r = await handlePromotionCallback({ rawBody, signatureHeader: signature, secret: SECRET, engine });

    // Fail closed: the Brain body carries no source_id/provider/candidate_id/artifact_hash, so
    // gbrain cannot disambiguate and refuses — a write path must NEVER guess which row to mutate.
    expect(r.ok).toBe(false);
    expect((r as Extract<PromotionCallbackResult, { ok: false }>).status).toBe(409);

    // NEITHER row was mutated.
    expect((await readRow(a.row.id)).promotion_status).toBeNull();
    expect((await readRow(b.row.id)).promotion_status).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────
// Logging discipline (AC7): no secret / signature / raw body in logs
// ─────────────────────────────────────────────────────────────────
describe('logging discipline (AC7)', () => {
  afterEach(() => {
    // restored inside the test's finally, but guard against an early throw.
  });

  test('captured logs never contain the secret, the signature, or the raw body', async () => {
    const { id, hash16 } = await seedDispatched('rec-log');
    // Embed a recognizable marker in the pr_url so we can assert the raw body never leaked.
    const markerPrUrl = 'https://github.com/Techtrisdev/techtris-brain/pull/777?marker=RAWBODYLEAK';
    const { rawBody, signature } = signedBody({ status: 'opened', branch: BRANCH, pr_url: markerPrUrl, source_record_id_hash: hash16 });

    const captured: string[] = [];
    const origLog = console.log;
    const origErr = console.error;
    const origWarn = console.warn;
    console.log = (...a: unknown[]) => { captured.push(a.map(String).join(' ')); };
    console.error = (...a: unknown[]) => { captured.push(a.map(String).join(' ')); };
    console.warn = (...a: unknown[]) => { captured.push(a.map(String).join(' ')); };
    try {
      await handlePromotionCallback({ rawBody, signatureHeader: signature, secret: SECRET, engine });
    } finally {
      console.log = origLog;
      console.error = origErr;
      console.warn = origWarn;
    }

    const all = captured.join('\n');
    expect(all).not.toContain(SECRET);
    expect(all).not.toContain(signature);
    expect(all).not.toContain(rawBody.toString('utf8'));
    expect(all).not.toContain('RAWBODYLEAK'); // raw body content never logged
    // It IS allowed to log status + source_record_id_hash + candidate id.
    expect(all).toContain(hash16);
    expect(all).toContain(`candidate_id=${id}`);
  });

  test('a forged-signature rejection logs neither the signature nor any body content', async () => {
    const { hash16 } = await seedDispatched('rec-logforge');
    const markerPrUrl = 'https://x/pull/9?marker=FORGEDLEAK';
    const { rawBody } = signedBody({ status: 'opened', branch: BRANCH, pr_url: markerPrUrl, source_record_id_hash: hash16 });
    const forgedSig = 'abad1dea'.repeat(8);

    const captured: string[] = [];
    const origWarn = console.warn;
    const origErr = console.error;
    console.warn = (...a: unknown[]) => { captured.push(a.map(String).join(' ')); };
    console.error = (...a: unknown[]) => { captured.push(a.map(String).join(' ')); };
    try {
      await handlePromotionCallback({ rawBody, signatureHeader: forgedSig, secret: SECRET, engine });
    } finally {
      console.warn = origWarn;
      console.error = origErr;
    }
    const all = captured.join('\n');
    expect(all).not.toContain(forgedSig);
    expect(all).not.toContain('FORGEDLEAK'); // body never parsed/logged on a sig failure
    expect(all).not.toContain(SECRET);
  });
});
