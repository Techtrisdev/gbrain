/**
 * test/stdio-trust-boundary.test.ts — SEC-001.
 *
 * `localOnly: true` means "this operation is CLI-only; an agent-facing
 * transport must not be able to reach it". Before this suite that promise was
 * kept in exactly one place: serve-http.ts's `operations.filter(op =>
 * !op.localOnly)`. Two other paths reached the same handlers and honoured
 * nothing:
 *
 *   1. stdio MCP  — src/mcp/server.ts hands the RAW operations array to
 *                   buildToolDefs and passes every tools/call straight into
 *                   dispatchToolCall, which had no localOnly or scope gate.
 *   2. subagents  — the brain-allowlist registry literally named `file_list`
 *                   and `file_url` (both admin + localOnly), built a
 *                   `remote: true` context, and invoked handlers directly.
 *
 * CHARACTERIZATION, measured on origin/main before the fix, so the change is
 * legible rather than asserted:
 *
 *   localOnly ops (7): purge_deleted_pages, sync_brain, file_list,
 *                      file_upload, file_url, get_recent_transcripts,
 *                      code_traversal_cache_clear
 *   in subagent allowlist: file_list, file_url   <- the leak
 *   allowlist size: 13
 *
 * Of the 7, only get_recent_transcripts and file_upload carried their own
 * `ctx.remote` guard. The other five were reachable with no gate at all,
 * including purge_deleted_pages — which hard-deletes rows INSIDE their
 * documented 72h recovery window.
 *
 * The threat is not a malicious local process (that already owns the shell
 * and could run the CLI directly). It is the confused deputy: a legitimate
 * MCP client or a prompt-driven subagent induced by injected content to call
 * something the operator never intended.
 */

import { test, expect, describe } from 'bun:test';
import { operations } from '../src/core/operations.ts';
import { BRAIN_TOOL_ALLOWLIST } from '../src/core/minions/tools/brain-allowlist.ts';
import { dispatchToolCall } from '../src/mcp/dispatch.ts';
import type { BrainEngine } from '../src/core/engine.ts';

const localOnlyOps = operations.filter(o => o.localOnly === true);
const localOnlyNames = localOnlyOps.map(o => o.name);

/** An engine that explodes if touched — reaching it means the gate failed. */
const trapEngine = new Proxy({} as BrainEngine, {
  get(_t, prop) {
    if (prop === 'kind') return 'pglite';
    throw new Error(`GATE FAILED: handler reached the engine (.${String(prop)})`);
  },
});

describe('characterization — the shape being protected', () => {
  test('localOnly is a real, non-empty set', () => {
    expect(localOnlyNames.length).toBeGreaterThan(0);
  });

  test('localOnly is overwhelmingly admin-scoped, with one documented exception', () => {
    // Measured, not assumed. 6 of 7 are admin; get_recent_transcripts is
    // scope=read because it reads local transcript files rather than mutating
    // the brain — and it is precisely the one op that ALREADY carried its own
    // ctx.remote guard. localOnly is therefore not a synonym for admin, and
    // the dispatch gate must key on localOnly itself, not on scope.
    const notAdmin = localOnlyOps.filter(o => o.scope !== 'admin').map(o => o.name);
    expect(notAdmin).toEqual(['get_recent_transcripts']);
  });

  test('the destructive op that motivated this is still localOnly', () => {
    // purge_deleted_pages bypasses the documented 72h recovery window.
    expect(localOnlyNames).toContain('purge_deleted_pages');
  });
});

describe('stdio / dispatch enforcement (transport-agnostic)', () => {
  test.each(localOnlyNames)('%s is REFUSED for a remote caller', async (name) => {
    const res = await dispatchToolCall(trapEngine, name, {}, { remote: true });
    expect(res.isError).toBe(true);
    expect(JSON.stringify(res.content)).toContain('permission_denied');
  });

  test('fail-closed: an UNSET remote flag is treated as remote, not trusted', async () => {
    // v0.26.9 convention — anything that is not strictly `false` is untrusted.
    // A transport that forgets to set the field must not get a free pass.
    const res = await dispatchToolCall(trapEngine, 'purge_deleted_pages', {}, {});
    expect(res.isError).toBe(true);
    expect(JSON.stringify(res.content)).toContain('permission_denied');
  });

  test('the refusal happens BEFORE the handler runs', async () => {
    // trapEngine throws on any property access, so a non-throwing refusal
    // proves the gate short-circuits rather than failing deep in the handler.
    const res = await dispatchToolCall(trapEngine, 'sync_brain', {}, { remote: true });
    expect(res.isError).toBe(true);
    expect(JSON.stringify(res.content)).not.toContain('GATE FAILED');
  });

  test('a NON-localOnly op is not collaterally blocked', async () => {
    // The gate must be surgical. `search` is read-scope and agent-facing;
    // it should pass the gate and fail later for its own reasons (no engine),
    // never with permission_denied.
    const res = await dispatchToolCall(trapEngine, 'search', { query: 'x' }, { remote: true });
    expect(JSON.stringify(res.content)).not.toContain('permission_denied');
  });

  test('an explicit local caller (remote:false) is still allowed through the gate', async () => {
    // The CLI sets remote:false and must keep working. It reaches the engine
    // and trips the trap — which is the proof it got past the gate.
    const res = await dispatchToolCall(trapEngine, 'sync_brain', {}, { remote: false });
    expect(JSON.stringify(res.content)).not.toContain('permission_denied');
  });
});

describe('subagent registry — structural exclusion', () => {
  test('NO localOnly op appears in the subagent allowlist', () => {
    const leaked = localOnlyNames.filter(n => BRAIN_TOOL_ALLOWLIST.has(n));
    expect(leaked).toEqual([]);
  });

  test('file_list and file_url specifically are gone', () => {
    // Named explicitly: these two were the actual leak, and a future edit
    // that re-adds them by hand should fail loudly here.
    expect(BRAIN_TOOL_ALLOWLIST.has('file_list')).toBe(false);
    expect(BRAIN_TOOL_ALLOWLIST.has('file_url')).toBe(false);
  });

  test('NO admin-scope op appears in the subagent allowlist', () => {
    const adminNames = operations.filter(o => o.scope === 'admin').map(o => o.name);
    const leaked = adminNames.filter(n => BRAIN_TOOL_ALLOWLIST.has(n));
    expect(leaked).toEqual([]);
  });

  test('the allowlist is still useful — exclusion did not empty it', () => {
    expect(BRAIN_TOOL_ALLOWLIST.size).toBeGreaterThanOrEqual(10);
    expect(BRAIN_TOOL_ALLOWLIST.has('search')).toBe(true);
    expect(BRAIN_TOOL_ALLOWLIST.has('get_page')).toBe(true);
  });

  test('every allowlisted name still resolves to a real operation', () => {
    const known = new Set(operations.map(o => o.name));
    const dangling = [...BRAIN_TOOL_ALLOWLIST].filter(n => !known.has(n));
    expect(dangling).toEqual([]);
  });
});
