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
 * Out of scope (later): NER-model enrichment.
 */

import { scrubPii } from '../eval-capture-scrub.ts';

const REDACTED = '[REDACTED]';

// ── strip: PII (via scrubPii) + secret shapes ───────────────────────────────────

/**
 * Secret-shape patterns layered on top of scrubPii's six PII families. Each is
 * anchored on a distinctive prefix/structure so [REDACTED] (no prefix, no digit
 * run) can never re-match — preserving idempotency. Linear, backtracking-safe.
 */
const SECRET_PATTERNS: readonly RegExp[] = [
  // PEM private-key blocks (RSA/EC/OPENSSH/PGP). Non-greedy, bounded by END line.
  /-----BEGIN[A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END[A-Z0-9 ]*PRIVATE KEY-----/g,
  // AWS access key id.
  /\bAKIA[0-9A-Z]{16}\b/g,
  // GitHub tokens: ghp_/gho_/ghs_/ghr_/ghu_ + classic, and fine-grained PAT.
  /\bgh[posru]_[A-Za-z0-9]{36,255}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{59,255}\b/g,
  // Slack tokens (bot/user/app/refresh/legacy).
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g,
  // Google API key.
  /\bAIza[0-9A-Za-z_-]{35}\b/g,
  // OpenAI-style secret key.
  /\bsk-[A-Za-z0-9]{20,}\b/g,
  // Stripe-style keyed secrets (sk/pk/rk _ live/test _ ...).
  /\b[sprSPR]k_(?:live|test)_[A-Za-z0-9]{16,}\b/g,
];

/**
 * Mask obvious PII and secrets in free text. Pure, idempotent, safe on any input.
 * scrubPii runs first (email/phone/SSN/JWT/Bearer/Luhn-CC), then the secret shapes.
 */
export function strip(text: string): string {
  if (!text) return text;
  let out = scrubPii(text);
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
