# Hermes + GBrain memory boundary

Status: proposed
Date: 2026-07-08
Owner: Techtris/GBrain maintainers
Audience: downstream agent authors, Techtris operators, GBrain maintainers
Revisit when: Hermes changes external-provider slot semantics, GBrain adds per-OAuth-client slug-prefix allow-lists, or capture retention/distillation becomes source-parametric.

Fork note: this document is Techtris/Hermes-specific. Do not upstream it verbatim into generic GBrain docs without replacing private fork/operator names.

## Decision

Hermes and GBrain should remain separate memory layers by default:

```text
Hermes USER / MEMORY = tiny always-on steering layer
Hermes skills        = reusable procedures and corrected approaches
session_search       = prior chat/task recall on demand
GBrain MCP           = cited company/project/entity retrieval
GBrain capture lanes = private/agent operational capture and distillation
techtris-brain repo  = governed shared company truth
source systems       = secrets, contracts, CRM, current code, vendor docs
```

Keep Hermes' external memory-provider slot empty for now. A custom
Hermes-to-GBrain provider is viable in principle, but only as a bounded
capture emitter into GBrain's existing capture/review machinery. It must not
be a direct shared-memory writer.

## Why this exists

Downstream agents need two things that sound similar but have different trust
models:

1. always-on operational memory about how the agent should behave;
2. durable company/world knowledge with source, review, and promotion controls.

Hermes built-in memory is good for the first. GBrain and the Techtris Brain
repo are the authority for the second.

The mistake to avoid: treating GBrain as a generic greenfield memory provider.
The Techtris/GBrain fork already has robust capture and write boundaries. The
open question is how Hermes should use those boundaries safely.

## Existing GBrain boundaries

The fork already has the machinery a provider would need to target:

- connector output lands in `connector_candidates`, not directly in shared
  pages;
- connector writes pass through `landRecords()` redaction/substance checks;
- shared promotion uses HMAC-signed artifacts and a Techtris Brain PR bridge;
- auto-approval is default-off and narrow/allow-listed;
- OAuth/source scoping can confine downstream agents to a source;
- `OperationContext.remote` distinguishes trusted local callers from untrusted
  MCP/agent callers and fails closed when unset;
- session capture/distillation can turn raw captures into reviewed durable
  memory candidates.

So the provider question is not "does GBrain have boundaries?" It is "which
boundary should Hermes enter through?"

## Four tiers

| Tier | Mechanism | Correct Hermes relationship |
|---|---|---|
| Hermes provider lifecycle | Hermes `MemoryProvider` hooks as verified from Hermes docs on 2026-07-07: prompt context, prefetch, turn sync, session-end extraction, memory mirroring | If built, emit only into a dedicated capture/private source; never directly into shared truth. |
| GBrain operational capture | `capture-events`, `capture/<session>/...`, distillation, Context Mirror consolidation | Natural landing zone for provider write hooks after source/OAuth scoping and retention decisions. |
| GBrain inbox/candidates | `gbrain capture` -> `inbox/`; connectors -> `connector_candidates` | Quarantined review lane; distilled facts can surface here for human/governed approval. |
| Techtris shared brain | HMAC-signed promotion bridge -> `techtris-brain` PR/review/merge/reindex | Hermes never writes shared directly by default, provider or not. |

## Default operating policy

Do this now:

```text
Hermes built-in memory: enabled
Hermes external provider: off
Techtris GBrain MCP: read-only by default
Shared writes: promotion / PR / review / reindex only
```

Routing rules:

- User communication preference or stable agent operating fact -> Hermes
  `USER` / `MEMORY`.
- Repeatable workflow -> Hermes/GBrain skill documentation.
- Past-chat recall -> Hermes `session_search`.
- Company/client/project/entity fact -> GBrain / Techtris Brain governed path.
- Secrets, tokens, credentials, connection strings -> Doppler/current source
  system only; never Hermes memory or GBrain capture.

## Custom Hermes provider contract

A future Hermes-to-GBrain provider may be built only if it obeys this contract.

### Writes

Allowed:

```text
source_id: hermes-capture or another dedicated private source
slug prefix: capture/... or inbox/hermes/...
```

Disallowed by provider contract:

```text
source_id: shared, default, or any source that syncs the Techtris Brain repo
clients/
people/
projects/
decisions/
playbooks/
any Techtris Brain shared path
```

Important enforcement note: today, GBrain source scoping is the mechanical
OAuth boundary. Slug-prefix confinement is not enforced for ordinary OAuth
writers; `put_page` slug allow-lists apply to subagent/trusted-workspace
contexts, not broad OAuth clients. Until per-client slug-prefix enforcement is
built server-side, the prefix rules above are provider-side discipline plus a
required new server gate.

Provider write hooks may create private capture records. They may not create
shared company truth. Promotion to shared must stay on the candidate / PR /
review / reindex path.

### Auth and source scope

The provider needs a dedicated OAuth client with only the scopes it needs:

```text
read,write scoped to the Hermes private capture source
```

Do not reuse a broad `shared`, `default`, admin, or legacy unrestricted token.

### Raw text and secrets

Raw captures can contain full conversation text. That means a provider must
choose one of these before turn sync is enabled:

1. scrub/reject secret-like content before page write; or
2. store raw captures only inside a tightly source-scoped private lane,
   exclude/demote raw captures from default host retrieval, enable retention/TTL
   for raw capture pages, and either disable embedding for the capture source or
   explicitly accept that raw turn text is sent to the configured embedding
   provider and distillation model before TTL can purge it.

Source scoping, retrieval demotion, and TTL do not prevent write-time egress to
external AI providers. They reduce retrieval and retention risk; they do not
replace pre-write scrubbing for secrets.

