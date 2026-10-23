import { describe, it, expect } from 'vitest';
import {
  withKeyLock,
  withStateJsonLock,
  __chainsSizeForTest,
  __stateJsonWaitersForTest,
  LockAcquisitionTimeoutError,
  LOCK_ACQUISITION_TIMEOUT_CODE,
  isLockAcquisitionTimeout,
  itemFailureReason,
  LOCK_CONTENTION_ITEM_REASON,
  requestFailureMessage,
  LOCK_CONTENTION_REQUEST_ERROR,
  requestFailureMessageFs,
  FS_FAILURE_REQUEST_ERROR,
  FS_PERMANENT_FAILURE_REQUEST_ERROR,
} from './file-lock.js';

/* ops-46 (#2028), Narrow option: withKeyLock's `chains` Map (file-lock.ts:5)
   is module-level mutable state keyed by a fixed string — exactly the shape
   that turned a genuine red-phase test green while landing #2001's fix
   (attempt 1 fails and leaks its key into `chains`; the suite's global
   retry:1 re-runs attempt 2 against that already-mutated map, so it can pass
   for the wrong reason). retry:0 here means a red-phase test against this
   file's state is never silently rescued by the suite-wide retry — see
   CONTRIBUTING.md's "When you ship a change" section (the "#2028" note) and
   server/vitest.config.ts's retryHazardReporter for the survey that ruled
   out flipping retry:1 suite-wide instead.

   PR #2049 review, Finding 7 — this is NOT the only file sharing the shape.
   `routes/script-review.ts:278-279` declares two module-level Maps
   (`mainScriptReviewJobByBook`, `subsetScriptReviewJobByChapter`); its test
   sets `bookId` once in `beforeAll` and reuses it as the key, has zero
   `afterEach`, and releases sit after assertions with no `try`/`finally`.
   It is not currently exploitable, though — independently verified:
   disabling its 409-conflict producer to probe for a silent false-green
   times out loudly under both retry:1 and --retry=0, it does not pass. So
   the accurate claim is narrower than "no sibling shares this shape": no
   sibling was found where the leak actually produces a SILENT pass —
   script-review.ts just doesn't clear the fix-now bar on the evidence
   available. */
