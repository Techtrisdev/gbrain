# Why the hybrid + graph stack works

Vector search alone underdelivers on real personal-knowledge queries. This doc explains why gbrain layers four strategies together and how they compound.

## The four strategies in concert

1. **Vector (HNSW on pgvector)** — semantic similarity. Catches "who works on retrieval quality at YC?" → pages mentioning "Garry Tan + retrieval" even when the user never typed "YC".
2. **Keyword (Postgres full-text)** — lexical match via `ts_rank` + `websearch_to_tsquery` (a `tsvector` index, not a true BM25 index — the ranking is `ts_rank`, referred to loosely as "BM25-style" elsewhere). Catches names, exact phrases, code identifiers, anything where the user remembers the literal token. Survives the cases where vector search drifts into thematic neighbors.
3. **Reciprocal-rank fusion (RRF)** — merges vector + keyword rankings without weighting one over the other globally. Each strategy gets to vote.
4. **Knowledge graph traversal** — follows typed edges. Catches "what did Bob invest in this quarter?" by walking `bob ── invested_in ──> company ── dated ──> Q1`. Vector search can't see causal chains; the graph can.

## Why each one alone fails

**Vector only.** Returns chunks semantically close to the query. Misses any factual relationship not directly encoded in the embedding. "Companies in Garry's portfolio" returns essays about portfolios, not company pages.

**Keyword only (ripgrep-style).** Brittle to phrasing. "Who works on retrieval?" misses pages that say "search ranking" instead of "retrieval." Garbage on synonyms, near-misses, or paraphrases.

**Graph only.** Excellent at "neighbors of Alice" but blind to anything not yet linked. Sparse on fresh pages until backlinks accumulate.

**Hybrid (vector + keyword + RRF), no graph.** Decent at "what is X?" type queries. Fails on "what is Y's relationship to X?" — those are graph queries and no amount of embedding tuning recovers them.

## The benchmark

