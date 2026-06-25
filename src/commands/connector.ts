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
 */

import type { BrainEngine } from '../core/engine.ts';
import { loadAllSources } from '../core/sources-load.ts';
import {
  selectEnabledConnectorSources,
  runConnectorPoll,
  type ConnectorPollTarget,
  type ConnectorPollResult,
} from '../core/connectors/poll.ts';

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
  console.error(`Unknown connector subcommand "${sub}". Try: gbrain connector poll`);
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

function printHelp(): void {
  console.log(`Usage: gbrain connector <subcommand>

One-shot SaaS connector operations — the synchronous, daemon-free equivalent of
the autopilot connector-dispatch branch (no Minion worker required).

Subcommands:
  poll    Poll enabled connector sources NOW. Lands connector_candidates (a
          REVIEW queue) — NEVER durable Brain pages, NEVER a promotion.

poll options:
  --source <id> --provider <name>   Poll ONE (source, provider) target. Both
                                    required together; omit both to poll every
                                    enabled connector source.
  --json                            Machine-readable report.
  --dry-run                         List targets without polling.
  --help, -h                        Show this help.

Idempotent: a re-poll is a safe no-op (backfill ON CONFLICT). Promotion of the
landed candidates to durable Brain pages remains a separate, human-gated step.

Examples:
  gbrain connector poll
  gbrain connector poll --json
  gbrain connector poll --source default --provider granola
`);
}
