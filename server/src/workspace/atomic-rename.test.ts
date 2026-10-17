/* Atomic-rename retry coverage. The primitive backs every sync-folder
   copy + the plan-79 partial-then-rename on export builds, so its
   retry contract is load-bearing. Tests use vi.mock on node:fs/promises
   to inject controllable failures into the rename call. */

import { describe, it, expect, vi, afterEach } from 'vitest';

let callCount = 0;
const renameMock = vi.fn();
const copyFileMock = vi.fn();

vi.mock('node:fs/promises', () => ({
  rename: (...args: unknown[]) => renameMock(...args),
  copyFile: (...args: unknown[]) => copyFileMock(...args),
}));

const { renameWithRetry, copyFileWithRetry } = await import('./atomic-rename.js');

afterEach(() => {
  renameMock.mockReset();
  copyFileMock.mockReset();
  callCount = 0;
});

function makeErr(code: string): Error {
  const e = new Error(`mock ${code}`);
  (e as { code?: string }).code = code;
  return e;
}

describe('renameWithRetry', () => {
  it('returns immediately on first-try success', async () => {
    renameMock.mockResolvedValueOnce(undefined);
    await renameWithRetry('src', 'dest');
    expect(renameMock).toHaveBeenCalledTimes(1);
  });

  for (const code of ['EPERM', 'EBUSY', 'ENOENT', 'EACCES', 'EIO']) {
    it(`retries past transient ${code} then succeeds`, async () => {
      callCount = 0;
      renameMock.mockImplementation(async () => {
        callCount += 1;
        if (callCount < 3) throw makeErr(code);
        return undefined;
      });
      await renameWithRetry('src', 'dest');
      expect(callCount).toBe(3);
    });
  }

  it('throws immediately on a non-retryable code (EROFS)', async () => {
    renameMock.mockRejectedValueOnce(makeErr('EROFS'));
    await expect(renameWithRetry('src', 'dest')).rejects.toThrow(/EROFS/);
    expect(renameMock).toHaveBeenCalledTimes(1);
  });

  it('throws the last error after exhausting all retry attempts', async () => {
    renameMock.mockImplementation(async () => {
      throw makeErr('EBUSY');
    });
    await expect(renameWithRetry('src', 'dest')).rejects.toThrow(/EBUSY/);
    /* 1 initial + 5 retry delays = 6 attempts total (RENAME_RETRY_DELAYS_MS grew to 5 in #921). */
    expect(renameMock).toHaveBeenCalledTimes(6);
  });

  it('throws when the error has no `code` field (defensive — never retry an unknown shape)', async () => {
    renameMock.mockRejectedValueOnce(new Error('weird'));
    await expect(renameWithRetry('src', 'dest')).rejects.toThrow(/weird/);
    expect(renameMock).toHaveBeenCalledTimes(1);
  });
});

describe('copyFileWithRetry', () => {
  it('retries past transient EPERM then succeeds', async () => {
    callCount = 0;
    copyFileMock.mockImplementation(async () => {
      callCount += 1;
      if (callCount < 3) throw makeErr('EPERM');
      return undefined;
    });
    await copyFileWithRetry('src', 'dest');
    expect(callCount).toBe(3);
  });

  it('throws immediately on a non-retryable code (EROFS)', async () => {
    copyFileMock.mockRejectedValueOnce(makeErr('EROFS'));
    await expect(copyFileWithRetry('src', 'dest')).rejects.toThrow(/EROFS/);
    expect(copyFileMock).toHaveBeenCalledTimes(1);
  });
});
