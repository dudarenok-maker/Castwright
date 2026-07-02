import { describe, it, expect, vi, afterEach } from 'vitest';

/* node:fs's `readFileSync` export isn't configurable under Vitest's ESM
   module namespace, so `vi.spyOn(fs, 'readFileSync')` throws ("Cannot
   redefine property"). Mirror the established convention elsewhere in this
   codebase (server/src/workspace/state-io.test.ts) instead: mock the whole
   module via a factory that delegates to a per-test-overridable closure. */
let readFileSyncImpl: (() => string) | null = null;

vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  return {
    ...actual,
    readFileSync: (...args: Parameters<typeof actual.readFileSync>) =>
      readFileSyncImpl ? readFileSyncImpl() : actual.readFileSync(...args),
  };
});

const { readRestartBreadcrumb } = await import('./restart-breadcrumb.js');

describe('readRestartBreadcrumb', () => {
  afterEach(() => {
    readFileSyncImpl = null;
  });

  it('parses a valid breadcrumb file', () => {
    readFileSyncImpl = () =>
      JSON.stringify({ card: { uuid: 'GPU-1', idx: 1 }, reason: 'reserved VRAM', residentEngines: ['coqui'], ts: 123 });
    expect(readRestartBreadcrumb()).toEqual({
      card: { uuid: 'GPU-1', idx: 1 }, reason: 'reserved VRAM', residentEngines: ['coqui'],
    });
  });

  it('returns null when the file is missing', () => {
    readFileSyncImpl = () => {
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    };
    expect(readRestartBreadcrumb()).toBeNull();
  });

  it('returns null on malformed JSON', () => {
    readFileSyncImpl = () => 'not json';
    expect(readRestartBreadcrumb()).toBeNull();
  });
});
