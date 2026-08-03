# Related repos

`gbrain` (this repo) is the engine. `techtris-brain` (`D:\Projects\techtris-brain`) is the corpus it serves. They are coupled at deploy time and at runtime, but never at build time — no import in `src/` reaches the other repo, and no page in that repo is executed here.

## Who owns what

| Concern | Owner |
|---|---|
| CLI verbs, MCP tools, search ranking, schema, migrations | this repo |
| Page content, page taxonomy, filing rules, provenance policy | `techtris-brain` |
| The Postgres schema | this repo (`src/schema.sql`) |
| The rows in that schema | `techtris-brain`, via import/seed |
| Which gbrain version production runs | `techtris-brain` (`Dockerfile`, `ARG GBRAIN_PACKAGE`) |

The dividing question, from `docs/guides/repo-architecture.md`: *is this about how the agent operates, or is this knowledge about the world?* Machinery here; world knowledge there.

## This repo is the fork production runs

`origin` is `git@github.com:Techtrisdev/gbrain.git`, not upstream `garrytan/gbrain`. That matters: changes merged here are eligible to reach production, but do not reach it on merge.

Production pins an exact commit in `techtris-brain`'s `Dockerfile`:

```
ARG GBRAIN_PACKAGE=github:Techtrisdev/gbrain#<sha>
RUN bun install -g "$GBRAIN_PACKAGE"
```

**Merging here changes nothing in production until that SHA is bumped by a PR in the other repo.** `main` runs ahead of the deployed pin routinely; check the real gap with `git rev-list --left-right --count <pinned-sha>...HEAD` rather than assuming they match. Use the three-dot, two-sided form — a plain `--count <sha>..HEAD` returns 0 both when the two are in sync and when HEAD is *behind* the pin, which are very different situations. The Dockerfile comment records why the pin, not a Railway environment variable, is the lever: a service-variable bump was observed not to re-propagate to the build ARG, so a cached layer served ~6-week-old code across multiple bumps. It also records the failure one level up — the pin itself going stale for 24 days while nothing showed red. That repo's `reconciliation_probe.py` now asserts deployed-ref equals audited-ref.

If you are debugging behavior someone reports in production, resolve the deployed SHA first. Assume nothing from local `main`.

## How the corpus reaches the database

Two paths, both in `techtris-brain`:

1. **Container boot** — `deploy/railway/start-gbrain-mcp.sh` runs `gbrain apply-migrations --yes`, re-asserts `search.mode` and `search.reranker.enabled` on every start (a DB re-init would otherwise silently drop retrieval to keyword-only with no error), then `gbrain import /app/brain`, then `gbrain serve --http` behind a Bun reverse proxy. A background loop runs `gbrain dream --phase purge` and `gbrain embed --stale` on an interval, because the full maintenance cycle is not deployed there.
2. **Push to `main`** — `.github/workflows/reindex.yml` re-seeds the `shared` source through the HTTP MCP surface using OAuth client credentials, after a mandatory dry run. Its `concurrency` group deliberately sets `cancel-in-progress: false` so a superseding push waits rather than killing a seed mid-flight.

Both paths are ordinary CLI and MCP surfaces. Neither is special-cased in this repo's code.

## What this means when you change things here

- **Changing an operation's name, params, or scope** breaks that repo's seeder and probe scripts, which call the MCP tools by name over OAuth. Grep `techtris-brain/scripts/` before renaming anything in `src/core/operations.ts`.
- **Changing search defaults** can be silently overridden: the boot script force-sets `search.mode` and `search.reranker.enabled` on every container start.
- **Changing embedding model or dimensions** invalidates stored vectors. That deployment scopes embedding to an explicit source allowlist (`GBRAIN_EMBED_SOURCES`) so restricted sources are never sent to a third-party embedder — a boundary enforced in their boot script, not by anything here.
- **Adding a migration** runs against production Neon Postgres on the next container boot, unattended.

## Counter-case

Not every gbrain deployment looks like this. A single-user PGLite brain has no Railway container, no OAuth, no seeder workflow, and no fork pin — `gbrain init` and `gbrain sync` are the whole story. Treat everything above as specific to the Techtris deployment, not as an invariant of the engine. `docs/architecture/topologies.md` enumerates the supported shapes.
