/**
 * gbrain connector — one-shot SaaS connector operations.
 *
 * `gbrain connector poll` is the SYNCHRONOUS, daemon-free equivalent of the
 * autopilot's connector-dispatch branch: it selects the same enabled
 * (source, provider) targets via `selectEnabledConnectorSources` and runs
 * `runConnectorPoll` on each inline — no Minion worker, no autopilot loop. A
 * minimal deployment (serve + a maintenance loop) can therefore refresh
 * connector candidates on an interval the same way it runs
 * `gbrain dream --phase purge`.
 *
 * Idempotent + candidate-only: `runConnectorPoll` lands `connector_candidates`
 * (a REVIEW queue) through the framework's redaction path; it NEVER writes a
 * durable Brain page and NEVER promotes. Promotion stays a separate,
 * human-gated step. Re-polling is a safe no-op (backfill's ON CONFLICT). The
 * kill-switch (`GBRAIN_CONNECTORS_KILLSWITCH`) and per-connector `enabled`
 * default-off both still gate every poll at run time inside runConnectorPoll.
 *
 * Usage:
 *   gbrain connector poll                                  # every enabled connector source
 *   gbrain connector poll --source <id> --provider <name>  # one explicit target
 *   gbrain connector poll --json                           # machine-readable report
 *   gbrain connector poll --dry-run                        # list targets, do not poll
 *   gbrain connector review                                # push the confident pending queue to a human
 *   gbrain connector review --json                         # stable machine shape
 *   gbrain connector review --digest                       # compact markdown for scheduled delivery
 */

import type { BrainEngine } from '../core/engine.ts';
import { fetchSource, loadAllSources } from '../core/sources-load.ts';
import {
  selectEnabledConnectorSources,
  runConnectorPoll,
  type ConnectorPollTarget,
  type ConnectorPollResult,
} from '../core/connectors/poll.ts';
import { listCandidates, type ReviewCandidate } from '../core/connectors/candidate.ts';
import { consolidateContextMirrorGeneration } from '../core/connectors/context-mirror.ts';
import { rollbackContextGeneration } from '../core/connectors/context-mirror-state.ts';
import {
  runBoundedContextMirrorReconciliation,
  toBoundedContextMirrorReconciliationWireReport,
} from '../core/connectors/context-mirror-reconcile.ts';
// Side-effect import: register all SaaS connectors so the standalone `gbrain connector`
// CLI resolves providers. Without it getConnector() returns undefined and every source
// skips as `connector_not_registered` (the HTTP server gets this via serve-http.ts:60;
// the CLI needs it too).
import '../core/connectors/registry.ts';

function flagValue(args: string[], name: string): string | null {
  const i = args.indexOf(name);
  return i !== -1 ? (args[i + 1] ?? null) : null;
}

/**
 * Resolve which (source, provider) targets a `connector poll` invocation should
 * hit. Pure routing over two inputs:
 *   - an explicit `--source` + `--provider` pair → exactly that one target
 *     (both required together; one without the other is a usage error), OR
 *   - neither → every ENABLED connector target, via the same
 *     `selectEnabledConnectorSources` selection the autopilot branch uses.
 *
 * Exported for unit testing — the CLI handler stays a thin I/O shell over it.
 */
export async function resolveConnectorPollTargets(
  engine: BrainEngine,
  opts: { source?: string | null; provider?: string | null },
): Promise<{ targets: ConnectorPollTarget[]; error?: string }> {
  const source = opts.source ?? null;
  const provider = opts.provider ?? null;
  if (source || provider) {
    if (!source || !provider) {
      return { targets: [], error: '--source and --provider must be given together.' };
    }
    return { targets: [{ sourceId: source, provider }] };
  }
  const sources = await loadAllSources(engine);
  const targets = selectEnabledConnectorSources(
    sources.map((s) => ({ id: s.id, local_path: s.local_path, config: s.config })),
  );
  return { targets };
}

export interface TargetedConsolidationArgs {
  sourceId: string;
  sessionId: string;
  generation: number;
  maxPartitions: number;
  maxCalls: number;
  maxCostUsd: number;
  maxRuntimeMs: number;
  budgetAuditPath: string;
  json: boolean;
}

export interface GenerationRollbackArgs {
  sourceId: string;
  sessionId: string;
  generation: number;
  rollbackGeneration: number;
  json: boolean;
}

export interface ContextMirrorTailArgs {
  sourceId: string;
  batchSize: number;
  maxBatches: number;
  maxRuntimeMs: number;
  reason: string;
  json: boolean;
}

