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

  it('parses a valid breadcrumb file, including the device enumeration', () => {
    const devices = [{ uuid: 'GPU-1', idx: 1, name: 'RTX 5070 Ti', total_mb: 16303, free_mb: 12000 }];
    readFileSyncImpl = () =>
      JSON.stringify({
        card: { uuid: 'GPU-1', idx: 1 },
        reason: 'reserved VRAM',
        residentEngines: ['coqui'],
        devices,
        ts: 123,
      });
    expect(readRestartBreadcrumb()).toEqual({
      card: { uuid: 'GPU-1', idx: 1 }, reason: 'reserved VRAM', residentEngines: ['coqui'], devices,
    });
  });

  it('reads devices as undefined (not []) from an OLDER breadcrumb written before this field existed', () => {
    readFileSyncImpl = () =>
      JSON.stringify({ card: { uuid: 'GPU-1', idx: 1 }, reason: 'reserved VRAM', residentEngines: ['coqui'], ts: 123 });
    expect(readRestartBreadcrumb()).toEqual({
      card: { uuid: 'GPU-1', idx: 1 }, reason: 'reserved VRAM', residentEngines: ['coqui'], devices: undefined,
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
