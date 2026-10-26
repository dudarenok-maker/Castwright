import { describe, it, expect } from 'vitest';
import { DEFAULT_USER_SETTINGS, type UserSettings } from '../workspace/user-settings.js';
import {
  assertConfiguredCapabilitiesAllowed,
  capabilityRecordFor,
  capabilityRecordKey,
  verdictTestedAtFor,
  type ModelCapabilityRecord,
} from './capabilities.js';

const rec = (over: Partial<ModelCapabilityRecord> = {}): ModelCapabilityRecord => ({
  serverUrl: 'http://127.0.0.1:11434', testedAt: '2026-09-11T10:00:00.000Z', control: { ok: true },
  structuredOutput: {}, reasoning: {}, ...over,
});

describe('one Ollama model id for Test records (N7)', () => {
  it('a record saved under either tag form answers for the other; an endpoint id is looked up exactly', () => {
    const s = { ...DEFAULT_USER_SETTINGS, analyzerCapabilitiesByModel: { 'qwen3:latest': rec(), 'openai:lab::m': rec() } } as UserSettings;
    expect(capabilityRecordFor(s, 'qwen3', 'http://127.0.0.1:11434')).toEqual(rec());
    expect(capabilityRecordFor(s, 'qwen3:latest', 'http://127.0.0.1:11434')).toEqual(rec());
    expect(capabilityRecordFor(s, 'openai:lab::m:latest', 'http://127.0.0.1:11434')).toBeUndefined();
    expect(capabilityRecordKey('qwen3:latest')).toBe('qwen3');
    expect(capabilityRecordKey('qwen3.5:4b')).toBe('qwen3.5:4b');
    expect(capabilityRecordKey('openai:lab::qwen3:latest')).toBe('openai:lab::qwen3:latest');
  });
});

describe("a refusal cites the verdict's own Test date (A2)", () => {
  it('reads verdictTestedAt for the rejected verdict, and the record date when it has none', () => {
    const dated = rec({
      testedAt: '2026-09-12T09:00:00.000Z',
      reasoning: { on: 'rejected' },
      verdictTestedAt: { reasoning: { on: '2026-09-10T08:00:00.000Z' } },
    });
    expect(verdictTestedAtFor(dated, { setting: 'reasoning', reasoning: 'on' })).toBe('2026-09-10T08:00:00.000Z');
    let thrown: unknown;
    try {
      assertConfiguredCapabilitiesAllowed(dated, { structuredOutput: 'off', reasoning: 'on' }, 'q:4b');
    } catch (e) {
      thrown = e;
    }
    expect((thrown as { testedAt: string }).testedAt).toBe('2026-09-10T08:00:00.000Z');
    /* A record written before per-verdict dates existed: its own testedAt stands in. */
    expect(verdictTestedAtFor(rec({ testedAt: '2026-09-12T09:00:00.000Z', reasoning: { on: 'rejected' } }), { setting: 'reasoning', reasoning: 'on' })).toBe(
      '2026-09-12T09:00:00.000Z',
    );
  });
});