export interface ContextMirrorTailCommandRuntime {
  fetchSource: typeof fetchSource;
  reconcile: typeof runBoundedContextMirrorReconciliation;
  writeStdout: (text: string) => void;
  writeStderr: (text: string) => void;
  setExitCode: (code: 0 | 1 | 2) => void;
}

function finiteTargetedNumber(flag: string, value: string, integer: boolean): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0 || (integer && !Number.isInteger(parsed))) {
    throw new Error(`${flag} must be a finite ${integer ? 'integer ' : ''}> 0`);
  }
  return parsed;
}

/** Strict parser for the one-generation consolidation canary. Ordinary poll
 * parsing remains unchanged; this seam refuses defaults because every provider
 * and partition boundary must be explicit in the evidence packet. */
export function parseTargetedConsolidationArgs(args: string[]): TargetedConsolidationArgs {
  const values = new Map<string, string>();
  let json = false;
  const allowed = new Set([
    '--source', '--session-id', '--generation', '--max-partitions', '--max-calls',
    '--max-cost-usd', '--max-runtime-ms', '--budget-audit-path',
  ]);
  for (let index = 0; index < args.length; index++) {
    const flag = args[index];
    if (flag === '--json') {
      if (json) throw new Error('--json may be specified only once');
      json = true;
      continue;
    }
    if (!allowed.has(flag)) throw new Error(`unknown targeted consolidation option: ${flag}`);
    if (values.has(flag)) throw new Error(`${flag} may be specified only once`);
    const value = args[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`${flag} requires a value`);
    values.set(flag, value);
    index += 1;
  }
  const missing = [...allowed].filter((flag) => !values.has(flag));
  if (missing.length > 0) throw new Error(`required targeted consolidation options missing: ${missing.join(', ')}`);
  return {
    sourceId: values.get('--source')!,
    sessionId: values.get('--session-id')!,
    generation: finiteTargetedNumber('--generation', values.get('--generation')!, true),
    maxPartitions: finiteTargetedNumber('--max-partitions', values.get('--max-partitions')!, true),
    maxCalls: finiteTargetedNumber('--max-calls', values.get('--max-calls')!, true),
    maxCostUsd: finiteTargetedNumber('--max-cost-usd', values.get('--max-cost-usd')!, false),
    maxRuntimeMs: finiteTargetedNumber('--max-runtime-ms', values.get('--max-runtime-ms')!, true),
    budgetAuditPath: values.get('--budget-audit-path')!,
    json,
  };
}

export function parseGenerationRollbackArgs(args: string[]): GenerationRollbackArgs {
  const values = new Map<string, string>();
  let json = false;
  const allowed = new Set(['--source', '--session-id', '--generation', '--rollback-generation']);
  for (let index = 0; index < args.length; index++) {
    const flag = args[index];
    if (flag === '--json') {
      if (json) throw new Error('--json may be specified only once');
      json = true;
      continue;
    }
    if (!allowed.has(flag)) throw new Error(`unknown generation rollback option: ${flag}`);
    if (values.has(flag)) throw new Error(`${flag} may be specified only once`);
    const value = args[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`${flag} requires a value`);
    values.set(flag, value);
    index += 1;
  }
  const missing = [...allowed].filter((flag) => !values.has(flag));
  if (missing.length > 0) throw new Error(`required generation rollback options missing: ${missing.join(', ')}`);
  return {
    sourceId: values.get('--source')!,
    sessionId: values.get('--session-id')!,
    generation: finiteTargetedNumber('--generation', values.get('--generation')!, true),
    rollbackGeneration: finiteTargetedNumber(
      '--rollback-generation', values.get('--rollback-generation')!, true,
    ),
    json,
  };
}

function boundedTailInteger(flag: string, value: string, min: number, max: number): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`${flag} must be an integer from ${min} to ${max}`);
  }
  return parsed;
}

