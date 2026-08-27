/* #2260 review round 2 — the swallow-vs-rethrow discrimination.
 *
 * `clearNotLinkedEdgesForDroppedRejections`'s `catch` is one of the
 * best-effort handlers in the cast-identity path (see the report on PR #2284
 * for the current tally — round 2 called it seven, round 4 demoted
 * `reconcileRejectEdgesOnDisk` to a deliberate swallow, and #2295 added the
 * two authoritative `writeChecked` calls, so it is eight and this file's
 * handler is one of them). All of them were scoped for a DISK fault —
 * EPERM/ENOSPC/an AV lock — on the
 * reasoning that "the side-table is never authoritative for identity, so
 * losing an entry degrades to today's behaviour". That reasoning is sound for
 * a disk fault and wrong for a `withKeyLock` acquisition timeout, which
 * ordinary contention can reach: swallowing THAT returns success with
 * `cast.json` already written and the identity record never updated.
 *
 * This file pins BOTH halves, which is the whole point. A handler that
 * rethrows everything is a regression, not a fix, and a test that only checked
 * the rethrow would call that regression coverage. Mutation-proved in the PR
 * report: making the rethrow unconditional reddens the EPERM case, deleting
 * the rethrow reddens the timeout case, and neither test passes under both.
 *
 * `withCastLock` is mocked rather than genuinely contended because the real
 * budget is 10s, which races vitest's 15s testTimeout — the mock throws the
 * REAL `LockAcquisitionTimeoutError`, and that the real mutex throws that
 * class on expiry is pinned separately in `workspace/file-lock.test.ts`.
 * Both errors are delivered by the SAME route (out of `withCastLock`), so the
 * only thing that can tell them apart is the discrimination under test.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const lock = vi.hoisted(() => ({ toThrow: null as unknown }));

vi.mock('../workspace/cast-lock.js', () => ({
  withCastLock: async <T>(_bookDir: string, fn: () => Promise<T>): Promise<T> => {
    if (lock.toThrow) throw lock.toThrow;
    return fn();
  },
}));

const { LockAcquisitionTimeoutError } = await import('../workspace/file-lock.js');
const { clearNotLinkedEdgesForDroppedRejections } = await import('./not-linked-edges.js');

const BOOK_DIR = '/w/hollow-tide';
const BOOK_ID = 'book-hollow-tide';
const DROPPED = [{ from: 'mayrin', to: 'mairin' }];

let warn: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  lock.toThrow = null;
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  warn.mockRestore();
});

describe('clearNotLinkedEdgesForDroppedRejections — lock timeout vs disk fault (#2260)', () => {
  it('RETHROWS a lock-acquisition timeout instead of swallowing it', async () => {
    const timeout = new LockAcquisitionTimeoutError(`cast:${BOOK_DIR}`, 10_000);
    lock.toThrow = timeout;

    await expect(
      clearNotLinkedEdgesForDroppedRejections(BOOK_DIR, BOOK_ID, DROPPED),
    ).rejects.toBe(timeout);

    /* Not merely "some error" — the caller must receive the SAME object, so
       the next handler up can discriminate on it too. And nothing is warned:
       a warning here would mean the handler treated it as best-effort. */
    expect(warn).not.toHaveBeenCalled();
  });

  it('STILL SWALLOWS an EPERM-shaped disk fault, exactly as before', async () => {
    const eperm = Object.assign(
      new Error("EPERM: operation not permitted, rename '/w/hollow-tide/.audiobook/cast.json'"),
      { code: 'EPERM' },
    );
    lock.toThrow = eperm;

    /* Resolves — the retirement that called this must not fail because a
       cosmetic edge cleanup hit a locked file. #2694 — the function now
       returns the written payload (or null) rather than void, so a
       swallowed failure resolves to `null` ("nothing was written"), not
       `undefined`. */
    await expect(
      clearNotLinkedEdgesForDroppedRejections(BOOK_DIR, BOOK_ID, DROPPED),
    ).resolves.toBeNull();

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain('[not-linked-edges]');
    expect(warn.mock.calls[0][1]).toBe(eperm);
  });

  it('STILL SWALLOWS a plain Error carrying no code at all', async () => {
    /* The other half of "do not narrow it beyond this one class": a bare
       Error (e.g. a JSON shape failure out of readJson) keeps its old
       best-effort treatment. */
    lock.toThrow = new Error('cast.json is not an object');

    await expect(
      clearNotLinkedEdgesForDroppedRejections(BOOK_DIR, BOOK_ID, DROPPED),
    ).resolves.toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
  });
});
