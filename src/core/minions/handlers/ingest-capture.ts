/**
 * `ingest_capture` Minion job handler. Receives an IngestionEvent payload
 * from the daemon's dispatcher (or the webhook source's POST /ingest
 * handler) and routes it through `importFromContent` to land as a brain
 * page.
 *
 * Trust posture (E1 + eng-review decisions):
 *   - Every job carries a server-signed source authorization. The handler
 *     re-validates that record after queue pickup and rejects unsigned,
 *     forged, old, or contradictory rows as unrecoverable. Both OAuth and
 *     trusted daemon producers cross this same fail-closed boundary.
 *   - The event's `untrusted_payload` flag is preserved on the job's result
 *     for audit, but does NOT change the importFromContent call itself —
 *     auto-link runs at the put_page operation layer, which we deliberately
 *     bypass here. Content is still treated as user-authored markdown.
 *   - Auto-link integration with the untrusted_payload tag is a v2
 *     improvement (would require routing through the put_page op AND
 *     extending OperationContext with the trust tag). See TODOs in the
 *     plan.
 *
 * Slug resolution (in order):
 *   1. `job.data.slug` if caller provided one
 *   2. `job.data.metadata.slug` if event metadata carried one
 *   3. Generated default: `inbox/YYYY-MM-DD-<hash6>` using the event's
 *      content_hash prefix. Stable for the same content.
 *
 * The default slug deliberately lives under `inbox/` — that's the
 * triage convention the user will discover when reviewing recent
 * captures. A downstream skill (post-capture-triage) can promote inbox
 * pages to canonical homes later.
 */

import { createHmac } from 'node:crypto';
import type { MinionJobContext } from '../types.ts';
import { UnrecoverableError } from '../types.ts';
import type { BrainEngine } from '../../engine.ts';
import type { IngestionEvent } from '../../ingestion/types.ts';
import { computeContentHash, validateIngestionEvent } from '../../ingestion/types.ts';
import { importFromContent } from '../../import-file.ts';
import { validatePageSlug } from '../../operations.ts';
import { safeHexEqual } from '../../timing-safe.ts';

export const INGEST_QUEUE_AUTH_SECRET_ENV = 'GBRAIN_INGEST_QUEUE_HMAC_SECRET';

export type UnsignedIngestCaptureSourceAuthorization =
  | {
      version: 2;
      transport: 'oauth';
      client_id: string;
      source_id: string;
    }
  | {
      version: 2;
      transport: 'daemon';
      producer_id: string;
      source_id: string;
    };

export type IngestCaptureSourceAuthorization =
  UnsignedIngestCaptureSourceAuthorization & { signature: string };

interface SourceAuthorizationInput {
  event: IngestionEvent;
  slug?: unknown;
  noEmbed?: unknown;
}

function authorizationActor(auth: UnsignedIngestCaptureSourceAuthorization): string {
  return auth.transport === 'oauth' ? auth.client_id : auth.producer_id;
}

function effectiveSlugHint(input: SourceAuthorizationInput): string | null {
  if (typeof input.slug === 'string' && input.slug.length > 0) return input.slug.toLowerCase();
  const metadataSlug = input.event.metadata?.slug;
  return typeof metadataSlug === 'string' && metadataSlug.length > 0
    ? metadataSlug.toLowerCase()
    : null;
}

function sourceAuthorizationPayload(
  auth: UnsignedIngestCaptureSourceAuthorization,
  input: SourceAuthorizationInput,
): string {
  return JSON.stringify([
    'gbrain:ingest-capture-source-authorization',
    auth.version,
    auth.transport,
    authorizationActor(auth),
    auth.source_id,
    input.event.source_id,
    input.event.source_kind,
    input.event.source_uri,
    input.event.received_at,
    input.event.content_type,
    input.event.content_hash,
    input.event.untrusted_payload === true,
    effectiveSlugHint(input),
    typeof input.noEmbed === 'boolean' ? input.noEmbed : null,
  ]);
}

