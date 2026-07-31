# cast.json write lock — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Serialise every cast.json read-modify-write behind a per-book lock, so
two concurrent writers can no longer silently discard each other's mutation.

**Architecture:** A thin named wrapper (`withCastLock` / `withCastLocks`) over the
existing `withKeyLock` promise-chain mutex, applied at 30 of the 35
`writeJsonAtomic(castJsonPath(…))` sites plus 2 delete sites. The lock always
encloses the **read** as well as the write — wrapping only the write buys
nothing. A third key class (`library-voice:<uuid>`) closes the delete-vs-assign
race, under a stated global lock order.

**Tech Stack:** TypeScript, Node 20, Express, Vitest (node env), real-fs
integration tests.

**Design of record:** [`docs/superpowers/specs/2026-07-31-cast-json-write-lock-design.md`](../specs/2026-07-31-cast-json-write-lock-design.md).
Read it before Task 1. Section references below (§3.1, §5, §10.2 …) point at it.

**Tickets:** `Closes #1981`, `Closes #2000`, `Closes #2001`. `Refs #2006`, `Refs #2015`.

## Global Constraints

- **Base branch:** cut after `fix/server-1933-assign-readiness` merges, or rebase
  onto it. It rewrites 208 lines of `voice-library.ts` and shifts the assign
  read/write by +138/+178. **Cite symbols, never line numbers, in code comments.**
- **Global lock order: `design` → `library-voice` → `cast`.** Never acquire an
  earlier class while holding a later one. Every acquisition site names its
  position in a comment.
- **Lock the innermost read-through-write, never the caller.** One level only.
  A locked function must not call another locked function on the same book.
- **The read goes inside the lock**, and so does every decision derived from it.
- **Two or more books → `withCastLocks`**, never nested `withCastLock`s.
- **Every outcome test pins a single module registry** — no `vi.resetModules()`
  between the two concurrent writers in a spec. This is **hygiene, not a
  detector**: a partitioned lock does not contend, so it loses a mutation and the
  outcome test goes *red*. Pinning avoids a confusing false failure. Do not add a
  `chains.size` accessor for this — §10.3 explains why it cannot work.
- **Task 6 must include one cross-module outcome spec** — two *different*
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
- **Do not touch** `analysis.ts`'s 5 write sites (deferred, #2015) or the three
  clone-consent gates in `voices.ts` / `single-design.ts` / `qwen-voice.ts`
  (deferred, #2006). Deleting or "improving" them is out of scope.
- Commit convention: `<type>(<scope>): <subject>`. Scope is `server` for all
  code tasks.

---

## File Structure

| File | Responsibility |
|---|---|
| `server/src/workspace/cast-lock.ts` | **New.** The three named lock wrappers + the lock-order rule in its header. Sole owner of key derivation. |
| `server/src/workspace/cast-lock.test.ts` | **New.** Primitive unit tests: sorted acquisition, dedupe, release-on-throw, waiter ordering. |
| `server/src/workspace/cast-lock.race.test.ts` | **New.** The outcome harness — two overlapping RMWs, both mutations must survive. The reference for every later site test. |
| `server/src/workspace/file-lock.ts` | Modify — #2001 map-cleanup fix. |
| `server/src/tts/design-lock.ts` | Modify — same fix, cleanup only. **Do not touch acquire/release/ordering**: `ensureCharacterVoiceUuid`'s series branch still depends on it (§5.1). |
| `server/src/routes/chapters-restructure.ts` | Modify — same fix; re-derive the safety argument, its control flow differs. |
| 14 route modules + `voice-library-usage.ts` | Modify — apply the lock per §5. |
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

- [ ] **Step 1: Write the failing test**

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

interface Cast {
  characters: Array<{ id: string; voice?: string }>;
}

let dir: string;
let castPath: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'cast-lock-race-'));
  castPath = join(dir, 'cast.json');
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
    /* Documents the defect. Task 2 replaces this with the both-survive
       assertion once the lock exists. */
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

- [ ] **Step 4: Commit**

```bash
git add server/src/workspace/cast-lock.race.test.ts
git commit -m "test(server): pin the cast.json lost-update race before locking anything"
```

---

### Task 2: `cast-lock.ts` — the three wrappers

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
import { describe, it, expect } from 'vitest';
import { withCastLock, withCastLocks } from './cast-lock.js';

const settle = () => new Promise((r) => setTimeout(r, 0));

