# How a downstream agent should talk to gbrain

This guide is for authors of downstream agents (hermes, openclaw, future
forks) that need to call gbrain operations from their own runtime. Reading
this first will save you a debugging cycle: gbrain has **two distinct
surfaces**, and which one you pick depends on the operation.

## The two surfaces

```
                       ┌─────────────────────────────────────────────┐
                       │                gbrain process                │
                       │                                              │
   Agent (hermes,      │  ┌──────────────────┐    ┌────────────────┐ │
   openclaw, fork) ────┼──▶  MCP ops surface  │    │ local CLI +    │ │
                       │  │ (HTTP + OAuth)    │    │ admin surface  │ │
                       │  │                   │    │                │ │
                       │  │  search, query,   │    │  sync, embed,  │ │
                       │  │  put_page,        │    │  extract,      │ │
                       │  │  get_page,        │    │  dream,        │ │
                       │  │  find_experts,    │    │  file/admin    │ │
                       │  │  ...              │    │  ops           │ │
                       │  └──────────────────┘    └────────────────┘ │
                       │           ▲                       ▲          │
                       │           │                       │          │
                       │           │                       │          │
                       │     thin-client OAuth      shell-job `inherit:`│
                       │     (preferred for          (preferred for   │
                       │      MCP-equivalent ops)    local CLI/admin) │
                       └─────────────────────────────────────────────┘
```

The two surfaces are **not interchangeable**. Pick by op, not by preference.

## Surface 1 — MCP ops over HTTP (thin-client + OAuth)

Use for any operation that has an MCP equivalent: `search`, `query`,
`put_page`, `get_page`, `find_experts`, `find_orphans`, `find_anomalies`,
`get_recent_salience`, `find_trajectory`, and so on. The canonical list is
the set of ops in `src/core/operations.ts` whose `localOnly` flag is unset
(or `false`).

### Setup

The host runs gbrain as a long-lived HTTP server:

```bash
gbrain serve --http --port 3131
```

The agent registers as an OAuth client (one-time):

```bash
gbrain auth register-client hermes \
  --grant-types client_credentials \
  --scopes read
# Add write only for a dedicated capture-source client; see
# docs/architecture/hermes-gbrain-memory-boundary.md.
# Prints client_id + client_secret one-time. Store securely.
```

The agent's runtime calls `/mcp` with a bearer token from `client_credentials`
grant. Secrets stay in the gbrain serve process; the agent never sees
DATABASE_URL or API keys.

Thin-client mode (`gbrain init --mcp-only`) gives the agent the same
client-credentials wiring, plus the `gbrain` CLI itself routes MCP-eligible
commands through the configured remote MCP. The agent can call
`gbrain search` / `gbrain query` directly and the CLI does the OAuth dance.

### Why this is preferred for MCP ops

- Secrets never leave the server process.
- OAuth scopes give you `read`, `write`, `admin` separation — agent only gets
  what it needs.
- Source-scoped tokens (`--source dept-x` on `register-client`) confine the
  agent to a specific source within a federated brain.
- One audit surface (`mcp_request_log`) covers every op call uniformly.

## Surface 2 — local-only CLI/admin commands via shell-job `inherit:`

Some CLI commands need local filesystem, daemon, or operator context and are
refused by thin-client mode even when lower-level MCP operations exist. Check
`src/cli.ts`'s thin-client refuse list and `src/core/operations.ts`'s
`localOnly` flags for the current source of truth. Common examples include:

- `sync` / `embed` / `extract` (filesystem walks and local indexing);
- `dream` (local synthesis cycle orchestration);
- local file/admin operations such as `file_upload`, `file_list`, `file_url`,
  `sync_brain`, `purge_deleted_pages`, `get_recent_transcripts`, and
  `code_traversal_cache_clear`.

For these, the agent should not route through HTTP MCP. The preferred pattern
is to run `gbrain` as a CLI subprocess, usually submitted as a shell job to the
GBrain Minions worker so retry / backoff / DLQ / audit trail all come for free.

### Setup

```bash
gbrain jobs submit shell --params '{
  "cmd": "gbrain sync --skip-failed && gbrain embed --stale",
  "cwd": "/data/gbrain",
  "inherit": ["database_url"]
}'
```

