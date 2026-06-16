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
import './slack.ts';
import './calendar.ts';
import './github.ts';

// TECH-2109: register the connector→Brain promotion bridge so candidate approvals build +
// sign + emit a repository_dispatch to techtris-brain. The hook is env-backed
// (PROMOTION_HMAC_SECRET + GBRAIN_PROMOTE_GITHUB_TOKEN) and INERT until a real approval
// fires — registering it performs no network call. Side-effect import mirrors the connector
// registrations above (the import IS the wiring).
import { registerDefaultPromotionHook } from './promotion-hook.ts';
registerDefaultPromotionHook();