describe('withCastLocks', () => {
  it('acquires in the same order regardless of argument order', async () => {
    const order: string[] = [];
    const track = (tag: string) => async () => {
      order.push(tag);
      await settle();
    };
    await withCastLocks(['/w/b', '/w/a'], track('first'));
    await withCastLocks(['/w/a', '/w/b'], track('second'));
    /* Both calls lock /w/a then /w/b — sorted, so AB/BA cannot arise. */
    expect(order).toEqual(['first', 'second']);
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

  it('runs waiters in FIFO order', async () => {
    const seen: number[] = [];
    await Promise.all(
      [1, 2, 3].map((n) =>
        withCastLock('/w/fifo', async () => {
          seen.push(n);
          await settle();
        }),
      ),
    );
    expect(seen).toEqual([1, 2, 3]);
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
 *   4. Global lock order: design -> library-voice -> cast. Never acquire an
 *      earlier class while holding a later one. The DELETE library-voice path
 *      holds `library-voice:<uuid>` across clearLibraryVoiceReferences, which
 *      takes a cast lock per book — so POST /assign must take library-voice
 *      BEFORE its cast lock, not after. The other order is an AB/BA cycle on a
 *      mutex with no timeout and no diagnostic: both requests hang forever.
 *
 * WHAT THIS DOES NOT COVER: it protects one read-modify-write. It does not make
 * a validate-then-write safe when the validation and the write are in different
 * scopes (#2006), and it does not cover analysis.ts, whose merge base is read
 * once at the start of a run and replayed for minutes (#2015).
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
export function withCastLocks<T>(bookDirs: string[], fn: () => Promise<T>): Promise<T> {
  const keys = [...new Set(bookDirs.map(castJsonPath))].sort();
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
Expected: PASS (4 tests).

- [ ] **Step 5: Flip the race harness to the both-survive assertion**

In `cast-lock.race.test.ts`, add a second `it` beside the existing one:

```ts
import { withCastLock } from './cast-lock.js';

it('keeps both mutations when the writers hold the cast lock', async () => {
  const bookDir = dir; // castJsonPath(dir) === castPath for this fixture
  await Promise.all([
    withCastLock(bookDir, () => assignVoice(castPath, 'alice', 'a')),
    withCastLock(bookDir, () => assignVoice(castPath, 'bob', 'b')),
  ]);
  const v = await readVoices(castPath);
  expect(v).toEqual({ alice: 'a', bob: 'b' });
});
```

Confirm `castJsonPath(dir)` really equals `castPath` for the fixture; if
`castJsonPath` appends a subdirectory, build the fixture at that path instead.
**Do not** hand-roll the key in the test — that would defeat the point of Task 2.

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

### Task 3: #2001 — the lock helpers' map cleanup has never run

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
 *  Task 3 — NOT a partition detector (design §10.3 explains why that idea was
 *  rejected). */
export function __chainsSizeForTest(): number {
  return chains.size;
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd server && npx vitest run src/workspace/cast-lock.test.ts -t "drops the map entry"`
Expected: FAIL — received 1, expected 0. The cleanup is dead code today.

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

### Task 4: `POST /:voiceUuid/assign` — the filed defect (#1981)

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

3. **Wrap that in `withLibraryVoiceLock(voiceUuid, …)`, outside the cast lock.**
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

### Task 5: `DELETE /:voiceUuid` — close the erase-vs-assign race

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

Wrap from `scanLibraryVoiceUsage` through `clearLibraryVoiceReferences` and
`eraseLibraryVoiceArtifacts` in `withLibraryVoiceLock(voiceUuid, …)`. Task 4
already made `/assign` take the same key, which is what makes this bite.

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

### Task 6: Class 1 — the mechanical single-book sites

**Files (16 sites across 10 modules):**
- `cast-aliases.ts` ×3, `cast-create.ts`, `cast-merge.ts`, `cast-series-patch.ts`,
  `cast-design.ts` ×2, `voice-style.ts` ×2, `voice-override-linked.ts`,
  `book-state.ts` (the cast write in the save handler),
  `qwen-voice.ts` (`DELETE emotion-variant`), `cast-add-from-roster.ts`,
  `voice-library.ts` (`DELETE /assign`)
- Plus each module's colocated `*.test.ts`

`voice-library.ts`'s `POST /assign` (Task 4), `voice-library-usage.ts` (Task 5)
and `qwen-voice.ts`'s `promote-voice` (Task 7) are **not** in this task.

- [ ] **Step 1: Write one failing test per module, plus the cross-module spec**

Use the Task 4 shape: two concurrent requests to that route, each touching a
different character, assert both survive. One module registry per spec file.

**Additionally, one cross-module spec — this is a required deliverable.** Race
two *different* modules' write sites against the same book, e.g. `cast-aliases`'s
alias split concurrent with `voice-style`'s style write; assert both survive.
Every other spec here races a site against itself, which uses one import and one
key and therefore cannot detect a key mismatch *between* sites. This is the only
test in the suite that can. Put it in `server/src/workspace/cast-lock.race.test.ts`
alongside the primitive harness, not in either route's spec.

- [ ] **Step 2: Run them and confirm each fails**

Run: `cd server && npx vitest run src/routes/cast-aliases.test.ts src/routes/cast-create.test.ts src/routes/cast-merge.test.ts src/routes/cast-series-patch.test.ts src/routes/cast-design.test.ts src/routes/voice-style.test.ts src/routes/voice-override-linked.test.ts src/routes/book-state.test.ts src/routes/qwen-voice.test.ts src/routes/cast-add-from-roster.test.ts`
Expected: each new test FAILS.

- [ ] **Step 3: Wrap each read..write span**

Exemplar — `cast-aliases.ts`, which every other site in this task mirrors:

```ts
return withCastLock(bookDir, async () => {
  const cast = await readJson<CastFile>(castJsonPath(bookDir));
  if (!cast?.characters?.length) {
    return res.status(409).json({ error: 'Book has no cast on disk yet. …' });
  }
  // … findIndex, 404s, build nextCharacters …
  await writeJsonAtomic(castJsonPath(bookDir), { characters: nextCharacters });
  return res.status(200).json({ /* … */ });
});
```

Per-site notes:

- **`cast-merge.ts`** — the span is long and contains a
  `writeJsonAtomic(manuscriptEditsJsonPath(...))`. Leave that inner write where
  it is; it is a different file and the cast lock does not cover it.
- **`cast-design.ts`** — both sites already re-read a `fresh` cast immediately
  before writing. Lock from that `fresh` read through the write, not from the
  earlier read. Deleting the re-read is fine once the lock is in place, but if
  you keep it, the lock must still enclose it.

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

For each of the 10 modules: remove that module's `withCastLock`, re-run its spec,
confirm red, restore. Record the list in the commit message. **A site whose test
stays green with the lock removed is a placebo — stop and investigate rather than
moving on.**

- [ ] **Step 6: Commit**

```bash
git add server/src/routes/
git commit -m "fix(server): serialise the single-book cast.json read-modify-writes"
```

---

### Task 7: `promote-voice` — narrow the lock, do not wrap the span

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
  staleVariantIds = Object.values(freshSlot?.variants ?? {})
    .map((v) => v?.name)
    .filter((n): n is string => !!n);
  if (freshSlot) delete freshSlot.variants;
  await writeJsonAtomic(castJsonPath(located.bookDir), fresh);
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

### Task 8: Class 2 — multi-book sites, plus the `library-cast-override` same-book bug

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
     snapshots, two writes to the same path. nextTargetCharacters does not
     contain mergedSource, so the second write discards the first. */
  await request(app).post('/api/library-cast-override')
    .send({ sourceBookId: bookId, sourceCharacterId: 'alice',
            targetBookId: bookId, targetCharacterId: 'bob' })
    .expect(200);

  const cast = await readJson<CastFile>(castJsonPath(bookDir));
  const byId = Object.fromEntries((cast?.characters ?? []).map((c) => [c.id, c]));
  expect(byId.alice.overrideTtsVoices).toBeDefined(); // the merge that got dropped
  expect(byId.bob.overrideTtsVoices).toBeDefined();
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
git add server/src/routes/cast-link-prior.ts server/src/routes/cast-not-linked-to.ts server/src/routes/library-cast-override.ts server/src/routes/
git commit -m "fix(server): lock multi-book cast writes in sorted order and fix the same-book merge"
```

---

### Task 9: Class 3 — `voices.ts`'s two fan-out branches

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
may wrap it in a cast lock for the same book. Task 10 depends on this.

- [ ] **Step 4: Run, mutation-verify both branches separately, commit.**

```bash
git add server/src/routes/voices.ts server/src/routes/voices.test.ts
git commit -m "fix(server): lock each book of the voices fan-out as it is written"
```

---

### Task 10: Class 4 — the `qwen-voice.ts` re-entrancy restructure

**Files:**
- Modify: `server/src/routes/qwen-voice.ts`
  (`ensureCharacterVoiceUuid`, `persistEmotionVariant`)
- Modify: `server/src/routes/qwen-voice.test.ts`

The highest-risk task. Both functions have two branches; only the **book-scoped**
one takes a cast lock. The **series** branch delegates to
`forEachMatchingCastCharacter`, which after Task 9 locks per book itself —
wrapping it here would violate rule 1 and self-deadlock the moment the walk
reaches this book.

- [ ] **Step 1: Write the failing tests** — concurrent book-scoped calls; assert
  no double-mint and no lost sibling write.

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

### Task 11: Class 6 — the two delete sites

**Files:**
- Modify: `server/src/routes/analysis.ts` (the "Start fresh" `rm`)
- Modify: `server/src/routes/book-state.ts` (the reparse `rm`, inside a `Promise.all`)
- Modify: their `*.test.ts`

These destroy cast.json and match neither the write pattern nor the guard's.
They matter **more** after this change: a locked writer whose read predates the
delete recreates the file afterwards, resurrecting the stale roster the delete
exists to remove — and the lock lengthens the gap between a queued writer's read
and its write.

**This is the only `analysis.ts` change in this plan.** Its five *write* sites are
out of scope (#2015). Touch the `rm` and nothing else.

- [ ] **Step 1: Write the failing test** — a delete concurrent with a cast write;
  assert the file stays deleted.
- [ ] **Step 2: Run to verify it fails.**
- [ ] **Step 3: Wrap each `rm` in `withCastLock(bookDir, …)`.** In
  `book-state.ts` the `rm` is one arm of a `Promise.all`; wrap that arm.
- [ ] **Step 4: Run, mutation-verify, commit.**

```bash
git add server/src/routes/analysis.ts server/src/routes/book-state.ts
git commit -m "fix(server): take the cast lock when deleting cast.json"
```

---

### Task 12: The guard test

**Files:**
- Create: `server/src/workspace/cast-lock.guard.test.ts`

- [ ] **Step 1: Write it**

Walk `server/src/**/*.ts` (excluding `*.test.ts`). For each file containing
`castJsonPath`, assert every `writeJsonAtomic(castJsonPath(` and
`rm(castJsonPath(` occurrence sits inside a `withCastLock` / `withCastLocks`
scope. Maintain an explicit allowlist with a reason per entry:

```ts
const ALLOWED_UNLOCKED = new Map([
  ['routes/analysis.ts', 'the 5 merge-base writes are deferred to #2015; the rm IS locked'],
]);
```

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

### Task 13: Docs, notes and ticket hygiene

**Files:**
- Modify: `CLAUDE.md` (*Conventions worth preserving*)
- Modify: `docs/release-notes-next.md`, `RELEASE_NOTES.md`
- Modify: `docs/superpowers/specs/2026-07-31-cast-json-write-lock-design.md` (status)

- [ ] **Step 1: Add the convention to CLAUDE.md**

One bullet with the four rules from `cast-lock.ts`'s header, including the
three-class lock order.

- [ ] **Step 2: Release notes, both files**

`docs/release-notes-next.md` — technical, PR-ref'd. `RELEASE_NOTES.md` — one
user-facing line in brand voice. The user-visible delta is real: concurrent cast
edits no longer silently discard one another. Do **not** claim cast.json is fully
protected — `analysis.ts` is not (#2015), and the check-then-act gates are not
(#2006).

- [ ] **Step 3: On-box acceptance**

No new hardware-only behaviour: every claim here is provable in-process by the
outcome tests. Say so explicitly in the PR body rather than omitting the step.

- [ ] **Step 4: Commit**

```bash
git add CLAUDE.md docs/release-notes-next.md RELEASE_NOTES.md docs/superpowers/specs/
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
- [ ] PR body: `Closes #1981`, `Closes #2000`, `Closes #2001`, `Refs #2006`,
      `Refs #2015`. Declare Task 8's `library-cast-override` same-book fix and
      Task 3's #2001 fix under "Also fixed, found in passing".
- [ ] Mandatory `code-review` pass at `high` effort — multi-scope, 17 modules.
