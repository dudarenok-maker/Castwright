/* Workspace-wide scan for resumable analysis snapshots.
 *
 * Cold-boot rehydration on the Books library: when the user lands on the
 * library after a refresh / restart, the top-bar AnalysisPill should
 * appear immediately if ANY book has a paused or halted analysis
 * snapshot on disk — without forcing the user to click into the
 * `analysing` route first to discover it.
 *
 * Per-book sticky rehydration is already covered by
 * `GET /api/books/:bookId/analysis/state` (see book-state.ts) — that
 * endpoint needs a `bookId` and returns one snapshot. This module
 * walks the BOOKS_ROOT tree and returns the matching snapshot for
 * every book that has one, sorted most-recently-written first. The
 * library route in `routes/library.ts` exposes this via
 * `GET /api/library/active-analyses`.
 *
 * Running→paused coercion happens here (same rule as the per-book
 * endpoint): if disk says `running`, no live in-flight job exists for
 * that manuscript, so the analyzer didn't survive whatever wiped the
 * in-memory map (server restart, crash, kill). The pill should render
 * as `paused` so the user clicks Resume to re-attach. Live in-flight
 * jobs aren't surfaced here at all — they only matter when the user
 * is actually on the analysing route, and the analysing view's own
 * SSE owns that path. */

import { join } from 'node:path';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { BOOKS_ROOT, analysisStateJsonPath, ensureWorkspace, stateJsonPath } from './paths.js';
import { readJson } from './state-io.js';
import { readAnalysisState, type AnalysisStateFile } from '../store/analysis-state.js';
import type { BookStateJson } from './scan.js';

/** Shape sent over the wire. `AnalysisStateFile` augmented with the
 *  identifying fields the pill needs (`bookId`, `bookTitle`) so the
 *  client doesn't have to round-trip `findBookByBookId` to render. */
export interface ActiveAnalysisSummary {
  bookId: string;
  bookTitle: string;
  manuscriptId: string;
  phaseId: number;
  phaseLabel: string;
  phaseProgress: number;
  /** Always `'paused'` or `'halted'` on the wire — `running` is coerced
      to `paused` because no live in-flight job means the analyzer
      didn't survive the restart that wiped the in-memory map. */
  state: 'paused' | 'halted';
  engine?: 'local' | 'gemini';
  kind?: 'main' | 'subset';
  subsetChapterIds?: number[];
  haltCode?: string;
  haltReason?: string;
  lastTickAt: number;
  writtenAt: number;
}

/** Walk BOOKS_ROOT, read each book's `.audiobook/analysis-state.json`,
 *  apply running→paused coercion, and return the matches sorted by
 *  `writtenAt` DESC (freshest first). Books with no snapshot file are
 *  silently skipped. */
export async function scanActiveAnalyses(): Promise<ActiveAnalysisSummary[]> {
  ensureWorkspace();
  const out: ActiveAnalysisSummary[] = [];
  for (const authorName of listDirs(BOOKS_ROOT)) {
    for (const seriesName of listDirs(join(BOOKS_ROOT, authorName))) {
      for (const titleName of listDirs(join(BOOKS_ROOT, authorName, seriesName))) {
        const bookDir = join(BOOKS_ROOT, authorName, seriesName, titleName);
        /* Snapshot file is the cheap probe — most books in a workspace
           never had analysis run, so skipping early avoids a state.json
           read per skip. */
        if (!existsSync(analysisStateJsonPath(bookDir))) continue;
        const snap = await readAnalysisState(bookDir);
        if (!snap) continue;
        /* state.json read only happens for books that DO have a snapshot
           — needed for bookId + bookTitle. A missing/malformed state.json
           means the workspace is in an inconsistent state for this book;
           skip it silently rather than 500 the whole scan. */
        const state = await readJson<BookStateJson>(stateJsonPath(bookDir)).catch(() => null);
        if (!state) continue;
        out.push(toSummary(state, snap));
      }
    }
  }
  out.sort((a, b) => b.writtenAt - a.writtenAt);
  return out;
}

function toSummary(state: BookStateJson, snap: AnalysisStateFile): ActiveAnalysisSummary {
  /* running → paused coercion (same rule as the per-book endpoint in
     book-state.ts). At this layer there's no in-memory job map to
     consult — the live-job check is the per-book endpoint's job. The
     library scan never returns `'running'` on the wire. */
  const coercedState: 'paused' | 'halted' =
    snap.state === 'halted' ? 'halted' : 'paused';
  return {
    bookId: state.bookId,
    bookTitle: state.title,
    manuscriptId: snap.manuscriptId,
    phaseId: snap.phaseId,
    phaseLabel: snap.phaseLabel,
    phaseProgress: snap.phaseProgress,
    state: coercedState,
    engine: snap.engine,
    kind: snap.kind,
    subsetChapterIds: snap.subsetChapterIds,
    haltCode: snap.haltCode,
    haltReason: snap.haltReason,
    lastTickAt: snap.lastTickAt,
    writtenAt: snap.writtenAt,
  };
}

/* Local copy of scan.ts's `listDirs` helper. Duplicated rather than
   exported to keep scan.ts's surface area small; the implementation is
   tiny and isolated. */
function listDirs(parent: string): string[] {
  try {
    return readdirSync(parent).filter(name => {
      try { return statSync(join(parent, name)).isDirectory(); }
      catch { return false; }
    });
  } catch {
    return [];
  }
}
