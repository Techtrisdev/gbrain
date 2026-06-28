/**
 * consolidation-config.ts — Memory Consolidation Engine (U6) config readers.
 *
 * Pure / engine-injected config helpers for the consolidation pipeline. Lives
 * OUTSIDE consolidate.ts (U1/U2's file, which does not exist yet when U6 lands)
 * so the gate + model + threshold readers carry NO forward dependency on the
 * extractor/classifier — `base.ts` (U3) and `consolidate.ts` (U1/U2) both import
 * from here, never the reverse.
 *
 * Three concerns, mirroring the existing connector + facts patterns:
 *
 *   1. ENABLEMENT — `consolidationEnabled(provider, sourceConfig)` reads
 *      `sources.config.connectors.<provider>.consolidation_enabled` (default
 *      FALSE). It is an opt-in layered ON TOP OF the existing safety gates, not
 *      a bypass: the kill-switch (`connectorAutomationDisabled`) and the
 *      connector's own `enabled === true` must BOTH hold first. Mirrors
 *      `readConnectorsConfig` / `granolaConfig`.
 *
 *   2. MODEL — `consolidationModel(engine)` resolves the reasoning-tier model
 *      via `connectors.consolidation_model`, falling back to Sonnet. Mirrors
 *      `getFactsExtractionModel` (route through `resolveModel`, keep the
 *      provider prefix so `gateway.chat()` can route it).
 *
 *   3. TIER-1 THRESHOLDS — `consolidationNoopCosine(engine)` (the ≥cutoff dedup
 *      band, default 0.95, anchored on facts/classify.ts's same-model 0.95) and
 *      `consolidationAddCosineFloor(engine)` (the low-cosine "ADD, no close
 *      match" band — calibration-gated per KTD2, default `null` = ESCALATE, so
 *      no premature low-cosine ADD before U2's Tier-1 distributions are logged).
 */

import type { BrainEngine } from '../engine.ts';
import { resolveModel } from '../model-config.ts';
import { readConnectorsConfig, connectorAutomationDisabled } from './poll.ts';

// ── Config keys + defaults (single source of truth) ──────────────────────────

/** Global config key for the consolidation model (reasoning tier). */
export const CONSOLIDATION_MODEL_KEY = 'connectors.consolidation_model';
/** Hardcoded last-resort model when nothing in the resolve chain matches. */
export const CONSOLIDATION_MODEL_FALLBACK = 'anthropic:claude-sonnet-4-6';

/** Global config key for the Tier-1 NOOP/dedup cosine cutoff. */
export const CONSOLIDATION_NOOP_COSINE_KEY = 'connectors.consolidation_noop_cosine';
/** Default NOOP cutoff — anchored on facts/classify.ts's same-model 0.95 (KTD2). */
export const CONSOLIDATION_NOOP_COSINE_DEFAULT = 0.95;

/** Global config key for the low-cosine "ADD, no close match" floor. */
export const CONSOLIDATION_ADD_COSINE_FLOOR_KEY = 'connectors.consolidation_add_cosine_floor';

/** Global config key for the minimum confidence at which an ADD/UPDATE SURFACES
 *  to the human review queue (U2). Below it, the verdict is logged but held back. */
export const CONSOLIDATION_SURFACE_MIN_CONFIDENCE_KEY = 'connectors.consolidation_surface_min_confidence';
/** Default surfacing floor — chosen from the prod sample (keeps the 0.87/0.92/0.97
 *  UPDATEs + ~0.93 ADDs, drops the 0.50 UPDATE). A starting point, not a tuned value. */
export const CONSOLIDATION_SURFACE_MIN_CONFIDENCE_DEFAULT = 0.7;

// ── 1. Enablement gate ───────────────────────────────────────────────────────

/**
 * Is consolidation enabled for `provider` on a source carrying `sourceConfig`
 * (the raw `sources.config` — object | JSON string | null)?
 *
 * Returns TRUE only when ALL hold:
 *   - the kill-switch is NOT tripped (env `GBRAIN_CONNECTORS_KILLSWITCH` or the
 *     per-source `connectors_killswitch` flag) — "stop everything" wins,
 *   - the connector itself is `enabled === true` (consolidation never runs on a
 *     disabled connector),
 *   - `connectors.<provider>.consolidation_enabled === true` (default false).
 *
 * Default-OFF + the two pre-gates mean a misconfigured or half-enabled source
 * degrades to today's raw passthrough. `env` is injected so tests don't mutate
 * `process.env`.
 */