/** Strict parser for the scheduled no-provider reconciliation tail. */
export function parseContextMirrorTailArgs(args: string[]): ContextMirrorTailArgs {
  const values = new Map<string, string>();
  let json = false;
  const allowed = new Set([
    '--source', '--batch-size', '--max-batches', '--max-runtime-ms', '--reason',
  ]);
  for (let index = 0; index < args.length; index++) {
    const flag = args[index];
    if (flag === '--json') {
      if (json) throw new Error('--json may be specified only once');
      json = true;
      continue;
    }
    if (!allowed.has(flag)) throw new Error(`unknown Context Mirror tail option: ${flag}`);
    if (values.has(flag)) throw new Error(`${flag} may be specified only once`);
    const value = args[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`${flag} requires a value`);
    values.set(flag, value);
    index += 1;
  }
  const missing = [...allowed].filter((flag) => !values.has(flag));
  if (missing.length > 0) throw new Error(`required Context Mirror tail options missing: ${missing.join(', ')}`);
  const sourceId = values.get('--source')!.trim();
  const reason = values.get('--reason')!.trim();
  if (!sourceId || sourceId.length > 120) throw new Error('--source must contain 1 to 120 characters');
  if (!reason || reason.length > 240) throw new Error('--reason must contain 1 to 240 characters');
  return {
    sourceId,
    batchSize: boundedTailInteger('--batch-size', values.get('--batch-size')!, 1, 5_000),
    maxBatches: boundedTailInteger('--max-batches', values.get('--max-batches')!, 1, 20),
    maxRuntimeMs: boundedTailInteger('--max-runtime-ms', values.get('--max-runtime-ms')!, 2_000, 45_000),
    reason,
    json,
  };
}

type ConnectorPollRunner = (
  engine: BrainEngine,
  target: ConnectorPollTarget,
) => Promise<ConnectorPollResult>;

function sanitizedPollError(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  return message.replace(/[\r\n\t]+/g, ' ').replace(/\s{2,}/g, ' ').trim().slice(0, 500) || 'connector poll failed';
}

/**
 * Poll every selected target even when one target throws. A connector-specific
 * outage must be visible in the final result without starving unrelated
 * connectors that happen to be scheduled in the same process.
 */
export async function pollConnectorTargets(
  engine: BrainEngine,
  targets: ConnectorPollTarget[],
  runner: ConnectorPollRunner = runConnectorPoll,
): Promise<ConnectorPollResult[]> {
  const results: ConnectorPollResult[] = [];
  for (const target of targets) {
    try {
      results.push(await runner(engine, target));
    } catch (err) {
      results.push({
        ...target,
        status: 'failed',
        landed: 0,
        tombstoned: 0,
        diagnostics: [{
          stage: 'poll',
          code: 'poll_exception',
          message: sanitizedPollError(err),
        }],
      });
    }
  }
  return results;
}

export interface ConnectorPollSummary {
  status: 'ok' | 'partial' | 'failed';
  exitCode: 0 | 1;
  landed: number;
  tombstoned: number;
}

/** Reduce per-target truth into the command's stable overall outcome. */
export function connectorPollSummary(results: ConnectorPollResult[]): ConnectorPollSummary {
  const status = results.some((result) => result.status === 'failed')
    ? 'failed'
    : results.some((result) => result.status === 'partial')
      ? 'partial'
      : 'ok';
  return {
    status,
    exitCode: status === 'failed' ? 1 : 0,
    landed: results.reduce((n, result) => n + result.landed, 0),
    tombstoned: results.reduce((n, result) => n + result.tombstoned, 0),
  };
}

export async function runConnector(
  engine: BrainEngine | null,
  args: string[],
  tailRuntime: Partial<ContextMirrorTailCommandRuntime> = {},
): Promise<void> {
  const sub = args[0];
  if (!sub || sub === '--help' || sub === '-h') {
    printHelp();
    return;
  }
  if (sub === 'poll') {
    await runPoll(engine, args.slice(1));
    return;
  }
  if (sub === 'consolidate') {
    await runTargetedConsolidation(engine, args.slice(1));
    return;
  }
  if (sub === 'rollback-generation') {
    await runGenerationRollback(engine, args.slice(1));
    return;
  }
  if (sub === 'tail-context-mirror') {
    await runContextMirrorTail(engine, args.slice(1), tailRuntime);
    return;
  }
  if (sub === 'review') {
    await runReview(engine, args.slice(1));
    return;
  }
  console.error(`Unknown connector subcommand "${sub}". Try: gbrain connector poll | gbrain connector consolidate | gbrain connector rollback-generation | gbrain connector tail-context-mirror | gbrain connector review`);
  process.exit(2);
}

