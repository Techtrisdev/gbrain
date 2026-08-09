import { afterEach, describe, expect, mock, spyOn, test } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import type { ConnectorCandidateRow, ApproveResult } from '../src/core/connectors/candidate.ts';
import type { PromotionTarget } from '../src/core/connectors/promotion.ts';
import {
  __setApproveCandidateForTests,
  maybeAutoApprove,
  trustTierDecision,
} from '../src/core/connectors/trust-tier.ts';

function candidateRow(overrides: Partial<ConnectorCandidateRow> = {}): ConnectorCandidateRow {
  return {
    id: 123,
    source_id: 'default',
    source_record_id: 'rec-1',
    version: '1',
    source_record_ids: [],
    provider: 'granola',
    proposed_slug: 'docs/foo',
    proposed_markdown: '# Foo\n\nSubstantive connector candidate body.',
    confidence: 0.95,
    redactions: [],
    expires_at: null,
    as_of: null,
    rationale_ref: 'takes/foo-rationale',
    status: 'pending',
    status_reason: null,
    acted_by: null,
    acted_at: null,
    superseded_by: null,
    target_kind: null,
    target_path: 'docs/foo.md',
    promotion_status: null,
    promotion_pr_url: null,
    promotion_branch: null,
    promoted_at: null,
    artifact_hash: null,
    base_compiled_hash: null,
    timeline_entry: null,
    classification: 'ADD',
    proposed_at: new Date('2026-01-01T00:00:00.000Z'),
    ...overrides,
  };
}

function fakeEngine(opts: {
  autoPromote?: string | null;
  sourceConfig?: unknown;
  sourceMissing?: boolean;
  currentCandidate?: ConnectorCandidateRow | null;
} = {}): BrainEngine {
  return {
    kind: 'postgres',
    getConfig: async (key: string) => {
      if (key === 'connectors.auto_promote_enabled') return opts.autoPromote ?? null;
      return null;
    },
    executeRaw: async (sql: string) => {
      if (/FROM sources WHERE id = \$1/.test(sql)) {
        return opts.sourceMissing ? [] : [{ config: opts.sourceConfig ?? {} }];
      }
      if (/FROM connector_candidates WHERE id = \$1/.test(sql)) {
        return opts.currentCandidate === null ? [] : [opts.currentCandidate ?? candidateRow()];
      }
      throw new Error(`unexpected SQL in fake engine: ${sql}`);
    },
  } as unknown as BrainEngine;
}

type ApproveCandidateFn = (
  engine: BrainEngine,
  id: number,
  actor: string,
  target: PromotionTarget,
) => Promise<ApproveResult>;

function mockApproval(row: ConnectorCandidateRow) {
  const approve = mock(async (..._args: Parameters<ApproveCandidateFn>): Promise<ApproveResult> => ({
    row,
    promotion: { invoked: true, prUrl: 'https://github.example/pr/1' },
  }));
  __setApproveCandidateForTests(approve);
  return approve;
}

afterEach(() => {
  __setApproveCandidateForTests(null);
});

describe('trustTierDecision', () => {
  test('high-confidence ADD to a safe path auto-approves (new_page receiver mode)', () => {
    // The receiver's new_page mode now lands ADD proposals (novelty re-check +
    // PR review gate), so a high-confidence, safe-path, rationale-carrying ADD
    // with no redactions may auto-approve.
    expect(trustTierDecision(candidateRow())).toBe('auto_approve');
    expect(trustTierDecision(candidateRow({ target_path: 'docs/foo.md' }))).toBe('auto_approve');
    expect(trustTierDecision(candidateRow({ classification: 'ADD', confidence: 0.99 }))).toBe('auto_approve');
  });

  test('non-ADD classifications stay human', () => {
    for (const classification of ['UPDATE', 'NEEDS_REVIEW', 'NOOP', null] as const) {
      expect(trustTierDecision(candidateRow({ classification }))).toBe('human');
    }
  });

  test('low or missing confidence stays human', () => {
    expect(trustTierDecision(candidateRow({ confidence: 0.89 }))).toBe('human');
    expect(trustTierDecision(candidateRow({ confidence: null }))).toBe('human');
  });

  test('sensitive target paths stay human even at high confidence', () => {
    for (const target_path of [
      'clients/acme.md',
      'people/x.md',
      'decisions/x.md',
      'integrations/x.md',
      'inbox/2026-01-01-x.md',
    ]) {
      expect(trustTierDecision(candidateRow({ target_path }))).toBe('human');
    }
  });

  test('missing rationale stays human', () => {
    expect(trustTierDecision(candidateRow({ rationale_ref: null }))).toBe('human');
    expect(trustTierDecision(candidateRow({ rationale_ref: '   ' }))).toBe('human');
  });

  test('redaction flags stay human', () => {
    expect(trustTierDecision(candidateRow({ redactions: [{ field: 'email' }] }))).toBe('human');
  });

  test('malformed unexpected input is human and never throws', () => {
    expect(() =>
      trustTierDecision(candidateRow({
        target_path: 'docs/../clients/acme.md',
        redactions: { field: 'email' } as unknown as unknown[],
      })),
    ).not.toThrow();
    expect(trustTierDecision(candidateRow({ target_path: 'docs/../clients/acme.md' }))).toBe('human');
    expect(trustTierDecision(candidateRow({ target_kind: 'inbox' }))).toBe('human');
  });
});

