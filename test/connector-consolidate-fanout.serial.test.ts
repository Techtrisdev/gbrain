/**
 * U4 — Multi-topic fan-out END-TO-END smoke + receiver-compat verification.
 *
 * Drives the REAL pipeline (`landRecords` → `extractConsolidationFacts` →
 * `classifyConsolidationFacts` → fan-out persist) over a synthetic multi-topic
 * capture against fixture pages, and proves the feature's payoff:
 *
 *   - one meeting that touches several pages produces N INDEPENDENT, targeted
 *     proposals (one ADD/UPDATE per page) — NOT one buried NEEDS_REVIEW;
 *   - each candidate carries a distinct, collision-free `source_record_id`
 *     (`<captureId>::<target>`) and, for an UPDATE, its OWN valid per-target
 *     `base_compiled_hash`;
 *   - those distinct ids map to DISTINCT receiver branch names under the EXACT
 *     techtris-brain `promote_candidate.py:branch_name` formula — so the receiver
 *     needs NO change (KTD4): N candidates from one capture are N ordinary,
 *     independent promotions.
 *
 * This is a *.serial.test.ts file because it mutates the chat/embedding gateway
 * singleton (the repo serial-quarantines gateway-mutating tests).
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { landRecords, type SaaSConnector, type NormalizedRecord } from '../src/core/connectors/base.ts';
import {
  __setChatTransportForTests,
  __setEmbedTransportForTests,
  configureGateway,
  resetGateway,
  type ChatOpts,
  type ChatResult,
} from '../src/core/ai/gateway.ts';
import {
  CONSOLIDATION_EXTRACT_SYSTEM,
  CONSOLIDATION_CLASSIFY_SYSTEM,
  compiledTruthHash,
} from '../src/core/connectors/consolidate.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import type { Page, SearchResult, SearchOpts } from '../src/core/types.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 60_000);

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  await resetPgliteState(engine);
  resetGateway();
  __setChatTransportForTests(null);
  __setEmbedTransportForTests(null);
});

afterEach(() => {
  __setChatTransportForTests(null);
  __setEmbedTransportForTests(null);
  resetGateway();
});

// ── harness (mirrors the connector-candidate U3 seam helpers) ──────────────────

/** A granola-shaped poll-only connector. */
const granolaLike: SaaSConnector = {
  provider: 'granola',
  signatureHeader: 'x-granola-unused',
  verifyWebhook: () => false,
  accountFromPayload: () => null,
  normalize: () => [],
  toCandidate: (record, sourceId) => ({
    source_id: sourceId,
    source_record_id: record.sourceRecordId,
    provider: 'granola',
    proposed_slug: record.proposedSlug,
    proposed_markdown: record.item.summary,
    confidence: 0.9,
  }),
};

function rec(id: string, summary: string): NormalizedRecord {
  return {
    sourceRecordId: id,
    profile: 'docs',
    item: { sourceRecordId: id, summary, metadata: {} },
    proposedSlug: `granola-note-${id}`,
  };
}

async function enableGranolaConsolidation(): Promise<void> {
  await engine.executeRaw(
    `UPDATE sources SET config = $1::jsonb WHERE id = 'default'`,
    [{ connectors: { granola: { enabled: true, consolidation_enabled: true } } }],
  );
}

function fakePage(slug: string, compiled_truth: string, source_id = 'shared'): Page {
  return {
    id: 1, slug, type: 'note', title: slug, compiled_truth, timeline: '',
    frontmatter: {}, created_at: new Date('2026-01-01T00:00:00Z'),
    updated_at: new Date('2026-01-01T00:00:00Z'), source_id,
  };
}
function fakeHit(slug: string, score: number, source_id = 'shared'): SearchResult {
  return {
    slug, page_id: 1, title: slug, type: 'note',
    chunk_text: 'a chunk — NOT the page body', chunk_source: 'compiled_truth',
    chunk_id: 1, chunk_index: 0, score, stale: false, source_id,
  };
}

