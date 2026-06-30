/**
 * capture-distill.serial.test.ts — the Session Distiller (`gbrain capture distill`).
 *
 * The distiller groups RAW per-turn `capture/<session>/…` pages by session and,
 * for each COMPLETED session (newest capture older than --idle-hours), makes ONE
 * gateway chat() call that emits 0–6 durable memory statements, written as
 * `distilled/<session-slug>/mem-K` pages + a `distill-state/<session-slug>`
 * idempotency marker.
 *
 * Mirrors connector-context-mirror.test.ts (a fake engine capturing listPages +
 * page writes) and connector-consolidate.serial.test.ts (chat stubbed via
 * __setChatTransportForTests). The fake engine is STATEFUL — putPage persists
 * into a store that later listPages calls read back — so the idempotency test is
 * a real two-run check (the second run sees the marker the first wrote).
 *
 * Serial + per-test gateway reset: bun shards individual tests, so a leaked chat
 * transport / gateway config from a prior file would otherwise make the
 * "chat unavailable" assertion flaky. resetGateway() + null transport before AND
 * after every test pins a clean baseline.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import {
  __setChatTransportForTests,
  configureGateway,
  resetGateway,
  type ChatOpts,
  type ChatResult,
} from '../src/core/ai/gateway.ts';
import {
  distillCaptureSessions,
  groupCapturesBySession,
  sessionIdOf,
  toSessionSlug,
  parseDistillMemories,
  assembleConversation,
  DISTILL_SYSTEM,
} from '../src/core/connectors/distill.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import type { Page, PageInput, PageFilters } from '../src/core/types.ts';

// ── Stateful fake engine ──────────────────────────────────────────────────────
//   The distiller enumerates with listAllSlugs (uncapped, DISTINCT slug ORDER BY
//   slug, keyset cursor via after/limit) and hydrates capture rows via getPage;
//   markers need only their slug. The fake mirrors that contract over a combined
//   set of seeded pages + any pages putPage wrote (markers/distilled). putPage
//   records + persists. listPages is retained for the retention-sweep style tests.

function makeFakeEngine(seededPages: Page[] = []) {
  const store = new Map<string, Page>();
  const puts: { slug: string; page: PageInput; sourceId?: string }[] = [];
  const listCalls: (PageFilters | undefined)[] = [];
  const allPages = (): Page[] => [...seededPages, ...store.values()];

  const listPages = async (filters?: PageFilters): Promise<Page[]> => {
    listCalls.push(filters);
    const prefix = filters?.slugPrefix ?? '';
    return allPages().filter((p) => (p.slug ?? '').startsWith(prefix));
  };

  // listAllSlugs: DISTINCT slug ORDER BY slug, optional prefix, keyset cursor.
  const listAllSlugs = async (opts?: {
    sourceId?: string;
    slugPrefix?: string;
    after?: string;
    limit?: number;
    includeDeleted?: boolean;
  }): Promise<string[]> => {
    const prefix = opts?.slugPrefix ?? '';
    let slugs = [
      ...new Set(
        allPages()
          .map((p) => p.slug as string)
          .filter((s) => typeof s === 'string' && s.startsWith(prefix)),
      ),
    ].sort();
    if (opts?.after) slugs = slugs.filter((s) => s > opts.after!);
    if (opts?.limit && opts.limit > 0) slugs = slugs.slice(0, opts.limit);
    return slugs;
  };

  // getPage: store (latest write) wins over the seeded set; null when unknown.
  const getPage = async (slug: string): Promise<Page | null> => {
    return store.get(slug) ?? allPages().find((p) => p.slug === slug) ?? null;
  };

  const putPage = async (slug: string, page: PageInput, opts?: { sourceId?: string }): Promise<Page> => {
    puts.push({ slug, page, sourceId: opts?.sourceId });
    const stored = {
      id: store.size + 1,
      slug,
      type: page.type,
      title: page.title,
      compiled_truth: page.compiled_truth,
      timeline: page.timeline ?? '',
      frontmatter: page.frontmatter ?? {},
      created_at: new Date(),
      updated_at: new Date(),
      source_id: opts?.sourceId ?? 'default',
    } as unknown as Page;
    store.set(slug, stored);
    return stored;
  };

  const engine = { kind: 'pglite', listPages, listAllSlugs, getPage, putPage } as unknown as BrainEngine;
  return { engine, puts, listCalls, store };
}

/** A bare `distill-state/<slug>` marker page (only the slug is read by the done-set). */
function mkMarker(sessionSlug: string): Page {
  return {
    id: 1,
    slug: `distill-state/${sessionSlug}`,
    type: 'note',
    title: `distill-state ${sessionSlug}`,
    compiled_truth: 'marker',
    timeline: '',
    frontmatter: { kind: 'distill-marker' },
    created_at: new Date(),
    updated_at: new Date(),
    source_id: 'capture-events',
  } as unknown as Page;
}