export function consolidationEnabled(
  provider: string,
  sourceConfig: unknown,
  env: Record<string, string | undefined> = process.env,
): boolean {
  // "Stop everything NOW" override + per-source kill flag.
  if (connectorAutomationDisabled({ config: sourceConfig as never }, env)) return false;
  const entry = readConnectorsConfig(sourceConfig)[provider];
  // The connector must be enabled at all before consolidation can layer on.
  if (entry?.enabled !== true) return false;
  return entry.consolidation_enabled === true;
}

// ── 2. Model resolution ──────────────────────────────────────────────────────

/**
 * Resolve the consolidation model (reasoning tier; salience + merge judgment
 * needs a sophisticated model, not Haiku). Precedence is the standard
 * `resolveModel` chain: `connectors.consolidation_model` → models.default →
 * models.tier.reasoning → Sonnet fallback. Always returns a `provider:model`
 * string so `gateway.chat()` can route it.
 */
export async function consolidationModel(engine: BrainEngine | null): Promise<string> {
  const resolved = await resolveModel(engine, {
    configKey: CONSOLIDATION_MODEL_KEY,
    tier: 'reasoning',
    fallback: CONSOLIDATION_MODEL_FALLBACK,
  });
  // resolveModel can return a bare model id via tier defaults; keep the provider
  // prefix so the gateway router can dispatch it (mirrors getFactsExtractionModel).
  return resolved.includes(':') ? resolved : `anthropic:${resolved}`;
}

// ── 3. Tier-1 thresholds ─────────────────────────────────────────────────────

/**
 * The Tier-1 NOOP/dedup cosine cutoff (`>= this → duplicate → NOOP`). Reads
 * `connectors.consolidation_noop_cosine`; falls back to 0.95. A malformed /
 * out-of-[0,1] value is ignored (returns the default) rather than trusted.
 */
export async function consolidationNoopCosine(engine: BrainEngine): Promise<number> {
  return await readUnitFloat(engine, CONSOLIDATION_NOOP_COSINE_KEY, CONSOLIDATION_NOOP_COSINE_DEFAULT);
}

/**
 * The minimum confidence at which an ADD/UPDATE verdict SURFACES to the human
 * review queue (U2 surfacing gate). Reads
 * `connectors.consolidation_surface_min_confidence`; falls back to 0.70. A
 * malformed / out-of-[0,1] value is ignored (returns the default) rather than
 * trusted — exactly mirroring {@link consolidationNoopCosine}. Below this floor
 * the verdict is still logged + the candidate persisted (audit), it is just not
 * pushed at the human.
 */
export async function consolidationSurfaceMinConfidence(engine: BrainEngine): Promise<number> {
  return await readUnitFloat(
    engine,
    CONSOLIDATION_SURFACE_MIN_CONFIDENCE_KEY,
    CONSOLIDATION_SURFACE_MIN_CONFIDENCE_DEFAULT,
  );
}

/**
 * The low-cosine "ADD, no close match" floor (`<= this → fast-path ADD`).
 * Calibration-gated (KTD2): the zembed-1 low-cosine ADD band has no in-repo
 * precedent, so the DEFAULT is `null` = ESCALATE (no premature low-cosine ADD).
 * An operator sets `connectors.consolidation_add_cosine_floor` only after U2's
 * Tier-1 distributions justify a value. A malformed / out-of-[0,1] value →
 * `null` (stay calibration-gated).
 */
export async function consolidationAddCosineFloor(engine: BrainEngine): Promise<number | null> {
  const raw = await engine.getConfig(CONSOLIDATION_ADD_COSINE_FLOOR_KEY);
  if (raw == null || raw.trim() === '') return null;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 && n <= 1 ? n : null;
}

/** Read a config key as a float clamped to [0,1]; default on missing/invalid. */
async function readUnitFloat(engine: BrainEngine, key: string, fallback: number): Promise<number> {
  const raw = await engine.getConfig(key);
  if (raw == null || raw.trim() === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 && n <= 1 ? n : fallback;
}
