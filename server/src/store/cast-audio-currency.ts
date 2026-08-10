/* #2128 / #2129 — "is this orphaned id's rendered audio still current?",
   answered ONCE for both consumers.

   Plan 278's invariant 7 established that the banner and the repair pass must
   not each rank candidates with independently written logic ("two independent
   rankers is the exact duplicate-matching-logic defect class [plan 278] Task
   16's CRITICAL finding came from"). This module extends that to CURRENCY: the
   Cast banner (`segments-io.ts`'s collector) and `repair-cast-id-drift.mjs`
   both call `isAudioCurrent`, and neither decides for itself. The divergence
   #2129 reported — "auto-reconciled, nothing to do" on the banner while the
   repair pass listed 67 segments of the same id — is what two answers look
   like.

   Pure and I/O-free by construction: two `type` imports and nothing else, so
   the repair script can import it from `server/dist` exactly as `main()`
   already imports `buildCastResolver`.

   THE RULE THAT MATTERS: damage is anything other than `true`. A missing
   render stamp, a missing `recordedAtSeq` field, a file counter below a render
   stamp, and a non-finite marker each read `'unknown'`, and `'unknown'` is
   listed. Only an affirmative comparison clears a row. Inverting this is the
   most dangerous mistake available here — it silently re-opens #2107, whose
   whole point was that only the `'exact'` tier means "these bytes are fine". */

import type { CastIdHistory } from './cast-id-history.js';
import type { CastResolution } from './cast-resolve.js';

export type AudioCurrency = true | false | 'unknown';

/** The only thing this module needs off a `<slug>.segments.json`. Structural,
 *  so both the strict write view (`ChapterSegmentsFile`) and the loose read
 *  view (`SegmentsFile`) satisfy it without either importing the other. */
export interface AudioCurrencyStamp {
  castHistorySeq?: number;
}

const finite = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n);

export function isAudioCurrent(
  resolution: CastResolution<{ id: string }> | undefined,
  segmentsFile: AudioCurrencyStamp | undefined,
  history: CastIdHistory,
): AudioCurrency {
  /* A genuine miss never resolved to anything, so there is nothing to be
     current WITH — it is the original #2040 damage, reported as 'unresolved'
     and always listed. */
  if (!resolution) return false;

  /* Unchanged from #2107: the id IS the live cast id today, so the frozen
     bytes were rendered against the same row they resolve to now. The only
     tier that means "fine". */
  if (resolution.via === 'exact') return true;

  const stamp = segmentsFile?.castHistorySeq;
  /* `0` is a VALID stamp, not an absent one — a truthiness check here routes
     every legacy render to 'unknown' and ships #2128 dead. */
  if (!finite(stamp)) return 'unknown';

  /* `'normalised-id'` has no history entry, so there is no marker to compare
     against. Its hazard is different in kind: the render may predate the
     four-tier resolver EXISTING (pre-Wave-1 `resolveGroup` did a bare
     `castById.get()` and substituted the narrator). Per register row A32 that
     is `the-torment` (67 segments) and `lightning-dave` (1) — 68 of the 188
     known damaged segments. The presence of `castHistorySeq` is itself the
     proof the resolver ran, which is the only distinction this tier needs. */
  if (resolution.via === 'normalised-id') return true;

  // 'history' | 'normalised-history'
  const markers = history.recordedAtSeq;
  /* The FIELD being absent means this file has never been through the lane's
     one-shot stamp — or the object was narrowed in transit, which is the shape
     this codebase has produced three times and documents each time. Either way
     there is nothing to compare, and absence must not read as current. */
  if (markers === undefined) return 'unknown';

  /* Counter-reset guard. A render cannot have read a FUTURE state of the file,
     so a file counter below a render's stamp means the file was rebuilt from
     nothing. With `repairSeq` on load this fires only on that path, and only
     transiently — once writes accumulate past the old stamps it stops firing,
     which is correct, because by then the rebuilt file's own markers govern.

     `!finite`, NOT `finite(...) && ...`. Review round 1 (Critical): the
     conjunctive form fails OPEN — `seq?: number` is optional, so an object
     that has `recordedAtSeq` but no `seq` (a hand-narrowed subset, a
     merge conflict, a hand-edit) skips the guard entirely and falls through to
     `stamp >= highest`, which can return `true`. That is spine rule 2's exact
     shape on the one axis this codebase actually fails, and guard 3 is
     call-graph-blind so it cannot see a subset built into a variable.
     `loadCastIdHistory` always supplies a numeric `seq`, so this costs a
     correctly-threaded object nothing. */
  if (!finite(history.seq) || history.seq < stamp) return 'unknown';

  /* An EMPTY `matchedHistoryKeys` must not fall through to the loop below and
     leave `highest` at its seed value — a seed-0 reduce over zero elements is
     the fail-open shape trap 1 warns about: `stamp >= 0` is true for any
     non-negative render stamp, vacuously clearing a row that was never
     actually verified against a marker. Neither current producer of this tier
     (`buildCastResolver`'s tier 2 and tier 4) emits an empty array today, but
     the type permits it and this predicate must not depend on that holding. */
  if (!resolution.matchedHistoryKeys?.length) return 'unknown';

  let highest = 0;
  for (const key of resolution.matchedHistoryKeys) {
    const marker = markers[key];
    /* #2128 review round 1 (I2, owner-ruled) — `cast-id-history.ts`'s
       `recordedAtSeq` doc comment was corrected from "contributes 0" to
       "must read 'unknown', never contribute 0": `bumpSeqAndStamp`'s
       reconcile loops guarantee every `supersededBy` key has a marker after
       every write, so a key missing here despite the FIELD being present
       means the file itself is suspect, not merely old. Treating it as 0
       would satisfy `stamp >= highest` for any finite render stamp and
       silently reopen #2107 — distinct from the field itself being absent,
       handled above. */
    if (marker === undefined) return 'unknown';
    if (!finite(marker)) return 'unknown';
    if (marker > highest) highest = marker;
  }
  /* `max`, not `min`: two raw spellings can collapse onto one `byNormHistory`
     slot with no basis for choosing between their markers, so the render must
     clear the LATEST of them. */
  return stamp >= highest;
}

/** `isAudioCurrent` is per-segments-file, but the banner and the repair pass
 *  both key by orphaned id ACROSS every rendered chapter — an id current in ch2
 *  and stale in ch5 needs one verdict. `false` if any chapter is `false`; else
 *  `'unknown'` if any is `'unknown'`; else `true`. Getting this wrong in the
 *  "any-current => true" direction re-opens #2107 on the banner side.
 *
 *  An empty list returns `true` vacuously; every caller aggregates over at
 *  least one segment, so that case does not arise in production. */
export function aggregateAudioCurrency(values: readonly AudioCurrency[]): AudioCurrency {
  if (values.some((v) => v === false)) return false;
  if (values.some((v) => v === 'unknown')) return 'unknown';
  return true;
}
