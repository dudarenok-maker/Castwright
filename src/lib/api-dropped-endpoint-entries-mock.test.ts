import { describe, it, expect, vi, afterEach } from 'vitest';

vi.stubEnv('VITE_USE_MOCKS', 'true');
const { api } = await import('./api');

describe('mock settings GET — dropped endpoint entries seed (#3084 P31, e2e)', () => {
  afterEach(() => {
    delete (globalThis as Record<string, unknown>).__SEED_DROPPED_ENDPOINT_ENTRIES__;
  });

  it('lists the seeded entries once, and acknowledging one removes it', async () => {
    (globalThis as Record<string, unknown>).__SEED_DROPPED_ENDPOINT_ENTRIES__ = [
      { archiveId: 'a1', kind: 'endpoint', name: 'Old box', issues: ['analyzerEndpoints.0.baseUrl: invalid_format'], droppedAt: '2026-09-13T10:00:00.000Z' },
    ];
    expect((await api.getUserSettings()).droppedEndpointEntries).toHaveLength(1);
    expect((await api.acknowledgeDroppedEndpointEntries(['a1'])).droppedEndpointEntries).toEqual([]);
    expect((await api.getUserSettings()).droppedEndpointEntries).toEqual([]);
  });
});
