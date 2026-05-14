/* Browser-flavoured pin of the same console-prefix contract as
   server/src/logger.test.ts. Lives under jsdom (the project default) so
   `console` is the same global the patched module touches at runtime. */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { formatTimestamp, installTimestamps } from './logger';

const TS_REGEX = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3}$/;
const METHODS = ['log', 'info', 'warn', 'error', 'debug'] as const;

type Captured = unknown[][];

describe('formatTimestamp', () => {
  it('matches YYYY-MM-DD HH:mm:ss.SSS shape', () => {
    expect(formatTimestamp(new Date('2026-05-15T14:23:45.123Z'))).toMatch(TS_REGEX);
  });

  it('zero-pads single-digit fields', () => {
    const d = new Date(2026, 0, 2, 3, 4, 5, 6);
    expect(formatTimestamp(d)).toBe('2026-01-02 03:04:05.006');
  });
});

describe('installTimestamps', () => {
  const originals: Record<(typeof METHODS)[number], typeof console.log> = {} as never;
  let captured: Record<(typeof METHODS)[number], Captured>;

  beforeEach(() => {
    captured = {} as Record<(typeof METHODS)[number], Captured>;
    for (const method of METHODS) {
      originals[method] = console[method];
      captured[method] = [];
      console[method] = ((...args: unknown[]) => {
        captured[method].push(args);
      }) as typeof console.log;
    }
    delete (console as unknown as Record<string, unknown>).__timestampPatched;
  });

  afterEach(() => {
    for (const method of METHODS) {
      console[method] = originals[method];
    }
    delete (console as unknown as Record<string, unknown>).__timestampPatched;
    vi.useRealTimers();
  });

  it('prepends a timestamp arg to each method', () => {
    installTimestamps();
    for (const method of METHODS) {
      console[method](`[frontend] ${method}`);
      expect(captured[method]).toHaveLength(1);
      expect(captured[method][0]).toHaveLength(2);
      expect(captured[method][0][0]).toMatch(TS_REGEX);
      expect(captured[method][0][1]).toBe(`[frontend] ${method}`);
    }
  });

  it('preserves non-string args as separate arguments', () => {
    installTimestamps();
    const err = new Error('boom');
    const obj = { a: 1, nested: { b: 2 } };
    console.log(obj, err);
    expect(captured.log[0]).toHaveLength(3);
    expect(captured.log[0][0]).toMatch(TS_REGEX);
    expect(captured.log[0][1]).toBe(obj);
    expect(captured.log[0][2]).toBe(err);
  });

  it('is idempotent', () => {
    installTimestamps();
    installTimestamps();
    console.log('once');
    expect(captured.log).toHaveLength(1);
    expect(captured.log[0]).toHaveLength(2);
    expect(captured.log[0][1]).toBe('once');
  });

  it('uses the current time on each call', () => {
    installTimestamps();
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 4, 15, 10, 0, 0, 0));
    console.log('first');
    vi.setSystemTime(new Date(2026, 4, 15, 11, 30, 0, 500));
    console.log('second');
    expect(captured.log[0][0]).toBe('2026-05-15 10:00:00.000');
    expect(captured.log[1][0]).toBe('2026-05-15 11:30:00.500');
  });
});
