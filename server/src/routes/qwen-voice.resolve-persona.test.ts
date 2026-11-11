/* resolveVariantPersona: a base-json read that fails once is retried, and the
   persona that comes back is the trimmed `instruct`. */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const readJson = vi.hoisted(() => vi.fn());
vi.mock('../workspace/state-io.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../workspace/state-io.js')>()),
  readJson,
}));

import { resolveVariantPersona } from './qwen-voice.js';

beforeEach(() => readJson.mockReset());

describe('resolveVariantPersona', () => {
  const row = { id: 'quill', name: 'Quill', voiceStyle: '', overrideTtsVoices: { qwen: { name: 'qwen-v_quill' } } } as never;

  it('retries a failed read once and returns the trimmed instruct', async () => {
    readJson.mockRejectedValueOnce(new Error('EBUSY')).mockResolvedValueOnce({ instruct: '  a dry archivist ' });
    await expect(resolveVariantPersona(row, 'quill', '', 'angry')).resolves.toBe('a dry archivist');
    expect(readJson).toHaveBeenCalledTimes(2);
  });

  it('answers a retryable error once the retries are spent', async () => {
    readJson.mockImplementation(async (path: string) => {
      if (String(path).includes('qwen-v_quill')) throw new Error('EBUSY');
      return null;
    });
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    let caught: unknown;
    try {
      await resolveVariantPersona(row, 'quill', '', 'angry');
    } catch (e) {
      caught = e;
    }
    spy.mockRestore();
    expect((caught as Error).message).toMatch(/try again/);
    expect(readJson.mock.calls.filter(([p]) => String(p).includes('qwen-v_quill'))).toHaveLength(4);
  });
});
