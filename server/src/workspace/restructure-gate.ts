/* Leaf gate between the chapter-restructure routes and the analysis routes.
   A restructure rewrites state.json + manuscript-edits.json and remaps chapter
   ids; an analysis job's terminal persist writes manuscript-edits.json from the
   sentences it analysed, unlocked. They must not overlap, so each side refuses
   while the other is live: a restructure is refused while a job (main, subset or
   a draining main) is registered for the manuscript, and a job start is refused
   while a restructure is in flight.

   A leaf module (imports nothing) so neither route module imports the other.
   analysis.ts registers its busy probe at load; with no probe registered no
   analysis job can exist, so the restructure side fails open. In memory only,
   like the job registry itself. */

const restructuring = new Set<string>();
let analysisBusyProbe: (manuscriptId: string) => boolean = () => false;

export function registerAnalysisBusyProbe(probe: (manuscriptId: string) => boolean): void {
  analysisBusyProbe = probe;
}

/** Claim the manuscript for a restructure. False (nothing claimed) while an
    analysis job is registered for it. Synchronous, so the check and the claim
    cannot be split by a job start. */
export function beginRestructure(manuscriptId: string): boolean {
  if (analysisBusyProbe(manuscriptId)) return false;
  restructuring.add(manuscriptId);
  return true;
}

export function endRestructure(manuscriptId: string): void {
  restructuring.delete(manuscriptId);
}

export function isRestructuring(manuscriptId: string): boolean {
  return restructuring.has(manuscriptId);
}
