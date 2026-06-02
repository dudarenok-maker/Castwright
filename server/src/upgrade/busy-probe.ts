/* fs-1 — "is the app busy?" probe for the upgrade gate.

   Applying an upgrade restarts the server and tears down the sidecar, so it
   must refuse while any generation or analysis job is in flight (the
   concurrent-multi-book invariant: a render in Book B can't be sacrificed to a
   restart triggered from Book C's Account tab). Reuses the existing in-memory
   job maps via the route-level probes — no new state. */

import { activeGenerationBooks } from '../routes/generation.js';
import { activeAnalysisManuscripts } from '../routes/analysis.js';

export interface BusyState {
  busy: boolean;
  generationBooks: string[];
  analysisManuscripts: string[];
}

export interface BusyProbeDeps {
  generation: () => string[];
  analysis: () => string[];
}

/** Aggregate in-flight generation + analysis. Deps injectable for tests. */
export function anyJobInFlight(deps: BusyProbeDeps = { generation: activeGenerationBooks, analysis: activeAnalysisManuscripts }): BusyState {
  const generationBooks = deps.generation();
  const analysisManuscripts = deps.analysis();
  return {
    busy: generationBooks.length > 0 || analysisManuscripts.length > 0,
    generationBooks,
    analysisManuscripts,
  };
}
