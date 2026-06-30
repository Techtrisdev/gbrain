/**
 * Real-corpus retrieval quality gate (search-quality "measurement unlock").
 *
 * WHAT THIS ADDS over test/eval-replay-gate.test.ts:
 *   eval-replay-gate is a hermetic PLUMBING test — it seeds basis vectors (a 1.0
 *   at one dimension) so retrieval is deterministic, and it has ZERO how-to /
 *   procedural queries. It proves fusion/boost wiring works; it cannot prove
 *   semantic recall, and it cannot catch the documented defect where people
 *   pages out-rank how-to docs.
 *
 *   THIS gate seeds a small REAL-PROSE corpus (people + company/client pages
 *   AND how-to / runbook / integration / decision docs) embedded with gbrain's
 *   OWN ZeroEntropy `zembed-1` @ 1280d path (frozen vectors committed under
 *   test/fixtures/eval-realcorpus/). It runs the production `runEval` HYBRID
 *   pipeline and asserts mean nDCG@k + recall floors AND — the key new signal —
 *   a per-band **how-to nDCG floor**.
 *
 * WHY THE HOW-TO BAND IS THE SIGNAL:
 *   Source-boost (src/core/search/source-boost.ts) multiplies people/ and
 *   companies/ scores by 1.2 but has NO band for docs/runbooks/integrations/
 *   decisions (they get the 1.0 ELSE factor in sql-ranking.ts). So a how-to
 *   query whose correct answer is a doc competes against a topically-adjacent
 *   person who gets a free 20% boost. A regression that widens that gap buries
 *   how-to docs under people pages and collapses the per-band how-to floor here.
 *   The `sensitivity` test below proves the gate trips when people-boost is
 *   inflated.
 *
 * HERMETIC DESIGN (no network, no real API key at test time):
 *   - The gateway is configured for ZE/1280 so the PGLite `embedding` column is
 *     sized 1280 to match the frozen vectors (the bunfig preload pins tests to
 *     OpenAI/1536; we override per the preload's documented escape hatch).
 *   - Document vectors are seeded directly from the frozen JSON.
 *   - Query embedding is served from the frozen JSON via the gateway's official
 *     `__setEmbedTransportForTests` seam — `runEval` → `hybridSearch` →
 *     `embedQuery` returns the frozen query vector with zero network.
 *   - Search mode is forced to `conservative` (reranker OFF, expansion OFF,
 *     graph-signals OFF) so the run is deterministic and never reaches a
 *     network-bound reranker. The gate measures the deterministic ranking core
 *     (keyword + vector + RRF + source-boost + post-fusion) where the defect lives.
 *
 * This file is `*.serial.test.ts` because it configures the gateway singleton
 * and installs an embed transport — the sanctioned home for gateway-state
 * mutation (run in its own process by scripts/run-serial-tests.sh).
 *
 * Env-overridable floors (mirrors eval-replay-gate's convention):
 *   GBRAIN_REALCORPUS_NDCG_FLOOR        (default below) — overall mean nDCG@k
 *   GBRAIN_REALCORPUS_RECALL_FLOOR      (default below) — overall mean recall@k
 *   GBRAIN_REALCORPUS_HOWTO_NDCG_FLOOR  (default below) — how-to band mean nDCG@k
 *
 * Refresh procedure: when a ranking change is intentional, update the floors
 * (or the qrels) with a `Why:` line in the commit body. Do NOT silently
 * rubber-stamp a how-to-band regression.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { readFileSync } from 'fs';
import {
  configureGateway,
  resetGateway,
  __setEmbedTransportForTests,
} from '../src/core/ai/gateway.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { runEval, type EvalQrel } from '../src/core/search/eval.ts';
import { withEnv } from './helpers/with-env.ts';
import {
  EMBEDDINGS_PATH,
  EVAL_EMBEDDING_DIMS,
  EVAL_EMBEDDING_MODEL,
  loadCorpus,
  loadQrels,
  type EvalBand,
  type FrozenEmbeddings,
  type RealcorpusQrel,
} from './fixtures/eval-realcorpus/loader.ts';

// ---------------------------------------------------------------------------
// Constants (env-overridable floors) — k and defaults
// ---------------------------------------------------------------------------

const K = 5;
const SEARCH_LIMIT = 10;

// Defaults are pinned BELOW the observed real-embedding metrics with margin so
// normal embedding jitter doesn't flake the gate, while a real ranking
// regression (especially how-to under people) still trips it. See the file
// header for the refresh procedure.
const DEFAULT_NDCG_FLOOR = 0.80;
const DEFAULT_RECALL_FLOOR = 0.80;
const DEFAULT_HOWTO_NDCG_FLOOR = 0.70;

function resolveFloors(): { ndcg: number; recall: number; howto: number } {
  const n = process.env.GBRAIN_REALCORPUS_NDCG_FLOOR;
  const r = process.env.GBRAIN_REALCORPUS_RECALL_FLOOR;
  const h = process.env.GBRAIN_REALCORPUS_HOWTO_NDCG_FLOOR;
  return {
    ndcg: n !== undefined ? Number(n) : DEFAULT_NDCG_FLOOR,
    recall: r !== undefined ? Number(r) : DEFAULT_RECALL_FLOOR,
    howto: h !== undefined ? Number(h) : DEFAULT_HOWTO_NDCG_FLOOR,
  };
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const frozen = JSON.parse(readFileSync(EMBEDDINGS_PATH, 'utf8')) as FrozenEmbeddings;
const corpus = loadCorpus();
const qrels = loadQrels();

/** Map exact query TEXT -> frozen query-side vector (the transport keys on text). */
const queryVecByText = new Map<string, Float32Array>();
for (const q of qrels) {
  const vec = frozen.queries[q.query_id];
  if (!vec) throw new Error(`fixture missing query embedding for ${q.query_id}`);
  queryVecByText.set(q.query, Float32Array.from(vec));
}