/** A raw capture page: only slug/frontmatter/compiled_truth/updated_at are read. */
function mkCapture(p: {
  slug: string;
  session_id?: string;
  compiled_truth?: string;
  kind?: string;
  turn?: number;
  updated_at: string;
}): Page {
  const fm: Record<string, unknown> = {};
  if (p.session_id !== undefined) fm.session_id = p.session_id;
  if (p.kind !== undefined) fm.kind = p.kind;
  if (p.turn !== undefined) fm.turn = p.turn;
  return {
    id: 1,
    slug: p.slug,
    type: 'note',
    title: p.slug,
    compiled_truth: p.compiled_truth ?? 'some content',
    timeline: '',
    frontmatter: fm,
    created_at: new Date(p.updated_at),
    updated_at: new Date(p.updated_at),
    source_id: 'capture-events',
  } as unknown as Page;
}

/** Install a chat transport. `respond` maps the call opts → the model's raw text. */
function stubChat(respond: (opts: ChatOpts) => string): { calls: ChatOpts[] } {
  const calls: ChatOpts[] = [];
  __setChatTransportForTests(async (opts: ChatOpts): Promise<ChatResult> => {
    calls.push(opts);
    return {
      text: respond(opts),
      blocks: [],
      stopReason: 'end',
      usage: { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_creation_tokens: 0 },
      model: 'test:stub',
      providerId: 'test',
    };
  });
  return { calls };
}

const NOW = new Date('2026-06-29T12:00:00Z');
/** Old enough to be "completed" at NOW (12h idle ≥ default 6h). */
const OLD = '2026-06-29T00:00:00Z';
/** Too recent at NOW (1h idle < default 6h). */
const RECENT = '2026-06-29T11:00:00Z';

beforeEach(() => {
  resetGateway();
  // Configure the gateway with an EMPTY env so chat()'s getChatModel() default
  // resolves (it would otherwise throw "not configured") WITHOUT supplying any
  // provider API key. The __setChatTransportForTests seam intercepts chat()
  // before provider resolution, so no real call is made; and with no key,
  // isAvailable('chat') is false UNLESS a transport stub is installed — exactly
  // what the "chat unavailable" test relies on.
  configureGateway({ env: {} });
  __setChatTransportForTests(null);
});
afterEach(() => {
  __setChatTransportForTests(null);
  resetGateway();
});

// ── Pure helpers ──────────────────────────────────────────────────────────────

describe('grouping + slug helpers', () => {
  test('groupCapturesBySession groups by frontmatter session_id', () => {
    const groups = groupCapturesBySession([
      mkCapture({ slug: 'capture/s1/prompt-a', session_id: 's1', updated_at: OLD }),
      mkCapture({ slug: 'capture/s1/reply-b', session_id: 's1', updated_at: OLD }),
      mkCapture({ slug: 'capture/s2/prompt-c', session_id: 's2', updated_at: OLD }),
    ]);
    expect([...groups.keys()].sort()).toEqual(['s1', 's2']);
    expect(groups.get('s1')!.length).toBe(2);
    expect(groups.get('s2')!.length).toBe(1);
  });

  test('sessionIdOf falls back to the slug segment when frontmatter lacks session_id', () => {
    expect(sessionIdOf(mkCapture({ slug: 'capture/abc123/prompt-x', updated_at: OLD }))).toBe('abc123');
    // frontmatter wins over slug segment
    expect(sessionIdOf(mkCapture({ slug: 'capture/abc123/prompt-x', session_id: 'real-sid', updated_at: OLD }))).toBe('real-sid');
  });

  test('ungroupable pages (no session_id, non-capture slug) are dropped', () => {
    const groups = groupCapturesBySession([
      { slug: 'random/page', frontmatter: {} } as unknown as Page,
      mkCapture({ slug: 'capture/ok/prompt', session_id: 'ok', updated_at: OLD }),
    ]);
    expect([...groups.keys()]).toEqual(['ok']);
  });

  test('toSessionSlug is deterministic + slug-safe', () => {
    expect(toSessionSlug('Abc 123/XY')).toBe('abc-123-xy');
    expect(toSessionSlug('uuid-1234-5678')).toBe('uuid-1234-5678');
    expect(toSessionSlug('   ')).toBe('unknown');
  });

  test('assembleConversation orders by turn and labels roles', () => {
    const convo = assembleConversation([
      mkCapture({ slug: 'capture/s/reply-2', session_id: 's', kind: 'reply', turn: 2, compiled_truth: 'B answer', updated_at: OLD }),
      mkCapture({ slug: 'capture/s/prompt-1', session_id: 's', kind: 'prompt', turn: 1, compiled_truth: 'A question', updated_at: OLD }),
    ]);
    expect(convo).toBe('[USER] A question\n\n[ASSISTANT] B answer');
  });
});

