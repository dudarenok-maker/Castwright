import { describe, it, expect } from 'vitest';
import { mergeCapabilityRecords, sameServer } from './capability-record-merge.js';

interface TestRecord {
  serverUrl: string;
  testedAt: string;
  control: { ok: true };
  structuredOutput: Record<string, Record<string, string>>;
  reasoning: Record<string, string>;
  digest?: string;
  verdictTestedAt?: { reasoning?: Record<string, string>; structuredOutput?: Record<string, Record<string, string>> };
}

const record = (over: Record<string, unknown> = {}): TestRecord => ({
  serverUrl: 'http://127.0.0.1:11434',
  testedAt: '2026-09-11T10:00:00.000Z',
  control: { ok: true },
  structuredOutput: {},
  reasoning: {},
  ...over,
});

describe('mergeCapabilityRecords (N14)', () => {
  it('a configured Test keeps the verdicts an earlier all Test recorded, replacing only what it probed', () => {
    const all = record({
      reasoning: { 'model-default': 'accepted', off: 'accepted', on: 'rejected', low: 'accepted' },
      structuredOutput: { schema: { off: 'enforced', low: 'ignored' }, json: { off: 'accepted' } },
    });
    const configured = record({
      testedAt: '2026-09-12T09:00:00.000Z',
      reasoning: { low: 'rejected' },
      structuredOutput: { schema: { low: 'enforced' } },
    });
    expect(mergeCapabilityRecords(all, configured)).toEqual(
      record({
        testedAt: '2026-09-12T09:00:00.000Z',
        reasoning: { 'model-default': 'accepted', off: 'accepted', on: 'rejected', low: 'rejected' },
        structuredOutput: { schema: { off: 'enforced', low: 'enforced' }, json: { off: 'accepted' } },
        verdictTestedAt: {
          reasoning: {
            'model-default': '2026-09-11T10:00:00.000Z',
            off: '2026-09-11T10:00:00.000Z',
            on: '2026-09-11T10:00:00.000Z',
            low: '2026-09-12T09:00:00.000Z',
          },
          structuredOutput: {
            schema: { off: '2026-09-11T10:00:00.000Z', low: '2026-09-12T09:00:00.000Z' },
            json: { off: '2026-09-11T10:00:00.000Z' },
          },
        },
      }),
    );
  });

  it('testedAt is the latest of the two', () => {
    const newer = record({ testedAt: '2026-09-12T09:00:00.000Z' });
    const older = record({ testedAt: '2026-09-11T08:00:00.000Z' });
    expect(mergeCapabilityRecords(newer, older).testedAt).toBe('2026-09-12T09:00:00.000Z');
  });

  it('a record for another server URL is replaced, not merged; with no earlier record the new one is kept as is', () => {
    const elsewhere = record({ serverUrl: 'http://old-host:11434', reasoning: { on: 'rejected' } });
    const next = record({ reasoning: { off: 'accepted' } });
    expect(mergeCapabilityRecords(elsewhere, next)).toBe(next);
    expect(mergeCapabilityRecords(undefined, next)).toBe(next);
  });

  it('a digest that differs replaces the record; the same digest merges (A2)', () => {
    const built = (digest: string | undefined, over: Record<string, unknown> = {}) => record({ digest, ...over });
    const previous = built('sha256-a', { reasoning: { on: 'rejected' } });
    expect(mergeCapabilityRecords(previous, built('sha256-b', { reasoning: { off: 'accepted' } })).reasoning).toEqual({ off: 'accepted' });
    expect(mergeCapabilityRecords(previous, built('sha256-a', { reasoning: { off: 'accepted' } })).reasoning).toEqual({ on: 'rejected', off: 'accepted' });
    /* A digest on one side only (a record written before A2, or a listing that failed) proves nothing. */
    expect(mergeCapabilityRecords(built(undefined, { reasoning: { on: 'rejected' } }), built('sha256-a', { reasoning: { off: 'accepted' } })).reasoning).toEqual({
      off: 'accepted',
    });
    /* Two records with no digest (endpoints, Gemini) merge on the server URL alone, as before. */
    expect(mergeCapabilityRecords(built(undefined, { reasoning: { on: 'rejected' } }), built(undefined, { reasoning: { off: 'accepted' } })).reasoning).toEqual({
      on: 'rejected',
      off: 'accepted',
    });
  });

  it("every kept verdict keeps its own date; one with none takes its record's testedAt (A2)", () => {
    const previous = record({
      testedAt: '2026-09-10T10:00:00.000Z',
      reasoning: { on: 'rejected', low: 'accepted' },
      structuredOutput: { schema: { off: 'enforced' } },
    });
    const next = record({
      testedAt: '2026-09-12T09:00:00.000Z',
      reasoning: { low: 'rejected' },
      structuredOutput: { schema: { low: 'ignored' } },
      verdictTestedAt: { reasoning: { low: '2026-09-12T09:00:00.000Z' }, structuredOutput: { schema: { low: '2026-09-12T09:00:00.000Z' } } },
    });
    expect(mergeCapabilityRecords(previous, next).verdictTestedAt).toEqual({
      reasoning: { on: '2026-09-10T10:00:00.000Z', low: '2026-09-12T09:00:00.000Z' },
      structuredOutput: { schema: { off: '2026-09-10T10:00:00.000Z', low: '2026-09-12T09:00:00.000Z' } },
    });
  });

  it('sameServer ignores trailing slashes only (moved from capabilities.ts, body unchanged)', () => {
    expect(sameServer('http://127.0.0.1:11434/', 'http://127.0.0.1:11434')).toBe(true);
    expect(sameServer('http://127.0.0.1:11434', 'http://127.0.0.1:11435')).toBe(false);
  });
});
