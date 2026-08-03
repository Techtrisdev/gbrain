# Testing

~842 test files. Which runner picks up a file, and whether it may touch shared state, is decided entirely by its filename. Get the suffix wrong and the failure shows up in someone else's test.

## The filename decides the runner

| Pattern | Runner | Concurrency |
|---|---|---|
| `test/**/*.test.ts` | `bun run test` | parallel, many files per process |
| `test/**/*.serial.test.ts` | `bun run test:serial` | `--max-concurrency=1`, after the parallel pass |
| `test/**/*.slow.test.ts` | `bun run test:slow` | excluded from the fast loop |
| `test/e2e/**/*.test.ts` | `bun run test:e2e` | sequential, needs `DATABASE_URL` |
| `tests/heavy/*.sh` | `bun run test:heavy` | shell, minutes each, never in `bun test` |

`scripts/run-unit-parallel.sh` fans out across CPU-count shards (override with `--shards N` or `SHARDS=N`), each capped at 600s (`GBRAIN_TEST_SHARD_TIMEOUT`). **Multiple test files share one bun process per shard.** Every isolation rule below follows from that one fact.

Local and CI shard differently on purpose: CI (`scripts/test-shard.sh`, 4-way, hash-bucketed) includes `*.slow.test.ts`; the local fast loop excludes it. Both exclude serial files from the buckets and run them separately. Don't try to unify them.

## Read failures from the log, not the terminal

On failure the runner writes `.context/test-failures.log` (failure blocks, prefixed `--- shard N: <name> ---`), `.context/test-summary.txt` (per-shard counts), and `.context/test-shards/` (raw logs). A wedged shard is recorded as `WEDGED after ${SHARD_TIMEOUT}s`.

Never pipe a test command through `tail` or `head`. `$?` after a pipe is the pipe's exit code, so a failing suite reports success, and bun prints failure detail *before* the summary line so tail drops exactly what you need. Redirect to a file, then read the file.

## Four isolation rules, linted

`scripts/check-test-isolation.sh` runs inside `bun run verify` and fails the build on any violation in a non-serial unit test file. `*.serial.test.ts` and `test/e2e/**` are exempt by design.

- **R1** — no `process.env` mutation (assignment, bracket assignment, `delete`, `Object.assign`, `Reflect.set`). Use `test/helpers/with-env.ts`, which saves and restores every key it touches via try/finally. It is cross-*test* safe but not intra-file concurrent-safe: `process.env` is process-global.
- **R2** — no `mock.module(...)` anywhere in the file. A top-level module mock rewrites the module registry for every other file sharing the shard process. There is no in-place fix; rename to `*.serial.test.ts`.
- **R3** — `new PGLiteEngine(` may only appear within ~50 lines after a `beforeAll(`. Module-scope or describe-body engines outlive the file.
- **R4** — any file constructing a `PGLiteEngine` must call `.disconnect(` inside `afterAll(`.

`scripts/check-test-isolation.allowlist` exempts 57 pre-existing files. It is documented as shrink-only; adding an entry means shipping a known flake.

## The canonical PGLite fixture

One engine per file, truncate between tests. Cold WASM start plus `initSchema()` costs seconds, so per-test engines are not viable; `test/helpers/reset-pglite.ts` truncates user data instead.

Copy the shape from `test/brain-writer.test.ts:199` — construct and `initSchema()` in `beforeAll` (`:201`), `disconnect()` in `afterAll` (`:207`), `resetPgliteState(engine)` in `beforeEach` (`:211`). That layout is what satisfies R3 and R4; any other arrangement will trip the linter.

`bunfig.toml` sets a 60s test timeout for this reason, and preloads `test/helpers/legacy-embedding-preload.ts` so the many fixtures carrying hard-coded 1536-dimension vectors still match the schema. A test that wants current gateway defaults calls `configureGateway()` in its own `beforeAll`.

## When to quarantine instead of fix

Rename to `*.serial.test.ts` when the file needs `mock.module`, is genuinely env-coupled at module load, or intentionally shares state across `it()` boundaries.

Treat it as a last resort. 96 files are currently serial and 95 of them have no same-named parallel counterpart, against a quarantine cap of 10 that the repo's own guidance describes as informational. Every addition makes the serial pass longer and it runs at concurrency 1. Prefer a dependency-injection seam — `__setChatTransportForTests`, `__setEmbedTransportForTests`, or the `opts.*Fn` parameters in search and eval code — over a module mock.

## E2E

E2E needs a real pgvector Postgres. Bring one up, bootstrap the schema, run, tear down:

```bash
docker run -d --name gbrain-test-pg -e POSTGRES_USER=postgres -e POSTGRES_PASSWORD=postgres \
  -e POSTGRES_DB=gbrain_test -p 5434:5432 pgvector/pgvector:pg16
export DATABASE_URL=postgresql://postgres:postgres@localhost:5434/gbrain_test
bun run dev -- doctor --json > /dev/null   # first connect runs initSchema()
bun run test:e2e
docker stop gbrain-test-pg && docker rm gbrain-test-pg
```

That `doctor` call is not optional. `apply-migrations` alone runs ALTER-style migrations on top of a base schema it does not create, so a fresh container without it fails on missing relations. `bun run ci:local` does this whole lifecycle for you in Docker.

Subprocess-spawning E2E tests must pass `env: { ...process.env }` explicitly. Bun's `execSync` does not inherit env set via `process.env.X = ...` after startup, so a `DATABASE_URL` loaded from `.env.testing` is invisible to children otherwise.

`scripts/select-e2e.ts` maps a diff to the E2E files worth running, and fails closed: an unmapped `src/` change runs everything rather than silently running nothing.

## Counter-case

The rules above govern the parallel unit pool only. `test/e2e/**` may mutate env and construct engines freely — it runs sequentially in its own process. `tests/heavy/` is shell, not bun, and is not gated by any of this.
