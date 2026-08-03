# CLAUDE.md

## Purpose

GBrain turns a directory of markdown into a queryable personal knowledge base. It is a Bun CLI plus an MCP server: it ingests pages into Postgres, serves hybrid (vector + keyword) retrieval to AI agents, and ships markdown "skills" that teach those agents how to use it. It is engine-pluggable, so the same brain runs embedded on a laptop or hosted for a team.

The markdown corpus this engine was built to serve lives in a separate repo, `techtris-brain` (`D:\Projects\techtris-brain`). That repo holds world knowledge; this one holds the machinery. Neither imports the other.

## Tech stack

- **Runtime**: Bun `>=1.3.10` (`package.json` `engines`). TypeScript executes directly; there is no transpile step outside `bun build --compile`.
- **Language**: TypeScript `strict`, ESM only. Imports carry `.ts` extensions (`allowImportingTsExtensions` in `tsconfig.json`).
- **Datastore**: Postgres 16 + pgvector, or PGLite 0.4.3 (Postgres compiled to WASM, embedded). One interface, two implementations — `src/core/engine.ts:593`.
- **AI**: Vercel AI SDK (`ai`, `@ai-sdk/*`) reached only through `src/core/ai/gateway.ts`. Providers are declared as data ("recipes"), not wired per call site.
- **HTTP**: Express 5 + `@modelcontextprotocol/sdk`, with OAuth 2.1 in `src/core/oauth-provider.ts`.
- **Admin UI**: React 19 + Vite in `admin/`, built separately and embedded into the compiled binary.
- **Package manager**: bun (`bun.lock`).

## Layout

| Path | Purpose |
|---|---|
| `src/cli.ts` | The only entry point. Parses global flags, then dispatches to a command or the shared operation layer. |
| `src/core/` | All behavior: engine, operations contract, search, AI gateway, job queue, maintenance cycle. |
| `src/commands/` | One module per CLI verb; thin orchestration over `src/core/`. |
| `src/mcp/` | Stdio MCP server plus the dispatch path shared with the HTTP transport. |
| `src/assets/` | tree-sitter WASM grammars, committed so `bun build --compile` can embed them. |
| `admin/` | React SPA served at `/admin`. `admin/dist/` is committed on purpose. |
| `skills/` | Markdown instructions shipped to downstream agents. Never imported or executed by `src/`. |
| `scripts/` | Build steps and the `check-*.sh` gates that `bun run verify` chains together. |
| `test/` | Unit and E2E suites. The filename suffix decides how a file runs — see the testing doc. |
| `tests/heavy/` | Shell-based ops tests costing minutes each; deliberately outside `bun test`. |
| `evals/`, `recipes/`, `templates/`, `examples/` | Eval harnesses and artifacts shipped to users. Not imported by `src/`. |

## Commands

```bash
bun install                      # install deps
bun run dev -- <args>            # run the CLI from source (alias for: bun run src/cli.ts)
bun run build                    # compile to bin/gbrain
bun run build:admin              # rebuild admin/dist, then re-embed it
bun run build:schema             # regenerate src/core/schema-embedded.ts from src/schema.sql
bun run build:llms               # regenerate llms.txt + llms-full.txt (required after editing CLAUDE.md)

bun run test                     # parallel unit suite (excludes *.slow, *.serial, e2e)
bun test test/config.test.ts     # a single file
bun run test:serial              # *.serial.test.ts at --max-concurrency=1
bun run test:slow                # *.slow.test.ts
bun run test:e2e                 # test/e2e/** — requires DATABASE_URL
bun run test:full                # verify + unit + slow + (e2e when DATABASE_URL is set)

bun run typecheck                # tsc --noEmit
bun run verify                   # the CI pre-test gate: 21 check-*.sh scripts, then typecheck
bun run ci:local                 # full local CI in Docker, including a throwaway pgvector

bun run dev -- apply-migrations --yes   # bring a brain's schema to head
```

There is no deploy step in this repo. `bun run build:all` cross-compiles release binaries; publishing runs from `.github/workflows/release.yml`.

Two gates bite quickly and are worth knowing before editing docs:

- `scripts/check-claude-md-paths.sh` fails if this file cites a `src/`, `test/`, `scripts/`, `skills/`, `docs/`, or `admin/` path that does not exist. A stale citation is treated as a correctness bug, not a typo, because `bun test` exits green on a filter that matches nothing.
- Editing this file without running `bun run build:llms` fails `test/build-llms.test.ts`, which is in the unit suite but *not* in `bun run verify`.

## Working agreement

> **Scope.** Deliver what was asked, at the scope intended. Make routine judgment calls yourself; check in only when different readings of the request would lead to materially different work. If the request seems mistaken or a better approach exists, say so in one sentence and continue with the task as asked rather than quietly narrowing, widening, or transforming it. Finish the whole task; stop short of actions clearly beyond it.
>
> **Simplicity.** Minimum code that solves the problem. No unrequested features. No abstractions for single-use code. No speculative configurability. No error handling for impossible states. If 200 lines could be 50, write 50.
>
> **Surgical edits.** Every changed line traces to the request. Don't improve adjacent code, comments, or formatting. Match surrounding style even where you'd choose differently. Remove imports and symbols your own change orphaned; leave pre-existing dead code alone and mention it instead.
>
> **Definition of done.** Restate the task as a checkable outcome before starting: "add validation" → "tests covering invalid input pass"; "fix the bug" → "a test reproducing it passes". For multi-step work, state the plan as one short list, then execute. Tests and typecheck green is the finish line — no separate verification pass, no re-checking work already checked.
>
> **Communication.** One sentence before the first tool call stating what you're doing. Mid-task updates only on a real finding or a change of direction. Close by leading with the outcome, supporting detail after. Correct an earlier statement only when the error would change code, conclusions, or decisions; otherwise fix it silently and move on.
>
> **Delegation.** Subagents only for large, genuinely independent, parallelizable tracks — a wide multi-file investigation, for instance. Never to verify or double-check your own work. One agent beats several; keep spawn counts low.
>
> **Written output.** Match document length to substance. No filler sections, no redundant summaries, no boilerplate.

## Additional documentation

- `.claude/docs/architecture.md` — read before changing anything under `src/core/`: the engine interface, schema and migration ownership, the operations contract, the trust boundary, search staging, and the AI gateway seam.
- `.claude/docs/testing.md` — read before adding or debugging a test: what the filename suffix decides, the four isolation rules a linter enforces, the canonical PGLite fixture, and the E2E database lifecycle.
- `.claude/docs/related-repos.md` — read when work spans this repo and `techtris-brain`: which repo owns what, and where the two are coupled at runtime.

Longer-form design docs live under `docs/` (`docs/architecture/`, `docs/guides/`, `docs/mcp/`) and are indexed by `llms.txt`.
