/**
 * Tests for the connector content-substance gate (connector-substance-gate PR).
 *
 * A contentless / title-only capture must NEVER become a candidate (the INGEST gate in
 * base.ts::landRecords) or a promotion PR (the EGRESS backstop in approveCandidate).
 *
 * The real incident: a Granola meeting with only a title ("Westside Pizza <> Techtris
 * Intro", body = just the title, 28 non-whitespace chars) flowed through the pipeline
 * and became a promotion PR for a contentless page. These tests pin both gates, the
 * pure substance helper, and the `connectors.min_candidate_body_chars` knob.
 *
 * Serial (mutates the module-level promotion-hook singleton via registerPromotionHook,
 * and reuses one PGLite engine per file).
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import {
  toRow,
  approveCandidate,
  registerPromotionHook,
  compiledTruthSubstance,
  minCandidateBodyChars,
  MIN_CANDIDATE_BODY_CHARS_KEY,
  MIN_CANDIDATE_BODY_CHARS_DEFAULT,
  PromotionTargetError,
  type ConnectorCandidateRow,
} from '../src/core/connectors/candidate.ts';
import {
  landRecords,
  type SaaSConnector,
  type NormalizedRecord,
} from '../src/core/connectors/base.ts';
import type { PromotionTarget } from '../src/core/connectors/promotion.ts';

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

afterEach(() => registerPromotionHook(null));

const INBOX: PromotionTarget = { kind: 'inbox', path: '' };

/** The real #140 incident body: a Granola meeting that is JUST a title. 28 non-ws chars. */
const WESTSIDE = 'Westside Pizza <> Techtris Intro';
/** A real, substantive capture body — well above the 64 floor (>119 non-ws chars). */
const REAL_BODY =
  'Westside Pizza wants a POS pilot. Agreed next steps: Techtris to scope the Toast ' +
  'integration, send a proposal by Friday, and confirm the rollout timeline with their ' +
  'ops lead before the Q3 launch window opens.';

/** A granola-shaped poll-only connector (mirrors granola.ts:toCandidate). */
const granolaLike: SaaSConnector = {
  provider: 'granola',
  signatureHeader: 'x-granola-unused',
  verifyWebhook: () => false,
  accountFromPayload: () => null,
  normalize: () => [],
  toCandidate: (record, sourceId) => ({
    source_id: sourceId,
    source_record_id: record.sourceRecordId,
    provider: 'granola',
    proposed_slug: record.proposedSlug,
    proposed_markdown: record.item.summary,
    confidence: 0.9,
  }),
};
function rec(id: string, summary: string): NormalizedRecord {
  return {
    sourceRecordId: id,
    profile: 'docs',
    item: { sourceRecordId: id, summary, metadata: {} },
    proposedSlug: `granola-note-${id}`,
  };
}
async function candidateCount(): Promise<number> {
  const [{ n }] = await engine.executeRaw<{ n: number }>(
    `SELECT count(*)::int AS n FROM connector_candidates`,
  );
  return Number(n);
}

// ── 1. The substance helper (pure) ────────────────────────────────────────────
describe('compiledTruthSubstance — compiled-truth non-whitespace count', () => {
  test('the real incident title-only body measures 28 (below the 64 default)', () => {
    expect(compiledTruthSubstance(WESTSIDE)).toBe(28);
    expect(compiledTruthSubstance(WESTSIDE)).toBeLessThan(MIN_CANDIDATE_BODY_CHARS_DEFAULT);
  });

  test('strips frontmatter + `## Timeline` + a leading inbox-draft blockquote, then counts', () => {
    const wrapped = [
      '---',
      'slug: granola-note-westside',
      'title: Westside Pizza',
      'type: note',
      '---',
      '> **Inbox draft** — auto-generated, pending human review',
      '',
      WESTSIDE,
      '',
      '## Timeline',
      '2026-06-30 — Captured from Granola (frontmatter + timeline must NOT count).',
    ].join('\n');
    // Only the compiled-truth body (WESTSIDE) survives → 28.
    expect(compiledTruthSubstance(wrapped)).toBe(28);
  });

  test('a real >=119-char body measures well above the floor', () => {
    const n = compiledTruthSubstance(REAL_BODY);
    expect(n).toBeGreaterThan(119);
    expect(n).toBeGreaterThan(MIN_CANDIDATE_BODY_CHARS_DEFAULT);
  });

  test('empty / null / frontmatter-only / timeline-only bodies measure 0', () => {
    expect(compiledTruthSubstance('')).toBe(0);
    expect(compiledTruthSubstance(null)).toBe(0);
    expect(compiledTruthSubstance(undefined)).toBe(0);
    expect(compiledTruthSubstance('---\nslug: x\ntitle: y\n---\n')).toBe(0);
    expect(compiledTruthSubstance('## Timeline\n2026-06-30 — created.')).toBe(0);
  });
});

// ── 2. The knob reader (mirrors the consolidation_* pattern) ───────────────────
describe('minCandidateBodyChars — knob reader', () => {
  test('unset → default 64; valid int honored; 0 honored (disables); malformed/negative → default', async () => {
    await engine.unsetConfig(MIN_CANDIDATE_BODY_CHARS_KEY);
    expect(await minCandidateBodyChars(engine)).toBe(MIN_CANDIDATE_BODY_CHARS_DEFAULT);

    await engine.setConfig(MIN_CANDIDATE_BODY_CHARS_KEY, '128');
    expect(await minCandidateBodyChars(engine)).toBe(128);

    await engine.setConfig(MIN_CANDIDATE_BODY_CHARS_KEY, '0');
    expect(await minCandidateBodyChars(engine)).toBe(0);

    await engine.setConfig(MIN_CANDIDATE_BODY_CHARS_KEY, '64.9');
    expect(await minCandidateBodyChars(engine)).toBe(64); // floored

    await engine.setConfig(MIN_CANDIDATE_BODY_CHARS_KEY, 'not-a-number');
    expect(await minCandidateBodyChars(engine)).toBe(MIN_CANDIDATE_BODY_CHARS_DEFAULT);

    await engine.setConfig(MIN_CANDIDATE_BODY_CHARS_KEY, '-5');
    expect(await minCandidateBodyChars(engine)).toBe(MIN_CANDIDATE_BODY_CHARS_DEFAULT);
  });
});

