/**
 * gbrain OAuth scope hierarchy + allowlist (v0.28).
 *
 * Single source of truth for the 7 scope strings. Used by:
 *  - src/commands/serve-http.ts (scopesSupported, request-time hasScope)
 *  - src/core/oauth-provider.ts (F3 refresh, token issuance, registration)
 *  - src/commands/auth.ts (CLI register-client validation)
 *  - admin/src/lib/scope-constants.ts (HAND-MAINTAINED MIRROR; CI drift check
 *    in scripts/check-admin-scope-drift.sh keeps them aligned)
 *
 * Hierarchy (see plan ASCII diagram):
 *
 *                    admin                  agent / context_mirror_recovery
 *                      │
 *      ┌──────────┬────┴────┬──────────┐
 *      ▼          ▼         ▼          ▼
 *   sources_admin  users_admin  write  read
 *                                │      ▲
 *                                └──────┘
 *
 * sources_admin and users_admin are siblings (different axes — sources-mgmt
 * vs user-account-mgmt — neither implies the other).
 */

export type Scope = 'read' | 'write' | 'admin' | 'sources_admin' | 'users_admin' | 'agent' | 'context_mirror_recovery';

export const ALLOWED_SCOPES: ReadonlySet<Scope> = new Set<Scope>([
  'read',
  'write',
  'admin',
  'sources_admin',
  'users_admin',
  'agent',
  'context_mirror_recovery',
]);

/**
 * Sorted list (deterministic for OAuth metadata + drift-check output).
 * Use this when emitting `scopes_supported` over the wire.
 */
export const ALLOWED_SCOPES_LIST: ReadonlyArray<Scope> = Object.freeze([
  'admin',
  'agent',
  'context_mirror_recovery',
  'read',
  'sources_admin',
  'users_admin',
  'write',
]);

/**
 * Public Dynamic Client Registration is intentionally narrower than operator
 * registration. A DCR request arrives without an authenticated operator, so
 * it can create only ordinary client capabilities. Administrative, agent, and
 * recovery capabilities must be issued through the authenticated admin route
 * or the local operator CLI.
 */
export const DCR_ALLOWED_SCOPES: ReadonlySet<Scope> = new Set<Scope>(['read', 'write']);

/**
 * Hierarchy table: which required scopes are implied by which granted scope.
 * `admin` implies the general management scopes. `agent` and
 * `context_mirror_recovery` are separate least-privilege scopes: an existing
 * super-admin client must be explicitly re-registered to receive either.
 * `write` implies `read`. The two `*_admin` siblings only imply themselves.
 *
 * v0.38 (D13): `agent` is a SIBLING, not implied by admin. A super-admin
 * token still needs to be re-registered with explicit bindings to submit
 * subagent jobs. This prevents existing admin clients from silently gaining
 * agent-dispatch capability on upgrade.
 *
 * Context Mirror recovery uses the same rule. Its narrowly-issued temporary
 * credential can operate only in its authenticated source, while an ordinary
 * admin credential cannot silently acquire backlog-recovery authority.
 */
const IMPLIES: Record<Scope, ReadonlySet<Scope>> = {
  admin: new Set(['admin', 'sources_admin', 'users_admin', 'write', 'read']),
  write: new Set(['write', 'read']),
  sources_admin: new Set(['sources_admin']),
  users_admin: new Set(['users_admin']),
  read: new Set(['read']),
  agent: new Set(['agent']),
  context_mirror_recovery: new Set(['context_mirror_recovery']),
};

/**
 * Does the granted scope set include something that satisfies `required`?
 * - admin in granted → true for general management scopes, but not agent or
 *   context_mirror_recovery
 * - write in granted → true for {write, read}
 * - sources_admin in granted → true for {sources_admin}
 * - users_admin in granted → true for {users_admin}
 * - read in granted → true for {read}
 *
 * Unknown scopes in `granted` are ignored (forward-compat — pre-allowlist
 * tokens with bogus scopes don't crash hasScope; they just don't satisfy).
 */
export function hasScope(grantedScopes: readonly string[], requiredScope: string): boolean {
  for (const granted of grantedScopes) {
    if (!isScope(granted)) continue;
    const implied = IMPLIES[granted];
    if (implied.has(requiredScope as Scope)) return true;
  }
  return false;
}

export function isScope(s: string): s is Scope {
  return ALLOWED_SCOPES.has(s as Scope);
}

/**
 * TECH-2742 — the scope a transport must require to invoke an op. Normally the op's
 * declared `scope` (default 'read'). A `readScopeCallable` op accepts `read` even though
 * its `scope` is 'write': a source-scoped, own-row-only feedback write (record_retrieval_use)
 * exposes no shared-knowledge write surface, so read-scoped clients may call it. Keeping
 * the carve-out here means the two HTTP scope gates (http-transport.ts + serve-http.ts)
 * cannot drift. Structural param (not the Operation type) to avoid an import cycle.
 */