BrainBench (corpus + harness in the sibling [gbrain-evals](https://github.com/garrytan/gbrain-evals) repo) measures retrieval P@5, R@5, MRR, nDCG@5 on a 240-page Opus-generated rich-prose corpus.

| Strategy | P@5 | R@5 | Notes |
|---|---|---|---|
| ripgrep BM25 only | ~18 | ~75 | Lexical-only baseline |
| vector-only RAG | ~18 | ~80 | Standard RAG implementation |
| gbrain graph-disabled (hybrid + RRF, no graph traversal) | ~18 | ~85 | Hybrid alone |
| **gbrain default (full stack)** | **49.1** | **97.9** | Graph + extract-quality lift |

**+31 P@5 points** from the graph + extract quality work. The graph isn't a marginal feature; it's the load-bearing wall.

## Auto-link: why zero-LLM-call edge extraction works

Every `put_page` runs `extractEntityRefs` on the markdown body. It matches:

- Standard markdown links: `[Garry Tan](wiki/people/garry-tan)`
- Obsidian wikilinks: `[[wiki/people/garry-tan|Garry Tan]]`
- Typed-link blockquotes: `> **Convention:** see [path](path).`

Three regexes, zero LLM tokens, single SQL `addLinksBatch` call with `INSERT ... SELECT FROM unnest(...) JOIN pages ON CONFLICT DO NOTHING RETURNING 1`. The graph grows on every write at near-zero cost. On a 17K-page brain, full graph extract completes in seconds.

Heuristic link-type inference (`attended`, `works_at`, `invested_in`, `founded`, `advises`) fires from surrounding sentence context — also LLM-free. Power users who want richer types add them via the typed-link blockquote convention.

## ZeroEntropy as reranker: 60% top-1 reshuffle

v0.36.0.0 ships ZeroEntropy's `zerank-2` as the default reranker (on for the `balanced` mode bundle). On a real-corpus benchmark across 20 queries, zerank-2 reshuffles **60% of top-1 results** after the hybrid + RRF + graph stack. That's the headline number.

The mechanical reason: hybrid ranking is locally optimal per strategy but globally suboptimal. A cross-encoder reranker reads the query + each candidate document jointly, with full attention. It catches the cases where the vector + keyword + graph signals all agreed on a document that's semantically related but topically wrong.

The cost: +150ms p50 latency, ~$0.025/M tokens. Disabled with `gbrain config set search.reranker.enabled false`. For agent loops that do downstream LLM work after retrieval, the latency is invisible.

## The honesty layer: abstention, answerability, and degraded-mode observability

A retrieval stack that *always returns its top hit* trains its consumers to distrust it. The reranker scores **topical relevance** ("is this passage about the query's topic"), not **answerability** ("does it answer the question"), and the bi-encoder embeds generic queries nearest a few broad, list-like "hub" pages. Together those produce **confident hub-noise**: for an out-of-domain or unanswerable query, a topically-adjacent page reranks high and is served as if it answered. Diagnosed live: `query("violin bow rosin technique")` returned `integrations/thanx` at a displayed 0.80. The honesty layer makes the Brain say *"I don't have a confident answer"* instead — a clean miss the consumer can recover from, never a confident wrong answer it must first notice.

**Rerank-abstention floor** (`search.rerank_abstain_floor`, default off). After rerank, if no candidate clears an absolute floor on the cross-encoder score, the query returns an empty result list plus an explicit `_meta.retrieval.abstained: true` (`isError` stays false — abstention is a *successful decision*, not a transport error; consumers detect it from the flag, never from an empty list). Text-modality only (the cross-encoder can't score image chunks). Validated operating point **0.5** against real consumer traffic: real answers rerank 0.63–0.98, junk ≤ 0.12.

```
gbrain config set search.rerank_abstain_floor 0.5     # enable; delete the key to disable (instant, no deploy)
```

**Answerability guard** (`search.answerability_guard` = `off | shadow | enforce`, default off). The one class the floor can't catch: a topically-adjacent page that reranks *above* the floor but doesn't answer ("Forge approval gate rules?" → a Context Mirror page at 0.69). A second-stage LLM judge (Haiku, explicit small model) asks "does this passage answer the question?" for the band-gated `[0.5, 0.85]`, non-known-entity, text-modality top result. **shadow** judges + logs the verdict to `query_cache.meta` but serves normally (the only way to harvest a labeled in-band set — the verdict doesn't exist passively); **enforce** abstains on a NO with `abstain_reason: 'not_answerable'`. Fail-open (LLM error/timeout/unavailable → serve), content-hash-keyed verdict cache, known-entity exemption (entity lookups are the reranker's strength). Worst case is a clean miss, never a new wrong answer. Roll out via shadow → measure → enforce, the same measured path the floor used.

**Degraded-mode observability.** Two silent failure surfaces are now visible in `_meta`:
- `vector_result_count` + `vector_requested_k` — a non-throwing partial vector recall (e.g. an HNSW cold-index miss) that drops the good page produces an abstention indistinguishable from a genuine no-answer. `count << requested_k` flags a *degraded* abstain per-request.
- `reranker_failed` — when the reranker errors it fail-opens and serves *un-reranked* (wrong-order) results silently. This marks it, and a `search_telemetry.reranker_failed` counter tracks the rate. (A reranker outage never abstains — the gate needs finite rerank scores — so it serves un-reranked, not nothing.)

**Semantic-cache entity gate.** The query cache matched on embedding cosine only, so entity-swapped queries ("What is Spendgo used for?" vs "…Punchh…") embed within threshold and served each other's cached results. A distinctive-token (entity) gate now requires the entity sets to match in addition to cosine — deterministic, no model call, a false negative only costs a recompute.

Every abstention/degradation is an *explicit, flagged* outcome, and its rate is queryable in `search_telemetry`. `abstention_rate` is a **health** metric (nonzero is good — the Brain refused to guess), monitored for deltas, not driven to zero — unlike the keyword→semantic `fallback_fired` rate, which should trend to zero once caller routing is correct.

## Source-aware ranking

Hybrid search applies a source-factor CASE expression at the SQL layer (lives in `src/core/search/sql-ranking.ts`). Curated content like `originals/`, `concepts/`, `writing/` outranks bulk content like `your-openclaw/chat/`, `daily/`, `media/x/`. Hard-exclude prefixes (`test/`, `archive/`, `attachments/`, `.raw/`) filter at retrieval, not post-rank.

The boost map is configurable via `GBRAIN_SOURCE_BOOST` env var or per-call `SearchOpts.exclude_slug_prefixes`. Temporal queries (`detail: 'high'`) bypass the boost so chat pages re-surface for time-sensitive lookups.

## Intent-aware query rewriting

`src/core/search/intent.ts` classifies queries into `entity`, `temporal`, `event`, or `general`. Each routes through different ranking knobs:

- **Entity** queries ("who works at X?") apply a higher graph-traversal weight.
- **Temporal** queries ("what happened last week?") bypass source-boost so chat/daily pages surface.
- **Event** queries ("Acme AI Series A") engage the timeline index.
- **General** queries hit the standard hybrid stack.

The classifier is deterministic (no LLM call). Wrong classification degrades gracefully — the hybrid stack still works without it.

## Multi-query expansion

For `detail: 'high'` searches, `src/core/search/expansion.ts` runs a Haiku-class LLM call to produce 2-3 query variants. Each variant runs through the full hybrid stack; results merge via RRF. Catches synonym misses without recall loss.

Expansion is opt-in per mode bundle (`tokenmax` on by default; `balanced` + `conservative` off). Default off in the cheap tiers because the LLM call adds ~$0.001/query and ~200ms — real money at scale.

## Putting it together

The full pipeline for a `query` op:

```
intent classify
       │
       ▼
expansion (if enabled)
       │
       ▼
hybrid search:
   ├── vector  (HNSW on chunk embeddings)
   ├── keyword (Postgres ts_rank via tsvector)
   ├── source-aware re-rank (CASE in SQL)
   └── RRF fusion → top 30
       │
       ▼
graph augment (typed-edge traversal from any seed)
       │
       ▼
reranker (zerank-2 cross-encoder, top 30 → reordered)
       │
       ▼
deduplication (same slug, different chunks → keep best)
       │
       ▼
── honesty layer (v0.41–0.43, see below) ──────────────
rerank-abstention floor   → below floor? return NO ANSWER
answerability guard (opt) → top result doesn't answer? abstain
       │
       ▼
token-budget enforcement (per mode bundle)
       │
       ▼
results  (or an explicit, flagged abstention)
```

Each stage is testable in isolation. Each stage is replaceable. The whole pipeline is < 1ms of orchestration cost; the latency budget goes to the upstream HTTP calls (embedding, rerank) and the index scans.

## How to verify on your own brain

```bash
# Run the public LongMemEval benchmark
gbrain eval longmemeval datasets/longmemeval_s.jsonl

# Capture your own queries and replay against retrieval changes
export GBRAIN_CONTRIBUTOR_MODE=1
# ... use gbrain normally ...
gbrain eval export > before.ndjson
# ... change something ...
gbrain eval replay --against before.ndjson

# A/B retrieval strategies on a labeled fixture
gbrain eval --qrels labels.tsv --config balanced.json
```

Methodology + metric glossary in [`docs/eval/SEARCH_MODE_METHODOLOGY.md`](../eval/SEARCH_MODE_METHODOLOGY.md).