// ── 3. The ingest gate (base.ts::landRecords) ──────────────────────────────────
describe('landRecords ingest gate — skips contentless, keeps substantive', () => {
  test('a title-only granola-shaped record is skipped (0 written, nothing persisted)', async () => {
    await engine.setConfig(MIN_CANDIDATE_BODY_CHARS_KEY, '64');
    const res = await landRecords(engine, 'default', granolaLike, [rec('ws-skip', WESTSIDE)]);
    expect(res).toEqual({ written: 0, total: 1 });
    expect(await candidateCount()).toBe(0);
  });

  test('a substantive record is kept (1 written, persisted)', async () => {
    await engine.setConfig(MIN_CANDIDATE_BODY_CHARS_KEY, '64');
    const res = await landRecords(engine, 'default', granolaLike, [rec('real-keep', REAL_BODY)]);
    expect(res).toEqual({ written: 1, total: 1 });
    expect(await candidateCount()).toBe(1);
  });

  test('a mixed batch lands only the substantive record', async () => {
    await engine.setConfig(MIN_CANDIDATE_BODY_CHARS_KEY, '64');
    const res = await landRecords(engine, 'default', granolaLike, [
      rec('mix-junk', WESTSIDE),
      rec('mix-real', REAL_BODY),
    ]);
    expect(res).toEqual({ written: 1, total: 2 });
    const [row] = await engine.executeRaw<{ source_record_id: string }>(
      `SELECT source_record_id FROM connector_candidates`,
    );
    expect(row.source_record_id).toBe('mix-real');
  });
});

// ── 4. The egress backstop (approveCandidate) ──────────────────────────────────
describe('approveCandidate egress backstop — fail-closed on a sub-threshold body', () => {
  test('a pre-existing title-only inbox candidate is REJECTED at approve (row stays pending)', async () => {
    // Simulate the incident: a junk candidate already in the table (landed when the gate
    // was off / the threshold lower), now an admin clicks accept.
    await engine.setConfig(MIN_CANDIDATE_BODY_CHARS_KEY, '0'); // land it past the ingest gate
    const { row } = await toRow(engine, {
      source_id: 'default',
      source_record_id: 'egress-junk',
      provider: 'granola',
      proposed_markdown: WESTSIDE,
      status: 'pending',
    });
    await engine.setConfig(MIN_CANDIDATE_BODY_CHARS_KEY, '64'); // gate ON at approve time
    await expect(approveCandidate(engine, row.id, 'admin', INBOX)).rejects.toThrow(
      PromotionTargetError,
    );
    const [after] = await engine.executeRaw<{ status: string }>(
      `SELECT status FROM connector_candidates WHERE id = $1`,
      [row.id],
    );
    expect(after.status).toBe('pending'); // untouched — never accepted, never dispatched
  });

  test('a substantive inbox candidate is ALLOWED through approve (accepted)', async () => {
    await engine.setConfig(MIN_CANDIDATE_BODY_CHARS_KEY, '64');
    const { row } = await toRow(engine, {
      source_id: 'default',
      source_record_id: 'egress-real',
      provider: 'granola',
      proposed_markdown: REAL_BODY,
      status: 'pending',
    });
    const res = await approveCandidate(engine, row.id, 'admin', INBOX);
    expect(res.row!.status).toBe('accepted');
  });
});

// ── 5. The threshold is respected at the just-under / just-over boundary ───────
describe('threshold/knob is respected at the boundary', () => {
  test('a body one char under the configured floor is skipped; one at the floor is kept', async () => {
    await engine.setConfig(MIN_CANDIDATE_BODY_CHARS_KEY, '40');
    const under = 'a'.repeat(39); // 39 non-ws < 40 → skip
    const at = 'a'.repeat(40); //    40 non-ws >= 40 → keep
    expect(compiledTruthSubstance(under)).toBe(39);
    expect(compiledTruthSubstance(at)).toBe(40);

    const r1 = await landRecords(engine, 'default', granolaLike, [rec('b-under', under)]);
    expect(r1).toEqual({ written: 0, total: 1 });

    const r2 = await landRecords(engine, 'default', granolaLike, [rec('b-at', at)]);
    expect(r2).toEqual({ written: 1, total: 1 });
  });
});

// ── 6. Default-OFF escape hatch: floor=0 disables the gate ─────────────────────
describe('floor=0 disables the gate end to end', () => {
  test('even a 1-char body lands and promotes when the floor is 0', async () => {
    await engine.setConfig(MIN_CANDIDATE_BODY_CHARS_KEY, '0');
    const res = await landRecords(engine, 'default', granolaLike, [rec('off-1', 'x')]);
    expect(res).toEqual({ written: 1, total: 1 });
    const [row] = await engine.executeRaw<ConnectorCandidateRow>(
      `SELECT * FROM connector_candidates WHERE source_record_id = 'off-1'`,
    );
    const approved = await approveCandidate(engine, row.id, 'admin', INBOX);
    expect(approved.row!.status).toBe('accepted');
  });
});