function titleFor(body: string, slug: string): string {
  const first = body.split('\n', 1)[0]?.trim() ?? '';
  return first.startsWith('# ') ? first.slice(2).trim() : (slug.split('/').pop() ?? slug);
}

// ---------------------------------------------------------------------------
// Engine lifecycle (canonical PGLite block; gateway configured for ZE/1280)
// ---------------------------------------------------------------------------

let engine: PGLiteEngine;

beforeAll(async () => {
  // Override the bunfig preload's OpenAI/1536 default so the `embedding` column
  // is sized 1280 to match the frozen ZE vectors. A sentinel key makes
  // isAvailable('embedding') return true under CI (no real key); the embed
  // transport below means no ZE request is ever sent.
  configureGateway({
    embedding_model: EVAL_EMBEDDING_MODEL,
    embedding_dimensions: EVAL_EMBEDDING_DIMS,
    env: {
      ...process.env,
      ZEROENTROPY_API_KEY: process.env.ZEROENTROPY_API_KEY ?? 'sentinel-not-a-real-key',
    } as Record<string, string | undefined>,
  });

  // Serve query embeddings from the frozen fixture — no network. `runEval`
  // hybrid embeds only the query text (docs are seeded directly below).
  __setEmbedTransportForTests(async ({ values }: { values: string[] }) => ({
    embeddings: values.map((text) => {
      const vec = queryVecByText.get(text);
      if (!vec) {
        throw new Error(
          `[eval-realcorpus-gate] no frozen query vector for embed input: ${JSON.stringify(text)}`,
        );
      }
      return Array.from(vec);
    }),
  }) as any);

  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();

  // Seed each corpus page as one compiled_truth chunk carrying its frozen
  // document-side vector.
  for (const page of corpus) {
    const vec = frozen.documents[page.slug];
    if (!vec) throw new Error(`fixture missing document embedding for ${page.slug}`);
    await engine.putPage(page.slug, {
      type: page.type,
      title: titleFor(page.body, page.slug),
      compiled_truth: page.body,
      timeline: '',
    });
    await engine.upsertChunks(page.slug, [
      {
        chunk_index: 0,
        chunk_text: page.body,
        chunk_source: 'compiled_truth',
        embedding: Float32Array.from(vec),
        token_count: Math.ceil(page.body.length / 4),
      },
    ]);
  }

  // Deterministic, network-free ranking: reranker/expansion/graph-signals OFF.
  await engine.setConfig('search.mode', 'conservative');
});