export async function runContextMirrorTail(
  engine: BrainEngine | null,
  args: string[],
  runtimeOverrides: Partial<ContextMirrorTailCommandRuntime> = {},
): Promise<void> {
  const runtime: ContextMirrorTailCommandRuntime = {
    fetchSource,
    reconcile: runBoundedContextMirrorReconciliation,
    writeStdout: (text) => { process.stdout.write(text); },
    writeStderr: (text) => { process.stderr.write(text); },
    setExitCode: (code) => { process.exitCode = code; },
    ...runtimeOverrides,
  };
  if (args.includes('--help') || args.includes('-h')) {
    printHelp(runtime.writeStdout);
    runtime.setExitCode(0);
    return;
  }
  if (!engine) {
    runtime.writeStderr('connector tail-context-mirror requires a database. Run `gbrain init` first.\n');
    runtime.setExitCode(1);
    return;
  }
  let parsed: ContextMirrorTailArgs;
  try {
    parsed = parseContextMirrorTailArgs(args);
  } catch (err) {
    runtime.writeStderr(`connector tail-context-mirror: ${err instanceof Error ? err.message : String(err)}\n`);
    runtime.setExitCode(2);
    return;
  }
  try {
    const source = await runtime.fetchSource(engine, parsed.sourceId);
    if (!source) {
      runtime.writeStderr(`connector tail-context-mirror: source ${parsed.sourceId} not found\n`);
      runtime.setExitCode(1);
      return;
    }
    const report = await runtime.reconcile(engine, {
      sourceId: parsed.sourceId,
      batchSize: parsed.batchSize,
      maxBatches: parsed.maxBatches,
      maxRuntimeMs: parsed.maxRuntimeMs,
      actor: 'context-mirror-tail-cli',
      reason: parsed.reason,
    });
    const output = toBoundedContextMirrorReconciliationWireReport(report);
    if (parsed.json) runtime.writeStdout(`${JSON.stringify(output)}\n`);
    else runtime.writeStdout(
      `connector tail-context-mirror: ${report.status}; batches=${report.batches}; `
      + `scanned=${report.scanned}; membership=${report.membership}; provider_calls=0\n`,
    );
    runtime.setExitCode(report.status === 'complete' ? 0 : 1);
  } catch (err) {
    runtime.writeStderr(`connector tail-context-mirror: ${sanitizedPollError(err)}\n`);
    runtime.setExitCode(1);
  }
}

async function runPoll(engine: BrainEngine | null, args: string[]): Promise<void> {
  if (!engine) {
    console.error('connector poll requires a database. Run `gbrain init` first.');
    process.exit(1);
    return;
  }
  const json = args.includes('--json');
  const dryRun = args.includes('--dry-run');

  const { targets, error } = await resolveConnectorPollTargets(engine, {
    source: flagValue(args, '--source'),
    provider: flagValue(args, '--provider'),
  });
  if (error) {
    console.error(error);
    process.exit(2);
    return;
  }

  if (dryRun || targets.length === 0) {
    if (json) {
      console.log(JSON.stringify({ targets, polled: 0, landed: 0, tombstoned: 0, results: [], dry_run: dryRun }, null, 2));
    } else if (targets.length === 0) {
      console.log('No enabled connector sources — nothing to poll.');
    } else {
      console.log(`[dry-run] would poll ${targets.length} target(s): ${targets.map((t) => `${t.sourceId}/${t.provider}`).join(', ')}`);
    }
    return;
  }

  const results = await pollConnectorTargets(engine, targets);
  const summary = connectorPollSummary(results);

  if (json) {
    console.log(JSON.stringify({ targets, polled: results.length, ...summary, results }, null, 2));
  } else {
    for (const r of results) {
      const tail = r.skippedReason
        ? `skipped (${r.skippedReason})`
        : `${r.status}: landed=${r.landed} tombstoned=${r.tombstoned}`;
      console.log(`  ${r.sourceId}/${r.provider}: ${tail}`);
    }
    console.log(
      `connector poll: ${summary.status}, ${results.length} target(s) polled, ` +
        `landed=${summary.landed}, tombstoned=${summary.tombstoned}`,
    );
  }
  if (summary.exitCode !== 0) process.exitCode = summary.exitCode;
}

