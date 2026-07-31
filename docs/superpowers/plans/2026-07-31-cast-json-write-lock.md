# cast.json write lock — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Serialise every cast.json read-modify-write behind a per-book lock, so
two concurrent writers can no longer silently discard each other's mutation.

**Architecture:** Three layers. (1) A thin named wrapper (`withCastLock` /
`withCastLocks`) over the existing `withKeyLock` promise-chain mutex, applied at
all 35 `writeJsonAtomic(castJsonPath(…))` sites plus 2 delete sites; the lock
always encloses the **read** as well as the write. (2) A cast.json revision
counter, for the six places where the decision is read in one lock scope and the
write lands in another — a lock cannot reach those, so staleness is made
detectable instead. (3) Two further key classes, `library-voice:<uuid>` and
`series:<author>/<series>`, for races a per-book key cannot express. Global lock
order: `design` → `series` → `library-voice` → `cast`.

**Tech Stack:** TypeScript, Node 20, Express, Vitest (node env), real-fs
integration tests.

**Design of record:** [`docs/superpowers/specs/2026-07-31-cast-json-write-lock-design.md`](../specs/2026-07-31-cast-json-write-lock-design.md).
Read it before Task 1. Section references below (§3.1, §5, §10.2 …) point at it.

**Tickets:** `Closes #1981`, `Closes #2000`, `Closes #2001`, `Closes #2006`,
`Closes #2015`. Nothing is deferred out of this change.

## Global Constraints

- **Base branch: cut off current `main`.** #1933 has since merged, so the
  sequencing constraint earlier drafts carried is discharged. It landed the
  +138/+178 shift in `voice-library.ts` that spec §9.1 predicted (the assign RMW
  is now `:1415` → `:1612`) and added a second readiness gate,
  `clonedAssignBlock`, *below* the cast read. Spec line numbers are as of
  `88476dca` and several have moved. **Cite symbols, never line numbers.**
- **Global lock order: `design` → `series` → `library-voice` → `cast`.** Never
  acquire an earlier class while holding a later one. Every acquisition site
  names its position in a comment.
- **Lock the innermost read-through-write, never the caller.** One level only.
  A locked function must not call another locked function on the same book.
- **The read goes inside the lock**, and so does every decision derived from it.
- **Two or more books → `withCastLocks`**, never nested `withCastLock`s.
- **Every outcome test pins a single module registry** — no `vi.resetModules()`
  between the two concurrent writers in a spec. This is **hygiene, not a
  detector**: a partitioned lock does not contend, so it loses a mutation and the
  outcome test goes *red*. Pinning avoids a confusing false failure. Do not add a
  `chains.size` accessor for this — §10.3 explains why it cannot work.
- **Task 7 must include one cross-module outcome spec** — two *different*
  modules' write sites racing on one book. A spec that races a site against
  itself uses one import and one key, so it can never catch cross-site key
  derivation drift. This is the only shape that can.
- **Rule 2 has exactly four sanctioned carve-outs** (spec §4): `promote-voice`'s
  `realVoiceId`, `cast-design.ts`'s idempotency guards, `cast-add-from-roster`'s
  target read, `ensureCharacterVoiceUuid`'s series branch. Anything else left
  outside its lock is the failure mode, not a narrowing.
- **Every lock is mutation-verified**: revert the lock at that site, re-run,
  paste the failing output into the task's commit message. A test that was never
  seen red proves nothing.
- **Tasks 14–16 use `cast-io.ts`'s helpers; the other 30 sites do not.** Those
  30 read and write inside one cast lock where nothing can interleave, so a
  staleness check there is inert and costs an extra full read per write. An
  earlier draft required universal adoption — that was a property of the
  *revision-counter* design, which is unsound unless every writer increments. The
  content fingerprint has no such requirement: any write changes the bytes,
  whoever made it. Do not widen the helpers' use.
- **`analysis.ts`'s 5 writes and the three clone-consent gates are IN scope** —
  Tasks 14 and 15. Earlier drafts deferred them to #2015/#2006; those issues are
  now closed by this PR. Do not skip them on the strength of a stale comment.
- Commit convention: `<type>(<scope>): <subject>`. Scope is `server` for all
  code tasks.

---

## File Structure

| File | Responsibility |
|---|---|
| `server/src/workspace/cast-lock.ts` | **New.** Four named lock wrappers (`withCastLock`, `withCastLocks`, `withLibraryVoiceLock`, `withSeriesLock`) + the lock-order rule in its header. Sole owner of key derivation. |
| `server/src/workspace/cast-io.ts` | **New.** `readCastForUpdate` / `writeCastChecked` / `assertCastUnchanged` — content-fingerprint staleness detection. Used by Tasks 14–16 only. |
| `server/src/workspace/cast-lock.test.ts` | **New.** Primitive unit tests: sorted acquisition (observed within one call), the AB/BA deadlock test, dedupe, release-on-throw, non-overlapping FIFO waiters, empty-list refusal. |
| `server/src/workspace/cast-lock.race.test.ts` | **New.** The outcome harness — two overlapping RMWs, both mutations must survive. The reference for every later site test. |
| `server/src/workspace/file-lock.ts` | Modify — #2001 map-cleanup fix. |
| `server/src/tts/design-lock.ts` | Modify — same fix, cleanup only. **Do not touch acquire/release/ordering**: `ensureCharacterVoiceUuid`'s series branch still depends on it (§5.1). |
| `server/src/routes/chapters-restructure.ts` | Modify — same fix; re-derive the safety argument, its control flow differs. |
| 17 route modules + `voice-library-usage.ts` | Modify — apply the lock per §5. |
| `server/src/workspace/cast-lock.guard.test.ts` | **New.** Static guard: no unlocked `writeJsonAtomic(castJsonPath(` / `rm(castJsonPath(`. |

---

### Task 1: The race harness, red before anything is locked

Lands the spike as a committed test **before any site is converted**, so the
200/200 figure the spec leans on is reproducible rather than quoted.

**Files:**
- Create: `server/src/workspace/cast-lock.race.test.ts`

**Interfaces:**
- Consumes: `readJson`, `writeJsonAtomic` from `./state-io.js`.
- Produces: `assignVoice(castPath, characterId, voice)` and
  `readVoices(castPath)` — the RMW shape every later task's test reuses.

- [ ] **Step 1: Pin the defect**

This one is a characterization test, not a red-phase test: it PASSES while the
bug exists. Task 2 adds the both-survive assertion *beside* it and both stay in
the file permanently — the pair is the red→green evidence.

```ts
/* The outcome harness for the cast.json lock sweep. Two overlapping
   read-modify-writes, each touching a DIFFERENT character: both mutations must
   survive. Deliberately ONE module registry — no vi.resetModules() between the
   two writers, because a partitioned lock behaves exactly like no lock and would
   make this pass vacuously (design §10.3). */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readJson, writeJsonAtomic } from './state-io.js';
import { castJsonPath } from './paths.js';

interface Cast {
  characters: Array<{ id: string; voice?: string }>;
}

let dir: string;
let castPath: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'cast-lock-race-'));
  /* Build at castJsonPath(dir), NOT join(dir, 'cast.json') — castJsonPath
     returns <dir>/.audiobook/cast.json, and later tasks derive the lock key
     from the same helper. */
  castPath = castJsonPath(dir);
  await writeJsonAtomic(castPath, {
    characters: [{ id: 'alice' }, { id: 'bob' }],
  } satisfies Cast);
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** One handler-shaped RMW: read the whole cast, mutate one character, write it
    all back. This is the shape of all 35 cast.json writers. */
export async function assignVoice(
  path: string,
  characterId: string,
  voice: string,
): Promise<void> {
  const cast = await readJson<Cast>(path);
  const characters = [...(cast?.characters ?? [])];
  const i = characters.findIndex((c) => c.id === characterId);
  characters[i] = { ...characters[i], voice };
  await writeJsonAtomic(path, { ...cast, characters });
}

export async function readVoices(path: string): Promise<Record<string, string | undefined>> {
  const cast = await readJson<Cast>(path);
  return Object.fromEntries((cast?.characters ?? []).map((c) => [c.id, c.voice]));
}

describe('cast.json concurrent read-modify-write', () => {
  it('loses a mutation when two writers overlap unlocked', async () => {
    await Promise.all([
      assignVoice(castPath, 'alice', 'a'),
      assignVoice(castPath, 'bob', 'b'),
    ]);
    const v = await readVoices(castPath);
    /* Documents the defect: unlocked, one mutation is always lost. Task 2 adds
       the locked counterpart beside this. If a future change to readJson /
       writeJsonAtomic ever stops them yielding in the same tick, this test goes
       red — the correct response is to update THIS test, never to reintroduce
       an unlocked write path. */
    expect(v.alice === 'a' && v.bob === 'b').toBe(false);
  });
});
```

- [ ] **Step 2: Run it and confirm it passes — i.e. the race is real**

Run: `cd server && npx vitest run src/workspace/cast-lock.race.test.ts`
Expected: PASS. A pass here means a mutation *was* lost, which is the defect.

- [ ] **Step 3: Prove it is not flaky**

Run: `cd server && npx vitest run src/workspace/cast-lock.race.test.ts --repeat=20`
Expected: 20/20 PASS. The spec's claim is 200/200; if any run fails, stop and
report — the whole test strategy depends on this interleave being deterministic.

**On route-level tests being deterministic too.** Route handlers do several
`await`s before their cast read, and two requests can take different branches
(`/assign`'s `hasRetainedDesignedClip` `stat` fires only for a designed entry),
so it is fair to ask whether the bare `Promise.all` still interleaves. Measured
during planning, 50 trials per configuration, at prologue depths 0v0, 2v2, 3v3,
2v3, 1v4 and 0v3: **the race was observed 50/50 in every case.** Differing
`await` depth does not desynchronise it — both requests dispatch in one tick and
both reads land before either write, because the write (`mkdir` + `writeFile` +
`rename`) is much the slower half.

**The one exception is wall-clock duration, not await depth.** `promote-voice`
does a sidecar `fetch` before its read, which takes real time and *will*
separate the two racers. Task 8's test must stub that `fetch` (or point it at a
local no-op) so the two requests reach their cast reads together. If any other
route-level red-phase test fails to go red, treat it as a **harness** problem —
not as evidence the site is safe — and stub whatever slow call sits in its
prologue before reaching for a different mechanism.

- [ ] **Step 4: Commit**

```bash
git add server/src/workspace/cast-lock.race.test.ts
git commit -m "test(server): pin the cast.json lost-update race before locking anything"
```

---

### Task 2: `cast-lock.ts` — the lock wrappers