describe('maybeAutoApprove', () => {
  test('safe high-confidence ADD approves via new_page when enabled', async () => {
    const row = candidateRow(); // ADD, confidence 0.95, docs/foo.md, rationale, no redactions
    const approve = mockApproval(row);

    await expect(
      maybeAutoApprove(fakeEngine({ autoPromote: 'true', currentCandidate: row }), row),
    ).resolves.toBe(true);
    expect(approve).toHaveBeenCalledTimes(1);
    const [engine, id, actor, target] = approve.mock.calls[0];
    expect(id).toBe(123);
    expect(target.kind).toBe('new_page');
    expect(target.path).toBe('docs/foo.md');
  });

  test('default-off config leaves a row untouched', async () => {
    const row = candidateRow();
    const approve = mockApproval(row);

    await expect(maybeAutoApprove(fakeEngine(), row)).resolves.toBe(false);
    expect(approve).not.toHaveBeenCalled();

    await expect(maybeAutoApprove(fakeEngine({ autoPromote: 'false' }), row)).resolves.toBe(false);
    expect(approve).not.toHaveBeenCalled();
  });

  test('enabled config plus kill-switch leaves a row untouched', async () => {
    const row = candidateRow();
    const approve = mockApproval(row);

    await expect(
      maybeAutoApprove(fakeEngine({
        autoPromote: 'true',
        sourceConfig: { connectors_killswitch: true },
      }), row),
    ).resolves.toBe(false);
    expect(approve).not.toHaveBeenCalled();
  });

  test('sensitive target path stays human even fully enabled', async () => {
    const approve = mockApproval(candidateRow());
    const row = candidateRow({ target_path: 'clients/acme.md' });

    await expect(
      maybeAutoApprove(fakeEngine({ autoPromote: 'true', currentCandidate: row }), row),
    ).resolves.toBe(false);
    expect(approve).not.toHaveBeenCalled();
  });

  test('non-ADD classifications never approve', async () => {
    const approve = mockApproval(candidateRow());

    await expect(
      maybeAutoApprove(fakeEngine({ autoPromote: 'true' }), candidateRow({ classification: 'UPDATE' })),
    ).resolves.toBe(false);
    await expect(
      maybeAutoApprove(fakeEngine({ autoPromote: 'true' }), candidateRow({ classification: 'NEEDS_REVIEW' })),
    ).resolves.toBe(false);
    expect(approve).not.toHaveBeenCalled();
  });

  test('fresh unsafe candidate reread fails closed before approval', async () => {
    const staleSafeRow = candidateRow();
    const currentUnsafeRow = candidateRow({
      classification: 'UPDATE',
      target_kind: 'update_page',
      target_path: 'clients/acme.md',
    });
    const approve = mockApproval(staleSafeRow);

    await expect(
      maybeAutoApprove(
        fakeEngine({ autoPromote: 'true', currentCandidate: currentUnsafeRow }),
        staleSafeRow,
      ),
    ).resolves.toBe(false);
    expect(approve).not.toHaveBeenCalled();
  });

  test('missing candidate reread fails closed before approval', async () => {
    const row = candidateRow();
    const approve = mockApproval(row);

    await expect(
      maybeAutoApprove(fakeEngine({ autoPromote: 'true', currentCandidate: null }), row),
    ).resolves.toBe(false);
    expect(approve).not.toHaveBeenCalled();
  });

  test('approveCandidate errors fail closed and do not propagate', async () => {
    const row = candidateRow();
    const approve = mock(async (..._args: Parameters<ApproveCandidateFn>): Promise<ApproveResult> => {
      throw new Error('promotion unavailable');
    });
    __setApproveCandidateForTests(approve);
    const errSpy = spyOn(console, 'error').mockImplementation(() => {});

    try {
      await expect(
        maybeAutoApprove(fakeEngine({ autoPromote: 'true', currentCandidate: row }), row),
      ).resolves.toBe(false);
      expect(approve).toHaveBeenCalledTimes(1); // reached, but its throw is absorbed
    } finally {
      errSpy.mockRestore();
    }
  });
});
