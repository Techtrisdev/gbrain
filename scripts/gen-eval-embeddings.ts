/**
 * Generate frozen embeddings for the eval-realcorpus retrieval gate.
 *
 * Embeds the committed corpus (document-side) and the qrels queries (query-side)
 * through gbrain's OWN embed path — the AI gateway configured for the system
 * default ZeroEntropy `zembed-1` at 1280 dims — and writes the resulting vectors
 * to `test/fixtures/eval-realcorpus/embeddings-frozen.json`. The CI gate
 * (test/eval-realcorpus-gate.serial.test.ts) seeds those frozen vectors into
 * PGLite so retrieval quality is measured against REAL semantic embeddings with
 * zero network or API key at test time.
 *
 * Run it with the real key injected from the environment (never hard-code it):
 *
 *   doppler run -p techtris-brain -c dev -- bun run scripts/gen-eval-embeddings.ts
 *
 * SECURITY: this script NEVER prints, logs, or commits the ZEROENTROPY_API_KEY
 * (or any secret). It reads the key out of `process.env` only to hand it to the
 * gateway, and writes ONLY the resulting embedding vectors (plain numbers). Do
 * not add any logging of `process.env` here.
 */
import { writeFileSync } from 'fs';
import { configureGateway } from '../src/core/ai/gateway.ts';
import { embedBatch, embedQuery } from '../src/core/embedding.ts';
import {
  EMBEDDINGS_PATH,
  EVAL_EMBEDDING_DIMS,
  EVAL_EMBEDDING_MODEL,
  loadCorpus,
  loadQrels,
  type FrozenEmbeddings,
} from '../test/fixtures/eval-realcorpus/loader.ts';

/** Round to 7 significant decimals — preserves cosine ordering, ~halves file size. */
function round(vec: Float32Array): number[] {
  return Array.from(vec, (x) => Math.round(x * 1e7) / 1e7);
}

async function main(): Promise<void> {
  const requiredKey = 'ZEROENTROPY_API_KEY';
  if (!process.env[requiredKey]) {
    // Do NOT print env. Just name the missing key and the doppler command.
    console.error(
      `[gen-eval-embeddings] missing ${requiredKey} in the environment.\n` +
        `Run with the key injected, e.g.:\n` +
        `  doppler run -p techtris-brain -c dev -- bun run scripts/gen-eval-embeddings.ts`,
    );
    process.exit(2);
  }

  configureGateway({
    embedding_model: EVAL_EMBEDDING_MODEL,
    embedding_dimensions: EVAL_EMBEDDING_DIMS,
    env: process.env as Record<string, string | undefined>,
  });

  const corpus = loadCorpus();
  const qrels = loadQrels();

  console.log(
    `[gen-eval-embeddings] embedding ${corpus.length} docs + ${qrels.length} queries ` +
      `via ${EVAL_EMBEDDING_MODEL} @ ${EVAL_EMBEDDING_DIMS}d`,
  );

  // Documents: batch document-side embed (gateway splits per ZE batch caps).
  const docVecs = await embedBatch(corpus.map((p) => p.body));
  const documents: Record<string, number[]> = {};
  corpus.forEach((p, i) => {
    if (docVecs[i].length !== EVAL_EMBEDDING_DIMS) {
      throw new Error(`doc ${p.slug}: got ${docVecs[i].length}d, expected ${EVAL_EMBEDDING_DIMS}d`);
    }
    documents[p.slug] = round(docVecs[i]);
  });

  // Queries: query-side embed (asymmetric — ZE returns query-encoded vectors).
  const queries: Record<string, number[]> = {};
  for (const q of qrels) {
    const v = await embedQuery(q.query);
    if (v.length !== EVAL_EMBEDDING_DIMS) {
      throw new Error(`query ${q.query_id}: got ${v.length}d, expected ${EVAL_EMBEDDING_DIMS}d`);
    }
    queries[q.query_id] = round(v);
  }

  const out: FrozenEmbeddings = {
    schema_version: 1,
    embedding_model: EVAL_EMBEDDING_MODEL,
    dimensions: EVAL_EMBEDDING_DIMS,
    documents,
    queries,
  };
  writeFileSync(EMBEDDINGS_PATH, JSON.stringify(out, null, 0) + '\n', 'utf8');
  console.log(
    `[gen-eval-embeddings] wrote ${Object.keys(documents).length} doc + ` +
      `${Object.keys(queries).length} query vectors to ${EMBEDDINGS_PATH}`,
  );
}

main().catch((err) => {
  // Print the message only — never dump env / config objects that could carry a key.
  console.error('[gen-eval-embeddings] FAILED:', err instanceof Error ? err.message : String(err));
  process.exit(1);
});