describe('parseDistillMemories', () => {
  test('parses a JSON array of strings; caps to 6', () => {
    const raw = JSON.stringify(['a', 'b', 'c', 'd', 'e', 'f', 'g']);
    expect(parseDistillMemories(raw)).toEqual(['a', 'b', 'c', 'd', 'e', 'f']);
  });
  test('tolerates ```json fences and drops non-strings/blanks', () => {
    expect(parseDistillMemories('```json\n["x", 3, "", "y"]\n```')).toEqual(['x', 'y']);
  });
  test('well-formed empty array → [] (a genuine no-signal distillation)', () => {
    expect(parseDistillMemories('[]')).toEqual([]);
  });
  test('malformed / non-array output → null (a failure, not an empty distillation)', () => {
    expect(parseDistillMemories('not json at all')).toBeNull();
    expect(parseDistillMemories('{"facts":["a"]}')).toBeNull();
    expect(parseDistillMemories('')).toBeNull();
  });
});

// ── Orchestrator ────────────────────────────────────────────────────────────

describe('distillCaptureSessions — happy path', () => {
  test('one completed session → N distilled pages + a marker; report counts', async () => {
    const { engine, puts } = makeFakeEngine([
      mkCapture({ slug: 'capture/sess-1/prompt-1', session_id: 'sess-1', kind: 'prompt', turn: 1, compiled_truth: 'Should we ship X?', updated_at: OLD }),
      mkCapture({ slug: 'capture/sess-1/reply-1', session_id: 'sess-1', kind: 'reply', turn: 2, compiled_truth: 'Yes, ship X behind a flag.', updated_at: OLD }),
    ]);
    stubChat(() => JSON.stringify(['Jonathan prefers shipping behind flags.', 'Jonathan approved X.']));

    const report = await distillCaptureSessions(engine, { now: NOW });

    expect(report.total_sessions).toBe(1);
    expect(report.eligible).toBe(1);
    expect(report.distilled).toBe(1);
    expect(report.memories_written).toBe(2);
    expect(report.pages_written).toBe(2);
    expect(report.sessions[0].status).toBe('distilled');

    // two mem pages + one marker
    const memPuts = puts.filter((p) => p.slug.startsWith('distilled/'));
    const markerPuts = puts.filter((p) => p.slug.startsWith('distill-state/'));
    expect(memPuts.map((p) => p.slug)).toEqual(['distilled/sess-1/mem-1', 'distilled/sess-1/mem-2']);
    expect(markerPuts.map((p) => p.slug)).toEqual(['distill-state/sess-1']);

    // memory page: compiled_truth IS the statement; bound to the same source; session in frontmatter
    expect(memPuts[0].page.compiled_truth).toBe('Jonathan prefers shipping behind flags.');
    expect(memPuts[0].sourceId).toBe('capture-events');
    expect((memPuts[0].page.frontmatter as Record<string, unknown>).session_id).toBe('sess-1');
  });

  test('a session with nothing durable ([]) is still marked done (0 memories, no mem pages)', async () => {
    const { engine, puts } = makeFakeEngine([
      mkCapture({ slug: 'capture/empty/prompt-1', session_id: 'empty', compiled_truth: 'hi', updated_at: OLD }),
    ]);
    stubChat(() => '[]');

    const report = await distillCaptureSessions(engine, { now: NOW });

    expect(report.distilled).toBe(1);
    expect(report.memories_written).toBe(0);
    expect(report.sessions[0].status).toBe('distilled');
    expect(report.sessions[0].memories).toBe(0);
    expect(puts.filter((p) => p.slug.startsWith('distilled/')).length).toBe(0);
    // marker IS written so it is not re-distilled next run
    expect(puts.filter((p) => p.slug === 'distill-state/empty').length).toBe(1);
  });

  test('the untrusted conversation never lands in the system slot', async () => {
    const { engine } = makeFakeEngine([
      mkCapture({ slug: 'capture/s/prompt-1', session_id: 's', compiled_truth: 'SECRET-MARKER', updated_at: OLD }),
    ]);
    const { calls } = stubChat(() => '["m"]');
    await distillCaptureSessions(engine, { now: NOW });
    expect(calls.length).toBe(1);
    expect(calls[0].system).toBe(DISTILL_SYSTEM);
    expect(calls[0].system).not.toContain('SECRET-MARKER');
    // conversation rides as DATA in the user message
    expect(String(calls[0].messages[0].content)).toContain('SECRET-MARKER');
  });
});

