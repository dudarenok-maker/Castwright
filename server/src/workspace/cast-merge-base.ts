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
  UNREADABLE,
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
        /* A transient read error (UNREADABLE — see cast-fingerprint.ts) says
           nothing about who last wrote cast.json, so it must suppress the
           COMPARISON: reporting a mismatch here would be a phantom "someone
           else edited your cast" for an AV-scanner/OneDrive/indexer blip,
           #2185 review). It must NOT also suppress the baseline advance
           below — the advance is derived from `payload`, the bytes THIS
           write just landed on disk, not from the read that failed, so it
           stays trustworthy regardless of whether the read worked. Skipping
           it too was tried and is strictly worse: the baseline would go
           stale at this site and then mismatch the NEXT site's successful
           read of this run's own write, reporting a phantom conflict there
           instead — a cascade, and two of the five real analysis.ts sites
           are inside a per-chapter loop, so this fires on any real
           multi-chapter book that hits a single I/O blip. See
           cast-merge-base.test.ts's "does NOT cause a phantom conflict at
           the NEXT site" regression test.

           The accepted trade: an UNREADABLE read may mean we MISS a real
           conflict that happened during the blip — we clobber the other
           writer exactly as today's (pre-#2185) code does, and say nothing.
           That is an honest missed detection, strictly better than a
           phantom report, and it keeps "merge behaviour is unchanged". */
        if (baseline !== null) {
          const { fingerprint: observed } = await readJsonWithFingerprint(path);
          if (observed !== UNREADABLE && observed !== baseline) {
            /* Report, then carry on: merge behaviour is unchanged and the
               write proceeds with the same base it uses today (design §4).
               onConflict must not throw — the caller's handler only logs and
               emits. */
            onConflict({ expected: String(baseline), observed: String(observed) });
          }
        }
        await writeJsonAtomic(path, payload);
        /* Advance unconditionally on every successful write — through a
           conflict, through an UNREADABLE pre-write read, through a clean
           comparison. Not advancing here would re-report the same event at
           every remaining site (five advisories for one foreign write), or
           worse, invent a phantom one out of this run's own write (see the
           comment above). */
        if (baseline !== null) baseline = fingerprintOfWrite(payload);
      });
    },
  };
}
