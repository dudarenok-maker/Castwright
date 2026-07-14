/* Gate for the cold-boot top-bar AnalysisPill hydration (layout.tsx).

   A book whose cast is already confirmed has finished analysis. A leftover
   paused/halted analysis snapshot on it — e.g. an aborted or displaced run the
   server never cleared — must NOT resurrect a clickable global "Analysing" pill
   on book open, because clicking that pill navigates to the analysing view and
   RESUMES (re-analyses) the book. In the 2026-07-14 voice-strip incident,
   clicking such a stale pill resumed a fresh re-analysis that stripped every
   designed voice. ("It should show nothing on click as there is nothing being
   analysed.")

   Only a genuinely-running analysis surfaces on a confirmed book. An unconfirmed
   book still surfaces paused/halted snapshots so its legitimate "resume
   analysis" flow keeps working. */
export function shouldSurfaceColdBootAnalysisPill(
  castConfirmed: boolean,
  snapState: 'running' | 'paused' | 'halted',
): boolean {
  if (!castConfirmed) return true;
  return snapState === 'running';
}