describe('distillCaptureSessions — idle-hours gating', () => {
  test('a session whose newest capture is too recent is skipped as active (no writes)', async () => {
    const { engine, puts } = makeFakeEngine([
      mkCapture({ slug: 'capture/fresh/prompt-1', session_id: 'fresh', updated_at: RECENT }),
    ]);
    stubChat(() => '["m"]');
    const report = await distillCaptureSessions(engine, { now: NOW }); // default idle 6h; 1h < 6h

    expect(report.eligible).toBe(0);
    expect(report.skipped_active).toBe(1);
    expect(report.sessions[0].status).toBe('active');
    expect(puts.length).toBe(0);
  });

  test('--idle-hours threshold is honored', async () => {
    const { engine } = makeFakeEngine([
      mkCapture({ slug: 'capture/s/prompt-1', session_id: 's', updated_at: OLD }), // 12h idle
    ]);
    stubChat(() => '["m"]');
    // 24h threshold → 12h idle is still "active"
    const r1 = await distillCaptureSessions(engine, { now: NOW, idleHours: 24 });
    expect(r1.skipped_active).toBe(1);
    expect(r1.eligible).toBe(0);
  });
});

describe('distillCaptureSessions — dry-run', () => {
  test('lists eligible sessions but writes nothing', async () => {
    const { engine, puts } = makeFakeEngine([
      mkCapture({ slug: 'capture/s/prompt-1', session_id: 's', updated_at: OLD }),
    ]);
    const { calls } = stubChat(() => '["m"]');
    const report = await distillCaptureSessions(engine, { now: NOW, dryRun: true });

    expect(report.dry_run).toBe(true);
    expect(report.eligible).toBe(1);
    expect(report.sessions[0].status).toBe('would_distill');
    expect(puts.length).toBe(0); // nothing written
    expect(calls.length).toBe(0); // model never called in dry-run
  });
});

describe('distillCaptureSessions — idempotency', () => {
  test('running twice does not re-distill or duplicate (second run skips via the marker)', async () => {
    const { engine, puts } = makeFakeEngine([
      mkCapture({ slug: 'capture/s/prompt-1', session_id: 's', compiled_truth: 'q', updated_at: OLD }),
    ]);
    stubChat(() => '["only memory"]');

    const r1 = await distillCaptureSessions(engine, { now: NOW });
    expect(r1.distilled).toBe(1);
    const putsAfterFirst = puts.length;
    expect(putsAfterFirst).toBe(2); // mem-1 + marker

    const r2 = await distillCaptureSessions(engine, { now: NOW });
    expect(r2.distilled).toBe(0);
    expect(r2.skipped_already).toBe(1);
    expect(r2.sessions[0].status).toBe('already_distilled');
    expect(puts.length).toBe(putsAfterFirst); // NO new writes on the second run
  });
});

