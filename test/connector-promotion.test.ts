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
import { createHmac, createHash } from 'node:crypto';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { toRow, approveCandidate, validatePromotionTarget, registerPromotionHook, PromotionTargetError, type PromotionHook } from '../src/core/connectors/candidate.ts';
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

// ═════════════════════════════════════════════════════════════════
// U4 — honor the stored consolidation UPDATE target through approve→artifact
// ═════════════════════════════════════════════════════════════════
//
// The cross-repo seam: a machine-decided UPDATE row carries the FULL pre-computed
// target (target_kind='update_page' + path + timeline_entry + base_compiled_hash).
// Approval must HONOR that stored target (not re-derive it from the reviewer HTTP
// request) and buildPromotionArtifact must emit the MODE-AWARE 5-key target the
// Brain receiver's validate_artifact expects (TARGET_SCHEMA | {base_compiled_hash}
// iff update_page, byte-unchanged 4-key otherwise).

// A structural sha256 hex (the compiled-truth gbrain merged against — KTD8).
const UPDATE_HASH = createHash('sha256').update('compiled-truth-v1').digest('hex');
// The classifier's REAL dated timeline line (NOT the hardcoded promoted-from string).
const UPDATE_TIMELINE = '2026-06-27: Merged the webhook-retry note into the integration page.';
// The merged compiled-truth body (clean — strip() is a no-op).
const MERGED_BODY = '# Toast\n\nUpdated compiled truth: webhook retries now back off exponentially.';
const UPDATE_TARGET: PromotionTarget = {
  kind: 'update_page',
  path: 'integrations/toast.md',
  timeline_entry: UPDATE_TIMELINE,
  base_compiled_hash: UPDATE_HASH,
};
const UPDATE_ROW = {
  provider: 'granola',
  source_id: 'default',
  source_record_id: 'rec-upd-1',
  proposed_markdown: MERGED_BODY,
};

