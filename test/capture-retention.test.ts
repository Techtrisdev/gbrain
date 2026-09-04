import { describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import { sweepCaptureRetention } from '../src/core/cycle.ts';

describe('raw capture retention', () => {
  test('ages captures using metadata-only reads', async () => {
    const now = Date.parse('2026-09-03T12:00:00Z');
    const deleted: string[] = [];
    const queries: string[] = [];
    const engine = {
      getConfig: async () => '14',
      executeRaw: async (sql: string, params?: unknown[]) => {
        queries.push(sql);
        const prefix = String(params?.[1] ?? '');
        if (prefix === 'capture/%') {
          return [
            { slug: 'capture/old', created_at: '2026-07-01T00:00:00Z', updated_at: '2026-07-01T00:00:00Z' },
            { slug: 'capture/new', created_at: '2026-09-02T00:00:00Z', updated_at: '2026-09-02T00:00:00Z' },
          ];
        }
        return [
          { slug: 'distill-state/old', created_at: '2026-07-01T00:00:00Z', updated_at: '2026-07-01T00:00:00Z' },
        ];
      },
      listPages: async () => {
        throw new Error('retention must not hydrate full pages');
      },
      softDeletePage: async (slug: string) => {
        deleted.push(slug);
        return { slug };
      },
    } as unknown as BrainEngine;

    const result = await sweepCaptureRetention(engine, now);

    expect(result).toEqual({
      days: 14,
      soft_deleted: 2,
      slugs: ['capture/old', 'distill-state/old'],
    });
    expect(deleted).toEqual(['capture/old', 'distill-state/old']);
    expect(queries).toHaveLength(2);
    for (const sql of queries) {
      expect(sql).toContain('SELECT slug, created_at, updated_at');
      expect(sql).not.toContain('SELECT *');
      expect(sql).toContain('deleted_at IS NULL');
    }
  });
});