export function resolveRequiredScope(op: { scope?: string; readScopeCallable?: boolean }): string {
  const declared = op.scope || 'read';
  // readScopeCallable relaxes ONLY a 'write' op to 'read' — the source-scoped, own-row
  // feedback-write carve-out (record_retrieval_use). It MUST NOT downgrade admin-class
  // scopes (admin / sources_admin / users_admin): a flag misapplied to a dangerous op
  // must never silently grant read tokens access to it. Structural defense-in-depth,
  // paired with the all-ops guard in operations-trust-boundary.test.ts.
  if (op.readScopeCallable && declared === 'write') return 'read';
  return declared;
}

/**
 * Validate that every scope in the input is allowed. Throws on the first
 * unknown scope. Used at OAuth client registration time; public DCR then
 * applies the stricter `assertDcrAllowedScopes` policy below.
 */
export class InvalidScopeError extends Error {
  constructor(public readonly invalidScope: string, public readonly allScopes: readonly string[]) {
    super(
      `Unknown scope "${invalidScope}". Allowed: ${ALLOWED_SCOPES_LIST.join(', ')}.`,
    );
    this.name = 'InvalidScopeError';
  }
}

export class DcrScopeNotAllowedError extends Error {
  constructor(public readonly deniedScope: string) {
    super(
      `Scope "${deniedScope}" is not available through public client registration. ` +
      `Allowed: ${[...DCR_ALLOWED_SCOPES].join(', ')}.`,
    );
    this.name = 'DcrScopeNotAllowedError';
  }
}

export function assertAllowedScopes(scopes: readonly string[]): void {
  for (const s of scopes) {
    if (!isScope(s)) throw new InvalidScopeError(s, scopes);
  }
}

/** Reject an otherwise-valid scope that a public DCR caller must not self-issue. */
export function assertDcrAllowedScopes(scopes: readonly string[]): void {
  assertAllowedScopes(scopes);
  for (const scope of scopes) {
    if (!DCR_ALLOWED_SCOPES.has(scope as Scope)) {
      throw new DcrScopeNotAllowedError(scope);
    }
  }
}

/**
 * Parse a space-separated scope string (OAuth wire format) into an array,
 * dropping empty fragments. Does NOT validate against ALLOWED_SCOPES — call
 * assertAllowedScopes afterward at registration time.
 */
export function parseScopeString(s: string | undefined | null): string[] {
  if (!s) return [];
  return s.split(' ').filter(Boolean);
}

/**
 * v0.39.3.0 WARN-9 + CV12 — normalize the `scopes` (or `scope`) field that
 * arrives from the admin SPA's register-client request body to the
 * space-separated wire format `registerClientManual` expects. Three valid
 * input shapes; everything else throws Error to be caught and surfaced
 * as 400 invalid_scopes.
 *
 * Valid shapes:
 *   - `undefined` / `null` / missing  →  defaults to 'read'
 *   - `string`                         →  split on /\s+/, filter empty,
 *                                         dedupe, validate each, re-join
 *   - `string[]`                       →  validate each element is a non-
 *                                         empty single scope (no internal
 *                                         whitespace — that's the bug
 *                                         shape codex flagged where
 *                                         ['read write'] silently lets
 *                                         `read write` through as a single
 *                                         unknown scope), dedupe, validate
 *                                         each against ALLOWED_SCOPES
 *
 * Rejection cases:
 *   - non-string non-array (number, object, boolean) → Error
 *   - empty array after normalization → Error
 *   - array element with internal whitespace → Error (the ['read write'] bug)
 *   - array element that's not a string (null, number, ...) → Error
 *   - any element not in ALLOWED_SCOPES → InvalidScopeError
 *
 * Returns the space-separated string (e.g. 'read write') in sorted order
 * for determinism so two registrations with the same scope set produce
 * identical DB rows.
 */
export function normalizeScopesInput(raw: unknown): string {
  if (raw == null) return 'read';

  let candidates: string[];

  if (typeof raw === 'string') {
    candidates = raw.split(/\s+/).filter(Boolean);
  } else if (Array.isArray(raw)) {
    for (const el of raw) {
      if (typeof el !== 'string') {
        throw new Error(
          `scopes array must contain only strings, got ${el === null ? 'null' : typeof el}`,
        );
      }
      if (el.length === 0) {
        throw new Error('scopes array must not contain empty strings');
      }
      if (/\s/.test(el)) {
        throw new Error(
          `scopes array element "${el}" contains whitespace. Each element must be a single scope name; use ['read', 'write'] not ['read write'].`,
        );
      }
    }
    candidates = raw as string[];
  } else {
    throw new Error(
      `scopes must be a string or array of strings, got ${typeof raw}`,
    );
  }

  // Dedupe via Set + sort for stable output.
  const deduped = Array.from(new Set(candidates)).sort();

  if (deduped.length === 0) {
    throw new Error('scopes is empty after normalization');
  }

  // Validate against ALLOWED_SCOPES (throws InvalidScopeError on miss).
  assertAllowedScopes(deduped);

  return deduped.join(' ');
}
