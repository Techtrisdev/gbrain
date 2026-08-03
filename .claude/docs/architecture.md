# Architecture

Patterns that hold across `src/`. Each entry states the rule, points at examples, and names where the rule stops applying.

## Two-axis addressing: brain, then source

Every read and write is scoped by *which database* (brain) and *which repo inside it* (source). Confusing the two makes queries silently return nothing rather than error.

A brain is a database — the local one, or a mounted team brain, routed by `--brain`, `GBRAIN_BRAIN_ID`, or a `.gbrain-mount` file. A source is a namespace inside that database; slugs are unique per source, not per brain, routed by `--source`, `GBRAIN_SOURCE`, or `.gbrain-source`. Both resolve through the same six-tier precedence chain — `src/core/source-resolver.ts` exposes `resolveSourceWithTier` so callers can report *which* tier won, not just the answer.

Examples: `src/core/brain-resolver.ts`, `src/core/source-resolver.ts`, `docs/architecture/brains-and-sources.md`. Counter-case: single-source brains never pass `sourceId` and fall through to the schema default `'default'`; that path is the majority of tests and is not evidence the axis is optional.

## One engine interface, two implementations

`BrainEngine` (`src/core/engine.ts:593`) is the only database abstraction. `src/core/postgres-engine.ts` and `src/core/pglite-engine.ts` implement it; `src/core/engine-factory.ts:8` picks one by dynamic import so the unused engine is never loaded.

Branch on the `kind` discriminator (`src/core/engine.ts:595`), never `instanceof` — the dynamic import means the constructor may not be in scope.

Dependency direction is meant to run `src/commands/` → `src/core/` → engine. Nine modules break it today by reaching back into `src/commands/` for helpers that were never extracted: value imports at `src/core/embed-stale.ts:22`, `src/core/cycle/extract-takes.ts:26`, `src/core/calibration/cross-brain.ts:43`, `src/core/search/mode-switch-ux.ts:35`, and `src/core/thin-client-upgrade-prompt.ts:25`, plus four type-only imports of `CalibrationProfileRow` that leave `src/commands/calibration.ts` owning a type four core modules depend on. No CI guard enforces the direction, which is why it drifted. Treat those as debt, not precedent.

Counter-case: parity is a goal, not a guarantee. PGLite no-ops on Postgres-only features (row-level security, `CREATE INDEX CONCURRENTLY`), and Postgres ranks pages then picks a chunk where PGLite returns chunks directly. `test/e2e/engine-parity.test.ts` and `test/e2e/schema-drift.test.ts` exist because the two do drift.

## Schema lives in SQL, changes live in migrations

`src/schema.sql` is the source of truth for a fresh Postgres brain. `src/core/schema-embedded.ts` is generated from it by `scripts/build-schema.sh` and must never be hand-edited. `src/core/pglite-schema.ts` is the PGLite equivalent.

Every change after the initial create is an append to `MIGRATIONS` (`src/core/migrate.ts:115`). A migration declares engine-specific SQL via `sqlFor` (`src/core/migrate.ts:26`) — set `sqlFor.pglite: ''` to no-op on the embedded engine — and opts out of the wrapping transaction via `transaction: false` (`src/core/migrate.ts:33`) for statements Postgres refuses inside one. Resolution is `m.sqlFor?.[engine.kind] ?? m.sql` (`src/core/migrate.ts:5102`).

Validate a new migration against both engines before it lands. `test/schema-bootstrap-coverage.test.ts` runs without a database; `test/e2e/schema-drift.test.ts` needs `DATABASE_URL` and diffs a freshly-migrated Postgres against a freshly-migrated PGLite, so engine divergence surfaces there rather than in production. This matters more than it looks: in the Techtris deployment a merged migration executes unattended against production Neon Postgres on the next container boot, with no approval step. A migration that half-applies leaves the version wedged, and the recovery path is `gbrain apply-migrations --force-retry <version>` (`src/commands/apply-migrations.ts:68`), not editing the ledger by hand.

Counter-case: PGLite additionally runs a forward-reference bootstrap before replaying the embedded schema, because old brains can hold a schema blob that references columns added later. Adding a column-plus-index to the embedded schema without extending that probe set is the single most repeated defect in this repo's history; `test/schema-bootstrap-coverage.test.ts` gates it.

## Contract-first operations

`src/core/operations.ts` declares 85 operations (`grep -c '^const .*: Operation' src/core/operations.ts` — treat any number written in prose as stale). Both transports are generated from that one list: the CLI builds its verb table from `cliHints` at `src/cli.ts:21`, and MCP builds tool definitions from the same array via `src/mcp/tool-defs.ts`.

