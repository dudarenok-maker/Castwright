# Cast merge-base serialisation + staleness detection — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Serialise every `cast.json` / `cast-reuse-carryover.json` access in
`server/src/routes/analysis.ts` under the existing `cast` lock, and make a stale
merge base *visible* (logged + surfaced on the SSE stream) instead of silent.

**Architecture:** A per-run compare-and-set baseline. `readPriorCastForMerge`
becomes locked and returns a sha256 fingerprint of the bytes it actually parsed.
Each of the five merge-base writes then re-reads, re-fingerprints, compares,
writes, and **advances the baseline to what it just wrote** — all inside one
`withCastLock` hold. Merge behaviour is unchanged; only the silence changes.

**Tech Stack:** TypeScript (Node 20 ESM), Vitest, Express + supertest,
`server/src/workspace/cast-lock.ts`, `writeJsonAtomic`, React + RTK on the
frontend.

**Spec:** [`docs/superpowers/specs/2026-08-06-cast-merge-base-serialise-and-detect-design.md`](../specs/2026-08-06-cast-merge-base-serialise-and-detect-design.md)
**Issues:** `Closes #2155`, `Refs #2015` (detection only; the rebuild stays open)
**Status:** implemented — all 10 tasks complete on `fix/server-cast-merge-base-serialise` (2026-08-06); PR [#2185](https://github.com/dudarenok-maker/Castwright/pull/2185), open, not yet merged.

## Global Constraints

Copied from the spec. Every task's requirements implicitly include these.

- **Cast-lock rule 1 — one level only.** A locked function must not call another
  locked function on the same book. Every new `withCastLock` site is checked
  against this before it is written.
- **Cast-lock rule 2 — the read goes inside the lock, and so does every decision
  derived from it.** Wrapping only the write buys nothing. A comparison in a
  different hold from the write it guards is the exact check-then-act shape this
  work removes.
- **Cast-lock rule 4 — global order is `design` → `library-voice` → `cast`.**
  Never acquire an earlier class while holding `cast`.
- **The fingerprint hashes raw file bytes**, never a normalised or re-serialised
  form, and the bytes are read **once** — parse the bytes you hashed. A second
  read to hash what you already parsed reintroduces the gap the lock closes.
- **Three fingerprint states, never two.** `sha256` = compare normally;
  `ABSENT` = "no file is expected right now"; `null` = "detection disabled for
  this run". Collapsing `ABSENT` into `null` silently disables detection on
  every fresh run.
- **A `null` baseline is never advanced** and must never be logged as "checked
  and clean". *Not checkable* and *checked and clean* are different outcomes.
- **Merge behaviour does not change.** On conflict the write proceeds with the
  same base it uses today. No data is lost that is not already lost today.
- **`--retry=0` on every verification run**, and 5+ separate process runs for
  the race tests. `retry: 1` is live in this repo and has produced a false
  green (#2028).
- **Assert outcomes, never mechanisms.** The cast-lock guard is call-graph-blind
  by design, so a test asserting that a `withCastLock` token appears at a call
  site passes vacuously.

## Deviation from the spec (one, deliberate)

Spec §4 item 6 lists "the **mock** API, so the mock and real paths do not
diverge." **This plan does not add a mock emit**, for a reason found while
reading the code rather than the spec: `mockAnalyseManuscript`
(`src/lib/api.ts:1462-1464`) destructures only `{ onPhase, onHeartbeat }` — it
already emits nothing for `onLog`, `onThrottle`, `onSeriesPrior`,
`onChapterFailed`, `onChapterResolved`, `onCastUpdate` and `onEta`. Emitting
nothing for `onWarning` is therefore *consistent* with the mock, not divergent
from it, and an unconditional mock emit would put a stale-cast warning toast on
every demo capture and every mock-mode e2e run.

The item's actual goal — mock and real staying type-compatible — is discharged
by `onWarning` living on the **shared** `AnalyseOpts` interface (Task 8), which
both implementations are typed against.

## File Structure

**Created**

| File | Responsibility |
|---|---|
| `server/src/workspace/cast-fingerprint.ts` | The primitive: read-once-and-hash, and "what hash will `writeJsonAtomic` produce for this value". Nothing about locks or analysis. |
| `server/src/workspace/cast-fingerprint.test.ts` | Unit tests, incl. the coupling guard against `writeJsonAtomic`'s serialisation. |
| `server/src/workspace/cast-merge-base.ts` | The per-run compare-and-set baseline: capture → `markDeleted` → `writeChecked`. Owns the lock. Knows nothing about SSE or routes. |
| `server/src/workspace/cast-merge-base.test.ts` | Unit tests, incl. the unit-level negative control. |
| `server/src/routes/analysis.merge-base-detect.test.ts` | Route-level negative + positive controls through `runMainAnalyzerJob`. |

**Modified**

| File | Change |
|---|---|
| `server/src/routes/analysis.ts` | §1 locked fingerprinted capture; §2 carryover `rm` folded into the existing hold; §3 five writes through `writeChecked`; §4 the `warning` emit + replay. |
| `server/src/routes/analysis.test.ts` | The three `readPriorCastForMerge` cases at `:2086-2136` follow the new return shape. |
| `server/src/routes/analysis.fresh-cast-lock.test.ts` | Header comment corrected (the capture read is no longer unlocked) + settle window widened. |
| `server/src/workspace/cast-lock.guard.test.ts` | The `routes/analysis.ts` allowlist entry is **removed**. |
| `openapi.yaml` | `AnalyseWarningEvent` schema + both analysis routes' `oneOf`. |
| `src/lib/api-types.ts` | Regenerated — never hand-edited. |
| `src/lib/api.ts` | Hand-written union gains `'warning'`; `onWarning` on `AnalyseOpts`; **both** readers dispatch it. |
| `src/views/analysing.tsx` | **Both** stream call sites push a deduped toast. |

---

### Task 1: The fingerprint primitive

**Files:**
- Create: `server/src/workspace/cast-fingerprint.ts`
- Test: `server/src/workspace/cast-fingerprint.test.ts`

**Interfaces:**
- Consumes: `writeJsonAtomic` from `../workspace/state-io.js` (test only).
- Produces:
  - `const ABSENT: unique symbol`-like string literal `'\0ABSENT'` — see
    Step 3 for why it is not the plain string `'ABSENT'`.
  - `type CastFingerprint = string | typeof ABSENT | null`
  - `hashBytes(raw: string): string`
  - `readJsonWithFingerprint<T>(path: string): Promise<{ value: T | null; fingerprint: string | typeof ABSENT }>`
  - `fingerprintOfWrite(value: unknown): string`

- [ ] **Step 1: Write the failing tests**

Create `server/src/workspace/cast-fingerprint.test.ts`:

```ts
/* #2015 — the compare-and-set primitive behind the merge-base staleness
   detector. The coupling test at the bottom is the important one: it is the
   only thing standing between a change to writeJsonAtomic's serialisation and
   a detector that reports a conflict on every write it makes itself. */
import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeJsonAtomic } from './state-io.js';
import { readFile } from 'node:fs/promises';
import {
  ABSENT,
  hashBytes,
  readJsonWithFingerprint,
  fingerprintOfWrite,
} from './cast-fingerprint.js';

function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), 'castwright-fingerprint-'));
}

describe('readJsonWithFingerprint', () => {
  it('returns ABSENT — not null, not a hash — for a file that does not exist', async () => {
    const dir = tmpDir();
    try {
      const got = await readJsonWithFingerprint(join(dir, 'nope.json'));
      expect(got.value).toBeNull();
      expect(got.fingerprint).toBe(ABSENT);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('hashes the RAW bytes, not a re-serialised form', async () => {
    const dir = tmpDir();
    const p = join(dir, 'cast.json');
    try {
      /* Deliberately non-canonical whitespace: a normalising implementation
         would hash this identically to the compact form below, which is the
         bug this asserts against. */
      writeFileSync(p, '{  "characters"  :  [ ]  }', 'utf8');
      const loose = await readJsonWithFingerprint(p);
      writeFileSync(p, '{"characters":[]}', 'utf8');
      const tight = await readJsonWithFingerprint(p);

      expect(loose.value).toEqual({ characters: [] });
      expect(tight.value).toEqual({ characters: [] });
      expect(loose.fingerprint).not.toBe(tight.fingerprint);
      expect(loose.fingerprint).toBe(hashBytes('{  "characters"  :  [ ]  }'));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('still fingerprints unparseable bytes (a malformed cast.json is a real on-disk state)', async () => {
    const dir = tmpDir();
    const p = join(dir, 'cast.json');
    try {
      writeFileSync(p, '{ not json', 'utf8');
      const got = await readJsonWithFingerprint(p);
      expect(got.value).toBeNull();
      expect(got.fingerprint).toBe(hashBytes('{ not json'));
      expect(got.fingerprint).not.toBe(ABSENT);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('fingerprintOfWrite — coupling guard against writeJsonAtomic', () => {
  it('predicts the exact bytes writeJsonAtomic lands on disk', async () => {
    const dir = tmpDir();
    const p = join(dir, 'cast.json');
    try {
      const payload = { characters: [{ id: 'nova', voiceId: 'v1', nested: { a: [1, 2] } }] };
      await writeJsonAtomic(p, payload);
      const onDisk = await readFile(p, 'utf8');

      /* If writeJsonAtomic ever changes its serialisation (indent, key order,
         trailing newline), this fails HERE rather than as a detector that
         reports a conflict on every write it made itself. */
      expect(fingerprintOfWrite(payload)).toBe(hashBytes(onDisk));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('agrees with what readJsonWithFingerprint observes after the write', async () => {
    const dir = tmpDir();
    const p = join(dir, 'cast.json');
    try {
      const payload = { characters: [{ id: 'wren' }] };
      await writeJsonAtomic(p, payload);
      const observed = await readJsonWithFingerprint(p);
      expect(observed.fingerprint).toBe(fingerprintOfWrite(payload));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('ABSENT can never collide with a real sha256 hex digest', () => {
    expect(ABSENT).not.toMatch(/^[0-9a-f]{64}$/);
    expect(hashBytes('')).toMatch(/^[0-9a-f]{64}$/);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd server && npx vitest run src/workspace/cast-fingerprint.test.ts --retry=0`
Expected: FAIL — `Failed to resolve import "./cast-fingerprint.js"`.

- [ ] **Step 3: Write the implementation**

Create `server/src/workspace/cast-fingerprint.ts`:

```ts
/* #2015 — the compare-and-set primitive for cast.json's merge base.
   Deliberately knows nothing about locks, routes or SSE: it reads bytes and
   hashes them, and predicts the hash writeJsonAtomic will produce. */
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';

/** "No file is expected to exist right now" — a POSITIVE observation, not an
    absence of information. Distinct from `null`, which means "I cannot check".
    Collapsing the two disables detection on every Start-fresh run (design
    §1a), which is the single most important case.

    The NUL prefix makes collision with a real sha256 hex digest impossible by
    construction, so `observed !== baseline` needs no special-casing at the
    comparison sites. */
export const ABSENT = '\0ABSENT' as const;

/** Three states, never two — see design §1a. */
export type CastFingerprint = string | typeof ABSENT | null;

export function hashBytes(raw: string): string {
  return createHash('sha256').update(raw, 'utf8').digest('hex');
}

/** Read a JSON file ONCE and return both the parsed value and the hash of the
    exact bytes that were parsed.

    Never two reads: `readJson` parses and discards the bytes, so hashing after
    a `readJson` would mean a second `readFile` — and a second read outside the
    same syscall pair reintroduces the very gap the caller's lock closes
    (design §1, implementation note).

    Unparseable bytes still get a hash. A malformed cast.json is a real on-disk
    state, and a later write must be able to notice it changing. */
export async function readJsonWithFingerprint<T>(
  path: string,
): Promise<{ value: T | null; fingerprint: string | typeof ABSENT }> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch {
    return { value: null, fingerprint: ABSENT };
  }
  const fingerprint = hashBytes(raw);
  try {
    return { value: JSON.parse(raw) as T, fingerprint };
  } catch {
    return { value: null, fingerprint };
  }
}

/** The fingerprint `writeJsonAtomic` will produce for `value` — mirrors its
    `JSON.stringify(value, null, 2)` serialisation exactly (state-io.ts:111).

    Computed from the payload rather than by re-reading the file, so advancing
    the baseline after a write costs no syscall and cannot observe a THIRD
    party's write as if it were our own. `cast-fingerprint.test.ts` pins the
    two serialisations together; if writeJsonAtomic changes, that test fails
    rather than this silently drifting. */
export function fingerprintOfWrite(value: unknown): string {
  return hashBytes(JSON.stringify(value, null, 2));
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd server && npx vitest run src/workspace/cast-fingerprint.test.ts --retry=0`
Expected: PASS (6 tests).

- [ ] **Step 5: Mutation-verify the coupling guard**

Temporarily change `fingerprintOfWrite`'s `JSON.stringify(value, null, 2)` to
`JSON.stringify(value)`. Re-run. Expected: the two coupling tests FAIL. Revert.

This is the RED-phase proof for the one test in this file that could otherwise
pass vacuously — do not skip it.

- [ ] **Step 6: Commit**

```bash
git add server/src/workspace/cast-fingerprint.ts server/src/workspace/cast-fingerprint.test.ts
git commit -m "feat(server): add the cast.json merge-base fingerprint primitive"
```

---

### Task 2: The per-run compare-and-set baseline

**Files:**
- Create: `server/src/workspace/cast-merge-base.ts`
- Test: `server/src/workspace/cast-merge-base.test.ts`

**Interfaces:**
- Consumes: `ABSENT`, `CastFingerprint`, `readJsonWithFingerprint`,
  `fingerprintOfWrite` (Task 1); `withCastLock` from `./cast-lock.js`;
  `castJsonPath` from `./paths.js`; `writeJsonAtomic` from `./state-io.js`.
- Produces:
  - `interface CastMergeBaseConflict { expected: string; observed: string }`
  - `interface CastMergeBase { readonly value: CastFingerprint; readonly enabled: boolean; markDeleted(): void; writeChecked(payload: unknown, onConflict: (c: CastMergeBaseConflict) => void): Promise<void> }`
  - `function createCastMergeBase(bookDir: string, capturedFingerprint: string | null): CastMergeBase`

- [ ] **Step 1: Write the failing tests**

Create `server/src/workspace/cast-merge-base.test.ts`:

```ts
/* #2015 §3a — the baseline-advance rule. The "no conflicts on an uncontended
   run" test below is the negative control the first draft of the design
   lacked: without it, a detector that fires unconditionally passes every
   other test in this file. */
import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { castJsonPath } from './paths.js';
import { readJsonWithFingerprint, fingerprintOfWrite } from './cast-fingerprint.js';
import { createCastMergeBase } from './cast-merge-base.js';

function makeBookDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'castwright-merge-base-'));
  mkdirSync(join(dir, '.audiobook'), { recursive: true });
  return dir;
}

async function captureOf(dir: string): Promise<string | null> {
  const got = await readJsonWithFingerprint(castJsonPath(dir));
  return typeof got.fingerprint === 'string' && got.value !== null ? got.fingerprint : null;
}

describe('createCastMergeBase — the negative control (design §3a)', () => {
  it('an uncontended multi-chapter run emits ZERO conflicts across many writes', async () => {
    const dir = makeBookDir();
    try {
      writeFileSync(castJsonPath(dir), JSON.stringify({ characters: [{ id: 'a' }] }, null, 2));
      const base = createCastMergeBase(dir, await captureOf(dir));
      const onConflict = vi.fn();

      /* Six writes: two per-chapter interim writes repeated, then stage1,
         then final — the shape a 3-chapter book actually produces. Two of the
         five real sites are INSIDE per-chapter loops, so a single-write test
         cannot observe a stale-baseline false positive at all. */
      for (let chapter = 1; chapter <= 3; chapter++) {
        await base.writeChecked({ characters: [{ id: 'a', chapter }] }, onConflict);
      }
      await base.writeChecked({ characters: [{ id: 'a' }, { id: 'b' }] }, onConflict);
      await base.writeChecked({ characters: [{ id: 'a' }, { id: 'b' }, { id: 'c' }] }, onConflict);
      await base.writeChecked({ characters: [{ id: 'final' }] }, onConflict);

      expect(onConflict).not.toHaveBeenCalled();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('an uncontended START-FRESH run emits ZERO conflicts (the ABSENT baseline)', async () => {
    const dir = makeBookDir();
    try {
      writeFileSync(castJsonPath(dir), JSON.stringify({ characters: [{ id: 'prior' }] }, null, 2));
      /* Capture happens BEFORE the fresh block's rm, deliberately — the rows
         must survive the delete (analysis.ts:2846-2847). */
      const base = createCastMergeBase(dir, await captureOf(dir));

      await rm(castJsonPath(dir), { force: true });
      base.markDeleted();

      const onConflict = vi.fn();
      await base.writeChecked({ characters: [{ id: 'fresh1' }] }, onConflict);
      await base.writeChecked({ characters: [{ id: 'fresh2' }] }, onConflict);

      expect(onConflict).not.toHaveBeenCalled();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('WITHOUT markDeleted a fresh run would false-positive — proving the reset is load-bearing', async () => {
    const dir = makeBookDir();
    try {
      writeFileSync(castJsonPath(dir), JSON.stringify({ characters: [{ id: 'prior' }] }, null, 2));
      const base = createCastMergeBase(dir, await captureOf(dir));
      await rm(castJsonPath(dir), { force: true });
      // markDeleted() deliberately NOT called.

      const onConflict = vi.fn();
      await base.writeChecked({ characters: [{ id: 'fresh1' }] }, onConflict);
      expect(onConflict).toHaveBeenCalledTimes(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('createCastMergeBase — the positive control', () => {
  it('detects a foreign write landing between two of this run’s writes', async () => {
    const dir = makeBookDir();
    try {
      writeFileSync(castJsonPath(dir), JSON.stringify({ characters: [{ id: 'a' }] }, null, 2));
      const base = createCastMergeBase(dir, await captureOf(dir));
      const onConflict = vi.fn();

      await base.writeChecked({ characters: [{ id: 'a' }] }, onConflict);
      expect(onConflict).not.toHaveBeenCalled();

      // A foreign writer lands.
      writeFileSync(castJsonPath(dir), JSON.stringify({ characters: [{ id: 'foreign' }] }, null, 2));

      await base.writeChecked({ characters: [{ id: 'b' }] }, onConflict);
      expect(onConflict).toHaveBeenCalledTimes(1);
      const conflict = onConflict.mock.calls[0][0];
      expect(conflict.expected).not.toBe(conflict.observed);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reports a conflict ONCE, not on every subsequent write (the baseline advances through it)', async () => {
    const dir = makeBookDir();
    try {
      writeFileSync(castJsonPath(dir), JSON.stringify({ characters: [{ id: 'a' }] }, null, 2));
      const base = createCastMergeBase(dir, await captureOf(dir));
      const onConflict = vi.fn();

      writeFileSync(castJsonPath(dir), JSON.stringify({ characters: [{ id: 'foreign' }] }, null, 2));
      await base.writeChecked({ characters: [{ id: 'b' }] }, onConflict);
      await base.writeChecked({ characters: [{ id: 'c' }] }, onConflict);
      await base.writeChecked({ characters: [{ id: 'd' }] }, onConflict);

      expect(onConflict).toHaveBeenCalledTimes(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('still writes on conflict — merge behaviour is unchanged (design §4)', async () => {
    const dir = makeBookDir();
    try {
      writeFileSync(castJsonPath(dir), JSON.stringify({ characters: [{ id: 'a' }] }, null, 2));
      const base = createCastMergeBase(dir, await captureOf(dir));
      writeFileSync(castJsonPath(dir), JSON.stringify({ characters: [{ id: 'foreign' }] }, null, 2));

      await base.writeChecked({ characters: [{ id: 'ours' }] }, vi.fn());

      const after = await readJsonWithFingerprint<{ characters: Array<{ id: string }> }>(
        castJsonPath(dir),
      );
      expect(after.value?.characters.map((c) => c.id)).toEqual(['ours']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('createCastMergeBase — detection disabled (fingerprint: null)', () => {
  it('a carryover-sourced run never reports a conflict, even against a foreign write', async () => {
    const dir = makeBookDir();
    try {
      const base = createCastMergeBase(dir, null);
      expect(base.enabled).toBe(false);
      const onConflict = vi.fn();

      writeFileSync(castJsonPath(dir), JSON.stringify({ characters: [{ id: 'foreign' }] }, null, 2));
      await base.writeChecked({ characters: [{ id: 'ours' }] }, onConflict);

      expect(onConflict).not.toHaveBeenCalled();
      expect(base.value).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('markDeleted does NOT promote a disabled baseline to ABSENT', async () => {
    const dir = makeBookDir();
    try {
      const base = createCastMergeBase(dir, null);
      base.markDeleted();
      expect(base.value).toBeNull();
      expect(base.enabled).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('the write still lands with detection disabled', async () => {
    const dir = makeBookDir();
    try {
      const base = createCastMergeBase(dir, null);
      await base.writeChecked({ characters: [{ id: 'ours' }] }, vi.fn());
      expect(existsSync(castJsonPath(dir))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('createCastMergeBase — serialisation', () => {
  it('two concurrent writeChecked calls do not interleave read-compare-write', async () => {
    const dir = makeBookDir();
    try {
      writeFileSync(castJsonPath(dir), JSON.stringify({ characters: [{ id: 'a' }] }, null, 2));
      const a = createCastMergeBase(dir, await captureOf(dir));
      const b = createCastMergeBase(dir, await captureOf(dir));

      /* Both runs start from the same baseline. Serialised, exactly ONE of
         them observes the other's write and reports. If the hold did not
         cover read-compare-write, both could read the original and neither
         would report. Asserting the OUTCOME (someone noticed), never that a
         withCastLock token appears at a call site. */
      const conflicts: string[] = [];
      await Promise.all([
        a.writeChecked({ characters: [{ id: 'a2' }] }, () => conflicts.push('a')),
        b.writeChecked({ characters: [{ id: 'b2' }] }, () => conflicts.push('b')),
      ]);

      expect(conflicts).toHaveLength(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd server && npx vitest run src/workspace/cast-merge-base.test.ts --retry=0`
Expected: FAIL — `Failed to resolve import "./cast-merge-base.js"`.

- [ ] **Step 3: Write the implementation**

Create `server/src/workspace/cast-merge-base.ts`:

```ts
/* #2015 §3 / §3a — the per-run compare-and-set baseline for cast.json's merge
   base.

   WHY THIS IS MUTABLE RUN STATE, not a run-long constant: two of the five
   merge-base write sites in analysis.ts sit inside per-chapter loops. A
   baseline pinned at capture would be invalidated by the run's OWN second
   write, so every multi-chapter book would report a conflict from chapter 2
   onward with zero concurrent writers — a detector firing on ~100% of runs,
   which destroys both deliverables at once (the frequency data becomes noise,
   and the user learns to ignore the advisory). See design §3a. */
import { withCastLock } from './cast-lock.js';
import { castJsonPath } from './paths.js';
import { writeJsonAtomic } from './state-io.js';
import {
  ABSENT,
  type CastFingerprint,
  readJsonWithFingerprint,
  fingerprintOfWrite,
} from './cast-fingerprint.js';

export interface CastMergeBaseConflict {
  /** The fingerprint this run expected cast.json to still carry. */
  expected: string;
  /** What was actually on disk when the lock was taken. */
  observed: string;
}

export interface CastMergeBase {
  /** Current expected on-disk fingerprint; `null` when detection is off. */
  readonly value: CastFingerprint;
  /** False for a carryover-sourced or empty capture — see design §1a. */
  readonly enabled: boolean;
  /** Record that this run deleted cast.json (the Start-fresh `rm`). Call it
      INSIDE the same hold as the delete. No-op when detection is disabled — a
      null baseline is never advanced. */
  markDeleted(): void;
  /** Compare-and-set write. Takes the cast lock itself, so it must NOT be
      called from inside one (cast-lock rule 1). The read, the comparison, the
      write and the baseline advance all happen in ONE hold (rule 2). */
  writeChecked(
    payload: unknown,
    onConflict: (conflict: CastMergeBaseConflict) => void,
  ): Promise<void>;
}

export function createCastMergeBase(
  bookDir: string,
  capturedFingerprint: string | null,
): CastMergeBase {
  let baseline: CastFingerprint = capturedFingerprint;

  return {
    get value() {
      return baseline;
    },
    get enabled() {
      return baseline !== null;
    },
    markDeleted() {
      if (baseline === null) return;
      baseline = ABSENT;
    },
    async writeChecked(payload, onConflict) {
      await withCastLock(bookDir, async () => {
        const path = castJsonPath(bookDir);
        if (baseline !== null) {
          const { fingerprint: observed } = await readJsonWithFingerprint(path);
          if (observed !== baseline) {
            /* Report, then carry on: merge behaviour is unchanged and the
               write proceeds with the same base it uses today (design §4).
               onConflict must not throw — the caller's handler only logs and
               emits. */
            onConflict({ expected: String(baseline), observed: String(observed) });
          }
        }
        await writeJsonAtomic(path, payload);
        /* Advance THROUGH a conflict as well as through a clean write. Not
           advancing here would re-report the same foreign write at every
           remaining site — five advisories for one event. */
        if (baseline !== null) baseline = fingerprintOfWrite(payload);
      });
    },
  };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd server && npx vitest run src/workspace/cast-merge-base.test.ts --retry=0`
Expected: PASS (10 tests).

- [ ] **Step 5: Mutation-verify each control on its own line**

Run each mutation, confirm the named test fails, then revert:

| Mutation | Must fail |
|---|---|
| Delete the `if (baseline !== null) baseline = fingerprintOfWrite(payload);` line | "uncontended multi-chapter run emits ZERO conflicts" |
| Change `markDeleted` to `baseline = null` | "a fresh run still DETECTS a foreign write — markDeleted sets ABSENT, never null" |
| Change `if (observed !== baseline)` to `if (false)` | both positive-control tests |
| Drop the `withCastLock` wrapper | "two concurrent writeChecked calls do not interleave" |

A control that still passes under its mutation is not a control. Fix it before
moving on.

**Note (found during implementation):** the row above originally named "WITHOUT
markDeleted … proving the reset is load-bearing" as this mutation's target. That
was wrong and could not have failed it — that test never calls `markDeleted()`,
so mutating `markDeleted` cannot affect it. The real gap the dud row concealed:
no test distinguished `markDeleted()` setting `ABSENT` from setting `null` —
both leave an uncontended fresh run reporting zero conflicts, so the mutation
was unguarded. The control now named above was added to close it.

- [ ] **Step 6: Commit**

```bash
git add server/src/workspace/cast-merge-base.ts server/src/workspace/cast-merge-base.test.ts
git commit -m "feat(server): add the per-run cast merge-base compare-and-set"
```

---

### Task 3: Lock and fingerprint the capture (design §1)

**Files:**
- Modify: `server/src/routes/analysis.ts:169-190` (the function), `:2848-2852` (main caller), `:5388` (subset caller)
- Modify: `server/src/routes/analysis.test.ts:2086-2136`

**Interfaces:**
- Consumes: `readJsonWithFingerprint` (Task 1); `withCastLock` from `../workspace/cast-lock.js`.
- Produces: `interface PriorCastSnapshot { rows: Array<{ id: string } & Record<string, unknown>>; fingerprint: string | null; source: 'cast' | 'carryover' | 'none' }`, and
  `readPriorCastForMerge(bookDir: string): Promise<PriorCastSnapshot>`.

**Lock safety (re-verify before writing — do not take this on trust):** both
production callers sit at the top of their run, outside any lock, and
`applyReparse` never calls this function. Confirm with
`grep -n "readPriorCastForMerge" server/src -r` and check each hit is not inside
a `withCastLock` callback.

- [ ] **Step 1: Update the three existing tests to the new return shape**

In `server/src/routes/analysis.test.ts`, replace the three assertions in the
`readPriorCastForMerge (srv-13 carryover fallback)` block:

```ts
  it('prefers cast.json when present', async () => {
    const dir = makeBookDir();
    try {
      writeFileSync(
        castPath(dir),
        JSON.stringify({ characters: [{ id: 'live', voiceId: 'live' }] }),
      );
      writeFileSync(
        carryPath(dir),
        JSON.stringify({ characters: [{ id: 'stale', voiceId: 'stale' }] }),
      );
      const prior = await readPriorCastForMerge(dir);
      expect(prior.rows.map((c) => c.id)).toEqual(['live']);
      expect(prior.source).toBe('cast');
      expect(prior.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('falls back to the carryover when cast.json is absent (post-reparse window)', async () => {
    const dir = makeBookDir();
    try {
      writeFileSync(
        carryPath(dir),
        JSON.stringify({
          characters: [
            { id: 'wren', voiceId: 'wren', voiceState: 'reused', matchedFrom: { bookId: 'b0' } },
          ],
        }),
      );
      const prior = await readPriorCastForMerge(dir);
      expect(prior.rows).toHaveLength(1);
      expect(prior.rows[0]).toMatchObject({ id: 'wren', voiceId: 'wren', voiceState: 'reused' });
      expect(prior.source).toBe('carryover');
      /* Design §1a — carryover rows describe bytes cast.json never held, so
         there is no compare-and-set available. `null` says "I cannot check",
         which is the honest answer and is what disables detection for the run
         rather than producing a wrong verdict. */
      expect(prior.fingerprint).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns no rows and no fingerprint when neither file exists', async () => {
    const dir = makeBookDir();
    try {
      const prior = await readPriorCastForMerge(dir);
      expect(prior.rows).toEqual([]);
      expect(prior.source).toBe('none');
      expect(prior.fingerprint).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('an EMPTY characters[] in cast.json still falls through to the carryover', async () => {
    const dir = makeBookDir();
    try {
      writeFileSync(castPath(dir), JSON.stringify({ characters: [] }));
      writeFileSync(carryPath(dir), JSON.stringify({ characters: [{ id: 'wren' }] }));
      const prior = await readPriorCastForMerge(dir);
      expect(prior.rows.map((c) => c.id)).toEqual(['wren']);
      expect(prior.source).toBe('carryover');
      expect(prior.fingerprint).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd server && npx vitest run src/routes/analysis.test.ts -t "readPriorCastForMerge" --retry=0`
Expected: FAIL — `prior.rows` is undefined (the function still returns a bare array).

- [ ] **Step 3: Rewrite the function**

Replace `server/src/routes/analysis.ts:175-190` (keep the existing srv-13
comment block above it, and append the new paragraph):

```ts
/* srv-13 — the existing cast's voice/reuse fields to overlay onto a fresh
   analysis roster. Prefer cast.json; when it's absent (a reparse just deleted
   it) fall back to the reuse-carryover snapshot the reparse handler wrote, so
   continuity survives the reparse → re-analysis window. Once this run writes a
   fresh cast.json it takes precedence and the carryover goes inert until the
   next reparse refreshes it.

   #2015 / #2155 — the whole two-file fallback runs INSIDE the cast lock, which
   is what makes "which file did these rows come from" a decidable question
   answered atomically with the read itself. That is the capture problem the
   four earlier designs died on: fingerprinting cast.json from outside this
   fallback describes bytes the snapshot may not have come from.

   Rule 1 (one level only) holds: both production callers sit at the top of
   their run outside any lock, and applyReparse never calls this. */
export interface PriorCastSnapshot {
  rows: Array<{ id: string } & Record<string, unknown>>;
  /** sha256 of cast.json's raw bytes when the rows came from it. `null` means
      "no compare-and-set is available for this run" — carryover-sourced or
      empty. A null fingerprint DISABLES conflict detection rather than
      producing a wrong verdict (design §1a). */
  fingerprint: string | null;
  source: 'cast' | 'carryover' | 'none';
}

export async function readPriorCastForMerge(bookDir: string): Promise<PriorCastSnapshot> {
  type Rows = Array<{ id: string } & Record<string, unknown>>;
  return withCastLock(bookDir, async () => {
    const cast = await readJsonWithFingerprint<{ characters?: Rows }>(castJsonPath(bookDir));
    const fromCast = cast.value?.characters;
    if (fromCast?.length) {
      /* fingerprint is a hash, never ABSENT, on this branch — the file
         demonstrably parsed. The guard is for the type, not the case. */
      return {
        rows: fromCast,
        fingerprint: typeof cast.fingerprint === 'string' ? cast.fingerprint : null,
        source: 'cast' as const,
      };
    }
    const carry = await readJsonWithFingerprint<{ characters?: Rows }>(
      castReuseCarryoverJsonPath(bookDir),
    );
    const fromCarryover = carry.value?.characters;
    if (fromCarryover) {
      return { rows: fromCarryover, fingerprint: null, source: 'carryover' as const };
    }
    return { rows: [], fingerprint: null, source: 'none' as const };
  });
}
```

Add to the import block at the top of `analysis.ts`:

```ts
import { readJsonWithFingerprint } from '../workspace/cast-fingerprint.js';
import { createCastMergeBase, type CastMergeBase } from '../workspace/cast-merge-base.js';
```

(`withCastLock` and `castJsonPath` are already imported — confirm before
adding duplicates.)

- [ ] **Step 4: Update the two call sites**

`analysis.ts:2848-2852` (main route) becomes:

```ts
    const priorSnapshot = recordRef.bookDir
      ? await readPriorCastForMerge(recordRef.bookDir)
      : { rows: [], fingerprint: null, source: 'none' as const };
    let priorCastForMerge: Array<{ id: string } & Record<string, unknown>> = requestedFresh
      ? dropReuseContinuityKeepDesignedVoice(priorSnapshot.rows)
      : priorSnapshot.rows;
    /* #2015 §3a — mutable run state, NOT a run-long constant. Advanced after
       every merge-base write and reset by the Start-fresh delete below. */
    const castBase: CastMergeBase | null = recordRef.bookDir
      ? createCastMergeBase(recordRef.bookDir, priorSnapshot.fingerprint)
      : null;
```

Apply the identical shape at the subset route's call site (`:5388`), using that
route's own `record.bookDir` identifier. Read the surrounding five lines first —
the subset route does **not** have `requestedFresh`, so drop the ternary there
and use `priorSnapshot.rows` directly.

- [ ] **Step 5: Run to verify they pass**

```bash
cd server && npx vitest run src/routes/analysis.test.ts -t "readPriorCastForMerge" --retry=0
cd server && npx tsc --noEmit -p .
```
Expected: 4 tests PASS, typecheck clean.

- [ ] **Step 6: Commit**

```bash
git add server/src/routes/analysis.ts server/src/routes/analysis.test.ts
git commit -m "fix(server): lock and fingerprint analysis.ts's merge-base capture"
```

---

### Task 4: Fold the carryover delete into the existing hold (design §2, closes #2155)

**Files:**
- Modify: `server/src/routes/analysis.ts:2915-2930`
- Modify: `server/src/routes/analysis.fresh-cast-lock.test.ts` (header + settle window)

**Interfaces:**
- Consumes: `castBase` (Task 3).
- Produces: nothing new.

- [ ] **Step 1: Fold the delete in and reset the baseline**

Replace the `withCastLock(freshBookDir, …)` line and the two `rm`s that follow
it. Note the ordering: `manuscriptEditsJsonPath`'s `rm` stays **outside** — only
cast.json and the carryover belong in the hold.

```ts
        const freshBookDir = recordRef.bookDir;
        await withCastLock(freshBookDir, async () => {
          await rm(castJsonPath(freshBookDir), { force: true });
          /* Start fresh intentionally discards reuse continuity — drop the
             reparse carryover too so it can't resurrect links (srv-13).
             #2155: inside the SAME hold as cast.json's delete, so a concurrent
             analysis can no longer observe the intermediate state where the
             carryover is written but cast.json is not yet gone. */
          await rm(castReuseCarryoverJsonPath(freshBookDir), { force: true });
          /* #2015 §3a rule 2 — the capture above deliberately happened BEFORE
             this delete (so the rows survive it), which means the captured
             hash describes a file we are now removing. Without this reset the
             first write site re-reads an absent file against a live hash and
             reports a guaranteed false conflict on every fresh run. */
          castBase?.markDeleted();
        });
        await rm(manuscriptEditsJsonPath(recordRef.bookDir), { force: true });
```

Also update the comment block immediately above it: the sentence "This file's
five merge-base writes plus `readPriorCastForMerge` are deliberately out of
scope here — tracked on #2015" is now false. Replace with:

```
           #2015/#2155 update: the five merge-base writes and
           readPriorCastForMerge are no longer out of scope — they are locked
           too, and the carryover's delete now rides this same hold. */
```

- [ ] **Step 2: Correct `analysis.fresh-cast-lock.test.ts`'s stale header**

That file's header asserts the analysis job's `readPriorCastForMerge` read is
"unlocked, unrelated" — both halves are now wrong, and the claim is load-bearing
for how the test reasons about interception order. Replace that paragraph:

```
   Named deliberately: cast-aliases' add-alias re-reads cast.json INSIDE its
   own lock and refuses with 409 when the cast is absent (see
   cast-aliases.ts) — it is rule-2-compliant, so once serialised against the
   delete it leaves cast.json deleted in BOTH orderings.

   #2015 update: analysis.ts's own readPriorCastForMerge is now LOCKED, and
   reads via readFile (cast-fingerprint.ts) rather than state-io's readJson,
   so it neither trips the readJson interceptor below nor races the delete.
   It queues behind add-alias's held lock instead, which adds two extra lock
   handoffs between `released()` and the delete actually landing — hence the
   widened settle window below.
```

Then widen the post-release settle window from 80ms to 400ms:

```ts
        released();
        resAlias = await aliasPromise;
        /* #2015 — three handoffs now, not one: add-alias releases, the job's
           locked capture acquires+releases, then the delete acquires. */
        await new Promise((r) => setTimeout(r, 400));
```

- [ ] **Step 3: Run the race test 5 times in separate processes**

```bash
cd server
for i in 1 2 3 4 5; do npx vitest run src/routes/analysis.fresh-cast-lock.test.ts --retry=0 || echo "RUN $i FAILED"; done
```
Expected: 5/5 PASS, no `RUN n FAILED` lines. `retry: 1` is live in this repo and
has produced a false green (#2028) — `--retry=0` is not optional here.

- [ ] **Step 4: Confirm the fresh-run negative control from Task 2 still holds**

```bash
cd server && npx vitest run src/workspace/cast-merge-base.test.ts --retry=0
```
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/routes/analysis.ts server/src/routes/analysis.fresh-cast-lock.test.ts
git commit -m "fix(server): fold the reuse-carryover delete into the cast lock"
```

---

### Task 5: Route the five writes through the baseline, and delete the allowlist entry (§3, §5)

**Files:**
- Modify: `server/src/routes/analysis.ts` — five sites (`:3646`, `:3858`, `:4898` main; `:5626`, `:6161` subset)
- Modify: `server/src/workspace/cast-lock.guard.test.ts:400-404`

**Interfaces:**
- Consumes: `castBase` (Task 3), `reportCastConflict` (defined in this task,
  consumed by Task 6's emit).
- Produces: nothing new outside `analysis.ts`.

**Before writing:** re-locate all five sites with
`grep -n "writeJsonAtomic(castJsonPath" server/src/routes/analysis.ts`. The
line numbers above were verified at `5840b5f0` but earlier tasks in this plan
shift them.

- [ ] **Step 1: Add the conflict reporter next to each route's `send`**

In the main route, immediately after `const send = (payload: unknown) => {…}`
(`analysis.ts:2802-2805`):

```ts
  /* #2015 §4 — a genuine stale merge base stops being silent. The write still
     proceeds with the same base it uses today, so NO data is lost that is not
     already lost today; what changes is that it is now visible. */
  const reportCastConflict = (site: string) => (c: { expected: string; observed: string }) => {
    console.warn(
      `[analysis] cast_merge_base_stale mns=${manuscriptId} site=${site} ` +
        `expected=${c.expected.slice(0, 12)} observed=${c.observed.slice(0, 12)}`,
    );
    send({
      kind: 'warning',
      code: 'cast_merge_base_stale',
      message:
        'Another change to this book’s cast landed while the analysis was running. ' +
        'The analysis result was applied on top of the older cast, so that change may have been overwritten.',
    });
  };
```

Add the identical block to the subset route after its own `send`
(`analysis.ts:5357-5360`), with `[analysis-subset]` as the log prefix.

- [ ] **Step 2: Convert each of the five writes**

Site 1 — the main route's per-chapter interim write. Replace:

```ts
              const mergedInterim = overlayInterimCastForLiveView(priorCastForMerge, interim);
              await writeJsonAtomic(castJsonPath(recordRef.bookDir), {
                characters: mergedInterim,
              });
```

with:

```ts
              const mergedInterim = overlayInterimCastForLiveView(priorCastForMerge, interim);
              await castBase!.writeChecked(
                { characters: mergedInterim },
                reportCastConflict('interim'),
              );
```

`castBase` is non-null exactly when `recordRef.bookDir` is set, and every one of
the five sites already sits inside a `if (recordRef.bookDir)` / `if
(record.bookDir)` guard — confirm that for each site before using `!`.

Apply the same transformation at the other four, with these `site` labels:

| Site | Payload variable | `site` label |
|---|---|---|
| main per-chapter interim | `mergedInterim` | `'interim'` |
| main stage-1 | `mergedStage1` | `'stage1'` |
| main final | `mergedFinal.characters` | `'final'` |
| subset per-chapter interim | `mergedInterim` | `'subset-interim'` |
| subset final | `mergedFinal.characters` | `'subset-final'` |

**Rule 1 check before each:** all five spans contain only pure helpers plus
`writeJsonAtomic`, and `analysis.ts` imports no design or library-voice lock, so
no earlier-class acquisition happens inside the new `cast` hold. Re-confirm by
reading each span rather than trusting this line.

- [ ] **Step 3: Delete the allowlist entry**

In `server/src/workspace/cast-lock.guard.test.ts`, delete this entry outright —
do **not** renumber it to `{ writes: 0 }`:

```ts
  [
    'routes/analysis.ts',
    { writes: 5, rms: 0, why: 'merge-base writes deferred to #2015; the rm IS locked (Task 11)' },
  ],
```

`scanFile` returns `null` when a file has zero unlocked occurrences, so a
file that now scans clean but is still on the allowlist trips the guard's own
"scan now finds ZERO unlocked occurrences — update or remove this entry" branch
(`:450-457`). A `{ writes: 0 }` entry is not merely wrong, it is impossible.

Update the block comment above the map — it opens "Two entries by design." and
names `analysis.ts` throughout:

```ts
/* One entry by design.

   Keyed on file AND expected count, never on file alone, and the count check
   below fires on a mismatch in EITHER direction — a fix that removes an
   unlocked write must shrink or delete its entry, exactly as a regression
   that adds one must fail the guard.

   #2015/#2155 — routes/analysis.ts's entry is GONE, not zeroed: its five
   merge-base writes now go through createCastMergeBase (which takes the lock)
   and its reuse-carryover rm rides the same hold as cast.json's. A file that
   scans clean must not stay on the allowlist; `scanFile` returns null for it
   and the trailing unmatched-key check below would fail. Any NEW unlocked
   write in that file now fails the guard directly, with no entry to inherit. */
```

- [ ] **Step 4: Run the guard and the full analysis suite**

```bash
cd server && npx vitest run src/workspace/cast-lock.guard.test.ts --retry=0
cd server && npx vitest run src/routes/analysis --retry=0
cd server && npx tsc --noEmit -p .
```
Expected: all PASS. The guard failing with "NOT on the allowlist" means a write
was missed; the guard failing with "scan now finds ZERO" means the entry was not
deleted.

- [ ] **Step 5: Mutation-verify the guard actually still bites**

Temporarily revert site 1 to a bare `writeJsonAtomic(castJsonPath(...), …)`.
Run the guard. Expected: FAIL with `routes/analysis.ts: 1 unlocked write(s) …
NOT on the allowlist`. Revert.

Without this, "the guard is green" is indistinguishable from "the guard no
longer looks at this file".

- [ ] **Step 6: Commit**

```bash
git add server/src/routes/analysis.ts server/src/workspace/cast-lock.guard.test.ts
git commit -m "fix(server): serialise analysis.ts's five cast merge-base writes"
```

---

### Task 6: Replay the advisory (design §4 item 4)

**Files:**
- Modify: `server/src/routes/analysis.ts` — `AnalysisJobReplayState` (`:2116-2146`), `trackForReplay` (`:2338-2390`), `replayCatchUp` (`:2392-2400`), both job-init literals (`:2612-2619`, `:5282-5289`)
- Test: `server/src/routes/analysis.test.ts` (new cases in the existing replay describe at `:1027`)

**Interfaces:**
- Consumes: the `{ kind: 'warning', code, message }` payload from Task 5.
- Produces: `AnalysisJobReplayState['warnings']` —
  `Map<string, { kind: 'warning'; code: string; message: string }>`, keyed by
  `code`.

**Why this task exists:** `trackForReplay`'s switch handles only
`log`/`phase`/`eta`/`cast-update`/`chapter-failed`/`chapter-resolved`. Without a
`warning` case, an advisory emitted while the user is disconnected is never
replayed on reconnect — and a long, disconnected run is precisely the scenario
with the widest race window. Omitting this drops the signal in the dominant case,
**silently**.

- [ ] **Step 1: Write the failing tests**

Append to `server/src/routes/analysis.test.ts` (a new `describe` beside the
existing replay ones):

```ts
describe('warning replay (#2015 — an advisory survives a disconnect)', () => {
  function makeJob(): AnalysisJob {
    return {
      controller: new AbortController(),
      subscribers: new Set(),
      manuscriptId: 'm1',
      kind: 'main',
      bookDir: null,
      engine: 'gemini',
      replay: {
        logs: [],
        lastPhase: null,
        lastEta: null,
        lastCastUpdate: null,
        failedByChapterId: new Map(),
        lastSeriesPrior: null,
        warnings: new Map(),
      },
      lastDiskWriteAt: 0,
    } as unknown as AnalysisJob;
  }

  it('replays a warning emitted while nobody was listening', () => {
    const job = makeJob();
    trackForReplay(job, {
      kind: 'warning',
      code: 'cast_merge_base_stale',
      message: 'Another change landed.',
    });

    const sent: unknown[] = [];
    replayCatchUp(job, (ev) => sent.push(ev));

    expect(sent).toContainEqual({
      kind: 'warning',
      code: 'cast_merge_base_stale',
      message: 'Another change landed.',
    });
  });

  it('dedupes by code — five sites conflicting once replay ONE advisory, not five', () => {
    const job = makeJob();
    for (let i = 0; i < 5; i++) {
      trackForReplay(job, {
        kind: 'warning',
        code: 'cast_merge_base_stale',
        message: `attempt ${i}`,
      });
    }
    const sent: unknown[] = [];
    replayCatchUp(job, (ev) => sent.push(ev));
    expect(sent.filter((e) => (e as { kind?: string }).kind === 'warning')).toHaveLength(1);
  });

  it('ignores a malformed warning rather than storing an undefined key', () => {
    const job = makeJob();
    trackForReplay(job, { kind: 'warning' });
    trackForReplay(job, { kind: 'warning', code: 'x' });
    const sent: unknown[] = [];
    replayCatchUp(job, (ev) => sent.push(ev));
    expect(sent).toHaveLength(0);
  });
});
```

Confirm `trackForReplay` and `replayCatchUp` are already imported at the top of
`analysis.test.ts`; add them to the import if not.

- [ ] **Step 2: Run to verify they fail**

Run: `cd server && npx vitest run src/routes/analysis.test.ts -t "warning replay" --retry=0`
Expected: FAIL — nothing is replayed (the switch has no `warning` case).

- [ ] **Step 3: Implement**

Add to `AnalysisJobReplayState` (after `failedByChapterId`):

```ts
  /** #2015 — advisories emitted during the run, keyed by `code` so a burst
      across the five merge-base write sites replays as ONE. Not cleared:
      a stale merge base stays true for the rest of the run. */
  warnings: Map<string, { kind: 'warning'; code: string; message: string }>;
```

Add to `trackForReplay`'s switch, before the trailing comment:

```ts
    case 'warning': {
      const e = ev as { code?: string; message?: string };
      if (typeof e.code === 'string' && typeof e.message === 'string') {
        job.replay.warnings.set(e.code, {
          kind: 'warning',
          code: e.code,
          message: e.message,
        });
      }
      break;
    }
```

Add to `replayCatchUp`, after the `failedByChapterId` loop:

```ts
  for (const warning of job.replay.warnings.values()) send(warning);
```

Add `warnings: new Map(),` to **both** job-init literals (`:2612-2619` and
`:5282-5289`). Missing the subset one leaves `job.replay.warnings` undefined and
`trackForReplay` throws on the subset route — where two of the five write sites
live.

- [ ] **Step 4: Run to verify they pass**

```bash
cd server && npx vitest run src/routes/analysis.test.ts -t "warning replay" --retry=0
cd server && npx vitest run src/routes/analysis --retry=0
```
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/routes/analysis.ts server/src/routes/analysis.test.ts
git commit -m "feat(server): replay the cast merge-base advisory on reconnect"
```

---

### Task 7: Document the event in openapi.yaml

**Files:**
- Modify: `openapi.yaml` — new `AnalyseWarningEvent` schema near `AnalysePhaseEvent` (`:5165`), plus both analysis routes' `oneOf` (`:562-566`, `:596-600`)
- Modify: `src/lib/api-types.ts` (regenerated, never hand-edited)

**Interfaces:**
- Produces: `components["schemas"]["AnalyseWarningEvent"]` in the generated types.

**Scope note:** the analysis stream carries roughly fourteen `kind`s and
`openapi.yaml` documents two. This task documents the **new** one and does not
undertake to backfill the other twelve — that is a separate chore, and widening
it here would bury this change in an unrelated diff.

- [ ] **Step 1: Add the schema**

Insert immediately after `AnalysePhaseEvent` (`openapi.yaml:5172`):

```yaml
    AnalyseWarningEvent:
      type: object
      description: |
        Non-fatal advisory on the analysis SSE stream. The analysis continues;
        a `warning` never replaces the terminal `result`. Follows the same
        `code` + `message` envelope the splice, generation and QA-repair
        streams use, so a caller can dedupe and route without parsing prose.
      required: [kind, code, message]
      properties:
        kind: { type: string, enum: [warning] }
        code:
          type: string
          description: |
            Stable machine-readable warning code. Today only
            `cast_merge_base_stale` — emitted when another route wrote
            `cast.json` between two of this run's own merge-base writes, so the
            analysis result was merged onto an older cast and that write may
            have been overwritten. Replayed once per code on reconnect.
          enum: [cast_merge_base_stale]
        message:
          type: string
          description: Human-readable advisory text.
```

- [ ] **Step 2: Add it to both routes' `oneOf`**

In `/api/manuscripts/{manuscriptId}/analysis` and
`/api/manuscripts/{manuscriptId}/analysis/chapters`, both `text/event-stream`
blocks:

```yaml
              schema:
                oneOf:
                  - $ref: '#/components/schemas/AnalysePhaseEvent'
                  - $ref: '#/components/schemas/AnalyseWarningEvent'
                  - $ref: '#/components/schemas/AnalyseResponse'
```

- [ ] **Step 3: Regenerate the types**

```bash
npm run openapi:types
git diff --stat src/lib/api-types.ts
```
Expected: `api-types.ts` gains `AnalyseWarningEvent`. If the diff is empty the
regeneration did not run — an openapi.yaml edit always stales `api-types.ts`.

- [ ] **Step 4: Verify**

```bash
npm run typecheck
```
Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add openapi.yaml src/lib/api-types.ts
git commit -m "docs(api): document the analysis stream's warning event"
```

---

### Task 8: Deliver the advisory to the user (design §4 items 2, 3, 5)

**Files:**
- Modify: `src/lib/api.ts` — union (`:2679-2691`), `AnalyseOpts`, `realAnalyseManuscript` (`:2766`), `realRunAnalysisForChapters` (`:5363`)
- Modify: `src/views/analysing.tsx` — both stream call sites (near `:502` and `:838`)
- Test: `src/views/analysing.test.tsx`

**Interfaces:**
- Consumes: the `{ kind: 'warning', code, message }` wire payload (Task 6).
- Produces: `AnalyseOpts['onWarning']?: (w: { code: string; message: string }) => void`.

**Two traps, both silent:**

1. **`realRunAnalysisForChapters` is a second consumer.** Two of the five write
   sites are on the subset route. The `handle` chain ignores unknown kinds, so a
   missed reader drops the signal with no error anywhere.
2. **The wire kind is `'warning'`; the toast kind is `'warn'`.**
   `ToastKind = 'error' | 'warn' | 'info'` (`src/store/notifications-slice.ts:19`).
   Passing `'warning'` to `pushToast` is a type error — catch it here, not in CI.

- [ ] **Step 1: Write the failing test**

Add to `src/views/analysing.test.tsx`:

```tsx
it('surfaces a cast_merge_base_stale advisory as a deduped warn toast (#2015)', async () => {
  const store = makeStore();
  vi.mocked(api.analyseManuscript).mockImplementation(async (_id, opts) => {
    opts?.onWarning?.({ code: 'cast_merge_base_stale', message: 'Another change landed.' });
    opts?.onWarning?.({ code: 'cast_merge_base_stale', message: 'Another change landed.' });
    return ANALYSIS_FIXTURE;
  });

  render(
    <Provider store={store}>
      <Analysing />
    </Provider>,
  );

  await waitFor(() => {
    const toasts = store.getState().notifications.toasts;
    expect(toasts).toHaveLength(1);
    expect(toasts[0]).toMatchObject({
      kind: 'warn',
      dedupeKey: 'cast_merge_base_stale',
      message: 'Another change landed.',
    });
  });
});
```

Match the file's existing store/render/fixture helpers rather than the names
above if they differ — read the top of `analysing.test.tsx` first.

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/views/analysing.test.tsx -t "cast_merge_base_stale" --retry=0`
Expected: FAIL — `onWarning` is not a property of `AnalyseOpts`.

- [ ] **Step 3: Add the kind and the callback in `api.ts`**

Extend the hand-written union at `:2679-2691` (this union is **hand-mirrored**,
not generated — `npm run openapi:types` does not touch it):

```ts
interface AnalysisStreamEvent {
  kind:
    | 'phase'
    | 'result'
    | 'error'
    | 'log'
    | 'heartbeat'
    | 'cast-update'
    | 'eta'
    | 'chapter-failed'
    | 'chapter-resolved'
    | 'throttle'
    | 'series-prior'
    | 'warning';
```

`code` and `message` are already optional properties on this interface — no
further field is needed.

Add to `AnalyseOpts`:

```ts
  /** #2015 — a non-fatal advisory from the server (today only
      `cast_merge_base_stale`). Both the full-book and the subset stream emit
      it; the subset route carries two of the five merge-base write sites. */
  onWarning?: (warning: { code: string; message: string }) => void;
```

- [ ] **Step 4: Dispatch it in BOTH readers**

In `realAnalyseManuscript`, destructure `onWarning` alongside `onThrottle`, then
add a branch to the `handle` chain beside the `throttle` one:

```ts
    } else if (payload.kind === 'warning') {
      if (payload.code && payload.message) {
        onWarning?.({ code: payload.code, message: payload.message });
      }
```

Do the same in `realRunAnalysisForChapters` (`:5363`). Its handler is documented
as "Same handler as analyseManuscript" (`:5397`) — verify the branch actually
landed in both by grepping:

```bash
grep -c "payload.kind === 'warning'" src/lib/api.ts
```
Expected: `2`. A `1` here is the silent-drop failure mode.

- [ ] **Step 5: Push the toast from both `analysing.tsx` call sites**

At each of the two `onLog:` handlers' sibling positions (near `:502` and `:838`),
add:

```tsx
          onWarning: ({ code, message }) => {
            /* dedupeKey collapses a burst across the five merge-base write
               sites into one toast. Wire kind is 'warning'; ToastKind is
               'warn' — they are different vocabularies, not a typo. */
            dispatch(
              notificationsActions.pushToast({ kind: 'warn', message, dedupeKey: code }),
            );
          },
```

The first call site guards its handlers with `if (cancelled) return;` — match
the surrounding style at each site rather than pasting identically.

Two facts verified in the file, so you do not have to re-derive them: both call
sites live inside the single `AnalysingView` component (`:124`), so the
`dispatch` at `:132` is in scope for both. `notificationsActions` is **not**
currently imported — add it:

```tsx
import { notificationsActions } from '../store/notifications-slice';
```

- [ ] **Step 6: Run to verify it passes**

```bash
npx vitest run src/views/analysing.test.tsx --retry=0
npm run typecheck
```
Expected: PASS, clean.

- [ ] **Step 7: Verify the second reader is genuinely wired**

Add the same test against the subset path if `analysing.test.tsx` exercises it;
otherwise assert directly in `src/lib/api.*.test.ts` that
`runAnalysisForChapters` forwards an `onWarning`. Do not rely on the
`grep -c` count alone — it proves the text is present, not that it runs.

- [ ] **Step 8: Commit**

```bash
git add src/lib/api.ts src/views/analysing.tsx src/views/analysing.test.tsx
git commit -m "feat(frontend): surface the cast merge-base advisory as a toast"
```

---

### Task 9: Route-level controls through `runMainAnalyzerJob`

**Files:**
- Create: `server/src/routes/analysis.merge-base-detect.test.ts`

**Interfaces:**
- Consumes: everything above. Produces nothing.

**Why a route-level test on top of Task 2's unit controls:** Task 2 proves the
baseline logic is correct in isolation. It cannot prove `analysis.ts` *wired* it
— that `markDeleted()` is actually called in the fresh block, that all five
sites go through `writeChecked`, that the subset route got its own reporter.
That wiring is where a ~100%-false-positive detector would still hide.

Model this file on `analysis.fresh-cast-lock.test.ts` — same Express app +
workspace-backed book + stub-analyzer machinery, same
`detectOllamaDevice`/`setLastKnownAnalyzerDevice` hoisted mocks. Read that file
in full before starting; it is the working precedent for driving
`runMainAnalyzerJob` under test.

- [ ] **Step 1: Write the negative control**

```ts
/* #2015 — the route-level negative control. An uncontended multi-chapter
   Start-fresh run must emit ZERO cast_merge_base_stale warnings.

   This is the most important test in the change. A detector with a ~100%
   false-positive rate passes every positive-only test: asserting only that a
   real conflict is caught cannot distinguish a working detector from one that
   fires unconditionally. Multi-chapter is mandatory (two of the five write
   sites are inside per-chapter loops, so a single-chapter run executes each
   site once and cannot observe a stale-baseline false positive at all); fresh
   is mandatory (it is the shape that killed design 3). */
it('an uncontended multi-chapter Start-fresh run emits zero stale warnings', async () => {
  const warnings: Array<{ code?: string }> = [];
  const job = makeJob((ev) => {
    if ((ev as { kind?: string }).kind === 'warning') warnings.push(ev as { code?: string });
  });

  await runMainAnalyzerJob(job, getManuscript(manuscriptId)! as never, selection, {
    requestedFresh: true,
    allowStage1Shrink: true,
    requestedModel: undefined,
  });

  expect(warnings.filter((w) => w.code === 'cast_merge_base_stale')).toEqual([]);
}, 30_000);
```

The fixture must have **at least three chapters** so the per-chapter interim
write runs more than once. `makeJob` is a local helper that builds the
`AnalysisJob` literal (copy the shape from
`analysis.fresh-cast-lock.test.ts:240-257`, adding `warnings: new Map()`) with a
subscriber whose `send` pushes into the captured array.

- [ ] **Step 2: Write the same control for a NON-fresh run**

Identical, but seed a real `cast.json` first and pass `requestedFresh: false`.
This covers the `sha256` baseline path; Step 1 covers the `ABSENT` path.

- [ ] **Step 3: Write the positive control**

A foreign `writeFileSync` to `cast.json` between two of the run's own writes,
scripted with the same gated-`readJson` technique
`analysis.fresh-cast-lock.test.ts` uses. Assert **exactly one**
`cast_merge_base_stale` warning — not "at least one". "At least one" cannot fail
for a detector that fires five times, which is the regression Task 2's
baseline-advance rule exists to prevent.

- [ ] **Step 4: Write the disabled-detection control**

A carryover-sourced run (no `cast.json`, a populated
`cast-reuse-carryover.json`) plus a foreign write mid-run. Assert **zero**
warnings — `fingerprint: null` disables detection rather than reporting a false
conflict.

- [ ] **Step 5: Assert srv-13 carry-forward is unchanged**

Seed a `cast.json` carrying a designed voice, run a fresh analysis, and assert
the voice survives onto the final roster — the 2026-07-14 Coalfall voice-strip
invariant, carried forward from #2015's acceptance. `analysis.test.ts` already
has a fresh-run voice-preservation case; mirror its assertions rather than
inventing new ones.

- [ ] **Step 6: Run 5 times in separate processes**

```bash
cd server
for i in 1 2 3 4 5; do npx vitest run src/routes/analysis.merge-base-detect.test.ts --retry=0 || echo "RUN $i FAILED"; done
```
Expected: 5/5 PASS.

- [ ] **Step 7: Mutation-verify the negative control**

Comment out `castBase?.markDeleted()` in `analysis.ts`. Re-run. Expected: the
fresh negative control FAILS. Restore.

Then delete the baseline-advance line in `cast-merge-base.ts`. Re-run. Expected:
the multi-chapter negative control FAILS. Restore.

If either mutation leaves the suite green, the control is not wired to the
production path and the whole change is unverified.

- [ ] **Step 8: Commit**

```bash
git add server/src/routes/analysis.merge-base-detect.test.ts
git commit -m "test(server): add route-level controls for merge-base detection"
```

---

### Task 10: Ship

**Files:**
- Modify: `docs/release-notes-next.md`, `RELEASE_NOTES.md`
- Modify: `docs/features/INDEX.md` (link the spec + this plan)
- Modify: `docs/testing/onbox-acceptance-register.md`, `docs/testing/onbox-acceptance-register-live-view.html`

- [ ] **Step 1: Release notes, both files**

`docs/release-notes-next.md` — technical register, PR-refed:

```markdown
- **Cast merge-base serialised, and staleness now surfaces.** `analysis.ts`'s
  five `cast.json` merge-base writes and its `readPriorCastForMerge` capture now
  run inside the `cast` lock, and the reuse-carryover delete rides the same hold
  as `cast.json`'s. A write by another route landing mid-run is detected via a
  sha256 compare-and-set and surfaced as a `cast_merge_base_stale` advisory on
  the analysis SSE stream. Merge behaviour is unchanged — the rebuild-on-conflict
  path stays open on #2015. `routes/analysis.ts` leaves the cast-lock guard
  allowlist entirely. (#2155, PR #NN)
```

`RELEASE_NOTES.md` — user-facing, brand voice, in the in-progress version
section at the top:

```markdown
- If something else changes your cast while an analysis is running, Castwright
  now tells you instead of quietly keeping the older version.
```

- [ ] **Step 2: On-box acceptance**

This change is provable in CI — no live GPU, sidecar, analyzer or real book is
required, and Task 9's controls run in the normal server suite. **No register
row is owed.** State that explicitly in the PR body rather than omitting the
step silently.

- [ ] **Step 3: Full local battery**

```bash
npm run verify:fast:branch
```
Expected: every in-scope leg green.

- [ ] **Step 4: Open the PR**

Title: `fix(server): serialise the cast merge base and surface staleness`

Body must contain:
- `Closes #2155`
- `Refs #2015` — and one sentence saying **why it stays open**: this ships
  detection only; the rebuild-on-conflict path is deliberately out of scope and
  four designs have died on it.
- A link to the spec and to this plan.
- Any incidental findings fixed in passing, per CLAUDE.md ("Also fixed, found in
  passing: …").

- [ ] **Step 5: Mandatory `code-review` gate**

Multi-scope (`server` + `frontend` + `api`) → **`high`** effort, Premium tier.
Triage and fold findings before merge.

- [ ] **Step 6: Post the #2015 residual**

Comment on #2015 recording that capture and serialisation are done, that the
allowlist entry is gone, and that what remains is the rebuild — so the next
reader does not re-solve the capture problem for a sixth time.

---

## Self-Review

**Spec coverage**

| Spec section | Task |
|---|---|
| §1 capture, fingerprinted + locked | 1, 3 |
| §1a three fingerprint states | 1 (`ABSENT` sentinel), 2 (`enabled`), 3 (`null` for carryover) |
| §2 carryover rides the `cast` key | 3 (the read), 4 (the delete) |
| §3 five write sites, one hold each | 5 |
| §3a baseline-advance rule | 2 (mechanism), 4 (`markDeleted` wiring), 9 (proof) |
| §4 log + SSE advisory | 5 (emit), 6 (replay), 7 (openapi), 8 (readers + UI) |
| §4 item 6 the mock | **Deviation, documented above** — discharged via the shared `AnalyseOpts` type |
| §5 allowlist removed, not renumbered | 5 |
| Testing: negative control | 2 (unit), 9 (route) |
| Testing: fresh mandatory, both directions | 2, 9 |
| Testing: multi-chapter mandatory | 2, 9 |
| Testing: mutation-verified, `--retry=0`, 5 runs | 1, 2, 4, 5, 9 |
| Testing: assert outcomes not mechanisms | 2 (serialisation test), 9 |
| Testing: srv-13 carry-forward | 9 |
| Testing: carryover run disables detection | 2, 9 |

No spec requirement is unassigned.

**Type consistency**

`CastFingerprint`, `ABSENT`, `readJsonWithFingerprint`, `fingerprintOfWrite`
(Task 1) → `createCastMergeBase`, `CastMergeBase`, `CastMergeBaseConflict`
(Task 2) → `PriorCastSnapshot`, `castBase` (Task 3) → `markDeleted`,
`writeChecked` (Tasks 4–5) → `warnings` (Task 6) → `AnalyseWarningEvent`
(Task 7) → `onWarning` (Task 8). Names are used identically at every
consumption point. The one intentional asymmetry — wire `'warning'` vs. toast
`'warn'` — is called out at its call site in Task 8.

**Known line-number drift.** Every line reference was verified against
`analysis.ts` at `5840b5f0`, but Tasks 3, 4 and 5 all edit that file, so later
tasks' numbers shift. Each of those tasks re-locates its targets by `grep`
rather than by line number — do not navigate by the numbers in this document
after Task 3.