/** Proxy the real engine, overriding only searchVector/getPage (persistence stays real). */
function withClassifierIO(real: BrainEngine, io: { hits?: SearchResult[]; pages?: Record<string, Page> }): BrainEngine {
  return new Proxy(real, {
    get(target, prop, receiver) {
      if (prop === 'searchVector') {
        return async (_emb: Float32Array, o?: SearchOpts): Promise<SearchResult[]> => {
          const scope = o?.sourceId;
          return (io.hits ?? []).filter((h) => scope == null || (h.source_id ?? 'default') === scope);
        };
      }
      if (prop === 'getPage') {
        return async (slug: string): Promise<Page | null> => io.pages?.[slug] ?? null;
      }
      const v = Reflect.get(target, prop, receiver);
      return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(target) : v;
    },
  }) as BrainEngine;
}

function configureEmbedding(): void {
  configureGateway({
    embedding_model: 'zeroentropyai:zembed-1',
    embedding_dimensions: 1280,
    env: { ZEROENTROPY_API_KEY: 'sk-fake' },
  });
  __setEmbedTransportForTests((async (args: { values: unknown[] }) => ({
    embeddings: args.values.map(() => Array.from({ length: 1280 }, () => 0.1)),
  })) as unknown as Parameters<typeof __setEmbedTransportForTests>[0]);
}

function stubChatRouting(handlers: { extract?: (o: ChatOpts) => string; classify?: (o: ChatOpts) => string }): { calls: ChatOpts[] } {
  const calls: ChatOpts[] = [];
  __setChatTransportForTests(async (opts: ChatOpts): Promise<ChatResult> => {
    calls.push(opts);
    let text = '';
    if (opts.system === CONSOLIDATION_EXTRACT_SYSTEM) text = handlers.extract?.(opts) ?? '';
    else if (opts.system === CONSOLIDATION_CLASSIFY_SYSTEM) text = handlers.classify?.(opts) ?? '';
    return {
      text, blocks: [], stopReason: 'end',
      usage: { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_creation_tokens: 0 },
      model: 'test:stub', providerId: 'test',
    };
  });
  return { calls };
}

/**
 * Receiver branch name — a faithful replica of techtris-brain
 * promote_candidate.py:branch_name:
 *   promote/<sanitized-provider>-<sha256("<source_id>|<source_record_id>")[:12]>
 * Used to prove fan-out candidates land on DISTINCT branches with NO receiver change.
 */
function receiverBranch(provider: string, sourceId: string, srid: string): string {
  const safe = provider.replace(/[^a-zA-Z0-9-]/g, '-');
  return `promote/${safe}-${compiledTruthHash(`${sourceId}|${srid}`).slice(0, 12)}`;
}

// ── the smoke ──────────────────────────────────────────────────────────────────

