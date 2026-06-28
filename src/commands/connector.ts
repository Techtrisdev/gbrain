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
import { loadAllSources } from '../core/sources-load.ts';
import {
  selectEnabledConnectorSources,
  runConnectorPoll,
  type ConnectorPollTarget,
  type ConnectorPollResult,
} from '../core/connectors/poll.ts';
import { listCandidates, type ReviewCandidate } from '../core/connectors/candidate.ts';

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

export async function runConnector(engine: BrainEngine | null, args: string[]): Promise<void> {
  const sub = args[0];
  if (!sub || sub === '--help' || sub === '-h') {
    printHelp();
    return;
  }
  if (sub === 'poll') {
    await runPoll(engine, args.slice(1));
    return;
  }
  if (sub === 'review') {
    await runReview(engine, args.slice(1));
    return;
  }
  console.error(`Unknown connector subcommand "${sub}". Try: gbrain connector poll | gbrain connector review`);
  process.exit(2);
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

  const results: ConnectorPollResult[] = [];
  for (const t of targets) {
    results.push(await runConnectorPoll(engine, t));
  }
  const landed = results.reduce((n, r) => n + r.landed, 0);
  const tombstoned = results.reduce((n, r) => n + r.tombstoned, 0);

  if (json) {
    console.log(JSON.stringify({ targets, polled: results.length, landed, tombstoned, results }, null, 2));
  } else {
    for (const r of results) {
      const tail = r.skippedReason ? `skipped (${r.skippedReason})` : `landed=${r.landed} tombstoned=${r.tombstoned}`;
      console.log(`  ${r.sourceId}/${r.provider}: ${tail}`);
    }
    console.log(`connector poll: ${results.length} target(s) polled, landed=${landed}, tombstoned=${tombstoned}`);
  }
}

// ── connector review (U4) — push the few confident proposals TO the human ─────────
//
// A READ-ONLY digest over the (post-U1/U2, small + clean) pending consolidation
// queue. It surfaces ONLY confident ADD/UPDATE proposals — never the ambiguity the
// system already absorbed (NEEDS_REVIEW lands off-queue as rejected; low-confidence
// ADD/UPDATE is held back; expired rows are filtered by listCandidates) — each as a
// one-glance "what · where · how confident · one action" block. It writes nothing:
// accept/reject still run through the existing admin accept→promote seam
// (POST /admin/api/candidates/:id/approve|reject) and rejectCandidate.

/** The two verdicts a human is asked to decide on. NEEDS_REVIEW / NOOP never surface. */
const REVIEW_CLASSIFICATIONS = new Set<string>(['ADD', 'UPDATE']);

/**
 * A single reviewable proposal, projected from a pending candidate row. This is the
 * stable surface the renderers consume — `summary` is pre-computed (the UPDATE
 * timeline line, or an ADD body excerpt) so no renderer touches the raw row.
 */
export interface ReviewItem {
  /** Candidate id — the anchor of the one accept/reject action. */
  id: number;
  /** The verdict the human decides on (only ADD | UPDATE reach here). */
  classification: 'ADD' | 'UPDATE';
  /** UPDATE: the page being rewritten. ADD: null (the slug carries the "where"). */
  target_path: string | null;
  /** ADD: the proposed brain slug. UPDATE: usually null. */
  proposed_slug: string | null;
  /** Engine confidence 0..1; null only on legacy rows. Drives the ranking. */
  confidence: number | null;
  /** One-glance "what changes": UPDATE → timeline line; ADD → body excerpt. */
  summary: string;
  /** Owning brain source id. */
  source_id: string;
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
      lines.push(`      page:   ${it.target_path ?? '(unknown)'}`);
      lines.push(`      change: ${it.summary}`);
    } else {
      lines.push(`      slug:   ${it.proposed_slug ?? '(unspecified)'}`);
      lines.push(`      add:    ${it.summary}`);
    }
    lines.push(`      action: accept → POST /admin/api/candidates/${it.id}/approve`);
    lines.push(`              reject → POST /admin/api/candidates/${it.id}/reject`);
    lines.push('');
  });
  lines.push(
    `${n} proposal${n === 1 ? '' : 's'} · read-only digest — accept/reject runs through the admin review API; nothing is written here.`,
  );
  return lines.join('\n') + '\n';
}

/**
 * Machine surface. STABLE shape — exactly these keys, in this order:
 *   id, classification, target_path, confidence, summary, source_id
 * (for ADD, `target_path` is null and the "where" lives in `summary`/the slug).
 */
export function renderReviewJson(items: ReviewItem[]): string {
  const shaped = items.map((it) => ({
    id: it.id,
    classification: it.classification,
    target_path: it.target_path,
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
    lines.push(`- **${it.classification}** \`${where}\` (${fmtConf(it.confidence)}) — ${it.summary} · accept/reject id=${it.id}`);
  }
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
  const items = await loadReviewItems(engine, { sourceId });

  if (args.includes('--json')) {
    process.stdout.write(renderReviewJson(items));
  } else if (args.includes('--digest')) {
    process.stdout.write(renderReviewDigest(items));
  } else {
    process.stdout.write(renderReviewHuman(items));
  }
}

function printHelp(): void {
  console.log(`Usage: gbrain connector <subcommand>

One-shot SaaS connector operations — the synchronous, daemon-free equivalent of
the autopilot connector-dispatch branch (no Minion worker required).

Subcommands:
  poll    Poll enabled connector sources NOW. Lands connector_candidates (a
          REVIEW queue) — NEVER durable Brain pages, NEVER a promotion.
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

review options:
  --source <id>                     Only this brain source's pending queue.
  --json                            Stable machine shape (keys: id, classification,
                                    target_path, confidence, summary, source_id).
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