/**
 * Sign the durable source authorization carried by every page-writing
 * ingest_capture job. The signature makes the trust marker impossible to
 * forge through the pre-fix remote submit_job surface.
 */
export function signIngestCaptureSourceAuthorization(
  secret: string,
  auth: UnsignedIngestCaptureSourceAuthorization,
  input: SourceAuthorizationInput,
): IngestCaptureSourceAuthorization {
  if (secret.length < 32) {
    throw new Error(`${INGEST_QUEUE_AUTH_SECRET_ENV} must be at least 32 characters`);
  }
  const signature = createHmac('sha256', secret)
    .update(sourceAuthorizationPayload(auth, input), 'utf8')
    .digest('hex');
  return { ...auth, signature } as IngestCaptureSourceAuthorization;
}

export interface IngestCaptureResult {
  slug: string;
  source_id: string;
  status: 'imported' | 'skipped' | 'error';
  chunks: number;
  untrusted_payload: boolean;
  source_kind: string;
  source_uri: string;
}

/** Builds the default slug for an event when the caller didn't provide one. */
export function defaultSlugForEvent(event: IngestionEvent, now: Date = new Date()): string {
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, '0');
  const d = String(now.getUTCDate()).padStart(2, '0');
  const hashPrefix = event.content_hash.slice(0, 6);
  return `inbox/${y}-${m}-${d}-${hashPrefix}`;
}