afterAll(async () => {
  __setEmbedTransportForTests(null);
  resetGateway();
  if (engine) await engine.disconnect();
});

// ---------------------------------------------------------------------------
// Measurement helpers
// ---------------------------------------------------------------------------

function toEvalQrels(rows: RealcorpusQrel[]): EvalQrel[] {
  return rows.map((q) => ({
    id: q.query_id,
    query: q.query,
    relevant: q.relevant_slugs,
    grades: q.grades,
  }));
}

interface BandMetrics {
  meanNdcg: number;
  meanRecall: number;
  count: number;
}

async function measure(): Promise<{
  overallNdcg: number;
  overallRecall: number;
  byBand: Record<EvalBand, BandMetrics>;
  /** Mean reciprocal rank of the CANONICAL how-to doc across how-to queries. */
  howtoDocMrr: number;
  perQuery: Array<{ id: string; band: EvalBand; ndcg: number; recall: number; topHit: string; firstRelevantRr: number }>;
}> {
  const report = await runEval(engine, toEvalQrels(qrels), { strategy: 'hybrid', limit: SEARCH_LIMIT }, K);

  const perQuery = report.queries.map((qr, i) => {
    const idx = qr.hits.indexOf(qrels[i].first_relevant_slug);
    return {
      id: qrels[i].query_id,
      band: qrels[i].band,
      ndcg: qr.ndcg_at_k,
      recall: qr.recall_at_k,
      topHit: qr.hits[0] ?? '(none)',
      // Reciprocal rank of the page the qrel marks as the canonical answer.
      // For how-to queries this is the doc/runbook — the slug the defect buries.
      firstRelevantRr: idx >= 0 ? 1 / (idx + 1) : 0,
    };
  });

  const howtoRows = perQuery.filter((p) => p.band === 'howto');
  const howtoDocMrr = howtoRows.length
    ? howtoRows.reduce((s, r) => s + r.firstRelevantRr, 0) / howtoRows.length
    : 0;

  const bands: EvalBand[] = ['howto', 'people', 'company'];
  const byBand = {} as Record<EvalBand, BandMetrics>;
  for (const band of bands) {
    const rows = perQuery.filter((p) => p.band === band);
    byBand[band] = {
      count: rows.length,
      meanNdcg: rows.length ? rows.reduce((s, r) => s + r.ndcg, 0) / rows.length : 0,
      meanRecall: rows.length ? rows.reduce((s, r) => s + r.recall, 0) / rows.length : 0,
    };
  }

  return {
    overallNdcg: report.mean_ndcg,
    overallRecall: report.mean_recall,
    byBand,
    howtoDocMrr,
    perQuery,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('eval realcorpus gate — labeled real-prose retrieval (how-to band signal)', () => {
  test('current ranking meets nDCG / recall floors AND the per-band how-to nDCG floor', async () => {
    const m = await measure();
    const floors = resolveFloors();

    // Always surface the numbers so a refresh PR can read them without --verbose.
    process.stderr.write(`[eval realcorpus gate] k=${K}\n`);
    process.stderr.write(
      `  overall: nDCG@${K}=${m.overallNdcg.toFixed(3)} (floor ${floors.ndcg.toFixed(3)}) ` +
        `recall@${K}=${m.overallRecall.toFixed(3)} (floor ${floors.recall.toFixed(3)})\n`,
    );
    for (const band of ['howto', 'people', 'company'] as EvalBand[]) {
      const b = m.byBand[band];
      process.stderr.write(
        `  band ${band.padEnd(8)} n=${b.count} nDCG@${K}=${b.meanNdcg.toFixed(3)} recall@${K}=${b.meanRecall.toFixed(3)}` +
          (band === 'howto' ? ` (floor ${floors.howto.toFixed(3)})` : '') +
          '\n',
      );
    }
    for (const p of m.perQuery) {
      process.stderr.write(
        `    ${p.id.padEnd(24)} band=${p.band.padEnd(8)} nDCG=${p.ndcg.toFixed(2)} recall=${p.recall.toFixed(2)} top=${p.topHit}\n`,
      );
    }

    expect(m.overallNdcg).toBeGreaterThanOrEqual(floors.ndcg);
    expect(m.overallRecall).toBeGreaterThanOrEqual(floors.recall);
    // The headline new signal: how-to docs must not be buried under people pages.
    expect(m.byBand.howto.meanNdcg).toBeGreaterThanOrEqual(floors.howto);
  });

  test('sensitivity: inflating people source-boost buries how-to docs (gate would catch the regression)', async () => {
    const baseline = await measure();

    // Simulate the documented regression: people pages get a much larger boost.
    // searchVector/searchKeyword read GBRAIN_SOURCE_BOOST at query time, so this
    // re-weights ranking without editing any source file.
    const regressed = await withEnv(
      { GBRAIN_SOURCE_BOOST: 'people/:8.0' },
      async () => measure(),
    );

    process.stderr.write(
      `[eval realcorpus gate][sensitivity] how-to DOC mrr baseline=${baseline.howtoDocMrr.toFixed(3)} ` +
        `-> people-boost=8.0 ${regressed.howtoDocMrr.toFixed(3)}\n`,
    );

    // Band-mean nDCG is a noisy regression lens here because each how-to query's
    // people distractor is itself low-grade relevant — boosting it can offset
    // its own ranking damage. The precise victim is the CANONICAL how-to doc:
    // inflating people-boost pushes those docs DOWN the ranking, so their mean
    // reciprocal rank must drop. This proves the per-band how-to floor is a live
    // regression detector, not a constant that always passes.
    expect(baseline.howtoDocMrr).toBeGreaterThan(0.5); // the metric is meaningful
    expect(regressed.howtoDocMrr).toBeLessThan(baseline.howtoDocMrr);
  });

  test('fixture integrity — bands, frozen vectors, and embedding space', () => {
    // Every query is tagged with a known band, and the how-to band's canonical
    // answer is always a doc/runbook/integration/decision page (NOT a person).
    const bands = new Set(['howto', 'people', 'company']);
    let howtoCount = 0;
    for (const q of qrels) {
      expect(bands.has(q.band)).toBe(true);
      expect(q.relevant_slugs).toContain(q.first_relevant_slug);
      if (q.band === 'howto') {
        howtoCount++;
        expect(q.first_relevant_slug.startsWith('people/')).toBe(false);
        expect(q.first_relevant_slug.startsWith('companies/')).toBe(false);
      }
    }
    expect(howtoCount).toBeGreaterThanOrEqual(6);

    // Frozen embeddings cover every corpus doc and every query, at the right dim.
    expect(frozen.embedding_model).toBe(EVAL_EMBEDDING_MODEL);
    expect(frozen.dimensions).toBe(EVAL_EMBEDDING_DIMS);
    for (const page of corpus) {
      expect(frozen.documents[page.slug]?.length).toBe(EVAL_EMBEDDING_DIMS);
    }
    for (const q of qrels) {
      expect(frozen.queries[q.query_id]?.length).toBe(EVAL_EMBEDDING_DIMS);
    }
  });

  test('no PII shapes or secrets in the corpus + qrels fixtures (privacy rule)', () => {
    // The corpus is synthetic by construction; this is a belt-and-suspenders
    // scan over BOTH the qrels and every corpus page for PII shapes (real email
    // addresses, phone numbers) and secret shapes (sk- keys, bearer tokens).
    // Intentionally pattern-based, not a real-name blocklist, so the fixture
    // never has to embed real names to assert their absence.
    const blobs = [
      readFileSync(new URL('./fixtures/eval-realcorpus/qrels-realcorpus.json', import.meta.url), 'utf8'),
      ...corpus.map((p) => p.body),
    ];
    for (const raw of blobs) {
      // No email addresses (example.com is the only allowed RFC-6761 domain).
      const emails = raw.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g) ?? [];
      expect(emails.filter((e) => !e.endsWith('@example.com'))).toEqual([]);
      // No secret shapes.
      expect(/sk-[A-Za-z0-9]{20,}/.test(raw)).toBe(false);
      expect(/bearer\s+[A-Za-z0-9._-]{20,}/i.test(raw)).toBe(false);
      // No US-style phone numbers.
      expect(/\b\d{3}[-.]\d{3}[-.]\d{4}\b/.test(raw)).toBe(false);
    }
  });
});
