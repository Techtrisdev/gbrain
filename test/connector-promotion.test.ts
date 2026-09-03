/**
 * Tests for the gbrain side of the TECH-2109 connector→Brain promotion bridge.
 *
 * Covers (per the ticket test matrix):
 *  - canonical determinism: same artifact → same bytes / same hash, key order irrelevant.
 *  - the artifact has EXACTLY the 5 top-level keys + target has EXACTLY 4 keys (drift guard).
 *  - hex signature verifies against an independent node:crypto recomputation.
 *  - path validation rejects '..' / absolute / URL-scheme / backslash; existing_page needs a path.
 *  - emit failure → candidate stays accepted with a durable retryable failure state.
 *  - successful emit → dispatch remains pending until a signed callback proves PR creation.
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
import { MIGRATIONS } from '../src/core/migrate.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import {
  toRow,
  approveCandidate,
  retryCandidatePromotion,
  validatePromotionTarget,
  registerPromotionHook,
  PromotionTargetError,
  type PromotionHook,
} from '../src/core/connectors/candidate.ts';
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
import {
  applyPromotionCallbackTransition,
  readPromotionTransitionByCandidate,
} from '../src/core/connectors/promotion-state.ts';
import { compiledTruthHash } from '../src/core/connectors/consolidate.ts';

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
  // Content-substance gate (connector-substance-gate PR): these promotion-mechanics tests
  // approve minimal fixtures (`# X`, `# ACME`) to exercise canonicalization / hashing /
  // retriability / logging — NOT content substance — so they predate the egress floor.
  // Disable it (0) so the minimal bodies still flow. The gate itself is covered by the
  // dedicated substance-gate tests in connector-candidate.serial.test.ts.
  await engine.setConfig('connectors.min_candidate_body_chars', '0');
  await engine.setConfig('connectors.promotion_dispatch_frozen', 'false');
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

  test('a hung repository_dispatch is aborted at the finite request deadline', async () => {
    let signal: AbortSignal | undefined;
    const fetchFn: FetchFn = async (_url, init) => {
      signal = init.signal;
      return new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      });
    };
    await expect(emitRepositoryDispatch({
      canonical: '{}',
      signature: 'aa',
      githubToken: TOKEN,
      fetchFn,
      timeoutMs: 10,
    })).rejects.toThrow(/GitHub request timeout/);
    expect(signal?.aborted).toBe(true);
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

  test('emit failure keeps approval but records a durable retryable failure', async () => {
    const failing: FetchFn = async () => ({ ok: false, status: 500, text: async () => 'boom' });
    registerPromotionHook(makePromotionHook(deps(failing)));
    const { row } = await toRow(engine, { source_id: 'default', source_record_id: 'ap-fail', provider: 'crunchbase', proposed_markdown: '# X' });
    const res = await approveCandidate(engine, row.id, 'admin', INBOX);
    expect(res.row!.status).toBe('accepted');         // decision committed
    expect(res.promotion.invoked).toBe(false);
    expect(res.promotion.pending).toBe(true);          // retriable
    const [after] = await engine.executeRaw<{ promotion_status: string | null; state: string; attempt_count: number }>(
      `SELECT c.promotion_status, p.state, p.attempt_count
         FROM connector_candidates c
         JOIN connector_promotion_transitions p ON p.candidate_id = c.id
        WHERE c.id = $1`, [row.id],
    );
    expect(after.promotion_status).toBe('failed');
    expect(after.state).toBe('dispatch_failed');
    expect(Number(after.attempt_count)).toBe(1);
  });

  test('dispatch timeout is explicit and requires reconciliation before retry', async () => {
    const hanging: FetchFn = async (_url, init) => new Promise((_resolve, reject) => {
      init.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    });
    registerPromotionHook(makePromotionHook({
      ...deps(hanging),
      githubRequestTimeoutMs: 10,
    }));
    const { row } = await toRow(engine, {
      source_id: 'default',
      source_record_id: 'ap-timeout',
      provider: 'crunchbase',
      proposed_markdown: '# Timeout',
    });

    const res = await approveCandidate(engine, row.id, 'admin', INBOX);

    expect(res.row?.status).toBe('accepted');
    expect(res.promotion.pending).toBe(true);
    const [after] = await engine.executeRaw<{
      state: string;
      failure_code: string;
      next_action: string;
    }>(
      `SELECT state, failure_code, next_action
         FROM connector_promotion_transitions WHERE candidate_id = $1`,
      [row.id],
    );
    expect(after).toEqual({
      state: 'dispatch_failed',
      failure_code: 'dispatch_outcome_unknown',
      next_action: 'reconcile_dispatch',
    });
  });

  test('a late dispatch error cannot regress a callback-advanced transition', async () => {
    const { row } = await toRow(engine, {
      source_id: 'default',
      source_record_id: 'ap-callback-race',
      provider: 'crunchbase',
      proposed_markdown: '# Callback race',
    });
    const lateFailure: FetchFn = async () => {
      const transition = await readPromotionTransitionByCandidate(engine, row.id);
      expect(transition).not.toBeNull();
      await applyPromotionCallbackTransition(
        engine,
        transition!.correlation_id,
        'pr_opened',
        { branch: 'promote/callback-race', prUrl: 'https://github.com/Techtrisdev/techtris-brain/pull/42' },
      );
      throw new Error('network connection failed after callback');
    };
    registerPromotionHook(makePromotionHook(deps(lateFailure)));

    const res = await approveCandidate(engine, row.id, 'admin', INBOX);

    expect(res.promotion.pending).toBe(true);
    const transition = await readPromotionTransitionByCandidate(engine, row.id);
    expect(transition?.state).toBe('pr_opened');
    expect(transition?.failure_code).toBeNull();
    expect(transition?.pr_url).toContain('/pull/42');
    const [candidate] = await engine.executeRaw<{ promotion_status: string }>(
      `SELECT promotion_status FROM connector_candidates WHERE id = $1`,
      [row.id],
    );
    expect(candidate.promotion_status).toBe('pr_opened');
    const [dispatchEvent] = await engine.executeRaw<{ outcome: string; resulting_state: string }>(
      `SELECT outcome, resulting_state FROM connector_promotion_events
        WHERE candidate_id = $1 AND event_type = 'dispatch'
        ORDER BY id DESC LIMIT 1`,
      [row.id],
    );
    expect(dispatchEvent).toEqual({ outcome: 'stale', resulting_state: 'pr_opened' });
  });

  test('successful emit waits for a signed PR-opened callback', async () => {
    const ok: FetchFn = async () => ({ ok: true, status: 204, text: async () => '' });
    registerPromotionHook(makePromotionHook(deps(ok)));
    const { row } = await toRow(engine, { source_id: 'default', source_record_id: 'ap-ok', provider: 'crunchbase', proposed_markdown: '# X' });
    const res = await approveCandidate(engine, row.id, 'admin', INBOX);
    expect(res.promotion.invoked).toBe(true);
    const [after] = await engine.executeRaw<{ promotion_status: string | null; state: string; attempt_count: number }>(
      `SELECT c.promotion_status, p.state, p.attempt_count
         FROM connector_candidates c
         JOIN connector_promotion_transitions p ON p.candidate_id = c.id
        WHERE c.id = $1`, [row.id],
    );
    expect(after.promotion_status).toBeNull();
    expect(after.state).toBe('accepted_dispatching');
    expect(Number(after.attempt_count)).toBe(1);
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

  test('new_page target builds the 4-key artifact (mode new_page, no base_compiled_hash)', () => {
    const a = buildPromotionArtifact(ROW, { kind: 'new_page', path: 'playbooks/incident-response.md' });
    expect(a.target.mode).toBe('new_page');
    expect(a.target.path).toBe('playbooks/incident-response.md');
    expect('base_compiled_hash' in a.target).toBe(false);
    expect(Object.keys(a.target)).toHaveLength(4);
    // The body is the proposed new-page content, redacted at this boundary.
    expect(a.target.body).toContain('ACME');
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

  test('omit-not-null survives serialization: the parsed canonical target has the exact mode key set', () => {
    // Structural (not substring): round-trip through the canonical serializer and assert on the
    // PARSED key set, so a future fixture body containing "null"/"base_compiled_hash" can't flip
    // it. A null (vs an omitted key) would parse back as a PRESENT key → `in` true → fail here;
    // JSON.stringify drops an absent key but keeps a null, so this pins the omit-not-null contract.
    const updTarget = JSON.parse(
      canonicalizeArtifactForSigning(buildPromotionArtifact(UPDATE_ROW, UPDATE_TARGET)),
    ).target as Record<string, unknown>;
    expect(new Set(Object.keys(updTarget))).toEqual(
      new Set(['mode', 'path', 'timeline_entry', 'body', 'base_compiled_hash']),
    );
    expect(updTarget.base_compiled_hash).toBe(UPDATE_HASH);

    const inboxTarget = JSON.parse(
      canonicalizeArtifactForSigning(buildPromotionArtifact(ROW, INBOX)),
    ).target as Record<string, unknown>;
    expect(new Set(Object.keys(inboxTarget))).toEqual(
      new Set(['mode', 'path', 'timeline_entry', 'body']),
    );
    // Truly ABSENT (omit), not present-as-null — `in` is the precise omit/null discriminator.
    expect('base_compiled_hash' in inboxTarget).toBe(false);
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
  test('rejects update_page with a missing/blank timeline_entry (mirrors the receiver guard)', () => {
    expect(() => validatePromotionTarget({ kind: 'update_page', path: 'integrations/toast.md', base_compiled_hash: UPDATE_HASH })).toThrow(PromotionTargetError);
    expect(() => validatePromotionTarget({ kind: 'update_page', path: 'integrations/toast.md', base_compiled_hash: UPDATE_HASH, timeline_entry: '   ' })).toThrow(PromotionTargetError);
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

  // MINOR-1: fail CLOSED at approve on a malformed stored UPDATE (empty body or timeline_entry),
  // mirroring the receiver's update_page guard — never dispatch a doomed artifact.
  test('a stored update_page row with an EMPTY proposed_markdown (merged body) is rejected at approve — NO dispatch', async () => {
    // This test exercises the egress substance backstop itself (an empty body is the
    // extreme sub-threshold case), so re-enable the floor that the file beforeEach disables.
    await engine.setConfig('connectors.min_candidate_body_chars', '64');
    const { hook, getArtifact } = capturingHook();
    registerPromotionHook(hook);
    const { row } = await toRow(engine, {
      source_id: 'default',
      source_record_id: 'rec-upd-emptybody',
      provider: 'granola',
      proposed_markdown: '', // malformed: an empty merged compiled-truth body
      classification: 'UPDATE',
      target_kind: 'update_page',
      target_path: 'integrations/toast.md',
      timeline_entry: UPDATE_TIMELINE,
      base_compiled_hash: UPDATE_HASH,
      status: 'pending',
    });
    await expect(approveCandidate(engine, row.id, 'admin', INBOX)).rejects.toThrow(PromotionTargetError);
    expect(getArtifact()).toBeNull(); // never dispatched
    const [after] = await engine.executeRaw<{ status: string }>(
      `SELECT status FROM connector_candidates WHERE id = $1`,
      [row.id],
    );
    expect(after.status).toBe('pending'); // untouched (no accept write)
  });

  test('a stored update_page row with an EMPTY timeline_entry is rejected at approve — NO dispatch', async () => {
    const { hook, getArtifact } = capturingHook();
    registerPromotionHook(hook);
    const { row } = await toRow(engine, {
      source_id: 'default',
      source_record_id: 'rec-upd-emptytl',
      provider: 'granola',
      proposed_markdown: MERGED_BODY,
      classification: 'UPDATE',
      target_kind: 'update_page',
      target_path: 'integrations/toast.md',
      timeline_entry: '', // malformed: an empty dated line
      base_compiled_hash: UPDATE_HASH,
      status: 'pending',
    });
    await expect(approveCandidate(engine, row.id, 'admin', INBOX)).rejects.toThrow(PromotionTargetError);
    expect(getArtifact()).toBeNull(); // never dispatched
    const [after] = await engine.executeRaw<{ status: string }>(
      `SELECT status FROM connector_candidates WHERE id = $1`,
      [row.id],
    );
    expect(after.status).toBe('pending');
  });
});

describe('generation-aware promotion artifact', () => {
  test('Context Mirror candidate carries one exact v2 correlation through the signed artifact', () => {
    const artifact = buildPromotionArtifact(
      { ...ROW, id: 42, context_generation: 3, provider: 'context_mirror' },
      { kind: 'new_page', path: 'projects/context-mirror-proof.md' },
    );
    expect(Object.keys(artifact).sort()).toEqual([
      'schema_version', 'correlation_id', 'provider', 'redaction_attestation',
      'source_id', 'source_record_id', 'target',
    ].sort());
    expect('schema_version' in artifact && artifact.schema_version).toBe(2);
    expect('correlation_id' in artifact && artifact.correlation_id).toBe('cm-promo-v2-c42-g3');
    expect(canonicalizeArtifactForSigning(artifact)).toContain('cm-promo-v2-c42-g3');
  });

  test('legacy candidates remain byte-compatible until their in-flight work drains', () => {
    const artifact = buildPromotionArtifact(ROW, INBOX);
    expect('schema_version' in artifact).toBe(false);
    expect('correlation_id' in artifact).toBe(false);
    expect(Object.keys(artifact)).toHaveLength(5);
  });
});

describe('durable promotion retry lifecycle', () => {
  afterEach(() => registerPromotionHook(null));

  const hookDeps = (fetchFn: FetchFn) => ({
    getSecret: () => SECRET,
    getGithubToken: () => TOKEN,
    fetchFn,
  });

  test('migration freeze blocks outbound dispatch and leaves an explicit operator action', async () => {
    await engine.setConfig('connectors.promotion_dispatch_frozen', 'true');
    let fetchCalls = 0;
    registerPromotionHook(makePromotionHook(hookDeps(async () => {
      fetchCalls += 1;
      return { ok: true, status: 204, text: async () => '' };
    })));
    const { row } = await toRow(engine, {
      source_id: 'default',
      source_record_id: 'freeze-block',
      provider: 'crunchbase',
      proposed_markdown: '# Freeze block',
    });

    const approved = await approveCandidate(engine, row.id, 'admin', INBOX);
    expect(approved.row?.status).toBe('accepted');
    expect(approved.promotion.pending).toBe(true);
    expect(fetchCalls).toBe(0);
    const [transition] = await engine.executeRaw<{ state: string; failure_code: string; next_action: string; attempt_count: number }>(
      `SELECT state, failure_code, next_action, attempt_count
         FROM connector_promotion_transitions WHERE candidate_id = $1`,
      [row.id],
    );
    expect(transition.state).toBe('dispatch_failed');
    expect(transition.failure_code).toBe('dispatch_frozen');
    expect(transition.next_action).toBe('reconcile_dispatch');
    expect(Number(transition.attempt_count)).toBe(0);
  });

  test('operator retry reuses identity, increments attempts, and does not repeat approval', async () => {
    let fail = true;
    registerPromotionHook(makePromotionHook(hookDeps(async () => (
      fail
        ? { ok: false, status: 503, text: async () => 'unavailable' }
        : { ok: true, status: 204, text: async () => '' }
    ))));
    const { row } = await toRow(engine, {
      source_id: 'default',
      source_record_id: 'retry-once',
      provider: 'crunchbase',
      proposed_markdown: '# Retry once',
      context_generation: 7,
    });

    await approveCandidate(engine, row.id, 'reviewer-a', INBOX);
    const [before] = await engine.executeRaw<{ correlation_id: string; attempt_count: number; acted_at: Date }>(
      `SELECT p.correlation_id, p.attempt_count, c.acted_at
         FROM connector_promotion_transitions p
         JOIN connector_candidates c ON c.id = p.candidate_id
        WHERE p.candidate_id = $1`,
      [row.id],
    );
    expect(before.correlation_id).toBe(`cm-promo-v2-c${row.id}-g7`);
    expect(Number(before.attempt_count)).toBe(1);

    fail = false;
    const retried = await retryCandidatePromotion(engine, row.id, 'operator-retry');
    expect(retried.promotion.invoked).toBe(true);
    const [after] = await engine.executeRaw<{ correlation_id: string; attempt_count: number; state: string; acted_at: Date }>(
      `SELECT p.correlation_id, p.attempt_count, p.state, c.acted_at
         FROM connector_promotion_transitions p
         JOIN connector_candidates c ON c.id = p.candidate_id
        WHERE p.candidate_id = $1`,
      [row.id],
    );
    expect(after.correlation_id).toBe(before.correlation_id);
    expect(Number(after.attempt_count)).toBe(2);
    expect(after.state).toBe('accepted_dispatching');
    expect(new Date(after.acted_at).toISOString()).toBe(new Date(before.acted_at).toISOString());
    const attempts = await engine.executeRaw<{ attempt_no: number; outcome: string }>(
      `SELECT attempt_no, outcome FROM connector_promotion_attempts
        WHERE candidate_id = $1 ORDER BY attempt_no`,
      [row.id],
    );
    expect(attempts.map((attempt) => [Number(attempt.attempt_no), attempt.outcome])).toEqual([
      [1, 'failed'],
      [2, 'succeeded'],
    ]);
  });

  test('retry of an UPDATE stops before dispatch when compiled truth changed', async () => {
    await engine.executeRaw(
      `INSERT INTO sources (id, name, config) VALUES ('shared','shared','{}'::jsonb)`,
    );
    const original = 'Original reviewed compiled truth.';
    await engine.putPage('integrations/acme', {
      type: 'integration',
      title: 'Acme',
      compiled_truth: original,
    }, { sourceId: 'shared' });
    registerPromotionHook(makePromotionHook(hookDeps(async () => ({
      ok: false,
      status: 503,
      text: async () => 'unavailable',
    }))));
    const { row } = await toRow(engine, {
      source_id: 'default',
      source_record_id: 'stale-update-retry',
      provider: 'context_mirror',
      proposed_markdown: 'Updated compiled truth with enough content.',
      classification: 'UPDATE',
      target_kind: 'update_page',
      target_path: 'integrations/acme.md',
      timeline_entry: '2026-08-26 — Proposed update from reviewed evidence.',
      base_compiled_hash: compiledTruthHash(original),
    });
    await approveCandidate(engine, row.id, 'reviewer-a', INBOX);
    await engine.putPage('integrations/acme', {
      type: 'integration',
      title: 'Acme',
      compiled_truth: 'A different reviewer changed this page first.',
    }, { sourceId: 'shared' });

    let fetchCalls = 0;
    registerPromotionHook(makePromotionHook(hookDeps(async () => {
      fetchCalls += 1;
      return { ok: true, status: 204, text: async () => '' };
    })));
    await expect(retryCandidatePromotion(engine, row.id, 'operator-retry')).rejects.toThrow('stale_update_target');
    expect(fetchCalls).toBe(0);
    const [transition] = await engine.executeRaw<{ state: string; failure_code: string; next_action: string; attempt_count: number }>(
      `SELECT state, failure_code, next_action, attempt_count
         FROM connector_promotion_transitions WHERE candidate_id = $1`,
      [row.id],
    );
    expect(transition).toMatchObject({
      state: 'dispatch_failed',
      failure_code: 'stale_update_target',
      next_action: 'review_stale_update',
    });
    expect(Number(transition.attempt_count)).toBe(1);
  });
});

describe('promotion lifecycle migration', () => {
  test('freezes dispatch and maps every legacy accepted row or flags it unresolved, idempotently', async () => {
    const seeds = await Promise.all([
      toRow(engine, { source_id: 'default', source_record_id: 'legacy-unknown', proposed_markdown: '# Unknown' }),
      toRow(engine, { source_id: 'default', source_record_id: 'legacy-opened', proposed_markdown: '# Opened' }),
      toRow(engine, { source_id: 'default', source_record_id: 'legacy-needs-fix', proposed_markdown: '# Needs fix' }),
      toRow(engine, { source_id: 'default', source_record_id: 'legacy-indexed', proposed_markdown: '# Indexed' }),
    ]);
    await engine.executeRaw(
      `UPDATE connector_candidates
          SET status = 'accepted', acted_at = now(), acted_by = 'legacy', artifact_hash = 'legacy-artifact'
        WHERE id = ANY($1::bigint[])`,
      [seeds.map(({ row }) => row.id)],
    );
    await engine.executeRaw(
      `UPDATE connector_candidates SET promotion_status = 'pr_opened', promoted_at = now() WHERE id = $1`,
      [seeds[1].row.id],
    );
    await engine.executeRaw(
      `UPDATE connector_candidates SET promotion_status = 'needs_fix', promoted_at = now() WHERE id = $1`,
      [seeds[2].row.id],
    );
    await engine.executeRaw(
      `UPDATE connector_candidates SET promotion_status = 'indexed', promoted_at = now() WHERE id = $1`,
      [seeds[3].row.id],
    );
    await engine.executeRaw('DELETE FROM connector_promotion_events');
    await engine.executeRaw('DELETE FROM connector_promotion_attempts');
    await engine.executeRaw('DELETE FROM connector_promotion_transitions');

    const migration = MIGRATIONS.find((item) => item.version === 112);
    expect(migration?.sql).toBeTruthy();
    await engine.runMigration(migration!.version, migration!.sql!);
    await engine.runMigration(migration!.version, migration!.sql!);

    expect(await engine.getConfig('connectors.promotion_dispatch_frozen')).toBe('true');
    const rows = await engine.executeRaw<{ source_record_id: string; state: string; failure_code: string | null; next_action: string }>(
      `SELECT c.source_record_id, p.state, p.failure_code, p.next_action
         FROM connector_promotion_transitions p
         JOIN connector_candidates c ON c.id = p.candidate_id
        ORDER BY c.source_record_id`,
    );
    expect(rows).toEqual([
      { source_record_id: 'legacy-indexed', state: 'unresolved_legacy', failure_code: 'legacy_index_proof_unverified', next_action: 'resolve_legacy' },
      { source_record_id: 'legacy-needs-fix', state: 'unresolved_legacy', failure_code: 'legacy_stage_unresolved', next_action: 'resolve_legacy' },
      { source_record_id: 'legacy-opened', state: 'pr_opened', failure_code: null, next_action: 'await_merge' },
      { source_record_id: 'legacy-unknown', state: 'dispatch_failed', failure_code: 'legacy_dispatch_outcome_unknown', next_action: 'reconcile_dispatch' },
    ]);
    const [counts] = await engine.executeRaw<{ events: number; attempts: number }>(
      `SELECT
         (SELECT count(*) FROM connector_promotion_events) AS events,
         (SELECT count(*) FROM connector_promotion_attempts) AS attempts`,
    );
    expect(Number(counts.events)).toBe(4);
    expect(Number(counts.attempts)).toBe(4);
  });
});