describe('distillCaptureSessions — failure tolerance', () => {
  test('a per-session LLM failure is isolated; a sibling session still distills', async () => {
    const { engine, puts } = makeFakeEngine([
      mkCapture({ slug: 'capture/bad/prompt-1', session_id: 'bad', compiled_truth: 'BADSESSION turn', updated_at: OLD }),
      mkCapture({ slug: 'capture/good/prompt-1', session_id: 'good', compiled_truth: 'GOODSESSION turn', updated_at: OLD }),
    ]);
    // malformed (unparseable) output for the bad session, valid for the good one
    stubChat((opts) =>
      String(opts.messages[0].content).includes('BADSESSION') ? 'totally not json' : JSON.stringify(['a good memory']),
    );

    const report = await distillCaptureSessions(engine, { now: NOW });

    expect(report.eligible).toBe(2);
    expect(report.distilled).toBe(1);
    expect(report.failed).toBe(1);

    const bad = report.sessions.find((s) => s.session_id === 'bad')!;
    const good = report.sessions.find((s) => s.session_id === 'good')!;
    expect(bad.status).toBe('failed');
    expect(good.status).toBe('distilled');

    // the FAILED session is NOT marked done (so it retries next run); the good one is
    expect(puts.some((p) => p.slug === 'distill-state/bad')).toBe(false);
    expect(puts.some((p) => p.slug === 'distill-state/good')).toBe(true);
    expect(puts.some((p) => p.slug.startsWith('distilled/bad/'))).toBe(false);
    expect(puts.some((p) => p.slug === 'distilled/good/mem-1')).toBe(true);
  });

  test('chat gateway unavailable → eligible session fails (not marked done), nothing written', async () => {
    const { engine, puts } = makeFakeEngine([
      mkCapture({ slug: 'capture/s/prompt-1', session_id: 's', updated_at: OLD }),
    ]);
    // no chat transport installed → isAvailable('chat') is false
    const report = await distillCaptureSessions(engine, { now: NOW });

    expect(report.chat_available).toBe(false);
    expect(report.eligible).toBe(1);
    expect(report.failed).toBe(1);
    expect(report.sessions[0].status).toBe('failed');
    expect(report.sessions[0].error).toContain('unavailable');
    expect(puts.length).toBe(0);
  });
});

// ── Uncapped enumeration (the listAllSlugs rewire — no silent 100-row drop) ───
//   The old listPages(default LIMIT 100) enumeration silently truncated: capture
//   sessions past the 100th were never distilled, and the done-set was incomplete
//   so already-distilled sessions were re-distilled. listAllSlugs enumerates the
//   COMPLETE set, so these >100 corpora are fully + correctly handled.

describe('distillCaptureSessions — uncapped enumeration (>100)', () => {
  // session-id zero-padded so toSessionSlug + slug ASC ordering are stable.
  const sid = (i: number) => `sess-${String(i).padStart(3, '0')}`;

  test('>100 idle capture sessions are ALL distilled (none dropped past row 100)', async () => {
    const N = 150;
    const seeded: Page[] = [];
    for (let i = 0; i < N; i++) {
      seeded.push(
        mkCapture({ slug: `capture/${sid(i)}/prompt-1`, session_id: sid(i), compiled_truth: 'q', updated_at: OLD }),
      );
    }
    const { engine, puts } = makeFakeEngine(seeded);
    stubChat(() => '["one durable memory"]');

    const report = await distillCaptureSessions(engine, { now: NOW });

    // With the old listPages(100) cap, total_sessions would have been 100.
    expect(report.total_sessions).toBe(N);
    expect(report.eligible).toBe(N);
    expect(report.distilled).toBe(N);
    expect(report.failed).toBe(0);
    // Every session got a marker → none silently skipped.
    const markers = puts.filter((p) => p.slug.startsWith('distill-state/'));
    expect(markers.length).toBe(N);
  });

  test('>100 done-markers are ALL seen → no re-distillation past row 100', async () => {
    const N = 150;
    const seeded: Page[] = [];
    for (let i = 0; i < N; i++) {
      // every session is both captured AND already marked done
      seeded.push(
        mkCapture({ slug: `capture/${sid(i)}/prompt-1`, session_id: sid(i), compiled_truth: 'q', updated_at: OLD }),
      );
      seeded.push(mkMarker(sid(i)));
    }
    const { engine, puts } = makeFakeEngine(seeded);
    stubChat(() => '["should never be called"]');

    const report = await distillCaptureSessions(engine, { now: NOW });

    // All 150 markers are in the done-set → all sessions skipped, none re-distilled.
    // With the old listPages(100) marker cap, ~50 would have been re-distilled.
    expect(report.total_sessions).toBe(N);
    expect(report.skipped_already).toBe(N);
    expect(report.distilled).toBe(0);
    expect(puts.length).toBe(0); // no new writes at all
  });
});
