/**
 * Corpus term-statistics refresh (Ranked-OR + IDF keyword leg, work-class 2).
 *
 * Maintains the two per-source tables the `or_idf` keyword-ranking path reads:
 *   - corpus_term_stats(source_id, lexeme, df)      — per-lexeme document freq
 *   - corpus_term_stats_meta(source_id, n_docs, ..) — total text-chunk count N
 *
 * `df` and `n_docs` are derived ENTIRELY from the current chunk state via
 * Postgres' `ts_stat` over `content_chunks.search_vector` (english-stemmed,
 * matching how the query stems its lexemes), so a re-run produces the same
 * rows — the idempotency contract. The refresh is a per-source DELETE+INSERT
 * (stats) + UPSERT (meta) inside one transaction so the query never observes a
 * half-rebuilt table.
 *
 * Engine-agnostic: uses only `BrainEngine.transaction` + `executeRaw`, so the
 * SAME code runs on Postgres (prod) and PGLite (tests) — the parity guarantee.
 * The per-engine `refreshCorpusTermStats(sourceId)` methods are thin wrappers
 * over `refreshCorpusTermStats(engine, sourceId)` here.
 */

import type { BrainEngine } from '../engine.ts';

/**
 * Escape a value for safe inlining inside a single-quoted SQL string literal.
 * `ts_stat(text)` takes a SQL query STRING (not bind params), so the source_id
 * must be inlined; this doubles single-quotes so a source id can never break
 * out of the literal.
 */
function escapeSqlLiteral(s: string): string {
  return s.replace(/'/g, "''");
}

/**
 * Rebuild `corpus_term_stats` + `corpus_term_stats_meta` for one source.
 *
 * Idempotent: output depends only on the current `content_chunks` state, so
 * running twice yields identical rows. Safe to call at every reindex/sync
 * completion.
 *
 * @param engine   — target brain engine (Postgres or PGLite).
 * @param sourceId — source to refresh (e.g. 'default').
 */
export async function refreshCorpusTermStats(
  engine: BrainEngine,
  sourceId: string,
): Promise<void> {
  // The inner SELECT ts_stat runs over is a STRING literal (ts_stat has no bind
  // params), so build it with the source id inlined as an escaped SQL literal,
  // then escape the whole thing again when nesting it inside ts_stat('...').
  const innerSelect =
    `SELECT cc.search_vector ` +
    `FROM content_chunks cc ` +
    `JOIN pages p ON p.id = cc.page_id ` +
    `WHERE p.source_id = '${escapeSqlLiteral(sourceId)}' ` +
    `AND cc.modality = 'text' ` +
    `AND cc.search_vector IS NOT NULL`;
  const tsStatArg = escapeSqlLiteral(innerSelect);

  await engine.transaction(async (tx) => {
    // n_docs = total text chunks in this source (the IDF denominator N).
    const countRows = await tx.executeRaw<{ n_docs: number | string }>(
      `SELECT COUNT(*)::int AS n_docs
         FROM content_chunks cc
         JOIN pages p ON p.id = cc.page_id
        WHERE p.source_id = $1
          AND cc.modality = 'text'`,
      [sourceId],
    );
    const nDocs = Number(countRows[0]?.n_docs ?? 0);

    await tx.executeRaw(`DELETE FROM corpus_term_stats WHERE source_id = $1`, [sourceId]);

    // ts_stat returns (word, ndoc, nentry); ndoc is exactly the document
    // frequency we want. `word` is the english-stemmed lexeme (search_vector is
    // built with to_tsvector('english', ...)), matching the query's own
    // tsvector_to_array(to_tsvector('english', q)) lexemes.
    await tx.executeRaw(
      `INSERT INTO corpus_term_stats (source_id, lexeme, df)
         SELECT $1, word, ndoc
           FROM ts_stat('${tsStatArg}')`,
      [sourceId],
    );

    await tx.executeRaw(
      `INSERT INTO corpus_term_stats_meta (source_id, n_docs, refreshed_at)
         VALUES ($1, $2, now())
       ON CONFLICT (source_id)
         DO UPDATE SET n_docs = EXCLUDED.n_docs, refreshed_at = EXCLUDED.refreshed_at`,
      [sourceId, nDocs],
    );
  });
}

/**
 * Whether a source has a term-stats meta row (i.e. it has been refreshed at
 * least once). The or_idf query degrades gracefully to idf=1.0 without it, so
 * this is a diagnostic/telemetry helper, not a gate on the query path.
 */
export async function hasTermStats(engine: BrainEngine, sourceId: string): Promise<boolean> {
  const rows = await engine.executeRaw(
    `SELECT 1 FROM corpus_term_stats_meta WHERE source_id = $1 LIMIT 1`,
    [sourceId],
  );
  return rows.length > 0;
}
