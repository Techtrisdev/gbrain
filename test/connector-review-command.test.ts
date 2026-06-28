/**
 * gbrain connector review (U4) — the push review/digest surface.
 *
 * Proves the read-only review command brings ONLY the few confident proposals to
 * the human, in a glanceable one-action shape:
 *   1. loadReviewItems lists only PENDING ADD/UPDATE — never NEEDS_REVIEW (even a
 *      legacy pre-backfill pending row), rejected (NOOP / low_confidence), or expired.
 *   2. Items are confidence-ranked, highest first.
 *   3. The --source filter scopes to one brain source.
 *   4. The human render names verdict + where + confidence + the one accept/reject action.
 *   5. The --json shape is stable (exactly six documented keys).
 *   6. The --digest render is a markdown heading + a bullet per item.
 *   7. An empty queue renders a clean "nothing to review" on every surface (no error).
 *   8. `connector review` dispatches and --json emits parseable JSON.
 *
 * Canonical PGLite block (R3 + R4): one engine per file, beforeEach resets, afterAll disconnects.
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach, spyOn } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { toRow, type ConnectorCandidateItem } from '../src/core/connectors/candidate.ts';
import {
  runConnector,
  loadReviewItems,
  renderReviewHuman,
  renderReviewJson,
  renderReviewDigest,
  type ReviewItem,
} from '../src/commands/connector.ts';

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

/** Seed one candidate row. status defaults to 'pending' when omitted (the toRow default). */
async function seed(item: Partial<ConnectorCandidateItem> & { source_record_id: string }): Promise<void> {
  await toRow(engine, { source_id: 'default', ...item });
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** Seed the canonical mixed queue: 2 confident-pending ADD/UPDATE that SHOULD surface,
 *  plus the four kinds that must NOT (pending NEEDS_REVIEW, rejected NOOP, rejected
 *  low-confidence ADD, expired pending ADD). Returns nothing; tests assert on the result. */
async function seedMixedQueue(): Promise<void> {
  // SURFACE: a confident UPDATE (0.97) and a confident ADD (0.93).
  await seed({
    source_record_id: 'upd-1',
    classification: 'UPDATE',
    confidence: 0.97,
    target_kind: 'update_page',
    target_path: 'clients/acme.md',
    timeline_entry: '2026-06-28 — Acme moved to Series B; ARR now 4.2M',
    base_compiled_hash: 'deadbeefcafe',
    proposed_markdown: 'merged compiled-truth body',
  });
  await seed({
    source_record_id: 'add-1',
    classification: 'ADD',
    confidence: 0.93,
    proposed_slug: 'people/jane-doe',
    proposed_markdown: '# Jane Doe — VP Eng\n\nJane Doe joined Acme as VP of Engineering.',
  });
  // HIDE: a legacy pre-backfill PENDING NEEDS_REVIEW (the belt-and-suspenders case).
  await seed({
    source_record_id: 'nr-1',
    classification: 'NEEDS_REVIEW',
    confidence: 0.62,
    proposed_markdown: 'ambiguous multi-topic capture',
  });
  // HIDE: a rejected NOOP (off the pending queue).
  await seed({
    source_record_id: 'noop-1',
    classification: 'NOOP',
    status: 'rejected',
    status_reason: 'NOOP',
    confidence: 0.4,
  });
  // HIDE: a rejected low-confidence ADD (U2 held it back).
  await seed({
    source_record_id: 'lowc-1',
    classification: 'ADD',
    status: 'rejected',
    status_reason: 'low_confidence',
    confidence: 0.5,
    proposed_slug: 'people/maybe',
  });
  // HIDE: an EXPIRED pending ADD (listCandidates' expiry filter drops it pre-sweep).
  await seed({
    source_record_id: 'exp-1',
    classification: 'ADD',
    confidence: 0.91,
    proposed_slug: 'people/expired',
    proposed_markdown: 'should not surface',
    expires_at: new Date(Date.now() - DAY_MS),
  });
}

describe('loadReviewItems — filtering', () => {
  test('lists ONLY pending ADD/UPDATE; excludes NEEDS_REVIEW, rejected, and expired', async () => {
    await seedMixedQueue();
    const items = await loadReviewItems(engine);
    expect(items.map((i) => i.classification)).toEqual(['UPDATE', 'ADD']);
    // No hidden disposition leaked through.
    const slugsAndPaths = items.map((i) => `${i.target_path ?? ''}${i.proposed_slug ?? ''}`).join(' ');
    expect(slugsAndPaths).not.toContain('expired');
    expect(slugsAndPaths).not.toContain('maybe');
    // Only the two confident verdicts surface — nothing else.
    expect(items.every((i) => i.classification === 'ADD' || i.classification === 'UPDATE')).toBe(true);
  });

  test('a PENDING NEEDS_REVIEW row never surfaces even though its status is pending', async () => {
    await seed({ source_record_id: 'nr-only', classification: 'NEEDS_REVIEW', confidence: 0.9 });
    const items = await loadReviewItems(engine);
    expect(items).toEqual([]);
  });

  test('confidence-ranked, highest first', async () => {
    await seed({ source_record_id: 'a', classification: 'ADD', confidence: 0.8, proposed_slug: 'a' });
    await seed({ source_record_id: 'b', classification: 'UPDATE', confidence: 0.95, target_kind: 'update_page', target_path: 'b.md', timeline_entry: 't', base_compiled_hash: 'h', proposed_markdown: 'x' });
    await seed({ source_record_id: 'c', classification: 'ADD', confidence: 0.88, proposed_slug: 'c' });
    const items = await loadReviewItems(engine);
    expect(items.map((i) => i.confidence)).toEqual([0.95, 0.88, 0.8]);
  });

  test('--source scopes to one brain source', async () => {
    await engine.executeRaw(
      `INSERT INTO sources (id, name, config) VALUES ('other', 'other', '{}'::jsonb)
         ON CONFLICT (id) DO NOTHING`,
    );
    await seed({ source_record_id: 'd-1', classification: 'ADD', confidence: 0.9, proposed_slug: 'in-default' });
    await toRow(engine, { source_id: 'other', source_record_id: 'o-1', classification: 'ADD', confidence: 0.9, proposed_slug: 'in-other' });

    const dflt = await loadReviewItems(engine, { sourceId: 'default' });
    expect(dflt.map((i) => i.source_id)).toEqual(['default']);
    const other = await loadReviewItems(engine, { sourceId: 'other' });
    expect(other.map((i) => i.source_id)).toEqual(['other']);
  });
});

describe('renderReviewHuman', () => {
  test('each item names verdict + where + confidence + the one accept/reject action', async () => {
    await seedMixedQueue();
    const items = await loadReviewItems(engine);
    const out = renderReviewHuman(items);

    const upd = items.find((i) => i.classification === 'UPDATE')!;
    const add = items.find((i) => i.classification === 'ADD')!;

    expect(out).toContain('UPDATE');
    expect(out).toContain('clients/acme.md');                      // where (UPDATE)
    expect(out).toContain('0.97');                                  // confidence
    expect(out).toContain('Acme moved to Series B');               // one-glance change
    expect(out).toContain(`/admin/api/candidates/${upd.id}/approve`); // the one action
    expect(out).toContain(`/admin/api/candidates/${upd.id}/reject`);

    expect(out).toContain('people/jane-doe');                      // where (ADD slug)
    expect(out).toContain('Jane Doe');                             // ADD excerpt
    expect(out).toContain(`/admin/api/candidates/${add.id}/approve`);

    // Action signifiers match outcomes: reject signposts the REQUIRED reason body,
    // and a bare ADD approve is shown landing in inbox/ (not at the displayed slug).
    expect(out).toContain('{"reason":"…"}');
    expect(out).toContain('inbox/ for triage');
    expect(out).toContain('"target_kind":"existing_page"');        // the file-at-slug payload

    // Hidden dispositions never appear.
    expect(out).not.toContain('ambiguous multi-topic');
    expect(out).not.toContain('people/expired');
  });

  test('empty queue → clean one-liner, no error', () => {
    const out = renderReviewHuman([]);
    expect(out).toContain('Nothing to review');
  });
});

describe('renderReviewJson — stable shape', () => {
  test('exactly the six documented keys, confidence-ranked', async () => {
    await seedMixedQueue();
    const items = await loadReviewItems(engine);
    const parsed = JSON.parse(renderReviewJson(items)) as ReviewItem[];

    expect(parsed.length).toBe(2);
    expect(Object.keys(parsed[0]).sort()).toEqual(
      ['classification', 'confidence', 'id', 'proposed_slug', 'source_id', 'summary', 'target_path'],
    );
    expect(parsed.map((p) => p.classification)).toEqual(['UPDATE', 'ADD']);
    // UPDATE lands at target_path; ADD lands at proposed_slug — each from its own key.
    expect(parsed[0].target_path).toBe('clients/acme.md');
    expect(parsed[0].proposed_slug).toBeNull();
    expect(parsed[1].target_path).toBeNull();
    expect(parsed[1].proposed_slug).toBe('people/jane-doe');
  });

  test('empty queue → []', () => {
    expect(JSON.parse(renderReviewJson([]))).toEqual([]);
  });
});

describe('renderReviewDigest', () => {
  test('a markdown heading + a bullet per item', async () => {
    await seedMixedQueue();
    const items = await loadReviewItems(engine);
    const out = renderReviewDigest(items);
    expect(out).toContain('## Consolidation review');
    const bullets = out.split('\n').filter((l) => l.startsWith('- '));
    expect(bullets.length).toBe(2);
    expect(out).toContain('**UPDATE**');
    expect(out).toContain('`clients/acme.md`');
    expect(out).toContain('**ADD**');
    // The act-mechanics footer signposts the required reject reason + the ADD→inbox outcome.
    expect(out).toContain('{"reason":"…"}');
    expect(out).toContain('`inbox/`');
  });

  test('empty queue → "nothing to review" marker, no bullets', () => {
    const out = renderReviewDigest([]);
    expect(out).toContain('_Nothing to review._');
    expect(out.split('\n').filter((l) => l.startsWith('- ')).length).toBe(0);
  });
});

describe('runConnector review — dispatch', () => {
  test('`connector review --json` emits parseable JSON to stdout', async () => {
    await seedMixedQueue();
    const writes: string[] = [];
    const spy = spyOn(process.stdout, 'write').mockImplementation(((chunk: string) => {
      writes.push(String(chunk));
      return true;
    }) as typeof process.stdout.write);
    try {
      await runConnector(engine, ['review', '--json']);
    } finally {
      spy.mockRestore();
    }
    const parsed = JSON.parse(writes.join(''));
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed.map((p: ReviewItem) => p.classification)).toEqual(['UPDATE', 'ADD']);
  });

  test('`connector review --help` prints help without a database', async () => {
    const logs: string[] = [];
    const spy = spyOn(console, 'log').mockImplementation((...a: unknown[]) => {
      logs.push(a.join(' '));
    });
    try {
      await runConnector(null, ['review', '--help']);
    } finally {
      spy.mockRestore();
    }
    expect(logs.join('\n')).toContain('review options');
  });

  test('`connector review` with no DB (not --help) exits 1', async () => {
    const errs: string[] = [];
    const errSpy = spyOn(console, 'error').mockImplementation((...a: unknown[]) => {
      errs.push(a.join(' '));
    });
    let exitCode: number | undefined;
    const exitSpy = spyOn(process, 'exit').mockImplementation(((code?: number) => {
      exitCode = code;
      return undefined as never;
    }) as typeof process.exit);
    try {
      await runConnector(null, ['review']);
    } finally {
      errSpy.mockRestore();
      exitSpy.mockRestore();
    }
    expect(exitCode).toBe(1);
    expect(errs.join('\n')).toContain('requires a database');
  });
});
