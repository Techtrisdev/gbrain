/**
 * registry.ts — connector bootstrap (TECH-2035).
 *
 * Importing this module runs every connector module's top-level
 * registerConnector(...) side effect, populating the in-memory REGISTRY that the
 * /webhooks/:provider receiver resolves against (src/core/connectors/base.ts). The
 * server imports this ONCE at startup so the generic receiver can route to a real
 * connector instead of an empty registry.
 *
 * Add a connector by importing its module here (the import is the registration — the
 * connector module calls registerConnector at load). Keep this list as the single,
 * obvious place every connector is wired in.
 *
 * NOTE (parallel-branch hygiene): TECH-2033 also touches this file. Both branches only
 * ADD import lines, so the merge is additive — no behavioral coupling.
 */

import './linear.ts';