Add a capability by adding an `Operation` (`src/core/operations.ts:556`), not by adding a command and an MCP tool. Each carries `scope` (`:572`) and `localOnly` (`:584`); the HTTP server filters on `operations.filter(op => !op.localOnly)` and `scripts/check-operations-filter-bypass.sh` fails the build if any other module imports the array and skips that filter.

`scope` has five values, not three: `read`, `write`, `admin`, `sources_admin`, `users_admin`. The hierarchy lives in `src/core/scope.ts` — `admin` implies everything, while the two `*_admin` values are siblings on a separate axis and neither implies the other. There is also a carve-out worth knowing before assuming scope gates writes: `readScopeCallable` (`:583`) lets a caller holding only `read` invoke an op declared `scope: 'write'`. It is deliberately narrow. `resolveRequiredScope` (`src/core/scope.ts:100`) relaxes `write` to `read` and refuses to downgrade any admin-class scope, so the flag cannot grant read tokens access to a dangerous op even if misapplied. Exactly one op sets it — `record_retrieval_use` (`:1881`), a source-scoped, own-row-only feedback write that exposes no shared-knowledge surface. The rule lives in `scope.ts` rather than in each transport so the two HTTP gates cannot drift.

The rule has a boundary, and over-applying it is as wrong as under-applying it. An operation is a user-meaningful *action*, not an internal step. `run_doctor` and `get_health` are operations; the forty-odd individual checks inside `src/commands/doctor.ts` are not. `submit_job` and `list_jobs` are operations; the handlers under `src/core/minions/handlers/` that execute the work are not. Cycle phases in `src/core/cycle.ts` are steps in a pipeline and have no operation of their own. If a capability is a stage inside something already exposed, or needs a TTY, it does not become an operation.

Counter-case, and it is easy to misread: `CLI_ONLY` at `src/cli.ts:31` is a *dispatch* set, not a reachability set. It means the verb has its own handler instead of going through the generic op router — it says nothing about whether an equivalent operation exists. Many of those verbs have one: `orphans` alongside `find_orphans`, `doctor` alongside `run_doctor` (`scope: 'admin'`, `localOnly: false`, so genuinely MCP-callable), `salience` alongside `get_recent_salience`, and `call`, which exists purely to invoke operations. What an agent can reach is decided by `localOnly`, nothing else.

## The trust boundary is `ctx.remote`, and it fails closed

`OperationContext` (`src/core/operations.ts:278`) carries `remote`. `src/cli.ts:549` sets `false` (trusted local operator); `src/mcp/dispatch.ts:208` defaults to `true`. Two HTTP transports set it explicitly and both are live — the OAuth server at `src/commands/serve-http.ts:1766` and the older bearer-auth path at `src/mcp/http-transport.ts:425`. An audit of "everywhere `remote` is set" that finds only one of those is incomplete.

Gate on the strict comparison, never truthiness: `ctx.remote === false` for trusted-only paths, `ctx.remote !== false` for untrust-unless-proven. Real gates at `src/core/operations.ts:2796` (protected job names), `:952` (auto-link on trusted writes), and `:2687` (upload path strictness). The reason is historical — an HTTP context literal once omitted the field, a falsy `undefined` read as trusted, and a read+write OAuth token could submit shell jobs.

Counter-case: `localOnly: true` operations are rejected before dispatch, so their handlers never see a remote context. Testing them with `remote: true` tests an unreachable state.

## Reads scope through one helper

`sourceScopeOpts(ctx)` (`src/core/operations.ts:424`) encodes the precedence for read-side scoping: a federated array beats a scalar source id beats nothing. Every read handler routes through it so a token bound to one source cannot see neighbors.

Counter-case: write paths deliberately do not use it. Writes take `ctx.sourceId` directly, because a client with federated *read* across five sources must still write to exactly one.

## Raw SQL crosses engines through a narrow adapter

Infrastructure tables (OAuth, admin, audit) are not `BrainEngine` concerns, so they use `sqlQueryForEngine(engine)` (`src/core/sql-query.ts:32`) — a tagged template that builds positional `$N` SQL and routes through `engine.executeRaw`.

The adapter is deliberately narrower than postgres.js: scalars only, no nested fragments, no `sql.unsafe`, no transactions. JSONB writes go through `executeRawJsonb` (`src/core/sql-query.ts:107`) instead, because interpolating `${JSON.stringify(x)}::jsonb` double-encodes on postgres.js v3. `scripts/check-jsonb-pattern.sh` fails the build on that pattern.

Counter-case: page and chunk access never goes through this adapter. It exists for tables the engine interface does not model.