export function makeIngestCaptureHandler(
  engine: BrainEngine,
  options: { authorizationSecret?: string } = {},
) {
  return async function ingestCaptureHandler(job: MinionJobContext): Promise<IngestCaptureResult> {
    const data = job.data as {
      event?: unknown;
      slug?: unknown;
      noEmbed?: unknown;
      source_authorization?: unknown;
    };
    const event = data.event as IngestionEvent | undefined;
    if (!event) {
      throw new UnrecoverableError('ingest_capture: job.data.event is required');
    }
    const validationErr = validateIngestionEvent(event);
    if (validationErr) {
      throw new UnrecoverableError(`ingest_capture: invalid event payload: ${validationErr.message}`);
    }

    // Every page-writing queue row must carry a server-signed authorization.
    // Event fields are caller-controlled on the public webhook route and were
    // also caller-controlled through the pre-fix submit_job surface, so none
    // of them can be used to infer whether a row is trusted.
    const secret = options.authorizationSecret ?? process.env[INGEST_QUEUE_AUTH_SECRET_ENV];
    if (!secret || secret.length < 32) {
      throw new Error(`ingest_capture: ${INGEST_QUEUE_AUTH_SECRET_ENV} is not configured`);
    }
    const authorization = data.source_authorization;
    if (authorization === null || typeof authorization !== 'object' || Array.isArray(authorization)) {
      throw new UnrecoverableError(
        'ingest_capture: missing signed source authorization',
      );
    }
    const rawAuth = authorization as Record<string, unknown>;
    const validShape =
      rawAuth.version === 2 &&
      (rawAuth.transport === 'oauth' || rawAuth.transport === 'daemon') &&
      typeof rawAuth.source_id === 'string' &&
      rawAuth.source_id.length > 0 &&
      typeof rawAuth.signature === 'string' &&
      /^[0-9a-f]{64}$/.test(rawAuth.signature) &&
      (rawAuth.transport === 'oauth'
        ? typeof rawAuth.client_id === 'string' && rawAuth.client_id.length > 0
        : typeof rawAuth.producer_id === 'string' && rawAuth.producer_id.length > 0);
    if (!validShape) {
      throw new UnrecoverableError('ingest_capture: invalid signed source authorization');
    }
    const auth = rawAuth as unknown as IngestCaptureSourceAuthorization;
    const unsignedAuth = auth.transport === 'oauth'
      ? {
          version: 2 as const,
          transport: 'oauth' as const,
          client_id: auth.client_id,
          source_id: auth.source_id,
        }
      : {
          version: 2 as const,
          transport: 'daemon' as const,
          producer_id: auth.producer_id,
          source_id: auth.source_id,
        };
    const expected = signIngestCaptureSourceAuthorization(secret, unsignedAuth, {
      event,
      slug: data.slug,
      noEmbed: data.noEmbed,
    });
    if (!safeHexEqual(auth.signature, expected.signature)) {
      throw new UnrecoverableError('ingest_capture: invalid source authorization signature');
    }
    if (auth.source_id !== event.source_id) {
      throw new UnrecoverableError(
        `ingest_capture: authorized source '${auth.source_id}' does not match event source '${event.source_id}'`,
      );
    }
    if (computeContentHash(event.content) !== event.content_hash.toLowerCase()) {
      throw new UnrecoverableError('ingest_capture: content hash does not match signed event content');
    }
    if (auth.transport === 'oauth') {
      const metadataClientId = typeof event.metadata?.client_id === 'string'
        ? event.metadata.client_id
        : undefined;
      if (
        event.source_kind !== 'webhook' ||
        event.untrusted_payload !== true ||
        metadataClientId !== auth.client_id
      ) {
        throw new UnrecoverableError('ingest_capture: OAuth source authorization contradicts event provenance');
      }
    } else if (auth.producer_id !== event.source_kind) {
      throw new UnrecoverableError('ingest_capture: daemon source authorization contradicts event producer');
    }
    const sourceId = auth.source_id;

    // Use the exact same normalized destination that the HMAC covers. Keeping
    // signing and processing on one canonicalizer prevents empty/fallback
    // values from validating one destination and writing another.
    const slug = effectiveSlugHint({ event, slug: data.slug }) ?? defaultSlugForEvent(event);
    try {
      validatePageSlug(slug);
    } catch {
      throw new UnrecoverableError('ingest_capture: invalid destination slug');
    }

    // Untrusted-payload posture. For v1, the flag is propagated for audit
    // but not enforced at this layer (see file header). Future v2 wiring
    // through put_page will use this flag.
    const untrustedPayload = event.untrusted_payload === true;

    // For text-typed events, content is the inline markdown/text. For
    // binary types (image/audio/video/pdf), content is a path-or-URI that
    // the content-type processor pipeline transforms. The v1 wave lands
    // the text path; processors arrive in subsequent commits.
    const isText =
      event.content_type === 'text/markdown' ||
      event.content_type === 'text/plain' ||
      event.content_type === 'text/html' ||
      event.content_type === 'application/json' ||
      event.content_type === 'unknown';

    if (!isText) {
      // Binary content without a processor would land as a path-string
      // page, which isn't useful. Surface as job-level error so the
      // operator sees the gap in `gbrain doctor` and can decide whether
      // to install the appropriate skillpack-distributed processor.
      throw new Error(
        `ingest_capture: content_type '${event.content_type}' requires a content-type ` +
          `processor that is not yet installed. Install a processor skillpack ` +
          `(e.g. gbrain-audio-transcribe, gbrain-image-ocr) or pre-extract the ` +
          `content to text/markdown before emitting.`,
      );
    }

    // noEmbed defaults to true. Mirrors the sync handler's pattern:
    // embed runs as a separate Minion job (autopilot's embed phase OR an
    // explicit `gbrain embed --stale`). Callers can opt in to inline embed
    // by passing { noEmbed: false } in job.data.
    const noEmbed = data.noEmbed !== false;

    const result = await importFromContent(engine, slug, event.content, { noEmbed, sourceId });

    return {
      slug,
      source_id: sourceId,
      status: result.status,
      chunks: result.chunks,
      untrusted_payload: untrustedPayload,
      source_kind: event.source_kind,
      source_uri: event.source_uri,
    };
  };
}
