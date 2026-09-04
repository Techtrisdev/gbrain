/**
 * Raw Context Mirror events are durable evidence, not retrieval documents.
 * Keep this identity rule shared by live writes and maintenance commands so
 * routine reindex/extract work cannot make raw transcripts searchable again.
 */
export const RAW_CAPTURE_SOURCE_ID = 'capture-events';
export const RAW_CAPTURE_SLUG_PREFIX = 'capture/';
export const RAW_CAPTURE_SLUG_LIKE = `${RAW_CAPTURE_SLUG_PREFIX}%`;

export function isRawCapturePage(sourceId: string | undefined, slug: string): boolean {
  return sourceId === RAW_CAPTURE_SOURCE_ID && slug.startsWith(RAW_CAPTURE_SLUG_PREFIX);
}
