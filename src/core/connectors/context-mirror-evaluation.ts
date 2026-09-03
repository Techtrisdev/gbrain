/**
 * Isolated Context Mirror provider evaluation.
 *
 * This module deliberately accepts no operational database object. It reuses
 * the production distillation classifier, but cannot write pages, markers,
 * queues, cursors, candidates, decisions, or promotions. The caller owns any
 * restricted evaluation-result persistence outside operational Brain state.
 */

import { withBudgetTracker } from '../ai/gateway.ts';
import { BudgetTracker } from '../budget/budget-tracker.ts';
import {
  distillConversation,
  type DistillConversationOutcome,
} from './distill.ts';

export interface ContextMirrorEvaluationItem {
  opaqueId: string;
  conversation: string;
}

export interface ContextMirrorEvaluationOptions {
  model?: string;
  maxItems: number;
  maxCalls: number;
  maxInputTokens: number;
  maxOutputTokens: number;
  maxRuntimeMs: number;
  maxCostUsd: number;
  requestTimeoutMs: number;
  abortSignal?: AbortSignal;
  budgetAuditPath?: string;
  /** Test seam only; production defaults to the real distillation classifier. */
  distill?: typeof distillConversation;
}

export interface ContextMirrorEvaluationDisposition {
  opaque_id: string;
  status: 'memory' | 'noop' | 'rejected' | 'systemic_failure' | 'deferred';
  memories: string[];
  error_class?: string;
  usage: {
    input_tokens: number;
    output_tokens: number;
    cache_read_tokens: number;
    cache_creation_tokens: number;
  };
}

export interface ContextMirrorEvaluationReport {
  mode: 'evaluation_only';
  operational_mutations: 0;
  status: 'completed' | 'partial' | 'failed';
  stop_reason: 'completed' | 'item_limit' | 'call_limit' | 'input_token_limit' |
    'output_token_limit' | 'runtime_limit' | 'cost_limit' | 'systemic_failure';
  selected: number;
  calls: number;
  deferred: number;
  dispositions: ContextMirrorEvaluationDisposition[];
  usage: { input_tokens: number; output_tokens: number };
  estimated_cost_usd: number;
}

const OUTPUT_RESERVATION = 1_500;

function finiteInteger(name: string, value: number, min = 1): number {
  if (!Number.isFinite(value) || !Number.isInteger(value) || value < min) {
    throw new Error(`${name} must be a finite integer >= ${min}`);
  }
  return value;
}

function inputReservation(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

function usageOf(outcome: DistillConversationOutcome): ContextMirrorEvaluationDisposition['usage'] {
  return outcome.status === 'distilled'
    ? outcome.usage
    : { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_creation_tokens: 0 };
}

export async function runContextMirrorEvaluation(
  items: ContextMirrorEvaluationItem[],
  options: ContextMirrorEvaluationOptions,
): Promise<ContextMirrorEvaluationReport> {
  const maxItems = finiteInteger('maxItems', options.maxItems);
  const maxCalls = finiteInteger('maxCalls', options.maxCalls);
  const maxInputTokens = finiteInteger('maxInputTokens', options.maxInputTokens);
  const maxOutputTokens = finiteInteger('maxOutputTokens', options.maxOutputTokens);
  const maxRuntimeMs = finiteInteger('maxRuntimeMs', options.maxRuntimeMs);
  const requestTimeoutMs = finiteInteger('requestTimeoutMs', options.requestTimeoutMs);
  if (!Number.isFinite(options.maxCostUsd) || options.maxCostUsd <= 0) {
    throw new Error('maxCostUsd must be a finite number > 0');
  }
  const selected = items.slice(0, maxItems);
  const report: ContextMirrorEvaluationReport = {
    mode: 'evaluation_only',
    operational_mutations: 0,
    status: items.length > selected.length ? 'partial' : 'completed',
    stop_reason: items.length > selected.length ? 'item_limit' : 'completed',
    selected: selected.length,
    calls: 0,
    deferred: Math.max(0, items.length - selected.length),
    dispositions: [],
    usage: { input_tokens: 0, output_tokens: 0 },
    estimated_cost_usd: 0,
  };
  const startedAt = Date.now();
  let reservedInput = 0;
  let reservedOutput = 0;
  const execute = options.distill ?? distillConversation;
  const tracker = new BudgetTracker({
    maxCostUsd: options.maxCostUsd,
    maxRuntimeMs,
    label: 'context-mirror-evaluation-only',
    ...(options.budgetAuditPath ? { auditPath: options.budgetAuditPath } : {}),
  });

  const deferFrom = (index: number, reason: ContextMirrorEvaluationReport['stop_reason']): void => {
    for (let cursor = index; cursor < selected.length; cursor++) {
      report.dispositions.push({
        opaque_id: selected[cursor]!.opaqueId,
        status: 'deferred',
        memories: [],
        usage: { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_creation_tokens: 0 },
      });
      report.deferred += 1;
    }
    report.status = reason === 'systemic_failure' || reason === 'cost_limit' ? 'failed' : 'partial';
    report.stop_reason = reason;
  };

  try {
    await withBudgetTracker(tracker, async () => {
      for (let index = 0; index < selected.length; index++) {
        const item = selected[index]!;
        if (!/^[a-zA-Z0-9_.:-]{4,128}$/.test(item.opaqueId)) {
          throw new Error('evaluation item opaqueId is invalid');
        }
        if (Date.now() - startedAt >= maxRuntimeMs) {
          deferFrom(index, 'runtime_limit');
          break;
        }
        const input = inputReservation(item.conversation);
        if (report.calls >= maxCalls) {
          deferFrom(index, 'call_limit');
          break;
        }
        if (reservedInput + input > maxInputTokens) {
          deferFrom(index, 'input_token_limit');
          break;
        }
        if (reservedOutput + OUTPUT_RESERVATION > maxOutputTokens) {
          deferFrom(index, 'output_token_limit');
          break;
        }
        report.calls += 1;
        reservedInput += input;
        reservedOutput += OUTPUT_RESERVATION;
        const outcome = await execute(item.conversation, {
          model: options.model,
          abortSignal: options.abortSignal,
          requestTimeoutMs,
          maxRetries: 0,
        });
        const usage = usageOf(outcome);
        report.usage.input_tokens += usage.input_tokens;
        report.usage.output_tokens += usage.output_tokens;
        if (outcome.status === 'systemic_failure') {
          report.dispositions.push({
            opaque_id: item.opaqueId,
            status: 'systemic_failure',
            memories: [],
            error_class: outcome.errorClass,
            usage,
          });
          deferFrom(index + 1, 'systemic_failure');
          break;
        }
        if (outcome.status === 'session_rejected') {
          report.dispositions.push({
            opaque_id: item.opaqueId,
            status: 'rejected',
            memories: [],
            error_class: outcome.errorClass,
            usage,
          });
          continue;
        }
        report.dispositions.push({
          opaque_id: item.opaqueId,
          status: outcome.memories.length === 0 ? 'noop' : 'memory',
          memories: outcome.memories,
          usage,
        });
      }
    });
  } catch (error) {
    if (error instanceof Error && /budget|cost/i.test(error.message)) {
      report.status = 'failed';
      report.stop_reason = 'cost_limit';
    } else {
      throw error;
    }
  }
  report.estimated_cost_usd = tracker.snapshot().cumulativeCostUsd;
  return report;
}