describe('withKeyLock', { retry: 0 }, () => {
  it('serializes critical sections sharing a key', async () => {
    const order: string[] = [];
    const slow = withKeyLock('book-1', async () => {
      order.push('a-start');
      await new Promise((r) => setTimeout(r, 30));
      order.push('a-end');
    });
    const fast = withKeyLock('book-1', async () => {
      order.push('b-start');
      order.push('b-end');
    });
    await Promise.all([slow, fast]);
    expect(order).toEqual(['a-start', 'a-end', 'b-start', 'b-end']);
  });

  it('runs different keys concurrently', async () => {
    const order: string[] = [];
    const a = withKeyLock('book-1', async () => {
      order.push('a-start');
      await new Promise((r) => setTimeout(r, 30));
      order.push('a-end');
    });
    const b = withKeyLock('book-2', async () => {
      order.push('b-start');
      order.push('b-end');
    });
    await Promise.all([a, b]);
    expect(order.slice(0, 2).sort()).toEqual(['a-start', 'b-start']);
    expect(order.indexOf('b-end')).toBeLessThan(order.indexOf('a-end'));
  });

  it('releases the lock when fn throws', async () => {
    await expect(withKeyLock('k', async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    const ran = await withKeyLock('k', async () => 'ok');
    expect(ran).toBe('ok');
  });
});

/* #2260 — withKeyLock's acquisition timeout. cast-lock.ts rules 1 and 4 both
   deadlock the mutex with no timeout and no diagnostic; these pin the fix.
   retry:0 for the same reason as the suite above: a red-phase test against
   this file's module-level `chains` state must never be silently rescued by
   the suite-wide retry. */
describe('withKeyLock acquisition timeout (#2260)', { retry: 0 }, () => {
  it('throws instead of hanging when acquisition deadlocks, naming the key', async () => {
    const key = 'deadlock-key';
    /* First holder never releases -- stands in for a cast-lock.ts rule 1/4
       violation, where the true first holder is itself blocked forever
       waiting on a second lock held by whoever is queued behind it here. */
    void withKeyLock(key, () => new Promise<void>(() => {}));

    let secondRan = false;
    await expect(
      withKeyLock(key, async () => { secondRan = true; }, 50),
    ).rejects.toThrow(/deadlock-key/);
    /* Trap 1: the critical section must never run on the timeout path. */
    expect(secondRan).toBe(false);
  });

  it('does not fire for legitimate contention comfortably under budget', async () => {
    const key = 'contended-key';
    const order: string[] = [];
    const slow = withKeyLock(key, async () => {
      order.push('slow-start');
      await new Promise((r) => setTimeout(r, 20));
      order.push('slow-end');
    }, 500);
    const fast = withKeyLock(key, async () => {
      order.push('fast-start');
      order.push('fast-end');
    }, 500);
    await Promise.all([slow, fast]);
    expect(order).toEqual(['slow-start', 'slow-end', 'fast-start', 'fast-end']);
  });

  it('does not poison the key after a timeout -- a later call still works once the holder finishes', async () => {
    const key = 'unpoisoned-key';
    const order: string[] = [];
    /* The real holder -- NOT permanently stuck, unlike the deadlock test
       above. It finishes on its own, comfortably after the waiter below has
       already timed out. This is the case review Finding 2 called out: a
       first holder that never releases makes "a later call still works"
       provable only by barging past a still-running holder, which proves
       the opposite of what this test claims -- a neutralisation proof, not
       coverage. */
    const holder = withKeyLock(key, async () => {
      order.push('first-start');
      await new Promise((r) => setTimeout(r, 700));
      order.push('first-end');
      return 'first-done';
    });

    /* Comfortably shorter than the holder's 700ms hold, so this one times out
       while the holder is still running. 700ms/50ms is a ~650ms absolute
       gap -- widened from 150ms/20ms (an ~130ms gap) as cheap, no-regret
       insurance per docs/superpowers/specs/2026-09-01-verify-scope-branch-
       timing-design.md Decision B; not a claim these margins were ever
       provably flippable. */
    await expect(
      withKeyLock(key, async () => 'never', 50),
    ).rejects.toThrow(/unpoisoned-key/);

    /* A fresh acquisition of the SAME key, started after the timeout above
       already threw and returned, must still queue behind the still-running
       holder and succeed once it finishes -- neither barge past it (Finding
       1's mutual-exclusion break) nor hang forever (Trap 2's poisoning).
       This 2000ms budget's own headroom against the holder above was cut
       from ~1870ms to ~1350ms when that holder widened 150ms->700ms
       (Decision B) -- still ~3x the required wait, a deliberate trade, not
       an oversight. */
    const result = await withKeyLock(key, async () => {
      order.push('third-start');
      return 'ok-after-timeout';
    }, 2000);

    expect(result).toBe('ok-after-timeout');
    expect(order).toEqual(['first-start', 'first-end', 'third-start']);
    await holder;
  });

  it('does not let a later caller barge past a still-running holder after an earlier waiter times out', async () => {
    /* Case review Finding 3 -- the regression test for Finding 1. Nothing in
       the tests above pins ordering strictly enough to catch a `chains`
       cleanup on the timeout path that deletes the wrong thing: a subsequent
       caller must queue behind the ACTUAL holder, not merely "eventually
       succeed" (which a barge-past-and-race outcome can also produce by
       accident once the holder happens to finish first). */
    const key = 'mutex-key';
    const order: string[] = [];
    const holder = withKeyLock(key, async () => {
      order.push('a-start');
      await new Promise((r) => setTimeout(r, 750));
      order.push('a-end');
    });

    /* Times out well before the holder's 750ms hold ends -- a ~700ms
       absolute gap, widened from 200ms/20ms (an ~180ms gap) per Decision B,
       same no-regret-insurance rationale as the test above. */
    await expect(
      withKeyLock(key, async () => { order.push('b-ran'); }, 50),
    ).rejects.toThrow(/mutex-key/);

    /* Started immediately after the waiter's rejection -- the holder is
       still running at this point. */
    const later = withKeyLock(key, async () => {
      order.push('d-start');
      order.push('d-end');
    });

    await Promise.all([holder, later]);

    expect(order).toEqual(['a-start', 'a-end', 'd-start', 'd-end']);
    expect(order).not.toContain('b-ran');
  });

  it('leaves exactly one chains entry after a timeout behind a holder that FINISHES, reclaimed by the next completed caller', async () => {
    /* PR #2284 review C3. The timeout path deliberately does NOT delete its
       `chains` entry -- deleting it is what breaks mutual exclusion. The cost
       is that the entry outlives the timeout, and nothing pinned that before:
       the holder ahead will not remove it (its `finally` guards on its OWN
       `mine`, and the map now holds the waiter's). Pin both halves -- the
       entry that stays, and the later caller that reclaims it -- so a future
       change cannot quietly reintroduce the delete without this going red.

       SCOPED TO THE BENIGN BRANCH, deliberately (review round 2, CB4): this
       fixture's holder finishes on its own, so the retained `mine` resolves
       and nothing stays attached to it. The title used to say "inert", which
       generalised past that fixture -- in the DEADLOCK branch `prior` never
       settles, `mine` stays PENDING for the process lifetime, and each further
       caller chains another reaction record onto it. Only the map entry COUNT
       is bounded there, and that is a property of `Map`. See file-lock.ts's
       comment on the retained entry. */
    const key = 'chains-accounting-key';
    const before = __chainsSizeForTest();

    const holder = withKeyLock(key, async () => {
      /* 700ms/50ms is a ~650ms absolute gap, widened from 150ms/20ms per
         Decision B -- same no-regret-insurance rationale as the two tests
         above in this file. */
      await new Promise((r) => setTimeout(r, 700));
    });
    await expect(withKeyLock(key, async () => 'never', 50)).rejects.toThrow(/chains-accounting-key/);
    await holder;

    /* The holder has finished and still did not reclaim the timed-out
       waiter's entry -- this is the accepted, bounded leak. */
    expect(__chainsSizeForTest()).toBe(before + 1);

    /* ...and the next caller to run fn() to completion does reclaim it. */
    await withKeyLock(key, async () => 'ok');
    expect(__chainsSizeForTest()).toBe(before);
  });
});

/* #2260 review round 2 -- the expiry must be DISTINGUISHABLE from a plain
   Error, because the best-effort `catch` blocks around the cast-identity
   writes swallow by default and must keep swallowing EPERM/ENOSPC while
   letting an expiry through. A bare `Error` gave them nothing to branch on.
   retry:0 for the same module-state reason as the suites above. */
describe('withKeyLock typed timeout error (#2260 round 2)', { retry: 0 }, () => {
  it('rejects with LockAcquisitionTimeoutError, not a plain Error, and carries the key', async () => {
    const key = 'typed-error-key';
    void withKeyLock(key, () => new Promise<void>(() => {}));

    const err = await withKeyLock(key, async () => 'never', 20).then(
      () => {
        throw new Error('expected the acquisition to time out');
      },
      (e: unknown) => e,
    );

    expect(err).toBeInstanceOf(LockAcquisitionTimeoutError);
    expect((err as LockAcquisitionTimeoutError).code).toBe(LOCK_ACQUISITION_TIMEOUT_CODE);
    expect((err as LockAcquisitionTimeoutError).key).toBe(key);
    expect((err as LockAcquisitionTimeoutError).timeoutMs).toBe(20);
    expect((err as Error).name).toBe('LockAcquisitionTimeoutError');
    /* The round-1 message text is unchanged -- swallow sites branch on `code`,
       but a maintainer still meets this string first. */
    expect((err as Error).message).toContain('withKeyLock: timed out after 20ms');
    expect((err as Error).message).toContain(`"${key}"`);
  });

  it('isLockAcquisitionTimeout accepts the expiry and rejects everything a swallow site must keep swallowing', () => {
    expect(isLockAcquisitionTimeout(new LockAcquisitionTimeoutError('k', 10))).toBe(true);

    /* The negatives are the load-bearing half: a predicate that said `true`
       here would turn every swallow site into an unconditional rethrow, which
       is a regression, not a fix. */
    expect(isLockAcquisitionTimeout(new Error('boom'))).toBe(false);
    expect(isLockAcquisitionTimeout(Object.assign(new Error('eperm'), { code: 'EPERM' }))).toBe(
      false,
    );
    expect(isLockAcquisitionTimeout(Object.assign(new Error('enospc'), { code: 'ENOSPC' }))).toBe(
      false,
    );
    expect(isLockAcquisitionTimeout(null)).toBe(false);
    expect(isLockAcquisitionTimeout(undefined)).toBe(false);
    expect(isLockAcquisitionTimeout('ELOCKACQUIRETIMEOUT')).toBe(false);
  });

  it('matches by code, not identity -- a foreign object carrying the code still discriminates', () => {
    /* This is the point of checking `code` rather than `instanceof`: two copies
       of this module (vitest per-file registry, a future dual ESM/CJS load)
       must not make a swallow site fail OPEN and re-swallow the expiry. */
    const fromAnotherModuleInstance = Object.assign(new Error('withKeyLock: timed out'), {
      code: LOCK_ACQUISITION_TIMEOUT_CODE,
    });
    expect(fromAnotherModuleInstance instanceof LockAcquisitionTimeoutError).toBe(false);
    expect(isLockAcquisitionTimeout(fromAnotherModuleInstance)).toBe(true);
  });
});

/* #2292 (owner decision) — the shared per-item reason used by the five batch
 * routes (script-review, cast-design, voice-style, cast-series-patch,
 * voice-override-linked). The per-item SHAPE is theirs; only the words are
 * here, so all five say the same thing and cannot drift apart.
 *
 * Each route also has its own two-directional fixture proving it is wired to
 * this; these cases pin the helper itself, including the negative half a
 * route-level test cannot easily reach (a non-Error value).
 */
describe('itemFailureReason (#2292)', () => {
  it('reports contention for a lock-acquisition expiry, whatever produced it', () => {
    expect(itemFailureReason(new LockAcquisitionTimeoutError('cast:/w/b', 10_000), 'boom')).toBe(
      LOCK_CONTENTION_ITEM_REASON,
    );
    /* Same `code`-not-`instanceof` contract as `isLockAcquisitionTimeout` --
       a foreign copy of the class still discriminates. */
    expect(
      itemFailureReason(
        Object.assign(new Error('withKeyLock: timed out'), { code: LOCK_ACQUISITION_TIMEOUT_CODE }),
        'boom',
      ),
    ).toBe(LOCK_CONTENTION_ITEM_REASON);
  });

  it('passes an ordinary failure through untouched', () => {
    /* The half that reddens if a route starts rewriting every reason: a real
       per-item error must reach the user verbatim. */
    expect(itemFailureReason(Object.assign(new Error('nope'), { code: 'EPERM' }), 'disk full')).toBe(
      'disk full',
    );
    expect(itemFailureReason(new Error('plain'), 'plain')).toBe('plain');
    expect(itemFailureReason(null, 'fallback')).toBe('fallback');
    expect(itemFailureReason('ELOCKACQUIRETIMEOUT', 'fallback')).toBe('fallback');
  });

  it('never leaks the raw lock message, which is what read as a broken item', () => {
    expect(LOCK_CONTENTION_ITEM_REASON).not.toContain('withKeyLock');
    expect(LOCK_CONTENTION_ITEM_REASON).toContain('contention');
  });
});

/* #2260 FINAL ROUND (B2) — the WHOLE-REQUEST counterpart, same three
 * directions. Route-level coverage lives in
 * `routes/lock-timeout-response-bodies.test.ts`, which drives eight of the
 * twelve curated routes through a real lock seam. Of the other four,
 * `cast-design.ts` and `single-design.ts` are `endJob` SSE terminals and
 * `qwen-voice.ts` maps its status through `httpStatusForSidecarError` — none
 * of the three is cheap to drive end to end; `voice-style.ts` shares the
 * ordinary shape but isn't wired into that file's `CASES` either. This
 * describe pins the decision itself, including the non-Error inputs a route
 * test cannot easily produce.
 */
describe('requestFailureMessage (#2260 final round)', () => {
  it('curates a lock-acquisition expiry, whatever produced it', () => {
    expect(
      requestFailureMessage(
        /* The real shape of a cast-lock key: an absolute path into the user's
           library. Backslashes escaped, so this is one literal Windows path. */
        new LockAcquisitionTimeoutError('C:\\Users\\me\\books\\B\\cast.json', 10_000),
        'Voice library assign failed.',
      ),
    ).toBe(LOCK_CONTENTION_REQUEST_ERROR);
    /* `code`, not `instanceof` — a foreign copy of the class still
       discriminates, because an `instanceof` miss fails OPEN straight back to
       returning the key. */
    expect(
      requestFailureMessage(
        Object.assign(new Error('withKeyLock: timed out'), { code: LOCK_ACQUISITION_TIMEOUT_CODE }),
        'boom',
      ),
    ).toBe(LOCK_CONTENTION_REQUEST_ERROR);
  });

  it('passes an ordinary failure through untouched', () => {
    /* The half that reddens if the fix is over-applied into "stop returning
       e.message". These handlers have always surfaced an ordinary error's own
       message and this change is not the one that revisits that. */
    expect(
      requestFailureMessage(Object.assign(new Error('nope'), { code: 'EPERM' }), 'nope'),
    ).toBe('nope');
    expect(requestFailureMessage(null, 'Failed to write book state.')).toBe(
      'Failed to write book state.',
    );
    expect(requestFailureMessage('ELOCKACQUIRETIMEOUT', 'fallback')).toBe('fallback');
  });

  it('the curated body names no key, no path and no internal vocabulary', () => {
    expect(LOCK_CONTENTION_REQUEST_ERROR).not.toContain('withKeyLock');
    expect(LOCK_CONTENTION_REQUEST_ERROR).not.toContain('cast.json');
    expect(LOCK_CONTENTION_REQUEST_ERROR).not.toContain('rule');
    expect(LOCK_CONTENTION_REQUEST_ERROR).toContain('contention');
  });
});

/* #3700 review pass 1 -- `withStateJsonLock` curates the message (the key embeds
   the absolute workspace path) but must keep the lock-timeout CLASS, or the
   fail-loud sites (analysis persist, `classifyAnalysisFailure`) swallow it as a
   disk fault. */
describe('withStateJsonLock timeout keeps the lock-timeout class (#3700)', { retry: 0 }, () => {
  it('rethrows the curated message with the timeout code, never the key', async () => {
    const statePath = '/w/state-json-class/.audiobook/state.json';
    void withKeyLock(`state-json:${statePath}`, () => new Promise<void>(() => {}));
    const err = await withStateJsonLock(statePath, async () => 'ran', 50).catch((e: unknown) => e);
    expect(isLockAcquisitionTimeout(err)).toBe(true);
    expect((err as Error).message).toBe(LOCK_CONTENTION_REQUEST_ERROR);
    expect((err as Error).message).not.toContain(statePath);
  });

  it('a timed-out acquisition leaves no stale waiter count behind', async () => {
    const statePath = '/w/state-json-timeout-waiters/.audiobook/state.json';
    void withKeyLock(`state-json:${statePath}`, () => new Promise<void>(() => {}));
    await new Promise((r) => setTimeout(r, 0));
    await withStateJsonLock(statePath, async () => 'ran', 20).catch(() => undefined);
    expect(__stateJsonWaitersForTest(statePath)).toBe(0);
  });
});

describe('__stateJsonWaitersForTest (#3700)', { retry: 0 }, () => {
  it('counts exactly the callers queued behind a holder, and drops to 0 once they run', async () => {
    const statePath = '/tmp/waiters-test/.audiobook/state.json';
    expect(__stateJsonWaitersForTest(statePath)).toBe(0);
    let release!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    const holder = withStateJsonLock(statePath, () => held);
    // The holder acquires immediately; let its (zero-wait) acquisition settle.
    await new Promise((r) => setTimeout(r, 0));
    expect(__stateJsonWaitersForTest(statePath)).toBe(0);
    const w1 = withStateJsonLock(statePath, async () => 'a');
    const w2 = withStateJsonLock(statePath, async () => 'b');
    expect(__stateJsonWaitersForTest(statePath)).toBe(2);
    release();
    await Promise.all([holder, w1, w2]);
    expect(__stateJsonWaitersForTest(statePath)).toBe(0);
  });
});

/* #3711 PR #3714 -- a node fs error (write EBUSY / ENOSPC / EPERM) carries the
   absolute path it failed on in its message, and the book routes used to answer
   that message verbatim over LAN HTTPS. `requestFailureMessageFs` is
   `requestFailureMessage` plus that class. */
describe('requestFailureMessageFs (#3711)', () => {
  const fsError = (code: string, syscall: string, path: string): NodeJS.ErrnoException =>
    Object.assign(new Error(`${code}: failed, ${syscall} '${path}'`), { code, syscall, path, errno: -4082 });

  it('curates a node fs error, whatever its code', () => {
    const path = 'C:\\Users\\me\\books\\A\\S\\T\\.audiobook\\state.json';
    for (const code of ['EBUSY', 'ENOSPC', 'EPERM', 'EACCES', 'EIO', 'EROFS', 'EAGAIN', 'EMFILE']) {
      const body = requestFailureMessageFs(fsError(code, 'open', path), 'Merge failed.');
      expect([FS_FAILURE_REQUEST_ERROR, FS_PERMANENT_FAILURE_REQUEST_ERROR]).toContain(body);
      expect(body).not.toContain('C:');
      expect(body).not.toContain(code);
    }
    /* `path` alone, or `syscall` alone, is enough to recognise the class. */
    expect(
      requestFailureMessageFs(Object.assign(new Error(`EBUSY '${path}'`), { code: 'EBUSY', path }), 'x'),
    ).toBe(FS_FAILURE_REQUEST_ERROR);
    expect(
      requestFailureMessageFs(Object.assign(new Error('ENOSPC'), { code: 'ENOSPC', syscall: 'write' }), 'x'),
    ).toBe(FS_PERMANENT_FAILURE_REQUEST_ERROR);
  });

  /* PR #3714 review pass 5 -- a retry cannot fix a full disk or a permission
     error, so their body never says "Try again"; a transient one still does. */
  it('says "Try again" only for a transient fs error', () => {
    const path = 'C:\\w\\state.json';
    for (const code of ['ENOSPC', 'EACCES', 'EROFS']) {
      const body = requestFailureMessageFs(fsError(code, 'write', path), 'x');
      expect(body).toBe(FS_PERMANENT_FAILURE_REQUEST_ERROR);
      expect(body).not.toMatch(/try again/i);
    }
    for (const code of ['EBUSY', 'EPERM', 'EIO', 'EAGAIN', 'EMFILE']) {
      expect(requestFailureMessageFs(fsError(code, 'open', path), 'x')).toBe(FS_FAILURE_REQUEST_ERROR);
    }
    expect(FS_FAILURE_REQUEST_ERROR).toMatch(/Try again/);
  });

  it('still curates a lock-acquisition expiry exactly as requestFailureMessage does', () => {
    expect(
      requestFailureMessageFs(new LockAcquisitionTimeoutError('C:\\w\\cast.json', 10_000), 'x'),
    ).toBe(LOCK_CONTENTION_REQUEST_ERROR);
  });

  it('passes a deliberate message through verbatim', () => {
    expect(requestFailureMessageFs(new Error('Chapter 9 not found'), 'Chapter 9 not found')).toBe(
      'Chapter 9 not found',
    );
    /* A coded error that is not a node fs error (no syscall, no path). */
    expect(
      requestFailureMessageFs(Object.assign(new Error('nope'), { code: 'EPERM' }), 'nope'),
    ).toBe('nope');
    expect(requestFailureMessageFs(null, 'Failed to toggle held.')).toBe('Failed to toggle held.');
  });

  it('the curated body names no path, syscall or code', () => {
    for (const body of [FS_FAILURE_REQUEST_ERROR, FS_PERMANENT_FAILURE_REQUEST_ERROR]) {
      expect(body).not.toMatch(/[A-Z]:\\|\/|E[A-Z]{3,}|\bopen\b|\bwrite\b/);
    }
  });

  /* PR #3714 review pass 6 -- the voice library, the voices catalog and
     POST /import answer these bodies too, and none of them has a book. */
  it('the curated body names no book', () => {
    for (const body of [FS_FAILURE_REQUEST_ERROR, FS_PERMANENT_FAILURE_REQUEST_ERROR]) {
      expect(body).not.toMatch(/\bbook/i);
    }
  });
});
