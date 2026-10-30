import { describe, it, expect, vi } from 'vitest';
import { runModelTest } from './capabilities.js';
import type { ChatTransport, TransportRequest, TransportResult } from './runner/transport.js';

describe('Test probes carry the configured payload (#3084 wave 5, P19)', () => {
  it('every ladder request sends the payload a run would send', async () => {
    const calls: TransportRequest[] = [];
    const transport: ChatTransport = {
      kind: 'ollama',
      model: 'q:4b',
      send: vi.fn(async (req: TransportRequest): Promise<TransportResult> => {
        calls.push(req);
        return { text: '{"ok":true}', reasoningSeen: false, finish: 'stop', receivedBytes: 11 };
      }),
    };
    const payload = { options: { min_p: 0.05 } };
    await runModelTest(
      { modelId: 'q:4b', scope: 'all' },
      {
        transport,
        serverUrl: 'http://127.0.0.1:11434',
        configuredMode: 'json',
        offeredModes: ['json', 'off'],
        adaptSchema: (s) => ({ schema: s, dropped: [] }),
        probeLimits: () => ({ contextTokens: 32768, maxOutputTokens: null }),
        reasoningSelection: () => ({ engine: 'local', model: 'q:4b' }),
        configuredReasoning: () => 'off',
        extraParams: payload,
        now: () => new Date('2026-09-11T10:00:00.000Z'),
      },
    );
    expect(calls.length).toBeGreaterThan(2);
    expect(calls.every((c) => c.extraParams === payload)).toBe(true);
  });
});