Retention/distillation coverage is a real implementation requirement. Today,
the capture retention sweep is hardcoded to the `capture-events` source and
`capture/` / `distill-state/` prefixes. The distiller already accepts a
`--source` override, but nothing schedules it against a new Hermes source. If
Hermes uses a dedicated source such as `hermes-capture`, retention must become
source-parametric and distillation must be invoked for that source before
raw-turn sync is safe.

Do not rely on candidate/promotion redaction alone for raw-turn safety.
Candidate redaction protects downstream promotion; it does not by itself make
raw capture pages safe to retain forever or safe to surface in default search.

### Read hooks

Provider read hooks are separate from write hooks. If enabled, they must:

- use explicit source scope;
- frame retrieved content as untrusted context;
- cite source/slug/provenance;
- avoid injecting broad company context into every prompt.

### Single-provider slot

Hermes supports only one external memory provider at a time. Choosing GBrain
as that provider means not choosing Honcho, Mem0, Supermemory, Holographic,
ByteRover, or another provider for that profile. That opportunity cost should
be an explicit operator decision.

## Rollout plan

Phase 0: current state

- Keep read-only MCP for Techtris company context.
- Keep Hermes built-in memory for small steering facts.
- Keep shared writes governed.

Phase 1: explicit private capture

- Add an explicit command/tool path equivalent to "capture this to GBrain
  private inbox".
- Write only to a dedicated private source and `inbox/hermes/...` or
  `capture/...` slugs.
- No automatic turn sync.
- No session-end extraction.
- No built-in memory mirroring.

Phase 2: session-end distilled summary

- Capture only a bounded summary at session end.
- Preserve provenance back to the Hermes session where possible.
- Keep raw turns out unless the retention/scrubbing decision is resolved.

Phase 3: opt-in turn sync

- Enable only after source-bound OAuth, write-prefix restrictions,
  scrubbing/rejection, and retention tests pass.

Phase 4: read prefetch/context injection

- Add only if there is a clear product need beyond MCP search/query.
- Use injection-safe framing and citations.

Phase 5: shared promotion remains unchanged

- Provider output can become candidates.
- Shared truth still requires promotion, review, merge, and reindex.

## Required gates before automatic sync

Before Phase 3 or later, add/verify tests for:

- read-only Hermes MCP cannot call write operations;
- provider write token is source-bound;
- provider cannot write to `shared` or `default`;
- provider cannot write outside `capture/` or `inbox/hermes/` — this requires
  building per-OAuth-client slug-prefix enforcement because source scoping is
  the only mechanical OAuth write boundary today;
- capture retention and distillation cover the Hermes source — today retention
  is tied to `capture-events`; distillation accepts `--source` but must be
  scheduled/invoked for the Hermes source. A new `hermes-capture` source needs
  retention made source-parametric plus an explicit distill path, or a deliberate
  choice to use `capture-events` with a Hermes-specific sub-lane;
- raw `capture/` pages are excluded from or heavily demoted in default host
  retrieval, with tests proving they do not pollute normal search/think/dream
  contexts;
- raw captures can expire or be purged;
- secret-like strings are scrubbed/rejected before capture or explicitly
  covered by retention/source isolation;
- automatic writes have volume/cost caps so turn sync cannot create unbounded
  page/chunk/embed spend;
- the distillation prompt treats raw captured turn text as untrusted input;
  verify the existing sanitizer/framing covers provider-originated captures;
- client-secret custody and revocation are documented and tested;
- read-injected content is framed as untrusted and cited;
- the provider's `/token` and `/mcp` traffic is loopback-only or TLS-terminated;
  bearer tokens must never traverse plaintext networks;
- no other OAuth client's `federated_read` includes the Hermes capture source;
  test that a federated reader cannot retrieve raw Hermes `capture/` pages;
- raw capture pages are either scrubbed before write or excluded from embedding
  for the Hermes capture source; otherwise the operator has explicitly signed
  off on which external providers receive raw turn text for embedding and
  distillation;
- inbox/review flows are source-aware; if Hermes writes `inbox/hermes/...` under
  a dedicated source, review tooling must surface that source and not only
  `default`;
- the Hermes capture source is not included in published/mounted brains or in
  another client's federated-read scope;
- contributor-mode eval capture stays off on any host accepting provider turn
  sync, so raw provider writes do not create `eval_candidates` residue;
- `--log-full-params` stays off on any server accepting provider turn sync so
  raw turns are not mirrored into `mcp_request_log` or admin streams.

## Non-goals

This decision does not:

- enable a Hermes external memory provider;
- grant Hermes broad write access to GBrain;
- allow direct writes to shared Techtris Brain pages;
- replace Techtris Brain PR/review/reindex governance;
- store secrets or runtime truth in Hermes memory or GBrain.

## Evidence and related docs

- `CLAUDE.md` — architecture map, trust boundary, operation context.
- `AGENTS.md` — downstream agent operating protocol.
- `docs/guides/brain-vs-memory.md` — memory/session/brain routing model.
- `docs/guides/agent-to-gbrain.md` — downstream agent surfaces and OAuth scope.
- `docs/eval-capture.md` — off-by-default telemetry capture and scrubber.
- `src/commands/capture.ts` — explicit capture entrypoint.
- `src/commands/capture-distill.ts` — capture distillation path.
- `src/core/connectors/` — candidate, redaction, promotion, trust-tier logic.
- `src/core/operations.ts` — operation scopes and remote/trusted context.
- `test/operations-trust-boundary.test.ts` — trust-boundary regression tests.

## Summary

The correct posture is:

```text
GBrain already has boundaries.
Hermes should use them deliberately.
A provider is possible, but private-capture-first and shared-write-never.
```
