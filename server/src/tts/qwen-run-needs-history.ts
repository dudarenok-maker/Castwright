/* The run-start read of the book's cast-id history for the run-needs / post-score
   keep computation (#4556, #4560). Lives OUTSIDE the generation route handler on
   purpose: the #2128 guard (generation-cast-history-seq.guard.test.ts) requires
   exactly ONE `loadCastIdHistory(` call in the handler body — the per-chapter
   render read that `castHistorySeq` is stamped from. This read only decides which
   Qwen tiers to keep loaded; it never feeds a stamp. Never throws (see
   loadCastIdHistory's own doc comment). */

import { loadCastIdHistory, type CastIdHistory } from '../store/cast-id-history.js';

export function loadRunNeedsCastIdHistory(bookDir: string): Promise<CastIdHistory> {
  return loadCastIdHistory(bookDir);
}