The `inherit: ["database_url"]` field tells the worker to look up
`database_url` from its `loadConfig()` and inject the value into the child
env as `GBRAIN_DATABASE_URL`. The DB row in `minion_jobs.data` carries the
names only — `inherit: ["database_url"]` — never the value. See
[minions-shell-jobs.md#secrets](./minions-shell-jobs.md#secrets) for the
full validation rules and error catalog.

### Why this is preferred over writing secrets into `env:` per-job

- Pre-v0.36.5.0 callers passed `env: { GBRAIN_DATABASE_URL: "postgresql://..." }`
  per job. The URL landed plaintext in `minion_jobs.data` and the shell-audit
  JSONL. Anyone with brain-DB read access (or a brain dump, or a shared brain
  via mounts) saw the URL. As of v0.36.5.0, this is rejected at pre-enqueue
  validation. The error message names `inherit: ["database_url"]` as the
  replacement.

### Worker setup (one-time, per host)

The agent's host needs a worker that processes shell jobs:

```bash
# One-shot inline execution (PGLite or Postgres):
gbrain jobs submit shell --params '{...}' --follow

# Persistent worker (Postgres only — PGLite uses --follow inline):
GBRAIN_ALLOW_SHELL_JOBS=1 gbrain jobs work
```

`GBRAIN_ALLOW_SHELL_JOBS=1` is the worker-side opt-in. Without it, shell jobs
sit in `waiting` indefinitely. Set it on the worker process env (or in your
deploy unit / launchd plist), not per-submission — submitter env is a weak
proxy for worker env.

## Decision table

| Operation | Surface | Why |
|---|---|---|
| `search` / `query` | HTTP MCP via thin-client | Has MCP op; OAuth-scoped. |
| `get_page` / `list_pages` | HTTP MCP | Same. |
| `put_page` | HTTP MCP | Same; respects subagent allow-list when applicable. |
| `find_experts` / `find_orphans` | HTTP MCP | Same. |
| `sync` / `embed` / `extract` | Shell job + `inherit:` or direct local CLI | Thin-client refused; needs local filesystem/indexing. |
| `dream` | Shell job + `inherit:` or direct local CLI | Local synthesis orchestration. |
| `doctor` | HTTP MCP where supported, otherwise local CLI | Has remote report path for some checks; local filesystem checks need local CLI. |
| `autopilot` | Run as a daemon directly on the host | Long-lived, not job-shaped. |
| `init` / host setup | One-time operator action | Creates/configures the local brain. |

## Recommended patterns

- **For Hermes memory integration, keep shared writes out of the provider path.** See [`../architecture/hermes-gbrain-memory-boundary.md`](../architecture/hermes-gbrain-memory-boundary.md) for the decision: Hermes may eventually emit to a dedicated private capture source, but shared company truth still moves through candidate / PR / review / reindex governance. <!-- fork-only link; strip before upstreaming -->
- **Prefer `inherit:` for secrets you don't want in the row.** Names land in
  `minion_jobs.data`; values resolve at child-spawn from the worker's config.
  If a brain DB ever traverses a trust boundary, secrets stay out.
- **Free-form names.** `inherit:` accepts any snake_case config-key on your
  worker — `database_url`, `anthropic_api_key`, `openai_api_key`,
  `voyage_api_key`, `groq_api_key`, `zeroentropy_api_key`, or any custom
  field you stuff into `~/.gbrain/config.json`. The agent picks what it
  needs.
- **`env:` still works** for non-secret values, or for cases where you
  WANT the value in the row (e.g. an opaque correlation token your audit
  flow needs to read back later). The validator doesn't second-guess you.
- **Never try to route a local-only CLI/admin command through thin-client MCP.** It will
  fail as not routable; use shell-job + `inherit:` (for secrets) or `env:`
  (for non-secrets).

## Migration: from pre-v0.36.5.0

If your agent submits shell jobs that pass secrets via `env:`:

```jsonc
// Pre-v0.36.5.0: works but URL persists in minion_jobs.data plaintext.
{
  "cmd": "gbrain sync --skip-failed",
  "cwd": "/data/gbrain",
  "env": { "GBRAIN_DATABASE_URL": "postgresql://..." }
}
```

Switch to (recommended):

```jsonc
// v0.36.5.0+: name in row, value resolved at child-spawn from worker config.
{
  "cmd": "gbrain sync --skip-failed",
  "cwd": "/data/gbrain",
  "inherit": ["database_url"]
}
```

Make sure the worker host has `database_url` configured (either via
`gbrain config set database_url <value>` or via `GBRAIN_DATABASE_URL` /
`DATABASE_URL` env on the worker process). If the worker can't resolve the
key, the validator rejects the job at submit time with a paste-ready hint.
