/* Per-book snapshot of the in-flight analyzer's state for cold-boot
   rehydration of the AnalysisPill across browser reload + server
   restart.

   The sticky-analysis B-series (commits 287587d / 50f4285 / dc918ba)
   made the analyzer survive navigation by owning an `inFlightAnalysisByManuscript`
   in-memory map. But that map evaporates on server restart, and the
   client-side `analysis.activeStream` snapshot evaporates on browser
   reload — so even though `server/handoff/cache/{manuscriptId}.json`
   preserves the actual work, the pill silently disappears.

   This file persists *enough* state at phase boundaries / on pause /
   on terminal events for the GET /api/books/:bookId/analysis/state
   discovery endpoint to re-seed the pill. Disk format is intentionally
   minimal — anything we can re-derive from the analyzer cache stays
   out.

   Write sites:
   - server/src/routes/analysis.ts: trackForReplay's `phase` branch
     (throttled to once per 5s), pause endpoint, endJob branches.

   Read sites:
   - server/src/routes/book-state.ts: GET /:bookId/analysis/state.
     Memory-first (live in-flight job wins), disk-fallback, running→
     paused coercion when there's no live job. */

import { existsSync } from 'node:fs';
import { unlink } from 'node:fs/promises';
import { readJson, writeJsonAtomic } from '../workspace/state-io.js';
import { analysisStateJsonPath } from '../workspace/paths.js';

/** Persistable shape — minimal subset of AnalysisStreamSnapshot.
    Anything ephemeral (heartbeats, log lines, in-flight ETA) is
    intentionally not persisted because the live SSE re-derives it. */
export interface AnalysisStateFile {
  manuscriptId: string;
  phaseId: number;
  phaseLabel: string;
  phaseProgress: number;
  /** `running` is only set while the analyzer is actively producing
      ticks. On cold-boot read, callers must coerce `running` → `paused`
      because no live in-flight job means the analyzer didn't survive
      the restart. */
  state: 'running' | 'paused' | 'halted';
  /** Error code from the terminal event when state === 'halted'.
      Carried so the pill / view can route to the right banner. */
  haltCode?: string;
  /** Trimmed (≤256-char) error message when state === 'halted'. The
      pill shows the first ~32 chars; the full text lives in the
      analysing view's halted banner. */
  haltReason?: string;
  /** ms since epoch of the most recent in-process tick that produced
      this snapshot. The pill uses it for the "X seconds since last
      update" stall indicator on cold-boot. */
  lastTickAt: number;
  /** ms since epoch this file was written. Separate from lastTickAt
      so we can distinguish "in-flight tick fired at T1 and we wrote at
      T2" from "we wrote terminal state at T3". Used by tests + manual
      audit. */
  writtenAt: number;
}

/** Read the snapshot file. Returns null when the file is absent or
    unparseable — both equivalent to "no rehydratable state". */
export async function readAnalysisState(bookDir: string): Promise<AnalysisStateFile | null> {
  const path = analysisStateJsonPath(bookDir);
  if (!existsSync(path)) return null;
  try {
    return await readJson<AnalysisStateFile>(path);
  } catch {
    return null;
  }
}

/** Atomic write — same pattern as state.json / cast.json so an
    OneDrive sync hold can't corrupt the file. Throws on terminal
    failure; callers swallow because losing this snapshot is non-fatal
    (the analyzer cache is the real source of truth — this file only
    feeds the pill). */
export async function writeAnalysisState(
  bookDir: string,
  snapshot: Omit<AnalysisStateFile, 'writtenAt'>,
): Promise<void> {
  const payload: AnalysisStateFile = {
    ...snapshot,
    /* Trim the halt reason so the file doesn't bloat on a stack-traced
       error message. 256 chars is plenty for any pill subtitle; the
       full text lives in console logs + the analysing view's in-memory
       state (re-emitted on the next SSE). */
    haltReason: snapshot.haltReason ? snapshot.haltReason.slice(0, 256) : undefined,
    writtenAt: Date.now(),
  };
  await writeJsonAtomic(analysisStateJsonPath(bookDir), payload);
}

/** Remove the snapshot file. Called on terminal success (kind:'result')
    so a completed analysis doesn't keep showing a pill — the user is
    on the confirm screen and the work is done. Best-effort: a missing
    file is fine (the file may not exist if the analyzer never reached
    a phase boundary). */
export async function deleteAnalysisState(bookDir: string): Promise<void> {
  const path = analysisStateJsonPath(bookDir);
  if (!existsSync(path)) return;
  try {
    await unlink(path);
  } catch {
    /* Swallow — the file is non-load-bearing. Worst case it lingers
       and the next phase-boundary write overwrites it. */
  }
}
