/**
 * Tests for the gbrain side of the TECH-2109 connector→Brain promotion bridge.
 *
 * Covers (per the ticket test matrix):
 *  - canonical determinism: same artifact → same bytes / same hash, key order irrelevant.
 *  - the artifact has EXACTLY the 5 top-level keys + target has EXACTLY 4 keys (drift guard).
 *  - hex signature verifies against an independent node:crypto recomputation.
 *  - path validation rejects '..' / absolute / URL-scheme / backslash; existing_page needs a path.
 *  - emit failure → candidate stays accepted with NO promotion_status (injected failing http).
 *  - successful emit → promotion_status set.
 *  - log-capture: no secret / signature / full artifact ever logged.
 *  - duplicate approve is a guarded no-op.
 *
 * NO real network, NO real repository_dispatch — every external I/O is injected.
 *
 * Canonical PGLite block: one engine per file, beforeEach resets data, afterAll disconnects.
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach } from 'bun:test';
import { createHmac } from 'node:crypto';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { toRow, approveCandidate, validatePromotionTarget, registerPromotionHook, PromotionTargetError } from '../src/core/connectors/candidate.ts';
import {
  buildPromotionArtifact,
  canonicalizeArtifactForSigning,
  signArtifact,
  artifactHash,
  emitRepositoryDispatch,
  updateCandidatePromotionState,
  REDACTION_ATTESTATION,
  PROMOTION_EVENT_TYPE,
  BRAIN_DISPATCH_REPO,
  type PromotionArtifact,
  type PromotionTarget,
  type FetchFn,
} from '../src/core/connectors/promotion.ts';
import { makePromotionHook } from '../src/core/connectors/promotion-hook.ts';

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
const TOKEN = 'ghs_faketoken_never_real';

// A representative row shape for the pure-function tests.
const ROW = {
  provider: 'crunchbase',
  source_id: 'default',
  source_record_id: 'rec-abc-123',
  proposed_markdown: '# ACME\n\nA company body.',
};
const INBOX: PromotionTarget = { kind: 'inbox', path: '' };

// ─────────────────────────────────────────────────────────────────
// Canonicalization determinism + idempotency hash
// ─────────────────────────────────────────────────────────────────
describe('canonicalizeArtifactForSigning: determinism', () => {
  test('same artifact → identical canonical string and identical hash', () => {
    const a = buildPromotionArtifact(ROW, INBOX);
    const b = buildPromotionArtifact(ROW, INBOX);
    const ca = canonicalizeArtifactForSigning(a);
    const cb = canonicalizeArtifactForSigning(b);
    expect(ca).toBe(cb);
    expect(artifactHash(ca)).toBe(artifactHash(cb));
    expect(artifactHash(ca)).toMatch(/^[0-9a-f]{64}$/);
  });

  test('key order is irrelevant — a reordered artifact canonicalizes identically', () => {
    const a = buildPromotionArtifact(ROW, INBOX);
    const canonical = canonicalizeArtifactForSigning(a);
    // Rebuild the same logical artifact with keys in a DIFFERENT insertion order.
    const reordered: PromotionArtifact = {
      target: { body: a.target.body, path: a.target.path, mode: a.target.mode, timeline_entry: a.target.timeline_entry },
      redaction_attestation: a.redaction_attestation,
      source_record_id: a.source_record_id,
      source_id: a.source_id,
      provider: a.provider,
    };
    expect(canonicalizeArtifactForSigning(reordered)).toBe(canonical);
  });

  test('canonical string has no insignificant whitespace', () => {
    const canonical = canonicalizeArtifactForSigning(buildPromotionArtifact(ROW, INBOX));
    // JSON.stringify with no spacer: no ": " or ", " separators.
    expect(canonical).not.toContain(': ');
    expect(canonical).not.toContain(', ');
    expect(canonical.startsWith('{')).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────
// Exact-key schema (drift guard against the Brain's fail-closed validate_artifact)
// ─────────────────────────────────────────────────────────────────
describe('buildPromotionArtifact: exact-key shape', () => {
  test('artifact has EXACTLY the 5 top-level keys', () => {
    const a = buildPromotionArtifact(ROW, INBOX);
    expect(Object.keys(a).sort()).toEqual(
      ['provider', 'redaction_attestation', 'source_id', 'source_record_id', 'target'].sort(),
    );
  });

  test('target has EXACTLY the 4 keys', () => {
    const a = buildPromotionArtifact(ROW, INBOX);
    expect(Object.keys(a.target).sort()).toEqual(['body', 'mode', 'path', 'timeline_entry'].sort());
  });

  test('source_record_id is the FULL id (never hashed); redaction_attestation is the v1 string', () => {
    const a = buildPromotionArtifact(ROW, INBOX);
    expect(a.source_record_id).toBe('rec-abc-123');
    expect(a.redaction_attestation).toBe(REDACTION_ATTESTATION);
    expect(a.target.mode).toBe('inbox');
  });

  test('existing_page target carries the reviewer path as target.path', () => {
    const a = buildPromotionArtifact(ROW, { kind: 'existing_page', path: 'companies/acme.md' });
    expect(a.target.mode).toBe('existing_page');
    expect(a.target.path).toBe('companies/acme.md');
  });

  test('body + timeline_entry run through strip() (a pasted secret is masked)', () => {
    const a = buildPromotionArtifact(
      { ...ROW, proposed_markdown: 'leak AKIAIOSFODNN7EXAMPLE here' },
      INBOX,
    );
    expect(a.target.body).not.toContain('AKIAIOSFODNN7EXAMPLE');
    expect(a.target.body).toContain('[REDACTED]');
  });
});

// ─────────────────────────────────────────────────────────────────
// Signature: hex HMAC verifies against an INDEPENDENT recomputation
// ─────────────────────────────────────────────────────────────────
describe('signArtifact: hex HMAC verification', () => {
  test('signature is lowercase hex and matches an independent node:crypto HMAC', () => {
    const canonical = canonicalizeArtifactForSigning(buildPromotionArtifact(ROW, INBOX));
    const sig = signArtifact(canonical, SECRET);
    expect(sig).toMatch(/^[0-9a-f]{64}$/);
    // Independent recomputation, exactly as the Brain's verify_and_parse does (hex first).
    const expected = createHmac('sha256', SECRET).update(Buffer.from(canonical, 'utf8')).digest('hex');
    expect(sig).toBe(expected);
  });

  test('a different secret yields a different signature', () => {
    const canonical = canonicalizeArtifactForSigning(buildPromotionArtifact(ROW, INBOX));
    expect(signArtifact(canonical, SECRET)).not.toBe(signArtifact(canonical, 'other-secret'));
  });
});

// ─────────────────────────────────────────────────────────────────
// Path validation (server-side, rejects before any write)
// ─────────────────────────────────────────────────────────────────
describe('validatePromotionTarget: path sandbox', () => {
  test('rejects a ".." traversal segment', () => {
    expect(() => validatePromotionTarget({ kind: 'existing_page', path: '../etc/passwd' })).toThrow(PromotionTargetError);
    expect(() => validatePromotionTarget({ kind: 'existing_page', path: 'a/../../b.md' })).toThrow(PromotionTargetError);
  });
  test('rejects an absolute path (leading / or ~)', () => {
    expect(() => validatePromotionTarget({ kind: 'existing_page', path: '/etc/passwd' })).toThrow(PromotionTargetError);
    expect(() => validatePromotionTarget({ kind: 'existing_page', path: '~/secrets.md' })).toThrow(PromotionTargetError);
  });
  test('rejects a backslash', () => {
    expect(() => validatePromotionTarget({ kind: 'existing_page', path: 'a\\b.md' })).toThrow(PromotionTargetError);
  });
  test('rejects a NUL byte', () => {
    expect(() => validatePromotionTarget({ kind: 'existing_page', path: 'a\x00b.md' })).toThrow(PromotionTargetError);
  });
  test('rejects a URL scheme', () => {
    expect(() => validatePromotionTarget({ kind: 'existing_page', path: 'https://evil.test/x.md' })).toThrow(PromotionTargetError);
    expect(() => validatePromotionTarget({ kind: 'inbox', path: 'file://x' })).toThrow(PromotionTargetError);
  });
  test('existing_page REQUIRES a non-empty path', () => {
    expect(() => validatePromotionTarget({ kind: 'existing_page', path: '' })).toThrow(PromotionTargetError);
    expect(() => validatePromotionTarget({ kind: 'existing_page', path: '   ' })).toThrow(PromotionTargetError);
  });
  test('rejects non-canonical paths that a substring/segment-equality check would let pass', () => {
    // Leading whitespace that would defeat startsWith('/') in a naive check.
    expect(() => validatePromotionTarget({ kind: 'existing_page', path: ' /etc/passwd' })).toThrow(PromotionTargetError);
    expect(() => validatePromotionTarget({ kind: 'existing_page', path: 'companies/acme.md ' })).toThrow(PromotionTargetError);
    // Single-dot and literal multi-dot segments (non-canonical; not caught by '..'-equality).
    expect(() => validatePromotionTarget({ kind: 'existing_page', path: 'a/./b.md' })).toThrow(PromotionTargetError);
    expect(() => validatePromotionTarget({ kind: 'existing_page', path: '....//....//etc/passwd' })).toThrow(PromotionTargetError);
    // Dotfiles / dot-directories (e.g. a CI-exec vector onto .github/workflows).
    expect(() => validatePromotionTarget({ kind: 'existing_page', path: '.git/hooks/pre-commit' })).toThrow(PromotionTargetError);
    expect(() => validatePromotionTarget({ kind: 'existing_page', path: '.github/workflows/x.yml' })).toThrow(PromotionTargetError);
    // Empty interior segment from '//'.
    expect(() => validatePromotionTarget({ kind: 'existing_page', path: 'a//b.md' })).toThrow(PromotionTargetError);
  });
  test('inbox MAY omit the path; a clean relative existing_page path is allowed', () => {
    expect(() => validatePromotionTarget({ kind: 'inbox', path: '' })).not.toThrow();
    expect(() => validatePromotionTarget({ kind: 'existing_page', path: 'companies/acme.md' })).not.toThrow();
    expect(() => validatePromotionTarget({ kind: 'inbox', path: 'inbox/2026-06-16-acme-raise.md' })).not.toThrow();
  });
});

// ─────────────────────────────────────────────────────────────────
// emitRepositoryDispatch: payload shape + opaque-string + failure
// ─────────────────────────────────────────────────────────────────
describe('emitRepositoryDispatch: payload + injected fetch', () => {
  test('posts the opaque canonical STRING + hex signature to the Brain dispatches endpoint', async () => {
    const canonical = canonicalizeArtifactForSigning(buildPromotionArtifact(ROW, INBOX));
    const signature = signArtifact(canonical, SECRET);
    const calls: { url: string; init: any }[] = [];
    const fetchFn: FetchFn = async (url, init) => {
      calls.push({ url, init });
      return { ok: true, status: 204, text: async () => '' };
    };
    const res = await emitRepositoryDispatch({ canonical, signature, githubToken: TOKEN, fetchFn });
    expect(res.ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(`https://api.github.com/repos/${BRAIN_DISPATCH_REPO}/dispatches`);
    const sent = JSON.parse(calls[0].init.body);
    expect(sent.event_type).toBe(PROMOTION_EVENT_TYPE);
    // The artifact travels as an OPAQUE STRING, not a nested object.
    expect(typeof sent.client_payload.artifact).toBe('string');
    expect(sent.client_payload.artifact).toBe(canonical);
    expect(sent.client_payload.signature).toBe(signature);
    // Auth headers present.
    expect(calls[0].init.headers.authorization).toBe(`Bearer ${TOKEN}`);
    expect(calls[0].init.headers.accept).toBe('application/vnd.github+json');
    expect(calls[0].init.headers['x-github-api-version']).toBe('2022-11-28');
  });

  test('a delivered artifact STRING round-trips to the same bytes the Brain would verify', async () => {
    // Models the Brain: json.loads(toJSON(artifact)) → isinstance(str) → .encode().
    const canonical = canonicalizeArtifactForSigning(buildPromotionArtifact(ROW, INBOX));
    const signature = signArtifact(canonical, SECRET);
    let delivered = '';
    const fetchFn: FetchFn = async (_url, init) => {
      delivered = JSON.parse(init.body).client_payload.artifact;
      return { ok: true, status: 204, text: async () => '' };
    };
    await emitRepositoryDispatch({ canonical, signature, githubToken: TOKEN, fetchFn });
    // The Brain re-derives the MAC over the delivered string bytes; it must match.
    const brainMac = createHmac('sha256', SECRET).update(Buffer.from(delivered, 'utf8')).digest('hex');
    expect(brainMac).toBe(signature);
  });

  test('a non-2xx response throws (so the candidate stays retriable)', async () => {
    const fetchFn: FetchFn = async () => ({ ok: false, status: 403, text: async () => 'forbidden' });
    await expect(
      emitRepositoryDispatch({ canonical: '{}', signature: 'aa', githubToken: TOKEN, fetchFn }),
    ).rejects.toThrow(/status=403/);
  });
});

// ─────────────────────────────────────────────────────────────────
// updateCandidatePromotionState: allowlisted UPDATE
// ─────────────────────────────────────────────────────────────────
describe('updateCandidatePromotionState', () => {
  test('writes promotion_status / pr_url / branch and stamps promoted_at', async () => {
    const { row } = await toRow(engine, { source_id: 'default', source_record_id: 'ups-1', proposed_markdown: 'x' });
    const updated = await updateCandidatePromotionState(engine, row.id, {
      promotion_status: 'indexed',
      promotion_pr_url: 'https://github.com/Techtrisdev/techtris-brain/pull/9',
      promotion_branch: 'promote/crunchbase-abc123',
      promoted: true,
    });
    expect(updated!.promotion_status).toBe('indexed');
    expect(updated!.promotion_pr_url).toContain('/pull/9');
    expect(updated!.promotion_branch).toBe('promote/crunchbase-abc123');
    expect(updated!.promoted_at).not.toBeNull();
    // status (the accept decision) is untouched by this path.
    expect(updated!.status).toBe('pending');
  });

  test('returns null for a missing id', async () => {
    expect(await updateCandidatePromotionState(engine, 9999999, { promotion_status: 'failed' })).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────
// approveCandidate + promotion hook: emit failure vs success + persistence
// ─────────────────────────────────────────────────────────────────
describe('approveCandidate + promotion hook (end-to-end, injected fetch)', () => {
  afterEach(() => registerPromotionHook(null));

  const deps = (fetchFn: FetchFn) => ({
    getSecret: () => SECRET,
    getGithubToken: () => TOKEN,
    fetchFn,
  });

  test('persists target_kind / target_path / artifact_hash in the accept UPDATE', async () => {
    const { row } = await toRow(engine, { source_id: 'default', source_record_id: 'ap-1', provider: 'crunchbase', proposed_markdown: '# ACME' });
    const res = await approveCandidate(engine, row.id, 'admin', { kind: 'existing_page', path: 'companies/acme.md' });
    expect(res.row!.status).toBe('accepted');
    expect(res.row!.target_kind).toBe('existing_page');
    expect(res.row!.target_path).toBe('companies/acme.md');
    // The stored hash equals an independent recomputation off the same row + target.
    const expectedHash = artifactHash(
      canonicalizeArtifactForSigning(buildPromotionArtifact(
        { provider: 'crunchbase', source_id: 'default', source_record_id: 'ap-1', proposed_markdown: '# ACME' },
        { kind: 'existing_page', path: 'companies/acme.md' },
      )),
    );
    expect(res.row!.artifact_hash).toBe(expectedHash);
  });

  test('emit failure → candidate accepted with NO promotion_status (retriable)', async () => {
    const failing: FetchFn = async () => ({ ok: false, status: 500, text: async () => 'boom' });
    registerPromotionHook(makePromotionHook(deps(failing)));
    const { row } = await toRow(engine, { source_id: 'default', source_record_id: 'ap-fail', provider: 'crunchbase', proposed_markdown: '# X' });
    const res = await approveCandidate(engine, row.id, 'admin', INBOX);
    expect(res.row!.status).toBe('accepted');         // decision committed
    expect(res.promotion.invoked).toBe(false);
    expect(res.promotion.pending).toBe(true);          // retriable
    // Re-read: promotion_status MUST be null (never marked promoted on failure).
    const [after] = await engine.executeRaw<{ promotion_status: string | null }>(
      `SELECT promotion_status FROM connector_candidates WHERE id = $1`, [row.id],
    );
    expect(after.promotion_status).toBeNull();
  });

  test('successful emit → promotion_status set to pr_opened', async () => {
    const ok: FetchFn = async () => ({ ok: true, status: 204, text: async () => '' });
    registerPromotionHook(makePromotionHook(deps(ok)));
    const { row } = await toRow(engine, { source_id: 'default', source_record_id: 'ap-ok', provider: 'crunchbase', proposed_markdown: '# X' });
    const res = await approveCandidate(engine, row.id, 'admin', INBOX);
    expect(res.promotion.invoked).toBe(true);
    const [after] = await engine.executeRaw<{ promotion_status: string | null }>(
      `SELECT promotion_status FROM connector_candidates WHERE id = $1`, [row.id],
    );
    expect(after.promotion_status).toBe('pr_opened');
  });

  test('duplicate approve is an idempotent no-op (status guard → second call row null)', async () => {
    const ok: FetchFn = async () => ({ ok: true, status: 204, text: async () => '' });
    registerPromotionHook(makePromotionHook(deps(ok)));
    const { row } = await toRow(engine, { source_id: 'default', source_record_id: 'ap-dup', provider: 'crunchbase', proposed_markdown: '# X' });
    const first = await approveCandidate(engine, row.id, 'admin', INBOX);
    expect(first.row!.status).toBe('accepted');
    const second = await approveCandidate(engine, row.id, 'admin', INBOX);
    expect(second.row).toBeNull(); // guarded by status='pending'
  });

  test('an unsafe target throws before any write (no row mutated)', async () => {
    const { row } = await toRow(engine, { source_id: 'default', source_record_id: 'ap-unsafe', proposed_markdown: '# X' });
    await expect(
      approveCandidate(engine, row.id, 'admin', { kind: 'existing_page', path: '../escape.md' }),
    ).rejects.toThrow(PromotionTargetError);
    const [after] = await engine.executeRaw<{ status: string }>(
      `SELECT status FROM connector_candidates WHERE id = $1`, [row.id],
    );
    expect(after.status).toBe('pending'); // untouched
  });
});

// ─────────────────────────────────────────────────────────────────
// Logging discipline (AC7): no secret / signature / full artifact in logs
// ─────────────────────────────────────────────────────────────────
describe('promotion hook logging discipline (AC7)', () => {
  afterEach(() => registerPromotionHook(null));

  test('captured logs never contain the secret, the signature, or the full artifact', async () => {
    const captured: string[] = [];
    const origLog = console.log;
    const origErr = console.error;
    const origWarn = console.warn;
    console.log = (...a: unknown[]) => { captured.push(a.map(String).join(' ')); };
    console.error = (...a: unknown[]) => { captured.push(a.map(String).join(' ')); };
    console.warn = (...a: unknown[]) => { captured.push(a.map(String).join(' ')); };

    let signature = '';
    let canonical = '';
    try {
      const fetchFn: FetchFn = async (_u, init) => {
        const sent = JSON.parse(init.body);
        canonical = sent.client_payload.artifact;
        signature = sent.client_payload.signature;
        return { ok: true, status: 204, text: async () => '' };
      };
      registerPromotionHook(makePromotionHook({ getSecret: () => SECRET, getGithubToken: () => TOKEN, fetchFn }));
      const { row } = await toRow(engine, { source_id: 'default', source_record_id: 'log-1', provider: 'crunchbase', proposed_markdown: '# Secret body AKIAIOSFODNN7EXAMPLE' });
      await approveCandidate(engine, row.id, 'admin', INBOX);
    } finally {
      console.log = origLog;
      console.error = origErr;
      console.warn = origWarn;
    }

    const all = captured.join('\n');
    expect(signature).toMatch(/^[0-9a-f]{64}$/);   // sanity: we actually emitted
    expect(all).not.toContain(SECRET);
    expect(all).not.toContain(signature);
    expect(all).not.toContain(canonical);          // the full artifact string
    // The allowlisted log fields ARE allowed (and present).
    expect(all).toContain('candidate_id=');
    expect(all).toContain('provider=crunchbase');
    expect(all).toContain('target_kind=inbox');
  });
});