## Search is staged, and the cache key hashes the stages

`hybridSearch` (`src/core/search/hybrid.ts:463`) resolves the embedding column, embeds the query, runs vector and keyword retrieval, then post-processes in a fixed order: `rrfFusionWeighted` (`:1017`), `cosineReScore` (`:1024`), `runPostFusionStages` (`:1032`), `applyExactMatchBoost` (`:1036`), `dedupResults` (`:1091`), `applyReranker` (`:1123`), `enforceTokenBudget` (`:1252`).

Two orderings are easy to get backwards. Reranking runs *after* dedupe — `applyReranker` takes `deduped` as its argument, so it only ever sees the surviving set. And `applyExactMatchBoost` sits deliberately *outside* `runPostFusionStages`, so it is not floor-ratio gated: it is a lexical-relevance signal rather than a metadata boost.

`runPostFusionStages` holds four stages, not three — backlink (`:348`), salience (`:366`), recency (`:376`), and graph signals (`:399`). All four are wrapped in non-fatal try/catch and fail open. The floor threshold is computed once at entry (`computeFloorThreshold`, `:167`, called at `:345`) and passed to every stage, so gating is order-independent by design.

Counter-case: no single order describes every path. The no-embed (`:738`) and keyword-only (`:962`) branches skip fusion, cosine re-score, exact-match, and rerank entirely, running only post-fusion stages, dedupe, and the budget. "Rerank always runs" is false for both.

Behavior is bundled into named modes (`ModeBundle`, `src/core/search/mode.ts:41`; `MODE_BUNDLES`, `:314`). Because results are cached, every knob that changes ranking must be folded into the cache key: `KNOBS_HASH_VERSION` (`src/core/search/mode.ts:750`) is currently 10 and must be bumped whenever the knob set changes, or a cache row written under one configuration will be served to a caller expecting another.

Counter-case: `hybridSearch` is the uncached path. `hybridSearchCached` (`:1333`) wraps it, and eval harnesses call the bare function on purpose so a benchmark measures retrieval rather than cache hits.

## AI calls go through the gateway

`src/core/ai/gateway.ts` owns provider configuration and every outbound model call: `configureGateway` (`:349`), `chat` (`:2176`), `embed` (`:1126`), `rerank` (`:2724`). Providers are declared as data under `src/core/ai/recipes/`, so adding one is a new recipe rather than a new branch at each call site. Tests drive it through `__setChatTransportForTests` (`:533`) and `__setEmbedTransportForTests` (`:518`) rather than mocking the module.

Counter-case, and it is real: three production paths still construct the SDK directly. `src/core/cycle/synthesize.ts:644` and `src/commands/eval-longmemeval.ts:458` do so unconditionally; `src/core/minions/handlers/subagent.ts:140` is `deps.makeAnthropic ?? (() => new Anthropic())`, so it is injectable and only constructs directly on the default path. Those three are the complete set under `src/` — other apparent hits are comments, including several in `src/core/think/index.ts` describing a pattern that file no longer uses. Treat "single seam" as the direction of travel, not the current state.

## Model strings resolve through one chain

`resolveModel` (`src/core/model-config.ts:125`) walks CLI flag, deprecated key, per-task config key, `models.default`, `models.tier.<tier>`, environment variable, `TIER_DEFAULTS` (`:68`), then a caller fallback. Tiers are `utility | reasoning | deep | subagent` (`:25`).

Counter-case: the `subagent` tier is enforced Anthropic-only at three layers (queue admission, a runtime fallback, a doctor check) because the tool loop targets the Anthropic Messages API. A `models.default` pointing elsewhere is silently overridden for that tier alone.

## Background work is a Postgres-native queue

`MinionQueue` (`src/core/minions/queue.ts:36`) and `MinionWorker` (`src/core/minions/worker.ts:121`) implement a BullMQ-shaped queue with no Redis: claims use `FOR UPDATE SKIP LOCKED`, with lock renewal, stall detection, parent/child DAGs, and idempotency keys.

`PROTECTED_JOB_NAMES` (`src/core/minions/protected-names.ts:15`) holds seven job types that run shell commands or spend model budget. The single chokepoint is `MinionQueue.add` (`src/core/minions/queue.ts:81`), which throws unless the caller passes `{allowProtectedSubmit: true}`. The `submit_job` operation refuses to pass it for a protected name when the caller is remote (`src/core/operations.ts:2796`).