describe('U4 buildPromotionArtifact: update_page mode-dependent shape', () => {
  test('update_page target carries EXACTLY 5 keys incl. base_compiled_hash', () => {
    const a = buildPromotionArtifact(UPDATE_ROW, UPDATE_TARGET);
    expect(a.target.mode).toBe('update_page');
    expect(Object.keys(a.target).sort()).toEqual(
      ['base_compiled_hash', 'body', 'mode', 'path', 'timeline_entry'].sort(),
    );
  });

  test('body = the merged body; timeline_entry = the LLM line (NOT the hardcoded promoted-from string)', () => {
    const a = buildPromotionArtifact(UPDATE_ROW, UPDATE_TARGET);
    expect(a.target.body).toBe(MERGED_BODY); // strip() is a no-op on clean content
    expect(a.target.timeline_entry).toBe(UPDATE_TIMELINE);
    expect(a.target.timeline_entry).not.toContain('Promoted from connector candidate');
    expect(a.target.path).toBe('integrations/toast.md');
  });

  test('base_compiled_hash is emitted VERBATIM (a structural sha256, never strip()-mangled)', () => {
    const a = buildPromotionArtifact(UPDATE_ROW, UPDATE_TARGET);
    expect(a.target.base_compiled_hash).toBe(UPDATE_HASH);
    expect(a.target.base_compiled_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  test('inbox/existing_page targets OMIT base_compiled_hash (key ABSENT, not null) — byte-unchanged 4-key', () => {
    const inbox = buildPromotionArtifact(ROW, INBOX);
    expect('base_compiled_hash' in inbox.target).toBe(false);
    expect(Object.keys(inbox.target)).toHaveLength(4);
    const existing = buildPromotionArtifact(ROW, { kind: 'existing_page', path: 'companies/acme.md' });
    expect('base_compiled_hash' in existing.target).toBe(false);
    expect(Object.keys(existing.target)).toHaveLength(4);
    // The 4-key target is byte-identical to pre-U4: hardcoded provenance timeline_entry.
    expect(inbox.target.timeline_entry).toContain('Promoted from connector candidate');
  });

  test('cross-repo key-set match: mirrors the receiver mode-aware TARGET_SCHEMA', () => {
    // promote_candidate.py: expected = TARGET_SCHEMA | {base_compiled_hash} iff update_page,
    // plain TARGET_SCHEMA (4 keys) otherwise. fail-closed on BOTH missing and unknown keys.
    const upd = buildPromotionArtifact(UPDATE_ROW, UPDATE_TARGET);
    expect(new Set(Object.keys(upd.target))).toEqual(
      new Set(['mode', 'path', 'timeline_entry', 'body', 'base_compiled_hash']),
    );
    const inbox = buildPromotionArtifact(ROW, INBOX);
    expect(new Set(Object.keys(inbox.target))).toEqual(
      new Set(['mode', 'path', 'timeline_entry', 'body']),
    );
  });

  test('omit-not-null: the canonical update_page string carries base_compiled_hash; the 4-key string does NOT', () => {
    // JSON.stringify drops an ABSENT key but KEEPS a null — so the omit (not null) is what
    // keeps the 4-key modes free of the key on the wire.
    const updJson = canonicalizeArtifactForSigning(buildPromotionArtifact(UPDATE_ROW, UPDATE_TARGET));
    expect(updJson).toContain('"base_compiled_hash"');
    expect(updJson).not.toContain('null');
    const inboxJson = canonicalizeArtifactForSigning(buildPromotionArtifact(ROW, INBOX));
    expect(inboxJson).not.toContain('base_compiled_hash');
  });
});

describe('U4 validatePromotionTarget: update_page requires path + base_compiled_hash', () => {
  test('accepts a valid update_page (non-empty path + base_compiled_hash)', () => {
    expect(() => validatePromotionTarget(UPDATE_TARGET)).not.toThrow();
  });
  test('rejects update_page with a missing/blank path', () => {
    expect(() => validatePromotionTarget({ kind: 'update_page', path: '', base_compiled_hash: UPDATE_HASH })).toThrow(PromotionTargetError);
    expect(() => validatePromotionTarget({ kind: 'update_page', path: '   ', base_compiled_hash: UPDATE_HASH })).toThrow(PromotionTargetError);
  });
  test('rejects update_page with a missing/blank base_compiled_hash', () => {
    expect(() => validatePromotionTarget({ kind: 'update_page', path: 'integrations/toast.md' })).toThrow(PromotionTargetError);
    expect(() => validatePromotionTarget({ kind: 'update_page', path: 'integrations/toast.md', base_compiled_hash: '   ' })).toThrow(PromotionTargetError);
  });
  test('update_page path is still held to the canonical sandbox (traversal/absolute rejected)', () => {
    expect(() => validatePromotionTarget({ kind: 'update_page', path: '../escape.md', base_compiled_hash: UPDATE_HASH })).toThrow(PromotionTargetError);
    expect(() => validatePromotionTarget({ kind: 'update_page', path: '/etc/passwd', base_compiled_hash: UPDATE_HASH })).toThrow(PromotionTargetError);
  });
});

describe('U4 canonical signing: stable + deterministic across the mode-varying key set', () => {
  test('an update_page artifact signs to a hex HMAC that an independent recomputation matches', () => {
    const canonical = canonicalizeArtifactForSigning(buildPromotionArtifact(UPDATE_ROW, UPDATE_TARGET));
    const sig = signArtifact(canonical, SECRET);
    expect(sig).toMatch(/^[0-9a-f]{64}$/);
    const expected = createHmac('sha256', SECRET).update(Buffer.from(canonical, 'utf8')).digest('hex');
    expect(sig).toBe(expected);
  });
  test('a reordered 5-key update_page artifact canonicalizes identically (sortKeysDeep handles the extra key)', () => {
    const a = buildPromotionArtifact(UPDATE_ROW, UPDATE_TARGET);
    const canonical = canonicalizeArtifactForSigning(a);
    const reordered: PromotionArtifact = {
      target: {
        base_compiled_hash: a.target.base_compiled_hash,
        body: a.target.body,
        timeline_entry: a.target.timeline_entry,
        path: a.target.path,
        mode: a.target.mode,
      },
      redaction_attestation: a.redaction_attestation,
      source_record_id: a.source_record_id,
      source_id: a.source_id,
      provider: a.provider,
    };
    expect(canonicalizeArtifactForSigning(reordered)).toBe(canonical);
  });
});

describe('U4 approveCandidate: honor the stored consolidation UPDATE target (end-to-end)', () => {
  afterEach(() => registerPromotionHook(null));

  // Capture the dispatched artifact (the opaque canonical STRING) via an injected fetch.
  function capturingHook(): { hook: PromotionHook; getArtifact: () => PromotionArtifact | null } {
    let captured: PromotionArtifact | null = null;
    const fetchFn: FetchFn = async (_url, init) => {
      const sent = JSON.parse(init.body);
      captured = JSON.parse(sent.client_payload.artifact) as PromotionArtifact;
      return { ok: true, status: 204, text: async () => '' };
    };
    return {
      hook: makePromotionHook({ getSecret: () => SECRET, getGithubToken: () => TOKEN, fetchFn }),
      getArtifact: () => captured,
    };
  }

  async function insertUpdateRow(srid: string) {
    const { row } = await toRow(engine, {
      source_id: 'default',
      source_record_id: srid,
      provider: 'granola',
      proposed_markdown: MERGED_BODY,
      classification: 'UPDATE',
      target_kind: 'update_page',
      target_path: 'integrations/toast.md',
      timeline_entry: UPDATE_TIMELINE,
      base_compiled_hash: UPDATE_HASH,
      status: 'pending',
    });
    return row;
  }

  test('approving an UPDATE row emits an update_page artifact sourced from the ROW (reviewer target IGNORED)', async () => {
    const { hook, getArtifact } = capturingHook();
    registerPromotionHook(hook);
    const row = await insertUpdateRow('rec-upd-db-1');
    // The reviewer sends a DEFAULT inbox target — it MUST be ignored for the stored UPDATE.
    const res = await approveCandidate(engine, row.id, 'admin', INBOX);
    expect(res.row!.status).toBe('accepted');
    expect(res.promotion.invoked).toBe(true);
    const art = getArtifact()!;
    expect(art.target.mode).toBe('update_page');
    expect(art.target.body).toBe(MERGED_BODY);
    expect(art.target.timeline_entry).toBe(UPDATE_TIMELINE);
    expect(art.target.base_compiled_hash).toBe(UPDATE_HASH);
    // NOT the reviewer inbox, NOT the hardcoded promoted-from line.
    expect(art.target.timeline_entry).not.toContain('Promoted from connector candidate');
    expect(new Set(Object.keys(art.target))).toEqual(
      new Set(['mode', 'path', 'timeline_entry', 'body', 'base_compiled_hash']),
    );
  });

  test('an UPDATE row approves even when the reviewer target is existing_page with an EMPTY path (threw pre-U4)', async () => {
    const { hook, getArtifact } = capturingHook();
    registerPromotionHook(hook);
    const row = await insertUpdateRow('rec-upd-db-2');
    // Pre-U4 this reviewer target threw 'existing_page requires non-empty path' BEFORE the row
    // was read → the UPDATE was unapprovable. Now the EFFECTIVE (row-sourced) target validates.
    const res = await approveCandidate(engine, row.id, 'admin', { kind: 'existing_page', path: '' });
    expect(res.row!.status).toBe('accepted');
    expect(getArtifact()!.target.mode).toBe('update_page');
  });

  test('accept does NOT clobber the classifier-set target_kind (stays update_page + path)', async () => {
    registerPromotionHook(capturingHook().hook);
    const row = await insertUpdateRow('rec-upd-db-3');
    await approveCandidate(engine, row.id, 'admin', INBOX);
    const [after] = await engine.executeRaw<{ target_kind: string; target_path: string }>(
      `SELECT target_kind, target_path FROM connector_candidates WHERE id = $1`,
      [row.id],
    );
    expect(after.target_kind).toBe('update_page');
    expect(after.target_path).toBe('integrations/toast.md');
  });

  test('the persisted artifact_hash matches the dispatched update_page artifact (signing stability in the real flow)', async () => {
    const { hook, getArtifact } = capturingHook();
    registerPromotionHook(hook);
    const row = await insertUpdateRow('rec-upd-db-4');
    const res = await approveCandidate(engine, row.id, 'admin', INBOX);
    const dispatched = getArtifact()!;
    const recomputed = artifactHash(canonicalizeArtifactForSigning(dispatched));
    expect(res.row!.artifact_hash).toBe(recomputed);
  });

  test('a reviewer-driven (non-consolidation) inbox approval is UNCHANGED — 4-key target, hardcoded timeline, NO base_compiled_hash', async () => {
    const { hook, getArtifact } = capturingHook();
    registerPromotionHook(hook);
    const { row } = await toRow(engine, {
      source_id: 'default',
      source_record_id: 'rec-plain-1',
      provider: 'crunchbase',
      proposed_markdown: '# ACME',
    });
    await approveCandidate(engine, row.id, 'admin', INBOX);
    const art = getArtifact()!;
    expect(art.target.mode).toBe('inbox');
    expect('base_compiled_hash' in art.target).toBe(false);
    expect(Object.keys(art.target)).toHaveLength(4);
    expect(art.target.timeline_entry).toContain('Promoted from connector candidate');
  });
});
