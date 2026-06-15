/**
 * redact.ts — redact-before-write for connector candidates (TECH-2032).
 *
 * gbrain stores any written `pages`/`content_chunks` row verbatim and serves it
 * as truth, so the connector is the single redaction point: connector output is
 * minimized and PII/secret-stripped BEFORE it ever becomes a candidate (and long
 * before any human promotes it to a page).
 *
 * Two pure functions, zero new deps:
 *
 *   minimize(item, profile) — field-minimization. Keeps a per-source-class
 *     allowlist of structural metadata + the short summary; DROPS the body
 *     (and every non-allowlisted metadata field). An UNKNOWN profile yields
 *     maximal minimization (fail-closed): identity only. Kept string fields are
 *     run through strip(). Returns the minimized item plus a redaction trail.
 *
 *   strip(text) — deterministic PII + secret masking. Mirrors the six PII
 *     families in src/core/eval-capture-scrub.ts (reused via scrubPii) and adds
 *     common secret shapes (cloud keys, VCS/chat tokens, private-key blocks).
 *
 * Both are idempotent: [REDACTED] matches no PII/secret pattern, dropped fields
 * stay dropped, and a re-run of either yields byte-identical content.
 *
 * WIRING CONTRACT (hard dependency for the connector framework, TECH-2034): this is
 * a primitive — it is NOT yet called by candidate.ts::toRow. The framework MUST run
 * strip()/minimize() over EVERY field that flows into a candidate, including
 * `proposed_markdown` (which can become the served page body) and every metadata
 * value, BEFORE toRow. A wiring that strips summary/metadata but forgets
 * proposed_markdown bypasses this module entirely.
 *
 * Out of scope (later): NER-model enrichment, plus the regex-uncoverable shapes
 * documented on strip().
 */

import { scrubPii } from '../eval-capture-scrub.ts';

const REDACTED = '[REDACTED]';

// ── strip: PII (via scrubPii) + secret shapes ───────────────────────────────────

/**
 * URL userinfo (`scheme://user:pass@host`). Masks the credential regardless of host
 * shape (IP, bare hostname, or TLD) — runs BEFORE scrubPii so the email regex can't
 * partially eat a `pass@host.tld` substring and leave a malformed remainder.
 */
const URL_USERINFO_RE = /\b([a-zA-Z][a-zA-Z0-9+.-]*:\/\/)[^\s:@/]+:[^\s@/]+@/g;

/**
 * Non-Bearer `Authorization:` schemes (Basic/Token/ApiKey/Digest/...). Bearer is
 * already covered by scrubPii. Keeps the header + scheme literal, masks the credential.
 */
const AUTH_SCHEME_RE = /\b([Aa]uthorization:\s*[A-Za-z][A-Za-z-]*\s+)[A-Za-z0-9._~+/=-]{6,}=*/g;

/**
 * A secret value assigned to a secret-named key — AWS secret access key, Azure
 * `AccountKey`, generic `api_key` / `client_secret` / `password` / `token`. These
 * are the prefix-less high-entropy shapes only key-context can identify. Keeps the
 * key name, masks the value.
 */