async function runTargetedConsolidation(engine: BrainEngine | null, args: string[]): Promise<void> {
  if (!engine) {
    console.error('connector consolidate requires a database. Run `gbrain init` first.');
    process.exitCode = 1;
    return;
  }
  let parsed: TargetedConsolidationArgs;
  try {
    parsed = parseTargetedConsolidationArgs(args);
  } catch (err) {
    console.error(`connector consolidate: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 2;
    return;
  }
  const source = (await loadAllSources(engine)).find((candidate) => candidate.id === parsed.sourceId);
  if (!source) {
    console.error(`connector consolidate: source ${parsed.sourceId} not found`);
    process.exitCode = 1;
    return;
  }
  const report = await consolidateContextMirrorGeneration(
    engine,
    { id: source.id, config: source.config },
    {
      sessionId: parsed.sessionId,
      generation: parsed.generation,
      maxPartitions: parsed.maxPartitions,
      maxCalls: parsed.maxCalls,
      maxCostUsd: parsed.maxCostUsd,
      maxRuntimeMs: parsed.maxRuntimeMs,
      budgetAuditPath: parsed.budgetAuditPath,
    },
  );
  if (parsed.json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    process.stdout.write(
      `connector consolidate: ${report.status}; selected=${report.selected_partitions}; ` +
      `provider_calls=${report.provider_calls_reserved}; cost=$${report.estimated_cost_usd.toFixed(6)}; ` +
      `stop=${report.stop_reason}\n`,
    );
  }
  if (report.status !== 'ok') process.exitCode = 1;
}

async function runGenerationRollback(engine: BrainEngine | null, args: string[]): Promise<void> {
  if (!engine) {
    console.error('connector rollback-generation requires a database. Run `gbrain init` first.');
    process.exitCode = 1;
    return;
  }
  let parsed: GenerationRollbackArgs;
  try {
    parsed = parseGenerationRollbackArgs(args);
  } catch (err) {
    console.error(`connector rollback-generation: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 2;
    return;
  }
  try {
    const report = await rollbackContextGeneration(engine, {
      sourceId: parsed.sourceId,
      sessionId: parsed.sessionId,
      generation: parsed.generation,
      rollbackGeneration: parsed.rollbackGeneration,
    });
    if (parsed.json) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    else process.stdout.write(
      `connector rollback-generation: ${report.status}; generation=${report.generation}; `
      + `restored=${report.rollback_generation}; rejected_candidates=${report.rejected_candidates}\n`,
    );
  } catch (err) {
    console.error(`connector rollback-generation: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  }
}

// ── connector review (U4 + T6) — push what the human must act on TO the human ──────
//
// A READ-ONLY digest over the (post-U1/U2, small + clean) consolidation queue, in TWO
// distinct categories:
//   1. PROPOSALS — confident PENDING ADD/UPDATE the human accepts (→ promote) or rejects.
//   2. CONTRADICTIONS — 'needs_review' rows: a GENUINE classifier contradiction (a fact
//      that conflicts with an existing page, or can't be confidently placed) the human
//      RESOLVES on the source-of-truth page, then dismisses. These used to be silently
//      dropped as 'rejected' (the pre-fan-out de-flood) — surfacing them is what protects
//      the "memory compounds" thesis (T6).
// Still NEVER surfaced: the ambiguity the system genuinely absorbs — NOOP, a low-confidence
// or safe-degrade NEEDS_REVIEW, a single-writer concurrency hold, and expired rows.
// It writes nothing: accept/reject/dismiss run through the existing admin seam
// (POST /admin/api/candidates/:id/approve|reject) and approveCandidate/rejectCandidate.

/** The two verdicts surfaced as accept/reject PROPOSALS. NOOP never surfaces; a
 *  NEEDS_REVIEW contradiction surfaces in its OWN category (see CONTRADICTION_CLASSIFICATION). */
const REVIEW_CLASSIFICATIONS = new Set<string>(['ADD', 'UPDATE']);
/** The verdict surfaced as a CONTRADICTION the human resolves (distinct from a proposal). */
const CONTRADICTION_CLASSIFICATION = 'NEEDS_REVIEW';

/**
 * A single reviewable item, projected from a candidate row. This is the stable surface the
 * renderers consume — `summary` is pre-computed (the UPDATE timeline line, an ADD body
 * excerpt, or the conflicting fact for a contradiction) so no renderer touches the raw row.
 */
export interface ReviewItem {
  /** Candidate id — the anchor of the accept/reject/dismiss action. */
  id: number;
  /** The verdict: ADD | UPDATE for a proposal, NEEDS_REVIEW for a contradiction. */
  classification: 'ADD' | 'UPDATE' | 'NEEDS_REVIEW';
  /** UPDATE: the page being rewritten. CONTRADICTION: the conflicting page (if any). ADD: null. */
  target_path: string | null;
  /** ADD: the proposed brain slug. UPDATE/CONTRADICTION: usually null. */
  proposed_slug: string | null;
  /** Engine confidence 0..1; null only on legacy rows. Drives the ranking. */
  confidence: number | null;
  /** One-glance "what": UPDATE → timeline line; ADD/CONTRADICTION → body excerpt. */
  summary: string;
  /** Owning brain source id. */
  source_id: string;
}

/**
 * The review queue split into its two distinct, separately-rendered categories (T6).
 * `proposals` are accept/reject ADD/UPDATE; `contradictions` are 'needs_review' rows the
 * human resolves. Each list is independently confidence-ranked, highest first.
 */
export interface ReviewQueue {
  proposals: ReviewItem[];
  contradictions: ReviewItem[];
}

/** Collapse whitespace to single spaces and hard-cap length with an ellipsis. Pure. */
function collapse(s: string, max = 140): string {
  const flat = s.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** First line of a markdown body that carries content, stripped of leading list/heading
 *  markup (`#`, `>`, `-`, `*`) so an ADD excerpt reads as prose, not as raw markdown. Pure. */
function firstMeaningfulLine(md: string): string {
  for (const raw of md.split('\n')) {
    const stripped = raw.replace(/^[\s>#*-]+/, '').trim();
    if (stripped) return stripped;
  }
  return '';
}

/** The one-glance summary for an item: the UPDATE's dated timeline line, or an excerpt
 *  of the ADD's proposed body. Falls back to a clear placeholder, never empty. Pure. */
function summarize(row: Pick<ReviewCandidate, 'classification' | 'timeline_entry' | 'proposed_markdown'>): string {
  if (row.classification === 'UPDATE') {
    const t = (row.timeline_entry ?? '').trim();
    return t ? collapse(t) : '(no timeline entry)';
  }
  const md = (row.proposed_markdown ?? '').trim();
  const line = md ? firstMeaningfulLine(md) : '';
  return line ? collapse(line) : '(no proposed content)';
}

/** Project a pending candidate row into a ReviewItem. Pure. */
function toReviewItem(row: ReviewCandidate): ReviewItem {
  return {
    id: row.id,
    classification: row.classification as 'ADD' | 'UPDATE',
    target_path: row.target_path,
    proposed_slug: row.proposed_slug,
    confidence: row.confidence,
    summary: summarize(row),
    source_id: row.source_id,
  };
}

/**
 * Load the confidence-ranked review queue: every PENDING candidate (listCandidates
 * already excludes expired + non-pending rows), filtered to confident ADD/UPDATE only
 * (the U1/U2 belt-and-suspenders — even a legacy pre-backfill pending NEEDS_REVIEW row
 * never surfaces), sorted highest-confidence first. Paginates the full pending set so a
 * large legacy tail can't push a real proposal off the surface. Read-only.
 */
export async function loadReviewItems(
  engine: BrainEngine,
  opts: { sourceId?: string } = {},
): Promise<ReviewItem[]> {
  const rows: ReviewCandidate[] = [];
  let page = 1;
  for (;;) {
    const res = await listCandidates(engine, {
      status: 'pending',
      sourceId: opts.sourceId,
      page,
      pageSize: 200,
    });
    rows.push(...res.rows);
    if (page >= res.pages) break;
    page += 1;
  }
  const items = rows
    .filter((r) => r.classification != null && REVIEW_CLASSIFICATIONS.has(r.classification))
    .map(toReviewItem);
  // Confidence-ranked, highest first. Array.sort is stable (ES2019+), so equal
  // confidences keep listCandidates' proposed_at-DESC order; null confidence sorts last.
  items.sort((a, b) => (b.confidence ?? -1) - (a.confidence ?? -1));
  return items;
}

/** Project a surfaced `needs_review` contradiction row into a ReviewItem (classification
 *  NEEDS_REVIEW — a genuine conflict the human RESOLVES, not an auto-mergeable proposal). */
function toContradictionItem(row: ReviewCandidate): ReviewItem {
  return {
    id: row.id,
    classification: 'NEEDS_REVIEW',
    target_path: row.target_path,
    proposed_slug: row.proposed_slug,
    confidence: row.confidence,
    summary: summarize(row),
    source_id: row.source_id,
  };
}

/**
 * Load the full review queue split into its two categories (T6): confident ADD/UPDATE
 * `proposals` (the existing pending set) and `needs_review` `contradictions` — GENUINE
 * conflicts the human must resolve, SURFACED rather than silently dropped. Each list is
 * paginated in full and confidence-ranked, highest first. Read-only.
 */
export async function loadReviewQueue(
  engine: BrainEngine,
  opts: { sourceId?: string } = {},
): Promise<ReviewQueue> {
  const proposals = await loadReviewItems(engine, opts);
  const rows: ReviewCandidate[] = [];
  let page = 1;
  for (;;) {
    const res = await listCandidates(engine, {
      status: 'needs_review',
      sourceId: opts.sourceId,
      page,
      pageSize: 200,
    });
    rows.push(...res.rows);
    if (page >= res.pages) break;
    page += 1;
  }
  const contradictions = rows
    .filter((r) => r.classification === CONTRADICTION_CLASSIFICATION)
    .map(toContradictionItem);
  contradictions.sort((a, b) => (b.confidence ?? -1) - (a.confidence ?? -1));
  return { proposals, contradictions };
}

/**
 * Render the `needs_review` CONTRADICTIONS as a distinct, clearly-labelled block appended
 * after the proposals. Empty string when there are none, so the proposal-only surfaces are
 * byte-unchanged. A contradiction is a fact that conflicts with an existing page — the human
 * resolves it (edit the page, or reject the capture), it is NOT a one-click accept.
 */
export function renderContradictions(contradictions: ReviewItem[]): string {
  if (contradictions.length === 0) return '';
  const n = contradictions.length;
  const lines: string[] = ['', `⚠ ${n} contradiction${n === 1 ? '' : 's'} to resolve (a captured fact conflicts with an existing page):`];
  for (const it of contradictions) {
    lines.push(`  • \`${it.target_path ?? '(unplaced)'}\` (${fmtConf(it.confidence)}) — ${it.summary} · id ${it.id}`);
  }
  return lines.join('\n') + '\n';
}

/** Format a confidence for display: two decimals, or an em dash for a null/legacy score. */
function fmtConf(c: number | null): string {
  return c == null ? '—' : c.toFixed(2);
}

/**
 * Human-readable surface: one scannable block per proposal — verdict, confidence, id,
 * where (page for UPDATE / slug for ADD), the one-glance change, and the single
 * accept/reject action. Empty queue → a clean one-liner, never an error.
 */
export function renderReviewHuman(items: ReviewItem[]): string {
  if (items.length === 0) {
    return 'Nothing to review — the consolidation queue is empty.\n';
  }
  const n = items.length;
  const lines: string[] = [];
  lines.push(`Consolidation review — ${n} confident proposal${n === 1 ? '' : 's'} pending`);
  lines.push('');
  items.forEach((it, i) => {
    lines.push(`  [${i + 1}] ${it.classification.padEnd(6)} conf ${fmtConf(it.confidence)}  ·  id ${it.id}`);
    if (it.classification === 'UPDATE') {
      // An UPDATE carries a stored update_page target; a bare approve rewrites THAT page.
      lines.push(`      page:   ${it.target_path ?? '(unknown)'}`);
      lines.push(`      change: ${it.summary}`);
      lines.push(`      accept: POST /admin/api/candidates/${it.id}/approve   → rewrites ${it.target_path ?? 'the page above'}`);
    } else {
      // A bare ADD approve defaults to target_kind:'inbox' → lands at inbox/<date>-<slug>.md
      // for triage, NOT at the slug shown. Filing it at the slug needs an explicit body.
      const slug = it.proposed_slug;
      lines.push(`      slug:   ${slug ?? '(unspecified)'}`);
      lines.push(`      add:    ${it.summary}`);
      lines.push(`      accept: POST /admin/api/candidates/${it.id}/approve   → lands in inbox/ for triage`);
      if (slug) {
        lines.push(`              (to file at ${slug} instead, add body {"target_kind":"existing_page","target_path":"${slug}.md"})`);
      }
    }
    // reject HARD-REQUIRES a reason body (serve-http → 400 reason_required on a bare POST).
    lines.push(`      reject: POST /admin/api/candidates/${it.id}/reject    {"reason":"…"}  (reason required)`);
    lines.push('');
  });
  lines.push(
    `${n} proposal${n === 1 ? '' : 's'} · read-only digest — this command never writes; accept/reject run through the admin review API above.`,
  );
  return lines.join('\n') + '\n';
}

/**
 * Machine surface. STABLE shape — exactly these keys, in this order:
 *   id, classification, target_path, proposed_slug, confidence, summary, source_id
 * The destination is verdict-specific and ALWAYS machine-readable from a dedicated
 * key (never dug out of free-text `summary`): an UPDATE lands at `target_path`
 * (`proposed_slug` null); an ADD lands at `proposed_slug` (`target_path` null).
 */
export function renderReviewJson(items: ReviewItem[]): string {
  const shaped = items.map((it) => ({
    id: it.id,
    classification: it.classification,
    target_path: it.target_path,
    proposed_slug: it.proposed_slug,
    confidence: it.confidence,
    summary: it.summary,
    source_id: it.source_id,
  }));
  return JSON.stringify(shaped, null, 2) + '\n';
}

/**
 * Compact markdown digest suitable for scheduled delivery (a heading + a bullet per
 * item). The delivery CHANNEL — Slack / email / a Brain page — is out of scope; this
 * only produces the glanceable artifact.
 */
export function renderReviewDigest(items: ReviewItem[]): string {
  const n = items.length;
  const lines: string[] = [`## Consolidation review — ${n} proposal${n === 1 ? '' : 's'} pending`, ''];
  if (n === 0) {
    lines.push('_Nothing to review._');
    return lines.join('\n') + '\n';
  }
  for (const it of items) {
    const where = it.classification === 'UPDATE'
      ? (it.target_path ?? '(unknown)')
      : (it.proposed_slug ?? '(unspecified)');
    lines.push(`- **${it.classification}** \`${where}\` (${fmtConf(it.confidence)}) — ${it.summary} · id ${it.id}`);
  }
  // Act-mechanics, stated once (keeps each bullet glanceable while still accurate):
  // a bare ADD approve lands in inbox/ (NOT the shown slug); reject needs a reason body.
  lines.push('');
  lines.push(
    '_Act via the admin API — accept: `POST /admin/api/candidates/<id>/approve` ' +
      '(UPDATE rewrites the shown page; a bare ADD approve lands in `inbox/` for triage). ' +
      'reject: `POST /admin/api/candidates/<id>/reject` with a required `{"reason":"…"}` body._',
  );
  return lines.join('\n') + '\n';
}

/**
 * `gbrain connector review [--json] [--digest] [--source <id>]` — read-only push surface
 * over the pending consolidation queue. Flag precedence: --json, then --digest, else the
 * human block. No writes; accept/reject stay on the existing admin seam.
 */
async function runReview(engine: BrainEngine | null, args: string[]): Promise<void> {
  if (args.includes('--help') || args.includes('-h')) {
    printHelp();
    return;
  }
  if (!engine) {
    console.error('connector review requires a database. Run `gbrain init` first.');
    process.exit(1);
    return;
  }
  const sourceId = flagValue(args, '--source') ?? undefined;
  const { proposals, contradictions } = await loadReviewQueue(engine, { sourceId });

  if (args.includes('--json')) {
    // --json keeps its stable proposals-array contract (tooling consumes it); the
    // contradiction surface is the operator-facing human/digest renders.
    process.stdout.write(renderReviewJson(proposals));
  } else if (args.includes('--digest')) {
    process.stdout.write(renderReviewDigest(proposals));
    process.stdout.write(renderContradictions(contradictions));
  } else {
    process.stdout.write(renderReviewHuman(proposals));
    process.stdout.write(renderContradictions(contradictions));
  }
}

function printHelp(write: (text: string) => void = (text) => { console.log(text); }): void {
  write(`Usage: gbrain connector <subcommand>

One-shot SaaS connector operations — the synchronous, daemon-free equivalent of
the autopilot connector-dispatch branch (no Minion worker required).

Subcommands:
  tail-context-mirror
          Keep immutable raw membership and exact session heads current without
          reading transcript bodies or calling an AI provider.
  poll    Poll enabled connector sources NOW. Lands connector_candidates (a
          REVIEW queue) — NEVER durable Brain pages, NEVER a promotion.
  rollback-generation
          Restore the immediately prior generation for one exact historical
          repair. Preserves evidence and refuses ordinary, ambiguous, accepted,
          or promoted work.
  review  Push the confident pending consolidation queue to a human — a READ-ONLY,
          glanceable digest of ADD/UPDATE proposals, confidence-ranked. Writes
          nothing; accept/reject stay on the admin accept→promote seam.

poll options:
  --source <id> --provider <name>   Poll ONE (source, provider) target. Both
                                    required together; omit both to poll every
                                    enabled connector source.
  --json                            Machine-readable report.
  --dry-run                         List targets without polling.
  --help, -h                        Show this help.

tail-context-mirror options:
  --source <id>                     Exact source to reconcile.
  --batch-size <1-5000>             Raw metadata rows per batch.
  --max-batches <1-20>              Maximum batches in this invocation.
  --max-runtime-ms <2000-45000>     Wall-clock ceiling.
  --reason <text>                   Bounded audit reason.
  --json                            Machine-readable report.
  --help, -h                        Show this help.

review options:
  --source <id>                     Only this brain source's pending queue.
  --json                            Stable machine shape (keys: id, classification,
                                    target_path, proposed_slug, confidence, summary,
                                    source_id).
  --digest                          Compact markdown (heading + a bullet per item),
                                    suitable for scheduled delivery. The delivery
                                    channel (Slack/email/Brain page) is out of scope.
  --help, -h                        Show this help.

Idempotent: a re-poll is a safe no-op (backfill ON CONFLICT). Promotion of the
landed candidates to durable Brain pages remains a separate, human-gated step.
review surfaces ONLY confident ADD/UPDATE — never NEEDS_REVIEW (absorbed by the
system), low-confidence proposals, or expired rows.

Examples:
  gbrain connector poll
  gbrain connector poll --json
  gbrain connector poll --source default --provider granola
  gbrain connector review
  gbrain connector review --json
  gbrain connector review --digest --source default
`);
}