Counter-case, and read it before assuming MCP cannot reach protected jobs: `submit_agent` (`src/core/operations.ts:2867`) submits a `subagent` job with `allowProtectedSubmit: true` unconditionally (`:2997`). It is remote-callable by design. The trust comes from elsewhere — a dedicated `agent` OAuth scope, plus tools, source, slug prefixes, concurrency, and daily budget all bound at client-registration time rather than supplied per call. `ctx.remote === false` at `:2885` only skips the binding lookup for local callers.

A second counter-case: PGLite has no worker pool. Job paths there run inline, and several commands print a notice saying so rather than silently queueing work nothing will claim.

## Resumable commands checkpoint to a file, not the database

Three file-based checkpoint systems are live, one per long-running surface: `src/core/import-checkpoint.ts` (consumed by `src/commands/import.ts:22`, path computed at `:146`, written at `:249`), `src/core/remediation-checkpoint.ts` (`src/commands/doctor.ts:5003`), and `src/core/brainstorm/checkpoint.ts` (`src/commands/brainstorm.ts:221`, `src/core/brainstorm/orchestrator.ts:59`). All three write atomically via a temp file plus rename, and all three key on content rather than position — `import-checkpoint.ts` stores a set of completed paths, so a file enters it only when its own processing succeeds and resume correctness does not depend on walk order.

`src/core/op-checkpoint.ts` is a DB-backed primitive meant to replace all three, but only its garbage collector is wired: `purgeStaleCheckpoints` is called from `src/commands/jobs.ts:1403` and `src/core/cycle.ts:1128`, and no command reads or writes checkpoints through it. Its own comment at `:282` refers to an "import-checkpoint shim" that does not exist. The table is swept on a TTL while nothing fills it.

Counter-case: adding a fourth file-based checkpoint is the *consistent* choice today but not obviously the right one — the DB-backed primitive exists precisely because file checkpoints are per-machine and race across concurrent workers. Either is defensible; citing `op-checkpoint.ts` as established practice is not, since nothing has adopted it.

## stdout is data, stderr is everything else

`createProgress` (`src/core/progress.ts:449`) writes to stderr by default (`:450`) so `--json` output stays machine-parseable. Global flags are stripped before command dispatch by `parseGlobalFlags` (`src/core/cli-options.ts:54`), which is why `gbrain --progress-json doctor` works.

`scripts/check-progress-to-stdout.sh` fails the build if progress output reaches stdout.

Counter-case: a command's actual result belongs on stdout. Human-readable banners in otherwise-JSON commands go to stderr; the JSON envelope does not.

## Errors and audit have shared shapes

Agent-facing failures use `StructuredAgentError` / `buildError` / `serializeError` (`src/core/errors.ts:55`, `:39`, `:79`) so every surface returns the same envelope. Append-only audit trails use `createAuditWriter` (`src/core/audit/audit-writer.ts:174`), which handles ISO-week file rotation and honors `GBRAIN_AUDIT_DIR`. Audit writes are best-effort: they warn to stderr and never throw into the caller's path.

Counter-case: audit trails record decisions and failures, not successes. A per-success write on a search hot path is both I/O churn and a privacy leak, and was rejected on those grounds.

## Config is layered; secrets are not committed

`src/core/config.ts` resolves the file plane (`~/.gbrain/config.json`, honoring `GBRAIN_HOME` through `gbrainPath`, `:599`) and the database plane (a `config` table read by `loadConfigWithEngine`, `:303`). `gbrain config set` writes the database plane; a few keys are file-plane only and cannot be set that way.

Counter-case: `isThinClient` (`:178`) short-circuits the whole model. A thin client has no local brain at all and routes operations to a remote MCP server, so anything assuming a local engine must check it first.

## The CI gates are the coding standard

`bun run verify` chains 21 `scripts/check-*.sh` scripts plus `tsc --noEmit`. They encode conventions no linter would catch — no real names in fixtures, no double-encoded JSONB, no progress on stdout, WASM actually embedded in the compiled binary, `source_id` present in projections that feed `rowToPage`, admin bundle in sync with its source.

Read the header comment of a check before working around it; each one documents the incident that produced it. If a change makes a gate fail, the gate is usually right.

Counter-case: `verify` is not the full set. `bun run check:all` runs seven more, including `check-no-legacy-getconnection.sh`, `check-trailing-newline.sh`, and `check-exports-count.sh`. A green `verify` does not mean every gate in the repo passes.

## Unconfirmed

- Whether `src/core/schema-pack/` (a mutation surface for page-type packs) is reachable from every deployment shape, or only from the local CLI, was not verified.
- `resolveModel` applies `enforceSubagentCapable` on its config, tier, and env branches, but the CLI-flag and deprecated-key branches appear to return without that check. Whether an explicit `--model` can therefore place a non-tool-capable model in the subagent tier was not confirmed by execution.