const SECRET_ASSIGNMENT_RE =
  /\b([A-Za-z0-9_]*(?:secret|token|password|passwd|api[_-]?key|access[_-]?key|client[_-]?secret|account[_-]?key)['"]?\s*[=:]\s*['"]?)([A-Za-z0-9/+_=.-]{12,})/gi;

/**
 * Prefix-anchored secret tokens layered on top of scrubPii's six PII families. Each
 * is anchored on a distinctive prefix so [REDACTED] can never re-match (idempotency).
 * The PEM block's inner gap is BOUNDED ({0,8192}?) so a stream of unterminated BEGIN
 * markers cannot drive quadratic backtracking (a measured DoS); a real PEM private
 * key is well under 8KB.
 */
const SECRET_PATTERNS: readonly RegExp[] = [
  /-----BEGIN[A-Z0-9 ]*PRIVATE KEY-----[\s\S]{0,8192}?-----END[A-Z0-9 ]*PRIVATE KEY-----/g,
  /\bAKIA[0-9A-Z]{16}\b/g, // AWS access key id
  /\bgh[posru]_[A-Za-z0-9]{36,255}\b/g, // GitHub classic/OAuth/app/server/user tokens
  /\bgithub_pat_[A-Za-z0-9_]{59,255}\b/g, // GitHub fine-grained PAT
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, // Slack
  /\bAIza[0-9A-Za-z_-]{35}\b/g, // Google API key
  /\bGOCSPX-[A-Za-z0-9_-]{20,}\b/g, // Google OAuth client secret
  /\bsk-[A-Za-z0-9]{32,}\b/g, // OpenAI-style (>=32 cuts false positives on short sk- slugs)
  /\b[sprSPR]k_(?:live|test)_[A-Za-z0-9]{16,}\b/g, // Stripe-style
];

/**
 * Mask obvious PII and secrets in free text. Pure, idempotent, linear-time, safe on
 * any input. Order: URL userinfo → scrubPii (PII families) → Authorization schemes →
 * secret-named assignments → prefix-anchored tokens.
 *
 * v1 deliberately does NOT cover shapes regex cannot identify without context/NER
 * (the ticket scopes these out): IPv4/IPv6 addresses, IBANs, postal addresses, full
 * personal names, and prefix-less high-entropy keys outside a secret-named field.
 * That boundary is pinned in test/connector-redact.test.ts § "v1 coverage boundary".
 */
export function strip(text: string): string {
  if (!text) return text;
  let out = text.replace(URL_USERINFO_RE, `$1${REDACTED}@`);
  out = scrubPii(out);
  out = out.replace(AUTH_SCHEME_RE, (_m, prefix) => `${prefix}${REDACTED}`);
  out = out.replace(SECRET_ASSIGNMENT_RE, (_m, key) => `${key}${REDACTED}`);
  for (const re of SECRET_PATTERNS) {
    out = out.replace(re, REDACTED);
  }
  return out;
}

// ── minimize: field-minimization with fail-closed profiles ──────────────────────

/** A single connector record before it becomes a candidate. */
export interface RawConnectorItem {
  /** Stable upstream record id (kept; never PII). */
  sourceRecordId: string;
  /** Structural metadata; only the profile's allowlist survives, stripped. */
  metadata?: Record<string, unknown>;
  /** Short human summary; kept (stripped) when the profile allows, else dropped. */
  summary?: string;
  /** Full content; ALWAYS dropped — bodies are never carried into a candidate. */
  body?: string;
}

/** One redaction-trail entry recording what minimize did to a field. */
export interface RedactionTag {
  field: string;
  action: 'dropped' | 'masked';
}

/** Output of minimize. Structurally a RawConnectorItem with no body, so it can be
 *  fed back through minimize idempotently. */
export interface MinimizedItem {
  sourceRecordId: string;
  metadata: Record<string, unknown>;
  summary?: string;
  redactions: RedactionTag[];
}

interface RedactionProfile {
  /** Metadata keys kept (then stripped). Everything else is dropped. */
  keepMetadata: readonly string[];
  /** Whether the summary survives (always stripped when kept). */
  keepSummary: boolean;
}

/** Fail-closed default for an unknown source class: keep nothing but identity. */
const MAXIMAL_MINIMIZATION: RedactionProfile = { keepMetadata: [], keepSummary: false };

/**
 * Per-source-class allowlists. Bodies are dropped for EVERY class (handled in
 * minimize, not here) — these only choose which structural metadata + the
 * summary survive. Keys are matched exactly; absent keys are simply not kept.
 */
const PROFILES: Readonly<Record<string, RedactionProfile>> = {
  comms: {
    keepMetadata: ['channel', 'channel_id', 'author', 'author_id', 'thread_id', 'permalink', 'url', 'timestamp', 'ts'],
    keepSummary: true,
  },
  crm: {
    keepMetadata: ['record_type', 'record_id', 'object', 'stage', 'status', 'owner', 'owner_id', 'url', 'updated_at', 'created_at'],
    keepSummary: true,
  },
  calendar: {
    keepMetadata: ['event_id', 'organizer', 'start', 'end', 'status', 'attendee_count', 'url'],
    keepSummary: true,
  },
  docs: {
    keepMetadata: ['title', 'author', 'url', 'doc_id', 'updated_at', 'created_at'],
    keepSummary: true,
  },
  code: {
    keepMetadata: ['repo', 'number', 'author', 'state', 'url', 'labels', 'updated_at', 'created_at'],
    keepSummary: true,
  },
  generic: {
    keepMetadata: ['url', 'id', 'updated_at', 'created_at'],
    keepSummary: true,
  },
};

/** True when `profile` names a known source class. Unknown → fail-closed. */
export function isKnownProfile(profile: string): boolean {
  return Object.prototype.hasOwnProperty.call(PROFILES, profile);
}

/**
 * Field-minimize a connector item under a source-class profile.
 *
 * - Body is ALWAYS dropped.
 * - Only the profile's allowlisted metadata keys survive (each stripped).
 * - Summary survives (stripped) only when the profile keeps it.
 * - An unknown profile falls back to maximal minimization (identity only).
 *
 * NOTE: metadata allowlist keys are matched EXACTLY (case-sensitive, snake_case). A
 * connector emitting `Channel`/`channelId` instead of `channel`/`channel_id` will
 * have those fields dropped — fail-closed (never a leak) but a fidelity trap. The
 * framework (TECH-2034) must reconcile each connector's metadata vocabulary against
 * these profiles, or extend the allowlists, before go-live.
 *
 * Idempotent: feeding the result back in keeps the same metadata/summary
 * (strip is idempotent; there is no body left to drop).
 */
export function minimize(item: RawConnectorItem, profile: string): MinimizedItem {
  const p = PROFILES[profile] ?? MAXIMAL_MINIMIZATION;
  const redactions: RedactionTag[] = [];
  const metadata: Record<string, unknown> = {};

  for (const [key, val] of Object.entries(item.metadata ?? {})) {
    if (p.keepMetadata.includes(key)) {
      if (typeof val === 'string') {
        const stripped = strip(val);
        if (stripped !== val) redactions.push({ field: `metadata.${key}`, action: 'masked' });
        metadata[key] = stripped;
      } else {
        metadata[key] = val;
      }
    } else {
      redactions.push({ field: `metadata.${key}`, action: 'dropped' });
    }
  }

  const out: MinimizedItem = { sourceRecordId: item.sourceRecordId, metadata, redactions };

  if (item.summary !== undefined) {
    if (p.keepSummary) {
      const stripped = strip(item.summary);
      if (stripped !== item.summary) redactions.push({ field: 'summary', action: 'masked' });
      out.summary = stripped;
    } else {
      redactions.push({ field: 'summary', action: 'dropped' });
    }
  }

  // Bodies are never carried forward, under any profile.
  if (item.body !== undefined) {
    redactions.push({ field: 'body', action: 'dropped' });
  }

  return out;
}
