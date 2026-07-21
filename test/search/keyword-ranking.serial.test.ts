/**
 * Ranked-OR + corpus-grounded IDF keyword leg (v0.45, PR1 — default-legacy).
 *
 * The legacy keyword leg scores with `ts_rank(sv, websearch_to_tsquery('english',
 * q))` whose multi-word semantics are boolean AND: a single query word absent
 * from the WHOLE corpus zeros the entire leg (the "zero-row cliff"). The new
 * `keyword_ranking: 'or_idf'` knob replaces that with a ranked-OR match
 * (`buildIdfRankedKeyword`) weighted by corpus-grounded IDF, so:
 *   - one corpus-absent word can no longer empty the leg (graceful OR), and
 *   - a high-DF hub token is automatically downweighted vs a rare entity token
 *     (IDF), without a hand-maintained proper-noun list.
 * The default 'and' knob keeps bit-for-bit legacy behavior (the rollback path).
 *
 * These tests exercise the engine keyword leg DIRECTLY (engine.searchKeyword /
 * searchKeywordChunks with the keyword_ranking opt) — no gateway/embeddings
 * needed, since this is the lexical leg, not the hybrid fusion. See the plan
 * docs/plans/2026-07-21-001-feat-bm25-keyword-leg.md §8 and the defect notes in
 * gbrain-entity-vs-topic-ranking-defect.
 *
 * SERIAL: keeps its own bun process per the serial-test convention (the fresh
 * PGLiteEngine instances several cases spin up shouldn't contend with a shard).
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { hasTermStats } from '../../src/core/search/corpus-term-stats.ts';
import { knobsHash, MODE_BUNDLES, type ResolvedSearchKnobs } from '../../src/core/search/mode.ts';
import type { PageInput, SearchResult } from '../../src/core/types.ts';

let engine: PGLiteEngine;

// Corpus shape (source 'default'): a hub token ("techtris" → stem "techtri")
// and a content token ("capture" → "captur") that appear in EVERY chunk (high
// DF), plus a rare entity token ("zorplex", df=1) in exactly one page. "production"
// appears NOWHERE — it is the corpus-absent word that trips the AND cliff.
const ZORPLEX = 'projects/zorplex';
const HUB_PAGES: Array<[string, PageInput['type'], string]> = [
  ['integrations/toast', 'integration', 'techtris capture event stream'],
  ['integrations/thanx', 'integration', 'techtris capture loyalty program'],
  ['clients/acme', 'client', 'techtris capture client onboarding'],
  ['clients/globex', 'client', 'techtris capture pipeline sync'],
  ['playbooks/notes', 'playbook', 'techtris capture general notes'],
  ['decisions/misc', 'decision', 'techtris capture decision record'],
  ['people/jane', 'person', 'techtris capture profile page'],
];

async function seedCorpus(e: PGLiteEngine): Promise<void> {
  // The rare-entity page: the ONLY chunk containing "zorplex"; also carries the
  // hub tokens so a mixed query scores it on both legs.
  await e.putPage(ZORPLEX, { type: 'project', title: 'Zorplex', compiled_truth: 'Zorplex techtris capture status' } as PageInput);
  await e.upsertChunks(ZORPLEX, [{ chunk_index: 0, chunk_text: 'zorplex techtris capture status', chunk_source: 'compiled_truth' } as any]);
  for (const [slug, type, text] of HUB_PAGES) {
    await e.putPage(slug, { type, title: slug, compiled_truth: text } as PageInput);
    await e.upsertChunks(slug, [{ chunk_index: 0, chunk_text: text, chunk_source: 'compiled_truth' } as any]);
  }
}

const kw = (query: string, ranking: 'and' | 'or_idf'): Promise<SearchResult[]> =>
  engine.searchKeyword(query, { keyword_ranking: ranking, sourceId: 'default' });
const slugsOf = (rows: SearchResult[]): string[] => rows.map((r) => r.slug ?? '');

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  await seedCorpus(engine);
  await engine.refreshCorpusTermStats('default');
});

afterAll(async () => { await engine.disconnect(); });

describe('keyword_ranking leg (or_idf ranked-OR + corpus IDF)', () => {
  // (1) Legacy 'and' path is unchanged — still matches, and still exhibits the
  // AND-cliff on a corpus-absent word (proving nothing leaked into legacy).
  test('default and: normal multi-word query still returns rows (legacy path intact)', async () => {
    const rows = await kw('techtris capture', 'and');
    expect(rows.length).toBeGreaterThan(1);
  });

  test('default and: a corpus-absent word STILL zeros the leg (the cliff legacy keeps)', async () => {
    // websearch_to_tsquery('english','zorplex production') = 'zorplex' & 'production';
    // "production" is in no chunk → boolean-AND → zero rows.
    const rows = await kw('zorplex production', 'and');
    expect(rows.length).toBe(0);
  });

  // (2) or_idf kills the cliff: the SAME query returns matches via OR.
  test('or_idf: a corpus-absent word no longer zeros the leg — the rare-entity page still surfaces', async () => {
    const rows = await kw('zorplex production', 'or_idf');
    expect(rows.length).toBeGreaterThan(0);
    expect(slugsOf(rows)).toContain(ZORPLEX);
  });

  // (3) IDF downweights a high-DF hub token vs a rare entity token.
  test('or_idf: rare entity token outranks hub-only pages (IDF hub-downweight)', async () => {
    // Query mixes the hub token (df=8) with the rare token (df=1). Every page
    // matches "techtri"; only the zorplex page also matches "zorplex", whose
    // high IDF lifts it to the top over the hub-only pages.
    const rows = await kw('techtris zorplex', 'or_idf');
    const slugs = slugsOf(rows);
    expect(slugs[0]).toBe(ZORPLEX);
    expect(slugs.indexOf(ZORPLEX)).toBeLessThan(slugs.indexOf('integrations/toast'));
  });

  // (7) Parity smoke — the or_idf SQL runs on PGLite (both grains) w/o error.
  test('or_idf: searchKeywordChunks runs on PGLite without error (chunk-grain parity smoke)', async () => {
    const rows = await engine.searchKeywordChunks('techtris zorplex', { keyword_ranking: 'or_idf', sourceId: 'default' });
    expect(rows.length).toBeGreaterThan(0);
    expect(slugsOf(rows)).toContain(ZORPLEX);
  });

  // (8a) True empty-match: a query whose lexemes are in NO chunk → [] even
  // under or_idf (the genuine no-lexeme case where op-layer ksf is the correct
  // last resort — or_idf does not manufacture spurious matches).
  test('or_idf: a query with no corpus lexeme returns [] (genuine empty, not a cliff)', async () => {
    const rows = await kw('qwerty xyzzy', 'or_idf');
    expect(rows.length).toBe(0);
  });

  // (5) refreshCorpusTermStats populates the tables and hasTermStats flips.
  test('refreshCorpusTermStats populates stats and hasTermStats flips false→true', async () => {
    const e = new PGLiteEngine();
    await e.connect({});
    await e.initSchema();
    await seedCorpus(e);
    expect(await hasTermStats(e, 'default')).toBe(false);
    await e.refreshCorpusTermStats('default');
    expect(await hasTermStats(e, 'default')).toBe(true);
    const rows = await e.executeRaw<{ df: number | string }>(
      `SELECT df FROM corpus_term_stats WHERE source_id = 'default' AND lexeme = 'techtri'`,
    );
    // "techtri" is in all 8 chunks (7 hub + zorplex) → df = 8.
    expect(Number(rows[0]?.df)).toBe(8);
    const zx = await e.executeRaw<{ df: number | string }>(
      `SELECT df FROM corpus_term_stats WHERE source_id = 'default' AND lexeme = 'zorplex'`,
    );
    expect(Number(zx[0]?.df)).toBe(1);
    await e.disconnect();
  }, 30000); // fresh engine → full initSchema (101 migrations) is slow on PGLite

  // (4) Empty/absent stats → idf COALESCEs to 1.0 → pure ranked-OR, no crash.
  test('or_idf: with NO term-stats refreshed, idf defaults to 1.0 (ranked-OR still returns rows, no crash)', async () => {
    const e = new PGLiteEngine();
    await e.connect({});
    await e.initSchema();
    await seedCorpus(e); // deliberately NO refreshCorpusTermStats
    const rows = await e.searchKeyword('techtris zorplex', { keyword_ranking: 'or_idf', sourceId: 'default' });
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.map((r) => r.slug)).toContain(ZORPLEX);
    await e.disconnect();
  }, 30000); // fresh engine → full initSchema (101 migrations) is slow on PGLite

  // (8b) Refresh idempotency — output depends only on chunk state, so a re-run
  // yields identical rows.
  test('refreshCorpusTermStats is idempotent (re-run yields identical rows)', async () => {
    const snapshot = async () =>
      engine.executeRaw<{ lexeme: string; df: number | string }>(
        `SELECT lexeme, df FROM corpus_term_stats WHERE source_id = 'default' ORDER BY lexeme`,
      );
    const before = await snapshot();
    await engine.refreshCorpusTermStats('default');
    const after = await snapshot();
    expect(after.length).toBe(before.length);
    expect(after.map((r) => `${r.lexeme}:${r.df}`)).toEqual(before.map((r) => `${r.lexeme}:${r.df}`));
  });

  // (6) knobsHash isolation — 'and' vs 'or_idf' must hash distinctly so an
  // or_idf write is never served to an 'and' cache lookup (and vice-versa).
  test('knobsHash: and vs or_idf produce DISTINCT hashes (no cross-mode cache serve)', () => {
    const base: ResolvedSearchKnobs = { ...MODE_BUNDLES.balanced, resolved_mode: 'balanced', mode_valid: true };
    const hAnd = knobsHash({ ...base, keyword_ranking: 'and' });
    const hOr = knobsHash({ ...base, keyword_ranking: 'or_idf' });
    expect(hAnd).not.toBe(hOr);
  });

  // (9) CJK untouched — hasCJK() early-returns to _searchKeywordCJK (ILIKE)
  // BEFORE the or_idf branch, so the knob cannot regress CJK routing. Isolated
  // fresh engine so the CJK page doesn't perturb the shared corpus DF counts.
  test('or_idf: a CJK query still routes to the ILIKE CJK path (identical to and)', async () => {
    const e = new PGLiteEngine();
    await e.connect({});
    await e.initSchema();
    await e.putPage('projects/cjk', { type: 'project', title: 'CJK', compiled_truth: '生产状态捕获' } as PageInput);
    await e.upsertChunks('projects/cjk', [{ chunk_index: 0, chunk_text: '生产状态捕获流水线', chunk_source: 'compiled_truth' } as any]);
    const andRows = await e.searchKeyword('生产', { keyword_ranking: 'and', sourceId: 'default' });
    const orRows = await e.searchKeyword('生产', { keyword_ranking: 'or_idf', sourceId: 'default' });
    expect(andRows.map((r) => r.slug)).toContain('projects/cjk');
    // or_idf is a no-op for CJK: same route (CJK ILIKE), same result set.
    expect(orRows.map((r) => r.slug)).toEqual(andRows.map((r) => r.slug));
    await e.disconnect();
  }, 30000); // fresh engine → full initSchema (101 migrations) is slow on PGLite
});
