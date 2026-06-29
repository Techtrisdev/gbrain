/**
 * gbrain capture distill — turn RAW per-turn session captures into a FEW
 * distilled durable-memory pages.
 *
 * The `capture-events` source holds one raw capture page per prompt/reply
 * (`capture/<session>/<kind>-<hash>`). Consolidating those directly floods the
 * review queue with one candidate per turn. `distill` groups each COMPLETED
 * conversation (newest capture older than `--idle-hours`) and writes ~0–6
 * durable memory statements as `distilled/<session-slug>/mem-K` pages — which a
 * separate context_mirror connector (read_slug_prefix='distilled/') then
 * consolidates into a handful of clean candidates.
 *
 * Idempotent: a `distill-state/<session-slug>` marker page records completion;
 * a re-run skips already-distilled sessions and writes nothing new for them.
 * Candidate-only downstream: this command writes PAGES, never candidates and
 * never promotions — review/promotion stay human-gated.
 *
 * Usage:
 *   gbrain capture distill                       # distill completed sessions in capture-events
 *   gbrain capture distill --idle-hours 12       # only sessions idle ≥ 12h
 *   gbrain capture distill --source <id>         # a different source
 *   gbrain capture distill --dry-run             # list what WOULD distill; write nothing
 *   gbrain capture distill --json                # machine-readable report
 */

import type { BrainEngine } from '../core/engine.ts';
import {
  distillCaptureSessions,
  DEFAULT_DISTILL_SOURCE,
  DEFAULT_IDLE_HOURS,
  type DistillReport,
  type SessionReport,
} from '../core/connectors/distill.ts';

interface DistillArgs {
  source: string;
  idleHours: number;
  dryRun: boolean;
  json: boolean;
}

const HELP = `Usage: gbrain capture distill [options]

Distill RAW per-turn session captures into a FEW durable-memory pages.

Groups the raw \`capture/<session>/…\` pages in a source by session, and for
each COMPLETED session (newest capture older than --idle-hours) makes ONE LLM
call that emits 0–6 durable memory statements about Jonathan's decisions,
preferences, standards, and key project facts. Each statement is written as a
\`distilled/<session-slug>/mem-K\` page; a \`distill-state/<session-slug>\`
marker records completion so re-runs are idempotent (never re-distill, never
duplicate). A separate context_mirror connector consolidates ONLY the
\`distilled/\` pages — so the review queue gets a handful of clean candidates
instead of one per turn.

Options:
  --source <id>        Source holding the captures (default: ${DEFAULT_DISTILL_SOURCE}).
                       Distilled pages + markers are written to the SAME source.
  --idle-hours <N>     Only distill sessions whose newest raw capture is older
                       than N hours (= "completed"). Default: ${DEFAULT_IDLE_HOURS}.
  --dry-run            List the sessions that WOULD distill; write nothing.
  --json               Machine-readable report.
  --help, -h           Show this help.

Notes:
  - Writes PAGES, not candidates: it never promotes and never touches the live
    shared corpus. Consolidation + promotion stay human-gated downstream.
  - Idempotent: a session with a \`distill-state/…\` marker is skipped. A session
    with nothing durable is still marked done (0 memories) so it isn't re-paid.
  - Per-session failures (LLM/gateway) are tolerated and reported; those sessions
    are NOT marked done and retry on the next run.

Examples:
  gbrain capture distill
  gbrain capture distill --idle-hours 12 --dry-run
  gbrain capture distill --source capture-events --json
`;

function parseDistillArgs(args: string[]): DistillArgs | { help: true } {
  const out: DistillArgs = {
    source: DEFAULT_DISTILL_SOURCE,
    idleHours: DEFAULT_IDLE_HOURS,
    dryRun: false,
    json: false,
  };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--help' || a === '-h') return { help: true };
    if (a === '--dry-run') { out.dryRun = true; continue; }
    if (a === '--json') { out.json = true; continue; }
    if (a === '--source') {
      const v = args[++i];
      if (v) out.source = v;
      continue;
    }
    if (a === '--idle-hours') {
      const v = args[++i];
      const n = Number(v);
      if (Number.isFinite(n) && n >= 0) out.idleHours = n;
      continue;
    }
    // unknown flag → ignore (matches `gbrain capture` parsing posture)
  }
  return out;
}

function statusLine(s: SessionReport): string {
  const idle = `${s.idle_hours}h idle`;
  switch (s.status) {
    case 'distilled':
      return `  ✓ ${s.session_slug}  (${s.turns} turns, ${idle}) → ${s.memories ?? 0} memor${(s.memories ?? 0) === 1 ? 'y' : 'ies'}`;
    case 'would_distill':
      return `  • ${s.session_slug}  (${s.turns} turns, ${idle}) → would distill`;
    case 'already_distilled':
      return `  – ${s.session_slug}  already distilled`;
    case 'active':
      return `  – ${s.session_slug}  (${s.turns} turns, ${idle}) still active (< threshold)`;
    case 'failed':
      return `  ✗ ${s.session_slug}  (${s.turns} turns) FAILED: ${s.error ?? 'unknown'}`;
  }
}

function renderHuman(r: DistillReport): string {
  const lines: string[] = [];
  const mode = r.dry_run ? ' [dry-run]' : '';
  lines.push(
    `capture distill${mode} — source ${r.source_id}, idle ≥ ${r.idle_hours_threshold}h — ${r.total_sessions} session${r.total_sessions === 1 ? '' : 's'}`,
  );
  if (!r.chat_available && !r.dry_run && r.eligible > 0) {
    lines.push('  (chat gateway unavailable — eligible sessions failed; set the chat model/API key and re-run)');
  }
  if (r.sessions.length === 0) {
    lines.push('  no capture sessions found.');
  } else {
    for (const s of r.sessions) lines.push(statusLine(s));
  }
  lines.push('');
  if (r.dry_run) {
    lines.push(`would distill ${r.eligible} session${r.eligible === 1 ? '' : 's'} (${r.skipped_already} already done, ${r.skipped_active} still active).`);
  } else {
    lines.push(
      `distilled ${r.distilled} session${r.distilled === 1 ? '' : 's'} → ${r.memories_written} memories across ${r.pages_written} pages` +
        ` (${r.skipped_already} already done, ${r.skipped_active} still active, ${r.failed} failed).`,
    );
  }
  return lines.join('\n') + '\n';
}

/**
 * `gbrain capture distill [options]`. Thin I/O shell over
 * {@link distillCaptureSessions}. Engine is null only on the pre-bind `--help`
 * path (cli.ts routes `capture --help` before connecting a DB).
 */
export async function runCaptureDistill(engine: BrainEngine | null, args: string[]): Promise<void> {
  const parsed = parseDistillArgs(args);
  if ('help' in parsed) {
    console.log(HELP);
    return;
  }
  if (!engine) {
    console.error('capture distill requires a database. Run `gbrain init` first.');
    process.exit(1);
    return;
  }

  const report = await distillCaptureSessions(engine, {
    sourceId: parsed.source,
    idleHours: parsed.idleHours,
    dryRun: parsed.dryRun,
  });

  if (parsed.json) {
    process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  } else {
    process.stdout.write(renderHuman(report));
  }
}
