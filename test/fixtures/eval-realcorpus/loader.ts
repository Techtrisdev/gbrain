/**
 * Shared loader for the eval-realcorpus fixture.
 *
 * Imported by BOTH the frozen-vector generator (scripts/gen-eval-embeddings.ts)
 * and the CI gate (test/eval-realcorpus-gate.serial.test.ts) so the slug- and
 * type-derivation contract is defined in exactly one place. If these two ever
 * drift, the doc vectors are keyed by a slug the gate never seeds and the gate
 * fails loudly — which is the intended safety behavior, but DRY here avoids it
 * by construction.
 *
 * Corpus layout: real-prose markdown under `corpus/<slug>.md`, where the slug
 * (with `/` separators) is the path relative to `corpus/` minus the `.md`
 * extension. The page TYPE is derived from the slug prefix, matching how the
 * production brain types `people/` and `companies/` pages.
 */
import { readdirSync, readFileSync, statSync } from 'fs';
import { join, relative, sep } from 'path';

export const REALCORPUS_DIR = import.meta.dir;
export const CORPUS_DIR = join(REALCORPUS_DIR, 'corpus');
export const QRELS_PATH = join(REALCORPUS_DIR, 'qrels-realcorpus.json');
export const EMBEDDINGS_PATH = join(REALCORPUS_DIR, 'embeddings-frozen.json');

/** Embedding space the frozen vectors were generated in. */
export const EVAL_EMBEDDING_MODEL = 'zeroentropyai:zembed-1';
export const EVAL_EMBEDDING_DIMS = 1280;

export type EvalBand = 'howto' | 'people' | 'company';

export interface CorpusPage {
  slug: string;
  type: 'person' | 'company' | 'note';
  /** Full markdown body — used as the single chunk text AND the doc embed input. */
  body: string;
}

export interface RealcorpusQrel {
  query_id: string;
  band: EvalBand;
  query: string;
  relevant_slugs: string[];
  first_relevant_slug: string;
  grades?: Record<string, number>;
}

export interface RealcorpusQrelFile {
  schema_version: 1;
  queries: RealcorpusQrel[];
}

export interface FrozenEmbeddings {
  schema_version: 1;
  embedding_model: string;
  dimensions: number;
  /** slug -> document-side embedding (frozen). */
  documents: Record<string, number[]>;
  /** query_id -> query-side embedding (frozen). */
  queries: Record<string, number[]>;
}

/** Derive the page type from the slug prefix (mirrors production typing). */
export function typeForSlug(slug: string): CorpusPage['type'] {
  if (slug.startsWith('people/')) return 'person';
  if (slug.startsWith('companies/')) return 'company';
  return 'note';
}

function walk(dir: string, acc: string[]): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, acc);
    else if (entry.endsWith('.md')) acc.push(full);
  }
  return acc;
}

/** Load every corpus page, sorted by slug for deterministic ordering. */
export function loadCorpus(): CorpusPage[] {
  const files = walk(CORPUS_DIR, []).sort();
  return files.map((file) => {
    const slug = relative(CORPUS_DIR, file).split(sep).join('/').replace(/\.md$/, '');
    const body = readFileSync(file, 'utf8').trim();
    return { slug, type: typeForSlug(slug), body };
  });
}

export function loadQrels(): RealcorpusQrel[] {
  const parsed = JSON.parse(readFileSync(QRELS_PATH, 'utf8')) as RealcorpusQrelFile;
  return parsed.queries;
}