describe('U4 — multi-topic fan-out end-to-end smoke + receiver-compat', () => {
  const ACME_BODY = 'Acme is a Series B customer.\n\nRenewal: pending.';
  const OLO_BODY = 'Olo webhook integration.\n\nContract: v1.';

  test('a clean 2-topic capture → 2 targeted UPDATE proposals (zero NEEDS_REVIEW) — the v1→fan-out payoff', async () => {
    await enableGranolaConsolidation();
    configureEmbedding();
    stubChatRouting({
      extract: () => JSON.stringify({ facts: ['Acme closed Series B', 'Olo webhook contract changed'], confidence: 0.85 }),
      classify: () =>
        JSON.stringify([
          { classification: 'UPDATE', target: 'clients/acme', merged_body: 'Acme is a Series B customer.\n\nRenewal: SIGNED.', timeline_entry: '2026-06-28 — Series B closed.', confidence: 0.86 },
          { classification: 'UPDATE', target: 'integrations/olo', merged_body: 'Olo webhook integration.\n\nContract: v2 (breaking).', timeline_entry: '2026-06-28 — Webhook contract → v2.', confidence: 0.82 },
        ]),
    });
    const io = withClassifierIO(engine, {
      hits: [fakeHit('clients/acme', 0.55, 'shared'), fakeHit('integrations/olo', 0.5, 'shared')],
      pages: { 'clients/acme': fakePage('clients/acme', ACME_BODY, 'shared'), 'integrations/olo': fakePage('integrations/olo', OLO_BODY, 'shared') },
    });

    const res = await landRecords(io, 'default', granolaLike, [rec('meet-1', 'Acme Series B; Olo webhook changed')], { consolidate: true });
    expect(res.written).toBe(2); // ONE meeting → TWO independent proposals

    const rows = await engine.executeRaw<{
      source_record_id: string; classification: string; target_kind: string;
      target_path: string; base_compiled_hash: string; status: string;
    }>(
      `SELECT source_record_id, classification, target_kind, target_path, base_compiled_hash, status
         FROM connector_candidates WHERE source_record_id LIKE 'meet-1::%' ORDER BY source_record_id`,
    );
    expect(rows.map((r) => r.source_record_id)).toEqual(['meet-1::clients/acme', 'meet-1::integrations/olo']);

    // Zero NEEDS_REVIEW for a clean multi-topic capture (the v1 behavior was a single NEEDS_REVIEW).
    expect(rows.every((r) => r.classification === 'UPDATE')).toBe(true);
    expect(rows.every((r) => r.status === 'pending')).toBe(true);
    expect(rows.every((r) => r.target_kind === 'update_page')).toBe(true);

    // Each UPDATE carries its OWN valid per-target base_compiled_hash (KTD8) over the
    // FULL decomposed compiled-truth of THAT page — distinct per target.
    const acme = rows.find((r) => r.source_record_id === 'meet-1::clients/acme')!;
    const olo = rows.find((r) => r.source_record_id === 'meet-1::integrations/olo')!;
    expect(acme.target_path).toBe('clients/acme.md');
    expect(olo.target_path).toBe('integrations/olo.md');
    expect(acme.base_compiled_hash).toBe(compiledTruthHash(ACME_BODY));
    expect(olo.base_compiled_hash).toBe(compiledTruthHash(OLO_BODY));
    expect(acme.base_compiled_hash).not.toBe(olo.base_compiled_hash);

    // KTD4 — receiver-compat: the two candidates compute to DISTINCT receiver branch
    // names under the unchanged promote_candidate.py formula ⇒ two independent PRs.
    const b1 = receiverBranch('granola', 'default', acme.source_record_id);
    const b2 = receiverBranch('granola', 'default', olo.source_record_id);
    expect(b1).not.toBe(b2);
    expect(b1).toMatch(/^promote\/granola-[0-9a-f]{12}$/);
    expect(b2).toMatch(/^promote\/granola-[0-9a-f]{12}$/);
  });

  test('a 3-topic capture (2 UPDATEs + 1 novel ADD) → 3 candidates, all distinct keys + distinct branches', async () => {
    await enableGranolaConsolidation();
    configureEmbedding();
    stubChatRouting({
      extract: () => JSON.stringify({ facts: ['Acme Series B', 'Olo webhook changed', 'New onboarding project kicked off'], confidence: 0.85 }),
      classify: () =>
        JSON.stringify([
          { classification: 'UPDATE', target: 'clients/acme', merged_body: 'Acme is a Series B customer.\n\nRenewal: SIGNED.', timeline_entry: '2026-06-28 — Series B.', confidence: 0.86 },
          { classification: 'UPDATE', target: 'integrations/olo', merged_body: 'Olo webhook integration.\n\nContract: v2.', timeline_entry: '2026-06-28 — v2.', confidence: 0.82 },
          { classification: 'ADD', target: 'projects/onboarding-revamp', confidence: 0.9 },
        ]),
    });
    const io = withClassifierIO(engine, {
      hits: [fakeHit('clients/acme', 0.55, 'shared'), fakeHit('integrations/olo', 0.5, 'shared')],
      pages: { 'clients/acme': fakePage('clients/acme', ACME_BODY, 'shared'), 'integrations/olo': fakePage('integrations/olo', OLO_BODY, 'shared') },
    });

    const res = await landRecords(io, 'default', granolaLike, [rec('meet-3', 'three topics')], { consolidate: true });
    expect(res.written).toBe(3);

    const rows = await engine.executeRaw<{ source_record_id: string; classification: string }>(
      `SELECT source_record_id, classification FROM connector_candidates WHERE source_record_id LIKE 'meet-3::%'`,
    );
    expect(rows.length).toBe(3);
    expect(rows.filter((r) => r.classification === 'UPDATE').length).toBe(2);
    expect(rows.filter((r) => r.classification === 'ADD').length).toBe(1);

    // All three source_record_ids are distinct → all three receiver branches are distinct.
    const srids = rows.map((r) => r.source_record_id);
    expect(new Set(srids).size).toBe(3);
    const branches = srids.map((s) => receiverBranch('granola', 'default', s));
    expect(new Set(branches).size).toBe(3); // N independent, receiver-promotable proposals
  });
});