**Files:**
- Create: `server/src/workspace/cast-lock.ts`
- Create: `server/src/workspace/cast-lock.test.ts`
- Modify: `server/src/workspace/cast-lock.race.test.ts`

**Interfaces:**
- Consumes: `withKeyLock` from `./file-lock.js`, `castJsonPath` from `./paths.js`.
- Produces:
  - `withCastLock<T>(bookDir: string, fn: () => Promise<T>): Promise<T>`
  - `withCastLocks<T>(bookDirs: string[], fn: () => Promise<T>): Promise<T>`
  - `withLibraryVoiceLock<T>(voiceUuid: string, fn: () => Promise<T>): Promise<T>`

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, it, expect, vi } from 'vitest';
import { withCastLock, withCastLocks } from './cast-lock.js';
/* Namespace import so vi.spyOn can intercept the call cast-lock.ts makes
   internally — Vite's SSR transform rewrites it to a property access resolved
   at call time. Do NOT reach for vi.mock('./file-lock.js') instead; that
   replaces the module and the spy stops observing real acquisition. */
import * as fileLock from './file-lock.js';
import { castJsonPath } from './paths.js';

const settle = () => new Promise((r) => setTimeout(r, 0));

describe('withCastLocks', () => {
  /* Sorting is the ONLY thing standing between the 8 two-book sites and a
     permanent, diagnostic-free hang, so it gets two tests that genuinely fail
     without it. An earlier draft of this plan tested it by awaiting two
     withCastLocks calls SEQUENTIALLY and asserting they ran in call order —
     which is true with or without .sort(), with or without any lock at all.
     That is the placebo shape this whole PR exists to prevent. */

  it('acquires keys in sorted order within a single call', async () => {
    const acquired: string[] = [];
    const spy = vi.spyOn(fileLock, 'withKeyLock').mockImplementation(
      async (key: string, fn: () => Promise<unknown>) => {
        acquired.push(key);
        return fn();
      },
    );
    await withCastLocks(['/w/b', '/w/a'], async () => undefined);
    expect(acquired).toEqual([castJsonPath('/w/a'), castJsonPath('/w/b')]);

    acquired.length = 0;
    await withCastLocks(['/w/a', '/w/b'], async () => undefined);
    expect(acquired).toEqual([castJsonPath('/w/a'), castJsonPath('/w/b')]);
    spy.mockRestore();
  });

  it('does not deadlock when two callers pass the books in opposite orders', async () => {
    /* THE test for .sort(). Both hold their first lock across an await before
       asking for the second — the classic AB/BA setup. Without sorting this
       hangs forever; withKeyLock has no timeout. */
    const hold = async () => {
      await settle();
      return 'ok';
    };
    const raced = await Promise.race([
      Promise.all([
        withCastLocks(['/w/a', '/w/b'], hold),
        withCastLocks(['/w/b', '/w/a'], hold),
      ]),
      new Promise((r) => setTimeout(() => r('DEADLOCK'), 2000)),
    ]);
    expect(raced).toEqual(['ok', 'ok']);
  });

  it('dedupes a repeated book instead of self-deadlocking', async () => {
    /* A non-reentrant mutex acquired twice on one key wedges forever.
       library-cast-override can legitimately pass source === target. */
    const done = await Promise.race([
      withCastLocks(['/w/same', '/w/same'], async () => 'ran'),
      new Promise((r) => setTimeout(() => r('DEADLOCK'), 1000)),
    ]);
    expect(done).toBe('ran');
  });

  it('releases when the critical section throws', async () => {
    await expect(
      withCastLock('/w/x', async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    /* A leaked lock would hang this second acquisition. */
    const after = await Promise.race([
      withCastLock('/w/x', async () => 'ok'),
      new Promise((r) => setTimeout(() => r('LEAKED'), 1000)),
    ]);
    expect(after).toBe('ok');
  });

  it('runs waiters in FIFO order without overlapping them', async () => {
    /* `seen.push(n)` as the FIRST statement would run in map order with or
       without a lock. Record entry AND exit so overlap is observable. */
    const seen: string[] = [];
    await Promise.all(
      [1, 2, 3].map((n) =>
        withCastLock('/w/fifo', async () => {
          seen.push(`enter${n}`);
          await settle();
          seen.push(`exit${n}`);
        }),
      ),
    );
    expect(seen).toEqual(['enter1', 'exit1', 'enter2', 'exit2', 'enter3', 'exit3']);
  });

  it('refuses an empty book list rather than running unlocked', async () => {
    /* reduceRight over [] returns the initial value, so the critical section
       would run with no lock acquired at all. */
    await expect(withCastLocks([], async () => 'ran')).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd server && npx vitest run src/workspace/cast-lock.test.ts`
Expected: FAIL — `Cannot find module './cast-lock.js'`.

- [ ] **Step 3: Write the implementation**

```ts
/* Per-book cast.json write lock.
 *
 * cast.json carries every character's voice assignment and is the most-written
 * file in the workspace. Its writers are all read-modify-write: read the whole
 * file, change one character, write it all back. Two of those overlapping means
 * both read before either writes, and the later atomic rename wins outright —
 * the earlier mutation is gone, silently. Measured at 200/200 trials
 * (cast-lock.race.test.ts). An `await`-free window does NOT prevent this: the
 * read is itself the yield point.
 *
 * THE RULES (design §4 — keep these in sync with CLAUDE.md):
 *
 *   1. Lock the innermost read-through-write, never the caller. One level only.
 *      A locked function must not call another locked function on the same book.
 *   2. The read goes inside the lock, and so does every decision derived from
 *      it. Wrapping only the write buys nothing at all.
 *   3. Two or more books -> withCastLocks, never nested withCastLocks.
 *   4. Global lock order: design -> series -> library-voice -> cast. Never
 *      acquire an earlier class while holding a later one. The DELETE
 *      library-voice path holds `library-voice:<uuid>` across
 *      clearLibraryVoiceReferences, which takes a cast lock per book — so POST
 *      /assign must take library-voice BEFORE its cast lock, not after. The
 *      other order is an AB/BA cycle on a mutex with no timeout and no
 *      diagnostic: both requests hang forever. `series` and `library-voice` are
 *      never both held; their relative position is declared, not exercised.
 *
 * WHAT THIS DOES NOT COVER: it protects one read-modify-write. A validate-then-
 * write whose halves sit in different lock scopes needs the staleness helpers in
 * cast-io.ts, not this file — see that module and design §14.
 *
 * Key derivation lives here and ONLY here. A site that derived the key slightly
 * differently would get a second mutex that never contends with the first, and
 * every test would still pass.
 */
import { castJsonPath } from './paths.js';
import { withKeyLock } from './file-lock.js';

/** Hold the cast.json lock for one book across a read-modify-write. */
export function withCastLock<T>(bookDir: string, fn: () => Promise<T>): Promise<T> {
  return withKeyLock(castJsonPath(bookDir), fn);
}

/** Hold the cast.json lock for several books at once.
 *
 *  Dedupes, then sorts. Sorting makes AB/BA deadlock impossible by
 *  construction — argument order is caller-determined at the two-book routes.
 *  Deduping matters because library-cast-override can legitimately receive the
 *  same book twice (its guard rejects same-book AND same-character only), and a
 *  promise-chain mutex acquired twice on one key never releases. */
/* `async` deliberately: the empty-list guard below must surface as a REJECTED
   promise, not a synchronous throw. A sync throw fires while evaluating
   `expect()`'s argument, before `.rejects` can catch it, and the test fails
   instead of passing. */
export async function withCastLocks<T>(bookDirs: string[], fn: () => Promise<T>): Promise<T> {
  const keys = [...new Set(bookDirs.map(castJsonPath))].sort();
  /* reduceRight over an empty array returns `fn` unwrapped, which would run the
     critical section with no lock at all — fail loudly instead. */
  if (keys.length === 0) throw new Error('withCastLocks: no bookDirs given');
  const chained = keys.reduceRight<() => Promise<T>>(
    (next, key) => () => withKeyLock(key, next),
    fn,
  );
  return chained();
}

/** Hold the library-voice lock for one voice uuid.
 *
 *  Sits between `design` and `cast` in the global order (rule 4). Taken by the
 *  DELETE /voice-library/:voiceUuid path across scan -> clear -> erase, and by
 *  POST /:voiceUuid/assign around its own RMW — both sides must take it or it
 *  serialises nothing. */
export function withLibraryVoiceLock<T>(voiceUuid: string, fn: () => Promise<T>): Promise<T> {
  return withKeyLock(`library-voice:${voiceUuid}`, fn);
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd server && npx vitest run src/workspace/cast-lock.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Flip the race harness to the both-survive assertion**

In `cast-lock.race.test.ts`, add a second `it` beside the existing one:

```ts
import { withCastLock } from './cast-lock.js';

it('keeps both mutations when the writers hold the cast lock', async () => {
  const bookDir = dir; // castPath was built as castJsonPath(dir) in beforeEach
  await Promise.all([
    withCastLock(bookDir, () => assignVoice(castPath, 'alice', 'a')),
    withCastLock(bookDir, () => assignVoice(castPath, 'bob', 'b')),
  ]);
  const v = await readVoices(castPath);
  expect(v).toEqual({ alice: 'a', bob: 'b' });
});
```

**Do not** hand-roll the lock key in the test — deriving it any way other than
through `withCastLock` would defeat the point of Task 2.

- [ ] **Step 6: Run both, then mutation-verify**

Run: `cd server && npx vitest run src/workspace/cast-lock.race.test.ts`
Expected: PASS (2 tests).

Now revert: temporarily change `withCastLock` to `(bookDir, fn) => fn()`, re-run.
Expected: the both-survive test FAILS. Paste that output into the commit message,
then restore.

- [ ] **Step 7: Commit**

```bash
git add server/src/workspace/cast-lock.ts server/src/workspace/cast-lock.test.ts server/src/workspace/cast-lock.race.test.ts
git commit -m "feat(server): add the per-book cast.json write lock"
```

---

### Task 3: `cast-io.ts` — staleness detection for the cross-scope sites

Used by Tasks 14–16 only. The other 30 sites keep `readJson`/`writeJsonAtomic`
under their lock — see "Where it is used" below, and do not widen it.

**Files:**
- Create: `server/src/workspace/cast-io.ts`
- Create: `server/src/workspace/cast-io.test.ts`

**Interfaces:**
- Consumes: `readJson`, `writeJsonAtomic` from `./state-io.js`; `castJsonPath`.
- Produces:
  - `readCastForUpdate<T extends object>(bookDir): Promise<{ cast: T; fingerprint: string | null }>`
  - `writeCastChecked<T extends object>(bookDir, next: T, expected: string | null): Promise<string | null>`
    — returns the fingerprint of what it wrote
  - `assertCastUnchanged(bookDir, expected: string | null): Promise<void>`
  - `class CastStaleError extends Error` with `bookDir`

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fsp from 'node:fs/promises';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeJsonAtomic } from './state-io.js';
import { castJsonPath } from './paths.js';
import {
  readCastForUpdate,
  writeCastChecked,
  assertCastUnchanged,
  CastStaleError,
} from './cast-io.js';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'cast-io-'));
  await writeJsonAtomic(castJsonPath(dir), { characters: [{ id: 'alice' }] });
});
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

it('fingerprints an absent cast as null, distinctly from any content', async () => {
  await rm(castJsonPath(dir), { force: true });
  const { fingerprint } = await readCastForUpdate(dir);
  expect(fingerprint).toBeNull();
});

it('accepts a write when the file has not changed', async () => {
  const { cast, fingerprint } = await readCastForUpdate<{ characters: unknown[] }>(dir);
  await expect(writeCastChecked(dir, cast, fingerprint)).resolves.toBeUndefined();
});

it('rejects a write when the bytes changed under it', async () => {
  const { cast, fingerprint } = await readCastForUpdate<{ characters: unknown[] }>(dir);
  await writeJsonAtomic(castJsonPath(dir), { characters: [{ id: 'bob' }] });
  await expect(writeCastChecked(dir, cast, fingerprint)).rejects.toBeInstanceOf(CastStaleError);
});

it('detects a delete even when the file is recreated identically (ABA)', async () => {
  /* The property a revision counter cannot have: 1 -> delete -> recreate as 1
     reads as "unchanged" to a counter. Here, identical bytes genuinely ARE
     unchanged, and a delete-then-DIFFERENT-recreate is caught. */
  const { fingerprint } = await readCastForUpdate(dir);
  await rm(castJsonPath(dir), { force: true });
  await writeJsonAtomic(castJsonPath(dir), { characters: [{ id: 'zed' }] });
  await expect(assertCastUnchanged(dir, fingerprint)).rejects.toBeInstanceOf(CastStaleError);
});

it('detects a write made by a caller that never used these helpers', async () => {
  /* The other property a counter cannot have: soundness does not depend on
     universal adoption. A raw writeJsonAtomic still changes the bytes. */
  const { fingerprint } = await readCastForUpdate(dir);
  await writeJsonAtomic(castJsonPath(dir), { characters: [{ id: 'alice' }, { id: 'new' }] });
  await expect(assertCastUnchanged(dir, fingerprint)).rejects.toBeInstanceOf(CastStaleError);
});

it('derives the fingerprint from the same bytes it parses', async () => {
  /* Guards the single-read property. Two reads with an await between them would
     let a writer land in the gap, and the fingerprint would describe bytes other
     than the parsed ones — the window a revision counter had and this design
     exists to remove. Spy on readFile and assert exactly one call. */
  const spy = vi.spyOn(fsp, 'readFile');
  await readCastForUpdate(dir);
  expect(spy.mock.calls.filter(([p]) => String(p).endsWith('cast.json'))).toHaveLength(1);
  spy.mockRestore();
});

it('asserts a consulted book without writing it', async () => {
  const { fingerprint } = await readCastForUpdate(dir);
  await expect(assertCastUnchanged(dir, fingerprint)).resolves.toBeUndefined();
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd server && npx vitest run src/workspace/cast-io.test.ts`
Expected: FAIL — `Cannot find module './cast-io.js'`.

- [ ] **Step 3: Write the implementation**

```ts
/* Staleness detection for cast.json.
 *
 * The per-book lock (cast-lock.ts) makes one read-modify-write atomic. It cannot
 * help when the DECISION is read in one lock scope and the write lands in
 * another — analysis.ts's merge base, the clone-consent gates, the cross-book
 * consultations. Those need staleness to be DETECTABLE.
 *
 * A content fingerprint rather than a `rev` field on cast.json, deliberately
 * (design §14.1):
 *   - it is derived from the bytes you already read, so there is no separate
 *     capture step and no window between snapshot and capture to get wrong;
 *   - soundness does not depend on every writer participating — any write
 *     changes the bytes, whoever made it. A counter is "worse than none" if one
 *     writer skips the increment;
 *   - delete-then-recreate is handled honestly: identical bytes ARE unchanged.
 *
 * USED BY THE CROSS-SCOPE SITES ONLY (Tasks 14-16). The ~30 same-scope writers
 * read and write inside one cast lock, where nothing can interleave and this
 * comparison is inert — they keep readJson/writeJsonAtomic. Do not widen this.
 *
 * All three assume the caller holds the cast lock for `bookDir`.
 */
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { readJson, writeJsonAtomic } from './state-io.js';
import { castJsonPath } from './paths.js';

export class CastStaleError extends Error {
  constructor(readonly bookDir: string) {
    super(`cast.json for ${bookDir} changed under us since it was read.`);
    this.name = 'CastStaleError';
  }
}

/** Read the file's bytes once. `null` when absent — a real value, not a
 *  failure: "there was nothing here" is distinct from any content, which is what
 *  makes delete-then-recreate detectable. */
async function readBytes(bookDir: string): Promise<Buffer | null> {
  try {
    return await readFile(castJsonPath(bookDir));
  } catch {
    return null;
  }
}

const sha = (raw: Buffer | null): string | null =>
  raw === null ? null : createHash('sha256').update(raw).digest('hex');

export async function readCastForUpdate<T extends object>(
  bookDir: string,
): Promise<{ cast: T; fingerprint: string | null }> {
  /* ONE read. Hash and parse are both derived from the same Buffer.
     Hashing in one readFile and parsing in another would put an await between
     them and reintroduce the exact window this design exists to remove — a
     writer landing in the gap makes the fingerprint describe bytes that are not
     the ones we parsed, which is worse than no check at all because it reads as
     a guarantee. */
  const raw = await readBytes(bookDir);
  const cast = raw === null ? ({ characters: [] } as unknown as T) : (JSON.parse(raw.toString('utf8')) as T);
  return { cast, fingerprint: sha(raw) };
}

export async function assertCastUnchanged(
  bookDir: string,
  expected: string | null,
): Promise<void> {
  if (sha(await readBytes(bookDir)) !== expected) throw new CastStaleError(bookDir);
}

/** Write `next` if the file still matches `expected`. Returns the fingerprint of
 *  what was written, so a caller doing repeated writes (analysis.ts) can carry it
 *  forward without a re-read. */
export async function writeCastChecked<T extends object>(
  bookDir: string,
  next: T,
  expected: string | null,
): Promise<string | null> {
  await assertCastUnchanged(bookDir, expected);
  await writeJsonAtomic(castJsonPath(bookDir), next);
  return sha(await readBytes(bookDir));
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd server && npx vitest run src/workspace/cast-io.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add server/src/workspace/cast-io.ts server/src/workspace/cast-io.test.ts
git commit -m "feat(server): add cast.json staleness detection for cross-scope writers"
```

---

### Task 4: #2001 — the lock helpers' map cleanup has never run

**Files:**
- Modify: `server/src/workspace/file-lock.ts`
- Modify: `server/src/tts/design-lock.ts`
- Modify: `server/src/routes/chapters-restructure.ts`
- Modify: `server/src/workspace/cast-lock.test.ts`

**Interfaces:** no signature changes. Behaviour only.

- [ ] **Step 1: Write the failing test**

Append to `cast-lock.test.ts`:

```ts
import { __chainsSizeForTest } from './file-lock.js';

it('drops the map entry once the last holder settles', async () => {
  const before = __chainsSizeForTest();
  await withCastLock('/w/cleanup', async () => 'done');
  expect(__chainsSizeForTest()).toBe(before);
});
```

Add the accessor to `file-lock.ts`:

```ts
/** Test-only: the number of live chain entries. Used to pin the cleanup in
 *  Task 4 — NOT a partition detector (design §10.3 explains why that idea was
 *  rejected). */
export function __chainsSizeForTest(): number {
  return chains.size;
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd server && npx vitest run src/workspace/cast-lock.test.ts -t "drops the map entry"`
Expected: FAIL — received `before + 1`. (Not "1 vs 0": the six Task 2 tests
above have already leaked their own entries into the same map.) The cleanup is
dead code today.

- [ ] **Step 3: Fix all three helpers**

In `file-lock.ts`, hold a reference to the promise actually stored:

```ts
export async function withKeyLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prior = chains.get(key) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  /* `mine` is what goes in the map. The old code compared against `gate`, which
     is never what was stored, so this delete never ran and the map grew one
     entry per key for the process lifetime. */
  const mine = prior.then(() => gate, () => gate);
  chains.set(key, mine);
  await prior.catch(() => undefined);
  try {
    return await fn();
  } finally {
    release();
    if (chains.get(key) === mine) chains.delete(key);
  }
}
```

Apply the same shape to `withDesignLock` (`design-lock.ts`) and `withBookLock`
(`chapters-restructure.ts`). In `chapters-restructure.ts` the comparison
currently re-allocates a third promise inline (`bookWriteLock.get(bookId) ===
prev.then(() => next)`) — replace it with the stored reference.

**In `design-lock.ts`, change the cleanup and nothing else.** Do not touch
acquisition, release or ordering: `ensureCharacterVoiceUuid`'s series branch
still depends on that lock for its same-book double-mint guarantee (spec §5.1).

**In `chapters-restructure.ts`, re-derive the safety argument rather than
assuming it.** Its `await prev` sits *inside* the `try` and it omits the
`.catch()` swallow, so its control flow differs from `file-lock.ts`. State in the
commit message why the change is safe there.

Correct the three comments that claim the cleanup already works.

- [ ] **Step 4: Run to verify it passes**

Run: `cd server && npx vitest run src/workspace/ src/routes/chapters-restructure.test.ts`
Expected: PASS, no regressions.

- [ ] **Step 5: Commit**

```bash
git add server/src/workspace/file-lock.ts server/src/tts/design-lock.ts server/src/routes/chapters-restructure.ts server/src/workspace/cast-lock.test.ts
git commit -m "fix(server): make the promise-chain lock helpers actually free their map entries"
```

---

### Task 5: `POST /:voiceUuid/assign` — the filed defect (#1981)

**Files:**
- Modify: `server/src/routes/voice-library.ts` (the `POST /:voiceUuid/assign` handler)
- Modify: `server/src/routes/voice-library.test.ts`

**Interfaces:**
- Consumes: `withCastLock`, `withLibraryVoiceLock` (Task 2).

- [ ] **Step 1: Write the failing test**

In `voice-library.test.ts`, in a describe that does **not** call
`vi.resetModules()` between the two requests:

```ts
it('keeps both assignments when two /assign calls for one book overlap', async () => {
  /* Two different characters, one book. Unlocked, the later write replays a
     snapshot taken before the earlier one landed and drops it. */
  await Promise.all([
    request(app).post(`/api/voice-library/${uuidA}/assign`)
      .send({ bookId, characterId: 'alice' }),
    request(app).post(`/api/voice-library/${uuidB}/assign`)
      .send({ bookId, characterId: 'bob' }),
  ]);

  const cast = await readJson<CastJson>(castJsonPath(bookDir));
  const byId = Object.fromEntries((cast?.characters ?? []).map((c) => [c.id, c]));
  expect(byId.alice.overrideTtsVoices?.qwen?.libraryUuid).toBe(uuidA);
  expect(byId.bob.overrideTtsVoices?.qwen?.libraryUuid).toBe(uuidB);
});
```

Note `supertest`'s `Request` is lazy — `.send()` alone never dispatches. Inside
`Promise.all` it is awaited, so this is fine; do not restructure it into a form
that only builds the requests.

- [ ] **Step 2: Run to verify it fails**

Run: `cd server && npx vitest run src/routes/voice-library.test.ts -t "two /assign calls"`
Expected: FAIL — one character's `libraryUuid` is `undefined`.

- [ ] **Step 3: Apply the hoist and both locks**

Three changes to the handler:

1. **Hoist the manifest read** out of the RMW window. It depends only on
   `entry.provenance`, `voiceUuid` and `located.state` — all in hand once the
   book is located. Move the `readJson` of `qwenVoiceSidecarPath(...)` and the
   `sidecarLanguageName` call to just after the `located` null-check, keeping
   only the warning-**string** construction (which needs `character.name`, and is
   synchronous) at its current site.

2. **Wrap the RMW.** The cast `readJson` through `writeJsonAtomic` — including
   the character lookup, the 404, the clone-capable 409 and the
   `nextCharacters` build — goes inside `withCastLock(located.bookDir, …)`.
   Early `return res.status(...)` inside the callback is fine; the lock releases
   when the callback settles.

3. **Wrap in `withLibraryVoiceLock(voiceUuid, …)`, outside the cast lock — and
   it must start much higher than the cast RMW.** Rule 2 applies to *every* lock
   class, not just the cast lock: the read goes inside, and so does every
   decision derived from it. The decisions derived from the library entry are
   `readEntry` and its 404, the revoked-consent 409, and the
   `hasRetainedDesignedClip` readiness gate — all of which sit well above the
   cast read. The library-voice lock opens **before `readEntry`** and closes
   after the cast write.

   This is what makes Task 6 deterministic. `eraseLibraryVoiceArtifacts` deletes
   the entry directory, so with the 404 gate *inside* the lock a delete-first
   ordering makes the assign 404 cleanly; with it outside, the assign proceeds on
   an entry that is being erased underneath it and Task 6's assertion becomes a
   coin flip.

   Order matters and is not arbitrary: the DELETE path holds the library-voice
   key across `clearLibraryVoiceReferences`, which takes cast locks per book. Take
   them the other way round here and the two paths deadlock permanently.

Rewrite the invariant comment. It must say **the lock is the guarantee**, and
that the `await`-free window is now only a best-effort narrowing of unmeasured
size kept as insurance against a future writer that forgets to lock. Delete the
claim that a zero-`await` window is "effectively atomic" — it never was.

- [ ] **Step 4: Run to verify it passes**

Run: `cd server && npx vitest run src/routes/voice-library.test.ts`
Expected: PASS, no regressions.

- [ ] **Step 5: Mutation-verify**

Remove the `withCastLock` wrapper only, re-run the new test, confirm it goes red,
paste the output into the commit message, restore.

- [ ] **Step 6: Commit**

```bash
git add server/src/routes/voice-library.ts server/src/routes/voice-library.test.ts
git commit -m "fix(server): serialise the voice-library assign cast.json read-modify-write"
```

---

### Task 6: `DELETE /:voiceUuid` — close the erase-vs-assign race

**Files:**
- Modify: `server/src/routes/voice-library.ts` (the `DELETE /:voiceUuid` handler)
- Modify: `server/src/workspace/voice-library-usage.ts`
- Modify: `server/src/routes/voice-library.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
it('does not leave a dangling reference when an assign races a voice delete', async () => {
  /* The scan passes book B, then an assign plants a reference in B, then the
     artifacts are erased — leaving a character pointing at a libraryUuid whose
     files are gone. */
  await Promise.all([
    request(app).delete(`/api/voice-library/${uuid}?confirm=1`),
    request(app).post(`/api/voice-library/${uuid}/assign`)
      .send({ bookId, characterId: 'alice' }),
  ]);

  const cast = await readJson<CastJson>(castJsonPath(bookDir));
  const alice = cast?.characters?.find((c) => c.id === 'alice');
  const stillReferenced = alice?.overrideTtsVoices?.qwen?.libraryUuid === uuid;
  const artifactsGone = !existsSync(qwenVoicePtPath(`qwen-${uuid}`));
  /* Either the assign lost (no reference) or it won (artifacts still there).
     Never both. */
  expect(stillReferenced && artifactsGone).toBe(false);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd server && npx vitest run src/routes/voice-library.test.ts -t "dangling reference"`
Expected: FAIL — reference present and artifacts erased.

- [ ] **Step 3: Wrap scan → clear → erase in the library-voice lock**

Open `withLibraryVoiceLock(voiceUuid, …)` **before `readEntry` and its 404** —
symmetric with Task 5's assign side — and close it after
`eraseLibraryVoiceArtifacts`, spanning `scanLibraryVoiceUsage` and
`clearLibraryVoiceReferences`.

Starting it at `scanLibraryVoiceUsage` instead would leave a decision derived
from the library entry outside its own lock: rule 2's failure mode, in the very
PR that establishes rule 2, and not one of the four sanctioned carve-outs. Two
concurrent DELETEs are harmless in practice (the second erases nothing), but the
`high`-effort code-review gate will read an unreasoned exception as exactly that,
and symmetry costs nothing.

Task 5 already made `/assign` take the same key, which is what makes this bite.

In `voice-library-usage.ts`, `clearLibraryVoiceReferences` takes a
`withCastLock` per book **inside** its loop and **re-reads** the cast in there —
`walkConfirmedCasts()` yields an already-read `cast`, which is stale by the time
the body writes.

Do **not** change what the walker yields. `clearLibraryVoiceReferences` uses only
`bookDir` and `cast.characters`, so it can ignore the yielded `cast` entirely and
re-read `castJsonPath(bookDir)` inside its own lock. That leaves the walker's
signature and `scanLibraryVoiceUsage` (read-only, same walker) untouched.

This is `library-voice` → `cast`, matching rule 4.

- [ ] **Step 4: Run to verify it passes**

Run: `cd server && npx vitest run src/routes/voice-library.test.ts`
Expected: PASS.

- [ ] **Step 5: Mutation-verify, then commit**

```bash
git add server/src/routes/voice-library.ts server/src/workspace/voice-library-usage.ts server/src/routes/voice-library.test.ts
git commit -m "fix(server): hold a library-voice lock across voice delete scan, clear and erase"
```

---

### Task 7: Class 1 — the mechanical single-book sites

**Files (15 sites across 11 modules):**
- `cast-aliases.ts` ×3, `cast-create.ts`, `cast-merge.ts`, `cast-series-patch.ts`,
  `cast-design.ts` ×2, `voice-style.ts` ×2, `voice-override-linked.ts`,
  `book-state.ts` (the cast write in the save handler),
  `qwen-voice.ts` (`DELETE emotion-variant`), `cast-add-from-roster.ts`,
  `voice-library.ts` (`DELETE /assign`)
- Plus each module's colocated `*.test.ts`

`voice-library.ts`'s `POST /assign` (Task 5), `voice-library-usage.ts` (Task 6)
and `qwen-voice.ts`'s `promote-voice` (Task 8) are **not** in this task.

- [ ] **Step 1: Write one failing test per module, plus the cross-module spec**

Use the Task 5 shape: two concurrent requests to that route, each touching a
different character, assert both survive. One module registry per spec file.

**Additionally, one cross-module spec — this is a required deliverable.** Race
two *different* modules' write sites against the same book, e.g. `cast-aliases`'s
alias split concurrent with `voice-style`'s style write; assert both survive.
Every other spec here races a site against itself, which uses one import and one
key and therefore cannot detect a key mismatch *between* sites. This is the only
test in the suite that can. Put it in `server/src/workspace/cast-lock.race.test.ts`
alongside the primitive harness, not in either route's spec.

**Two modules cannot use the self-vs-self shape at all — race them cross-writer:**

- **`cast-design.ts`** — `cast-design.ts:648` gates on
  `inFlightByBook.get(bookId)`, so a second concurrent POST for the same book
  *attaches to the running job's SSE stream* rather than starting a second one.
  There is only ever one design writer per book. Race the job's
  `fresh`-read-through-write against a different module's writer on that book
  (`cast-aliases`), or drive the write helper directly rather than through the
  route.
- **`book-state.ts`** — its cast slice writes `body.patch` wholesale and is
  last-writer-wins **by contract**, so "two PUTs, different characters, both
  survive" stays red after the lock too. (Task 12 already reasons this out for
  its own test and picks a different writer; the same reasoning applies here.)
  What the lock actually protects is the **clone-consent guards** inside
  `preserveDesignedVoices`. The red→green test is: a cast PUT whose patch omits a
  character's `overrideTtsVoices`, raced against `/assign` planting one.
  Unlocked, the stale read means `preserveDesignedVoicesOnCastWrite` fails to
  fill the gap and the designed voice is erased; locked, the read lands after the
  write and it is restored.

- [ ] **Step 2: Run them and confirm each fails**

Run: `cd server && npx vitest run src/routes/cast-aliases.test.ts src/routes/cast-create.test.ts src/routes/cast-merge.test.ts src/routes/cast-series-patch.test.ts src/routes/cast-design.test.ts src/routes/voice-style.test.ts src/routes/voice-override-linked.test.ts src/routes/book-state.test.ts src/routes/qwen-voice.test.ts src/routes/cast-add-from-roster.test.ts src/routes/voice-library.test.ts`
Expected: each new test FAILS.

(`voice-library.test.ts` is in the list for the `DELETE /assign` site only —
`POST /assign` was Task 5.)

**Arithmetic check.** 15 sites here + 1 (Task 5, `POST /assign`) + 1 (Task 6,
`voice-library-usage`) + 1 (Task 8, `promote-voice`) + 8 (Task 9) + 2 (Task 10)
+ 2 (Task 11) = **30**, plus `analysis.ts`'s 5 in Task 14 = **35**. Every site is
covered; nothing is deferred. If your count differs, stop — the spec's §5
enumeration is the authority.

- [ ] **Step 3: Wrap each read..write span**

Exemplar — `cast-aliases.ts`, which every other site in this task mirrors:

```ts
return withCastLock(bookDir, async () => {
  /* Plain readJson/writeJsonAtomic, INSIDE the lock. cast-io.ts's staleness
     helpers are for the cross-scope sites only (Tasks 14-16) — here the read and
     the write are in one lock scope, so nothing can interleave and a staleness
     check would be inert. */
  const cast = await readJson<CastFile>(castJsonPath(bookDir));
  if (!cast?.characters?.length) {
    return res.status(409).json({ error: 'Book has no cast on disk yet. …' });
  }
  // … findIndex, 404s, build nextCharacters …
  await writeJsonAtomic(castJsonPath(bookDir), { ...cast, characters: nextCharacters });
  return res.status(200).json({ /* … */ });
});
```

**One shape change worth making while you are here:** spread the object you read
(`{ ...cast, characters }`) rather than writing a bare `{ characters }`. At least
20 of the 35 writers currently construct a fresh payload that silently drops
every other top-level field. Nothing depends on that today, but it is a trap
lying in wait for the next person who adds one.

Per-site notes:

- **`cast-merge.ts`** — the span is long and contains a
  `writeJsonAtomic(manuscriptEditsJsonPath(...))`. Leave that inner write where
  it is; it is a different file and the cast lock does not cover it.
- **`cast-design.ts`** — both sites already re-read a `fresh` cast immediately
  before writing. Lock from that `fresh` read through the write. **Do not remove
  the re-read**: the only other read is the loop-top one at `:263`, which sits
  above an LLM persona generation at `:273`, so writing from it would put a
  multi-second `await` inside the lock or the read outside it — both wrong.

  Known and accepted: the two idempotency `continue` guards (`:268`, `:269`) are
  evaluated against the *first* read, before the LLM persona generation at
  `:273`, so they stay stale and two concurrent runs can each generate a persona
  with the second overwriting the first. That is a sanctioned carve-out
  (spec §4), already recorded in §12 — **do not try to fix it here**, and do not
  extend the lock upward to cover the generation.
- **`book-state.ts`** — **the one site in this task that is not a wrap.** There is
  no cast read at the call site:

  ```ts
  const guarded = await preserveDesignedVoices(bookDir, body.patch);
  await writeJsonAtomic(castJsonPath(bookDir), await denormaliseCastReusedVoices(guarded));
  ```

  The read is inside `preserveDesignedVoices` (`book-state.ts:128-130`), and it
  feeds `rejectForeignCloneKeys` (`:135`) and `preserveClonedSlotsOnCastWrite`
  (`:140`) — both **clone-consent guards**. Wrapping only these two lines locks
  the write while the consent checks still read stale data, which is rule 2's
  named failure mode dressed as a conversion. **Lock must enclose the
  `preserveDesignedVoices` call and the write together.** Both `await`s go
  inside.
- **`cast-add-from-roster.ts`** — reads **both** books but writes only the
  source. Lock the **source** only. Do not use `withCastLocks`: it would widen a
  lock over a second book for a read-only consultation. The target read is a
  check-then-act and is a documented residual, not something to fix here.
- **`voice-override-linked.ts`** and **`cast-series-patch.ts`** — long spans; make
  sure the read at the top is inside, not just the write at the bottom.

  Both are also **cross-book check-then-act**, and that part is out of scope.
  `voice-override-linked` derives `canonicalVoiceId`, `sourceTokens`, the
  `inGroup` predicate and the whole `writes` list from the *source* book's
  snapshot and then writes *other* books via `applyToBook`;
  `cast-series-patch` derives `sourceChar` and `targets` from the source read
  plus `scanSeriesCharactersForBookId`. Lock each per-book read..write span.
  Do **not** attempt to make the cross-book derivation consistent — that is
  #2006.

- [ ] **Step 4: Run to verify they pass**

Run: `cd server && npm run test:server`
Expected: PASS.

- [ ] **Step 5: Mutation-verify each site**

For each of the 11 modules: remove that module's `withCastLock`, re-run its spec,
confirm red, restore. Record the list in the commit message. **A site whose test
stays green with the lock removed is a placebo — stop and investigate rather than
moving on.**

- [ ] **Step 6: Commit**

```bash
git add server/src/routes/cast-aliases.ts server/src/routes/cast-create.ts \
  server/src/routes/cast-merge.ts server/src/routes/cast-series-patch.ts \
  server/src/routes/cast-design.ts server/src/routes/voice-style.ts \
  server/src/routes/voice-override-linked.ts server/src/routes/book-state.ts \
  server/src/routes/qwen-voice.ts server/src/routes/cast-add-from-roster.ts \
  server/src/routes/voice-library.ts server/src/routes/*.test.ts
git commit -m "fix(server): serialise the single-book cast.json read-modify-writes"
```

Enumerate the files. `git add server/src/routes/` sweeps any concurrent session's
in-progress edits into this commit — a recurring incident in this repo.

---

### Task 8: `promote-voice` — narrow the lock, do not wrap the span

**Files:**
- Modify: `server/src/routes/qwen-voice.ts` (`promote-voice`)
- Modify: `server/src/routes/qwen-voice.test.ts`

This site is called out separately because the obvious conversion is wrong. Its
read..write span contains a `stat`, four `rm`s, three `rename`s, a `copyFile`,
and a **sidecar `fetch` with no `AbortSignal` and no timeout**. Wrapping the span
puts a network round-trip inside the hottest lock in the product: a hung sidecar
would stall every cast write for that book for minutes.

- [ ] **Step 1: Write the failing test**

Concurrent `promote-voice` and a `/assign` on a different character of the same
book; assert both survive.

**Stub the sidecar `fetch` first.** It is the one prologue in the sweep slow
enough to separate the two racers in wall-clock terms, so without a stub this
test will not go red and you will be looking at a placebo. Everything else about
the bare `Promise.all` harness holds here (see Task 1 Step 3).

Also give the character emotion variants in the fixture — the write is guarded
on `variants` being non-empty, so a variant-less character never writes cast.json
at all and there is nothing to race.

- [ ] **Step 2: Run to verify it fails**

Run: `cd server && npx vitest run src/routes/qwen-voice.test.ts -t "promote"`
Expected: FAIL.

- [ ] **Step 3: Re-read under a narrow lock**

The top-of-handler read is load-bearing throughout the span — `realVoiceId` comes
from `character.voiceUuid` and drives the 400 gate, the `stat` 409, the `rm`s,
the `rename`s, the `copyFile` and the evict payload; and `delete qwenSlot.variants`
mutates that same object *in place* before it is written. So the lock body is
given exactly. Replace the tail of the handler with:

```ts
/* Narrow by design. The artifact moves and the sidecar evict above stay OUTSIDE
   this lock: that fetch has no AbortSignal, so a hung sidecar would otherwise
   stall every cast write for this book. Global order: no other lock is held
   here (cast is last — see cast-lock.ts rule 4). */
await withCastLock(located.bookDir, async () => {
  const fresh = await readJson<CastFile>(castJsonPath(located.bookDir));
  const freshChar = fresh?.characters?.find((c) => c.id === characterId);
  if (!fresh || !freshChar) return; // deleted mid-promotion — artifacts already moved
  const freshSlot = freshChar.overrideTtsVoices?.qwen;
  /* KEEP this guard — it is the current behaviour (qwen-voice.ts:788) and it
     encloses the write. Without it every promote-voice writes cast.json and
     takes the lock even when the character has no emotion variants, which is
     the common path. Evaluated against the FRESH slot, per rule 2. */
  if (freshSlot?.variants && Object.keys(freshSlot.variants).length > 0) {
    staleVariantIds = Object.values(freshSlot.variants)
      .map((v) => v?.name)
      .filter((n): n is string => !!n);
    delete freshSlot.variants;
    await writeJsonAtomic(castJsonPath(located.bookDir), fresh);
  }
});
/* Teardown stays outside: filesystem work, and holding the lock across it
   reintroduces exactly the stall this narrowing avoids. */
for (const variantId of staleVariantIds) {
  await tearDownEmotionVariant(variantId);
}
```

Three things are deliberate and must not be "corrected":

- `staleVariantIds` is re-derived from `fresh`, not from the top-of-handler read.
  Hoist its declaration (`let staleVariantIds: string[] = []`) above the lock.
- **`realVoiceId` stays pinned to the pre-lock read.** By the time the lock is
  taken the artifacts have already been renamed to it, so re-deriving it from
  `fresh` would name files that do not exist. A concurrent write changing
  `voiceUuid` mid-promotion is a sanctioned residual (spec §4 carve-out, §12).
- The early `return` on a deleted character is a no-op, not a 404 — the response
  has not been sent yet at this point, and the artifacts have already moved.

- [ ] **Step 4: Run, mutation-verify, commit**

Run: `cd server && npx vitest run src/routes/qwen-voice.test.ts`

```bash
git add server/src/routes/qwen-voice.ts server/src/routes/qwen-voice.test.ts
git commit -m "fix(server): re-read cast.json under a narrow lock in promote-voice"
```

---

### Task 9: Class 2 — multi-book sites, plus the `library-cast-override` same-book bug

**Files:**
- Modify: `cast-link-prior.ts` (2 sites), `cast-not-linked-to.ts` (4 sites),
  `library-cast-override.ts` (2 sites), plus their `*.test.ts`

- [ ] **Step 1: Write the failing tests**

Two: (a) two concurrent two-book operations with the books in **opposite**
argument order — must complete, not deadlock; (b) the `library-cast-override`
same-book case below.

```ts
it('does not lose the source merge when source and target are the same book', async () => {
  /* Its guard rejects same-book AND same-character only, so same-book with two
     different characters is reachable — and broken with no concurrency at all:
     two independent reads of one file, two arrays derived from separate
     snapshots, two writes to the same path. nextTargetCharacters is derived
     from the PRE-merge targetCast read, so the second write puts alice back
     unmodified and her merge is gone.

     Assert on `aliases`. This route never touches overrideTtsVoices — it merges
     description, role, gender, ageRange, tone, attributes and aliases — so an
     overrideTtsVoices assertion would pass before and after and prove nothing. */
  await request(app).post('/api/library-cast-override')
    .send({ sourceBookId: bookId, sourceCharacterId: 'alice',
            targetBookId: bookId, targetCharacterId: 'bob' })
    .expect(200);

  const cast = await readJson<CastFile>(castJsonPath(bookDir));
  const byId = Object.fromEntries((cast?.characters ?? []).map((c) => [c.id, c]));
  /* alice's merge takes bob's name into her alias pool. Red today: alice is
     written back from the pre-merge snapshot. */
  expect(byId.alice.aliases).toContain(bobName);
  expect(byId.bob.aliases).toContain(aliceName);
});
```

- [ ] **Step 2: Run to verify they fail**

Expected: the same-book test FAILS today even single-threaded.

- [ ] **Step 3: Apply `withCastLocks` and fix same-book**

Wrap each handler's read..write span in `withCastLocks([a.bookDir, b.bookDir], …)`.

In `library-cast-override.ts`, add a same-book branch: one read, both merges
applied to that single array, one write. `withCastLocks` dedupes so it will not
deadlock, but dedupe alone leaves the data loss — it just puts a lock around it.

- [ ] **Step 4: Run, mutation-verify, commit**

```bash
git add server/src/routes/cast-link-prior.ts server/src/routes/cast-not-linked-to.ts \
  server/src/routes/library-cast-override.ts \
  server/src/routes/cast-link-prior.test.ts server/src/routes/cast-not-linked-to.test.ts \
  server/src/routes/library-cast-override.test.ts
git commit -m "fix(server): lock multi-book cast writes in sorted order and fix the same-book merge"
```

---

### Task 10: Class 3 — `voices.ts`'s two fan-out branches

**Files:**
- Modify: `server/src/routes/voices.ts` (`forEachMatchingCastCharacter`)
- Modify: `server/src/routes/voices.test.ts`

Both branches write, and **both need locking**:

- `:816-829`, the workspace/series walk (write at `:828`) — live for every
  **series** book. `cast-design.ts` and `single-design.ts` pass `seriesFilter`
  *and* `job.bookDir`, so the `onlyBookDir` fast path is bypassed for them.
  Three more callers never pass `onlyBookDir` at all.
- `:788-803`, the `onlyBookDir` fast path (write at `:801`) — standalone books.

- [ ] **Step 1: Write the failing tests** — one per branch: concurrent
  propagation and a direct cast write to a book in the match set; both survive.

- [ ] **Step 2: Run to verify both fail.**

- [ ] **Step 3: Lock per book inside each branch**, with the `readJson` moved
  inside. Do **not** wrap the whole walk — that would hold a lock on every book
  in the workspace across a full directory scan (spec §3.2).

Rule 1 check: `forEachMatchingCastCharacter` is now a locked leaf, so no caller
may wrap it in a cast lock for the same book. Task 11 depends on this.

- [ ] **Step 4: Run, mutation-verify both branches separately, commit.**

```bash
git add server/src/routes/voices.ts server/src/routes/voices.test.ts
git commit -m "fix(server): lock each book of the voices fan-out as it is written"
```

---

### Task 11: Class 4 — the `qwen-voice.ts` re-entrancy restructure

**Files:**
- Modify: `server/src/routes/qwen-voice.ts`
  (`ensureCharacterVoiceUuid`, `persistEmotionVariant`)
- Modify: `server/src/routes/qwen-voice.test.ts`

The highest-risk task. Both functions have two branches; only the **book-scoped**
one takes a cast lock. The **series** branch delegates to
`forEachMatchingCastCharacter`, which after Task 10 locks per book itself —
wrapping it here would violate rule 1 and self-deadlock the moment the walk
reaches this book.

- [ ] **Step 1: Write the failing tests — and NOT as a self-vs-self race**

`ensureCharacterVoiceUuid`'s entire body — read, decide, mint, write — is
**already inside `withDesignLock(bookDir)`**. Two concurrent calls on one book
are serialised today, so neither "no double-mint" nor "no lost sibling write"
can fail, before or after this task. Writing the usual two-concurrent-calls test
here produces a green test that proves nothing, and Task 1 Step 3's advice
("a red-phase test that will not go red is a harness problem") would then send
you hunting a harness bug that does not exist.

Race it against a writer that does **not** hold the design lock:

- **`ensureCharacterVoiceUuid`** vs a `cast-aliases` route call on the same book.
  Assert the alias mutation survives. Red today: the uuid write replays a
  snapshot taken before the alias write landed.
- **`persistEmotionVariant`** has no design lock at all, so the ordinary
  self-vs-self shape *is* valid there. The two functions are not symmetric and
  the plan does not treat them as such.

- [ ] **Step 2: Run to verify they fail.**

- [ ] **Step 3: Split each function**

For **both**: the book-scoped branch takes `withCastLock(bookDir, …)` and
**re-reads inside it**, then re-evaluates every decision and re-derives every
value that feeds the write — re-check `voiceUuid`, re-derive `qwenStorageKey`.
The outer read becomes an early-out optimisation and is never authoritative.
`persistEmotionVariant` in particular computes `baseVoiceId` from the outer read
and bakes it into the payload as the default slot name; that derivation must move
inside.

The series branch is left unlocked and delegating.

**Do not remove `withDesignLock` from `ensureCharacterVoiceUuid`.** It is still
what prevents the same-book double-mint on the series branch, where the decision
precedes the branch and no cast lock can reach it. (Across two books of one
series it does not help — pre-existing, tracked on #2006. Do not try to fix that
here.)

- [ ] **Step 4: Run the full server suite**

Run: `cd server && npm run test:server && npm run test:server-slow`
Expected: PASS. This task can deadlock rather than fail an assertion — if a spec
hangs, suspect a cast lock enclosing `forEachMatchingCastCharacter`.

- [ ] **Step 5: Mutation-verify, commit.**

```bash
git add server/src/routes/qwen-voice.ts server/src/routes/qwen-voice.test.ts
git commit -m "fix(server): lock the book-scoped voice-uuid and emotion-variant writes"
```

---

### Task 12: Class 6 — the two delete sites

**Files:**
- Modify: `server/src/routes/analysis.ts` (the "Start fresh" `rm`)
- Modify: `server/src/routes/book-state.ts` (the reparse `rm`, inside a `Promise.all`)
- Modify: their `*.test.ts`

These destroy cast.json and match neither the write pattern nor the guard's.
They matter because a delete that is not serialised against the writers can
simply be undone: a writer that acquires *after* the delete recreates cast.json,
resurrecting the stale roster the delete exists to remove.

(An earlier draft said the lock "lengthens the gap between a queued writer's read
and its write". That is wrong and the spec retracts it — `file-lock.ts:12-14`
awaits `prior` before `fn()`, so under rule 2 a queued writer's *read* happens
after the holder's write. Do not reintroduce the claim.)

**This task touches only the `rm`.** `analysis.ts`'s five *write* sites are
converted in Task 14, not here — keep the two changes separate so each is
reviewable on its own.

- [ ] **Step 1: Write the failing test** — a delete concurrent with a cast write;
  assert the file stays deleted.

  **Name the writer deliberately.** Use a rule-2-compliant one that re-reads
  inside its lock and refuses on an absent cast — `cast-aliases.ts` returns 409
  "Book has no cast on disk yet", so it leaves the file deleted in both
  orderings once serialised. Do **not** use `book-state.ts`'s cast-slice
  handler: it writes `body.patch` regardless of on-disk state and legitimately
  recreates cast.json when it acquires second, so the assertion would be
  ordering-dependent rather than lock-dependent.
- [ ] **Step 2: Run to verify it fails.**
- [ ] **Step 3: Wrap each `rm` in `withCastLock(bookDir, …)`.** In
  `book-state.ts` the `rm` is one arm of a `Promise.all`; wrap that arm.
- [ ] **Step 4: Run, mutation-verify, commit.**

```bash
git add server/src/routes/analysis.ts server/src/routes/book-state.ts
git commit -m "fix(server): take the cast lock when deleting cast.json"
```

---

### Task 13: The guard test

**Files:**
- Create: `server/src/workspace/cast-lock.guard.test.ts`

- [ ] **Step 1: Write it**

Walk `server/src/**/*.ts` (excluding `*.test.ts`). For each file containing
`castJsonPath`, assert every `writeJsonAtomic(castJsonPath(` and
`rm(castJsonPath(` occurrence sits inside a `withCastLock` / `withCastLocks`
scope.

**Use a brace-depth scan, and say so.** For each occurrence, walk backwards to
the nearest enclosing `withCastLock(` / `withCastLocks(` / `withSeriesLock(`
call and confirm the occurrence is inside its brace range. A file-level
heuristic ("does this module mention `withCastLock`?") is not sufficient — it
cannot resolve *per-occurrence* lockedness, which is exactly what a 6000-line
module like `analysis.ts` requires, and a guard that cannot do that is
decorative.

**Acceptance target, stated concretely:** on the finished branch the guard
reports **zero** unlocked occurrences in every file, including `analysis.ts`
(whose five writes are revision-checked and locked by Task 14). Maintain an
explicit allowlist with a reason per entry:

```ts
/* Empty by design. Every cast.json write and delete in the tree is locked and
   revision-checked after Task 14, so there is nothing to exempt.

   An earlier draft carried an allowlist entry for analysis.ts's five deferred
   writes. Keep this map empty rather than deleting the mechanism: if a future
   change needs an exemption it must be keyed on file AND expected count, never
   on file alone — a file-level exemption for analysis.ts would also have
   blinded the guard to the one rm that IS locked, which is the exact hole spec
   §5 class 6 exists to close. */
const ALLOWED_UNLOCKED = new Map<string, { writes: number; rms: number; why: string }>();
```

The guard checks **lockedness only**. It must NOT also require
`writeCastChecked`: that rule belonged to the revision-counter design, whose
soundness depended on universal adoption, and it would fail on `cast-io.ts`
itself — the sanctioned helper writes `writeJsonAtomic(castJsonPath(...))` inside
no lock scope, because its callers hold the lock. Exclude `workspace/cast-io.ts`
from the walk by name, with that reason in a comment.

Document the known blind spots in the file header: it sees one syntactic form, so
`const p = castJsonPath(dir); await writeJsonAtomic(p, …)` slips through, as
would a writer routed via `workspace/schema-migrate.ts`'s cast.json seam.

- [ ] **Step 2: Verify it catches a real regression**

Temporarily unwrap one converted site, run the guard, confirm it fails naming that
file. Restore.

- [ ] **Step 3: Confirm CI wiring — do not add an `extraFiles` entry**

The guard reads `server/src/**`, which `test:server` already globs and
`verify.yml` already matches, so any diff adding an unlocked site busts both
caches. An `extraFiles` entry would be a no-op.

Verify: `node scripts/verify-cache.mjs --steps test:server` picks up a change to
a converted route.

- [ ] **Step 4: Commit**

```bash
git add server/src/workspace/cast-lock.guard.test.ts
git commit -m "test(server): fail the build on an unlocked cast.json write"
```

---

### Task 14: `analysis.ts` — a revision-checked merge base (closes #2015)

**Files:**
- Modify: `server/src/routes/analysis.ts` (the 5 cast writes; **not** the `rm`,
  which Task 12 did)
- Modify: `server/src/routes/analysis.test.ts`

`priorCastForMerge` is read once near the top of a run and is the merge base for
writes minutes later. Holding a lock for the run was rejected (blocks every other
cast write on that book, unbounded); re-reading blind was rejected (iteration N
would merge against what N−1 wrote, degrading srv-13 carry-forward). The counter
is the third option: **keep replaying the snapshot, but check it, and overlay
concurrent edits only when it actually moved.**

> **Read spec §14.4 before writing any code in this task.** The obvious
> implementation re-breaks the 2026-07-14 Coalfall voice-strip on *every* "Start
> fresh" run, and the obvious test does not catch it.

- [ ] **Step 1: Write BOTH failing tests**

The second one is the important one.

```ts
it('does not discard a cast edit made during an analysis run', async () => {
  /* Assert on ALIASES, not on `name`. mergeAnalysisResultWithExistingCast
     overlays the base's VOICE-DESIGN fields onto the freshly-analysed roster and
     UNIONS aliases (see its docstring) — `name` comes from the fresh analysis,
     which re-derives it from the manuscript. A name assertion cannot go green on
     a correct implementation, and "fixing" it would mean weakening the test or
     changing merge semantics. */
  const run = startAnalysis(bookId);
  await waitForFirstInterimWrite();
  await request(app).post('/api/cast/aliases')
    .send({ bookId, characterId: 'alice', alias: 'The Coalfall Widow' });
  await run;
  const cast = await readJson<CastJson>(castJsonPath(bookDir));
  expect(cast?.characters?.find((c) => c.id === 'alice')?.aliases)
    .toContain('The Coalfall Widow');
});

it('keeps bespoke designed voices across a Start-fresh re-analysis', async () => {
  /* THE regression guard for the 2026-07-14 Coalfall voice-strip. Start fresh
     rm's cast.json, which resets the on-disk rev to 0 — so a rev captured
     alongside priorCastForMerge (i.e. ABOVE the rm) guarantees a conflict on the
     first interim write, and a rebuild that re-reads the deleted file gets an
     empty base. mergeAnalysisResultWithExistingCast short-circuits on an empty
     base and returns the fresh roster unmerged: every designed voice gone.
     This test fails on that implementation and passes on the correct one. */
  await giveCharacterADesignedVoice(bookDir, 'alice');
  await runAnalysis(bookId, { fresh: true });
  const cast = await readJson<CastJson>(castJsonPath(bookDir));
  const alice = cast?.characters?.find((c) => c.id === 'alice');
  expect(alice?.overrideTtsVoices?.qwen?.name).toBeDefined();
});
```

- [ ] **Step 2: Run to verify both fail**

Run: `cd server && npx vitest run src/routes/analysis.test.ts -t "cast edit made during"`
Run: `cd server && npx vitest run src/routes/analysis.test.ts -t "Start-fresh"`

The second must be verified red against a **deliberately wrong** implementation:
rebuild by plain re-read (base = whatever is on disk). If
it passes there, the test is not pinning what it claims and the whole task is
unguarded.

- [ ] **Step 3: Fingerprint with the snapshot; never rebuild to an empty base**

Three requirements, from spec §14.4:

1. **Capture the fingerprint from the same read as `priorCastForMerge`** — same
   bytes, same instant, nothing between them. This is where the revision-counter
   design failed: a counter needs a separate capture step, and the yields between
   the snapshot read and any post-`rm` capture point (`pruneStaleReuseLinks`,
   `loadAnalysisCache`) were a hole a concurrent writer could land in.
2. **The rebuild may never replace a non-empty prior with an empty base.** When
   the re-read is empty, the retained `priorCastForMerge` *is* the base. The
   rebuild overlays concurrent edits onto the prior; it never substitutes.
3. **Re-apply the load-point healers on the rebuild path** —
   `dropReuseContinuityKeepDesignedVoice`, `pruneStaleReuseLinks`,
   `dedupePriorCastByName`, `seedReuseGuardsFromPriorCast`,
   `applyRewriteToPriorCast`. Their comment says they run "at the single load
   point, so all cast.json write sites see one prior row per name"; a rebuild
   that skips them reintroduces the duplicate-by-name rows they collapse.

Shape for each of the five writes — read, decide and write in **one** lock
acquisition, so `writeCastChecked` cannot conflict and there is no retry loop:

```ts
await withCastLock(bookDir, async () => {
  const { cast: onDisk, fingerprint } = await readCastForUpdate<CastFile>(bookDir);
  const base =
    fingerprint === capturedFingerprint
      ? priorCastForMerge
      : rebuildBase(priorCastForMerge, onDisk.characters ?? []);
  capturedFingerprint = await writeCastChecked(
    bookDir,
    { ...onDisk, characters: mergeAnalysisResultWithExistingCast(base, freshRows) },
    fingerprint,
  );
});
```

`rebuildBase(prior, current)` returns `prior` unchanged when `current` is empty,
and otherwise overlays `current`'s rows onto `prior` by id — preserving `prior`'s
voice fields wherever `current` lacks them — then re-runs the healers.

**A conflict must never fail the run.** A user renaming a character mid-analysis
is normal. Log the rebuild at info so it is observable.

- [ ] **Step 4: Run, mutation-verify, commit**

Mutation-verify by replacing the rebuild path with a plain re-read (base =
whatever is on disk) and confirming the Start-fresh test goes red. Paste that
output into the commit message.

```bash
git add server/src/routes/analysis.ts server/src/routes/analysis.test.ts
git commit -m "fix(server): rebuild the analysis merge base when cast.json moved under it"
```

---

### Task 15: The three clone-consent gates (closes #2006, part 1)

**Files:**
- Modify: `server/src/routes/voices.ts`, `server/src/routes/single-design.ts`,
  `server/src/routes/qwen-voice.ts`
- Modify: their `*.test.ts`

Each reads cast.json, decides a 409, and writes in a different scope. Spec §14.2
gives one rule in three shapes — this task applies it.

- [ ] **Step 1: Write the failing tests** — one per gate: take the 409 decision,
  plant a cloned slot before the write lands, assert the write does not silently
  overwrite it.

- [ ] **Step 2: Run to verify all three fail.**

- [ ] **Step 3: Thread the revision through each**

- **`voices.ts` `PUT /:voiceId/override`** — `hasClonedSlotAmongMatches` records
  each matching book's rev as it walks. Note it **early-returns `true`** on the
  refusal path, so it does not walk the full set then; only the pass path yields
  a complete rev map.

  At write time, per book: if the fingerprint is unchanged, write. If it moved,
  **re-run the clone-consent predicate on the fresh read** — if the book is still
  clean, adopt the new fingerprint and continue; only a *newly planted cloned slot* is a
  genuine refusal. Aborting on any change would turn a whole-workspace override
  from an operation that always completes into one that fails at the
  concurrent-edit rate, and its failure state — the new voice in some books, the
  old in others — is the exact split the propagation exists to prevent.

  On a genuine refusal: `409 { code: 'cast-changed', written: [...] }` naming the
  books already written. **Partial application is reported, not prevented** —
  cross-book atomicity needs the workspace-wide lock §3.2 rejected (§14.3).
- **`single-design.ts`** — records the fingerprint at its `characterHasClonedSlot` gate;
  `runSingleDesign` passes it through to the write. It has already flushed SSE
  headers, so a conflict cannot 409: log it, skip the write, and surface it in
  `endJob({ type: 'error', code: 'cast-changed' })`.
- **`qwen-voice.ts`** — same, through `persistEmotionVariant`. Add an optional
  `expectedFingerprint` parameter: the JSON route passes it and maps a conflict to a 409;
  the SSE bulk caller passes it and reports via `endJob`. **Do not** make the
  helper decide which — it has two callers with two response channels, and that
  is exactly why §6 rejected a blanket 409.

**The `forEachMatchingCastCharacter` signature change belongs in Task 10, not
here.** It is the function that actually performs both writes (`:801` fast path,
`:828` walk), and it has five callers — `applyOverrideToCastFiles`,
`applyTierToCastFiles` (from `cast-tier.ts`), `persistEmotionVariant` and
`ensureCharacterVoiceUuid` — three of which have no rev to supply. Add
`expectedFingerprints?: Map<string, string | null>` there, defaulting to "no
assertion" when a book is absent from the map, so Task 10 lands the signature and
this task only populates it.

- [ ] **Step 4: Run, mutation-verify each gate separately, commit**

```bash
git add server/src/routes/voices.ts server/src/routes/single-design.ts \
  server/src/routes/qwen-voice.ts server/src/routes/voices.test.ts \
  server/src/routes/single-design.test.ts server/src/routes/qwen-voice.test.ts
git commit -m "fix(server): revision-check the clone-consent gates before their writes"
```

---

### Task 16: The three cross-book consultations (closes #2006, part 2)

**Files:**
- Modify: `server/src/routes/cast-link-prior.ts`,
  `server/src/routes/voice-override-linked.ts`,
  `server/src/routes/cast-series-patch.ts`,
  `server/src/routes/cast-add-from-roster.ts`
- Modify: their `*.test.ts`

All three derive something from **another book's** cast and write it elsewhere:
`cast-link-prior` copies the target's `overrideTtsVoices` (including a
`libraryUuid` it never names) into the source; `voice-override-linked` derives
`canonicalVoiceId`, `sourceTokens`, `inGroup` and its whole `writes` list from
the source snapshot; `cast-series-patch` derives `sourceChar` and `targets` the
same way.

- [ ] **Step 1: Write the failing tests** — mutate the consulted book between the
  read and the write; assert the operation detects it rather than writing a
  decision made against data that no longer exists.

- [ ] **Step 2: Run to verify all three fail.**

- [ ] **Step 3: Record and assert the consulted revision**

Each records the fingerprint of every book it *reads to decide*, not only the ones it
writes. The consulted book is asserted with **`assertCastUnchanged`** (Task 3) while
its lock is held via `withCastLocks`; the written book is asserted by
`writeCastChecked` as usual. `writeCastChecked` alone cannot do this — it asserts
only the book it writes, which is not the book these sites consulted.

A conflict is a `409 { code: 'cast-changed' }` — all are HTTP handlers that have
not responded yet, so the refusal is expressible.

**Include `cast-add-from-roster.ts`.** It reads the target book to decide a
source write, which is the same shape, and spec §12 claims it is closed by §14 —
so either it is converted here or that claim is false. It is the fourth file in
this task.

`cast-link-prior` is the one that also closes a `library-voice` hole: it plants
references to uuids it cannot know up front, so it cannot take that key. The
revision check is what makes the plant safe instead.

- [ ] **Step 4: Run, mutation-verify, commit**

```bash
git add server/src/routes/cast-link-prior.ts server/src/routes/voice-override-linked.ts \
  server/src/routes/cast-series-patch.ts server/src/routes/cast-link-prior.test.ts \
  server/src/routes/voice-override-linked.test.ts server/src/routes/cast-series-patch.test.ts
git commit -m "fix(server): revision-check the cross-book cast consultations"
```

---

### Task 17: The series lock — the cross-book double-mint (closes #2006, part 3)

**Files:**
- Modify: `server/src/workspace/cast-lock.ts` (add `withSeriesLock`)
- Modify: `server/src/workspace/cast-lock.test.ts`
- Modify: `server/src/routes/qwen-voice.ts` (`ensureCharacterVoiceUuid`)
- Modify: `server/src/routes/qwen-voice.test.ts`

The one residual §14's staleness check provably cannot reach. Two bulk designs on
two books of one series each read their **own** book, each see no `voiceUuid`,
each mint. The propagation then re-reads every book under its own lock, so every
write is against a current revision and is therefore "valid" — the staleness is
in a decision taken **before any file is read**, and no per-file counter can
encode it.

- [ ] **Step 1: Write the failing test**

```ts
it('mints one voiceUuid when two books of a series design the same identity', async () => {
  /* Both books carry the same linked identity (voiceId ?? id). Concurrent bulk
     designs each mint today, and the series ends up split across two uuids. */
  await Promise.all([
    ensureCharacterVoiceUuid(bookADir, 'narrator', seriesFilter),
    ensureCharacterVoiceUuid(bookBDir, 'narrator', seriesFilter),
  ]);
  const a = await readJson<CastFile>(castJsonPath(bookADir));
  const b = await readJson<CastFile>(castJsonPath(bookBDir));
  const uuidA = a?.characters?.find((c) => c.id === 'narrator')?.voiceUuid;
  const uuidB = b?.characters?.find((c) => c.id === 'narrator')?.voiceUuid;
  expect(uuidA).toBeDefined();
  expect(uuidA).toBe(uuidB);
});
```

- [ ] **Step 2: Run to verify it fails**

Expected: FAIL — two different uuids.

**This test is only reliably red after Task 10 lands.** Today the two
propagations race whole-file and one usually wins outright, so both books often
converge on a single uuid and the test is green for the wrong reason. Per-book
locking (Task 10) is what makes the split observable. Task 1's determinism
measurement does not transfer here — that was two reads issued in one tick, and
this is two nested workspace walks. If it is flaky, drive the two calls through a
barrier rather than weakening the assertion.

- [ ] **Step 3: Add `withSeriesLock` and wrap the series branch**

```ts
/** Hold the series lock for one author/series pair.
 *
 *  Position in the global order: design -> SERIES -> library-voice -> cast.
 *  Exists for one reason — every design gate keys on bookDir (withDesignLock,
 *  isDesignBusy, cast-design's inFlightByBook) while a linked-cast propagation
 *  is series-wide, so two books of one series can each decide "no voiceUuid
 *  yet" and each mint. That decision precedes any file read, so the cast.json
 *  staleness check cannot see it — there is no file whose content encodes it. */
export function withSeriesLock<T>(
  author: string,
  series: string,
  fn: () => Promise<T>,
): Promise<T> {
  /* Encode both components — neither can contain '/' on disk today (both are
     directory names under BOOKS_ROOT), but §3.1 insists key derivation be
     unambiguous rather than incidentally safe. */
  return withKeyLock(`series:${encodeURIComponent(author)}/${encodeURIComponent(series)}`, fn);
}
```

**Wrap the whole function body, not "the series branch".** The `voiceUuid` check
and the mint sit *above* the branch (spec §5.1); the series branch contains only
the propagation. Wrapping the branch would leave both racers deciding and minting
outside the lock and serialise two propagations of two *different* uuids — the
split-uuid outcome unchanged, under a lock that reads as the fix.

```ts
return withDesignLock(bookDir, () =>
  seriesFilter
    ? withSeriesLock(seriesFilter.author, seriesFilter.series, body)
    : body(),
);
```

where `body` is the existing read → decide → mint → propagate. Standalone books
take the book-scoped path and need no series key.

Ordering: the call already sits inside `withDesignLock` (`qwen-voice.ts:193`) and
the propagation takes cast locks, so this becomes `design → series → cast` —
consistent with rule 4, not a new constraint on it. Add a primitive test pinning
that a series lock may be taken while a design lock is held but never the
reverse.

- [ ] **Step 4: Run the full server suite**

Run: `cd server && npm run test:server && npm run test:server-slow`
Expected: PASS. Like Task 11, this task can hang rather than fail an assertion —
if a spec times out, suspect a series lock taken while a cast lock is held.

- [ ] **Step 5: Mutation-verify, commit**

```bash
git add server/src/workspace/cast-lock.ts server/src/workspace/cast-lock.test.ts \
  server/src/routes/qwen-voice.ts server/src/routes/qwen-voice.test.ts
git commit -m "fix(server): mint a series voiceUuid under a series lock"
```

---

### Task 18: Docs, notes and ticket hygiene

**Files:**
- Create: `docs/features/<n>-cast-json-write-lock.md` (from `docs/features/TEMPLATE.md`)
- Modify: `docs/features/INDEX.md`
- Modify: `CLAUDE.md` (*Conventions worth preserving*)
- Modify: `docs/release-notes-next.md`, `RELEASE_NOTES.md`
- Modify: `docs/superpowers/specs/2026-07-31-cast-json-write-lock-design.md` (status)

Walk CLAUDE.md's Before-shipping checklist and discharge every step explicitly.
Steps 1 and 4 were silently omitted from an earlier draft of this plan; the
checklist's own escape hatch is conditional — skipping is fine, *saying nothing*
is not.

- [ ] **Step 1: Create the regression plan (checklist step 1)**

This is substantial cross-cutting work introducing a codebase-wide invariant, so
it needs a durable `docs/features/` plan, not just the issue bodies. Scan the
worktrees for the next free plan number first (concurrent sessions claim them).
Record: the invariant and its four rules, the four lock classes and their order,
all 35 locked sites, the staleness check and what it does *not* reach (the
client full-document PUT), and a manual acceptance walkthrough.

**Pick the walkthrough carefully.** "Two browser tabs editing one book's cast,
both edits surviving" describes `PUT /:bookId/state`, which writes the client's
whole characters array and is explicitly outside the counter's reach (spec
§14.3) — that walkthrough would fail. Use instead: a bulk "Design full cast" job
running while the user renames a character in another tab; the rename survives
and the designed voices land.

- [ ] **Step 2: Update `docs/features/INDEX.md` (checklist step 4)**

New entry under its area.

- [ ] **Step 3: Add the convention to CLAUDE.md**

One bullet with the four rules from `cast-lock.ts`'s header, including the
four-class lock order, and one line pointing at `cast-io.ts` for the revision
counter.

- [ ] **Step 3b: openapi.yaml and the client retry**

Tasks 15/16 add a new refusal to `PUT /api/voices/{voiceId}/override`,
`cast-link-prior`, `voice-override-linked` and `cast-series-patch`. `openapi.yaml`
is the documented source of truth for backend shapes, so:

- Add `409 { code: 'cast-changed' }` to each of those four route blocks. While
  there, document the two 409s `voices.ts` already returns and never declared.
- Add the SSE terminal payload `endJob({ type: 'error', code: 'cast-changed' })`
  for `single-design`.
- **Handle it client-side.** Spec §14.2 says the caller "retries against fresh
  state" — that is a claim about behaviour nobody has implemented. Either add the
  refetch-and-retry in `src/lib/api.ts`, or change §14.2 to say the user sees an
  actionable error and retries manually. Do not leave the doc asserting a retry
  the product does not perform.

- [ ] **Step 4: Release notes, both files (checklist step 5)**


`docs/release-notes-next.md` — technical, PR-ref'd. `RELEASE_NOTES.md` — one
user-facing line in brand voice. The user-visible delta is real: concurrent cast
edits no longer silently discard one another.

Do **not** claim cast.json is *fully* protected. It is not: the counter does not
survive a delete, and it does not reach the client full-document PUT (spec
§14.3). Both are properties, not debt — but the release note must not overstate
them either way.

- [ ] **Step 5: Discharge the remaining checklist steps in the PR body**

State each explicitly rather than omitting it:

- **Step 3, on-box acceptance — N/A.** No hardware-only behaviour; every claim
  here is provable in-process by the outcome tests. No register row is owed.
- **openapi.yaml — REQUIRED, see Step 3b.** Tasks 15 and 16 add
  `409 { code: 'cast-changed' }` to four documented routes. (This N/A claim was
  false in an earlier draft, written before those tasks existed.)
- **Frontend — REQUIRED, see Step 3b.**
- **e2e — N/A.** The behaviour is server-side concurrency; it crosses no
  router/redux/layout seam, so Playwright cannot observe it. The two-tab
  walkthrough in the regression plan is the manual equivalent.

- [ ] **Step 6: Close the deferred issues, and check nothing new was filed**

#2006 and #2015 are closed by this PR (Tasks 14–17), not carried. Before opening
it, re-read spec §16: what remains in §12 must be **properties of the design**
(in-process only, `promote-voice`'s pinned `realVoiceId`, per-book propagation
atomicity, `cast-design`'s pre-LLM idempotency guards) and not outstanding work.
If any item there reads as a to-do, it either needs a task in this plan or an
explicit sentence saying why it is inherent. A residual list nobody intends to
action is the thing this fold exists to remove.

- [ ] **Step 7: Commit**

```bash
git add CLAUDE.md docs/release-notes-next.md RELEASE_NOTES.md \
  docs/features/ docs/superpowers/specs/
git commit -m "docs(docs): record the cast.json lock convention and release notes"
```

---

## Before opening the PR

- [ ] `npm run verify:fast:branch`
- [ ] `cd server && npm run test:server && npm run test:server-slow`
- [ ] `npm run typecheck` — **run this explicitly.** Vitest and pre-commit are
      both blind to type errors, so a task that left one will otherwise reach CI.
- [ ] `npx madge --circular --extensions ts server/src` — still 15 cycles.
      `cast-lock.ts` is a leaf under `workspace/`; if the count moved, a route
      module was imported from it.
- [ ] PR body: `Closes #1981`, `Closes #2000`, `Closes #2001`, `Closes #2006`,
      `Closes #2015`. Declare Task 9's `library-cast-override` same-book fix and
      Task 4's #2001 fix under "Also fixed, found in passing".
- [ ] Mandatory `code-review` pass at `high` effort — multi-scope, 17 modules.
