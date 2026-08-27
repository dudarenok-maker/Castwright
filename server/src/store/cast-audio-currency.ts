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

   THE RULE THAT MATTERS: damage is anything other than `true`. Every one of
   the seven sources below reads `'unknown'`, and `'unknown'` is listed exactly
   like `false` — only an affirmative comparison clears a row:
     1. a missing/non-finite render stamp (`segmentsFile.castHistorySeq`) —
        UNLESS the segment recorded `renderedFallbackCharacterId`, in which
        case source 1 reads `false`, not `'unknown'` (the eighth guard below
        sits above this one and short-circuits it);
     2. a missing `recordedAtSeq` FIELD (the file has never been through the
        #2128 lane);
     3. a missing/non-finite `history.seq` (the file's own write counter);
     4. a file counter below a render's stamp (the counter-reset guard — the
        render claims to have read a future state of the file);
     5. an EMPTY `matchedHistoryKeys` on an alias tier (nothing to verify a
        "current" verdict against — #2128 review round 1 trap 1);
     6. a `recordedAtSeq` KEY missing for a matched history key that IS present
        in `supersededBy` (the field being present but a specific key absent —
        #2128 review round 1 trap 3, I2 owner-ruled) or non-finite;
     7. an EMPTY list handed to `aggregateAudioCurrency` (no chapter evidence
        at all — #2128 review round 1, I1 owner-ruled).
   This list is the canonical statement of the fail-closed policy both
   consumers read — keep it in sync with the code: a header that enumerates
   fewer than the real set is exactly how a later reader talks themselves into
   "simplifying" a guard the header never mentioned. Inverting any of the
   seven is the most dangerous mistake available here — it silently re-opens
   #2107, whose whole point was that only the `'exact'` tier means "these
   bytes are fine".

   An eighth guard sits alongside the seven above but does NOT belong to the
   'unknown' list: ANY tier — not only `'normalised-id'` — additionally reads
   `false`, never vacuously `true` or `'unknown'`, when its segment recorded
   `renderedFallbackCharacterId` (render-time narrator substitution; register
   row A22). Originally added (fix round, PR #2244 review gate, F1) checking
   only inside the `'normalised-id'` branch; round 2's review gate found the
   identical fail-open one tier over — nothing bumps `history.seq` when the
   live roster changes underneath an already-matched alias, so a marker
   comparison on the 'history'/'normalised-history' tiers cannot see a
   render-time substitution either. Round 3's review gate found the same gap
   one tier further still: hoisting the check above the tier dispatch but
   BELOW the `'exact'` early return left `'exact'` uncovered, on the false
   premise that `'exact'` never reaches this function in practice — the
   banner does `continue` past `'exact'` before calling in, but the repair
   pass (`repair-cast-id-drift.mjs`) resolves every string id with no such
   filter and reaches `'exact'` routinely. The check now sits FIRST, above
   every tier including `'exact'` and above the `!finite(stamp)` guard: a
   recorded substitution is affirmative evidence of damage on its own, so it
   needs neither a tier match nor a stamp to be meaningful. Distinct in kind
   from the seven: those are "no evidence either way", this is affirmative
   evidence OF damage, so `false` is the correct verdict, not `'unknown'`,
   even with no stamp present.
   Still governed by the same rule at the top of this comment — only `true`
   clears a row — so collapsing this eighth guard back into a per-tier check
   (or dropping it for any tier), or sinking it back below `'exact'` or the
   stamp guard, is exactly as dangerous as inverting one of the seven. */

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
  /** F1 (PR #2244 review gate), widened by round 2's own gate — the SAME
   *  segment's `renderedFallbackCharacterId` (`segments-io.ts`'s
   *  `SegmentsFile['segments'][number]`, `string | null | undefined`).
   *  Consulted once, hoisted above every tier below (originally checked
   *  only inside `'normalised-id'`; round 2 found the identical fail-open
   *  one tier over). Appended after `history` rather than folded into
   *  `segmentsFile` so guard 3 (`cast-history-threading.guard.test.ts`)'s
   *  `argIndex = 2` pin for the `history` position needs no change. */
  renderedFallbackCharacterId?: string | null,
): AudioCurrency {
  /* A genuine miss never resolved to anything, so there is nothing to be
     current WITH — it is the original #2040 damage, reported as 'unresolved'
     and always listed. */
  if (!resolution) return false;

  /* A segment carrying `renderedFallbackCharacterId` was rendered in the
     narrator's voice, whatever id it resolves to TODAY — including
     `'exact'`. A live cast row can be reintroduced under the SAME id after
     a fallback render (the likeliest recovery path, since the analyzer
     produced that id from the manuscript originally), so `resolve(id).via
     === 'exact'` proves the id matches the roster TODAY, not that it
     matched at RENDER time. Checked first, above every tier including
     `'exact'` and above the `!finite(stamp)` guard below: a recorded
     substitution is itself affirmative evidence the audio is wrong — it
     needs no stamp and no tier match to be meaningful, unlike the seven
     "no evidence either way" cases in the header comment. That is why this
     reads `false`, not `'unknown'`, even when `segmentsFile.castHistorySeq`
     is absent — `'unknown'` means "we cannot tell"; a substitution record
     means we CAN tell, and the answer is "wrong". `== null`, not
     truthiness — the field is `string | null | undefined` and an empty
     string would BE a substitution record, not an absence of one.

     The two consumers do not reach every tier alike: the repair pass
     (`repair-cast-id-drift.mjs`) resolves every string `characterId` and
     calls `isAudioCurrent` with no exact-tier filter ahead of it, so it
     reaches every tier here, including `'exact'` — an unguarded `'exact'`
     branch above this check would have silently cleared every re-minted-id
     substitution case it reaches (unnumbered: no measured population of
     such cases exists, see the doc comment on
     `buildOrphansFromSegments` in `repair-cast-id-drift.mjs` for the same
     framing). The banner (`segments-io.ts`'s
     `collectOrphanedCharacterFallbacks`) `continue`s past `'exact'` before
     ever calling in, so this function never sees that tier from the banner
     side. Do not move this below `'exact'` or below the stamp guard
     without re-deriving that consumer fact. */
  if (renderedFallbackCharacterId != null) return false;

  /* The substitution check above has already run, so any segment reaching
     here that resolves `'exact'` really was rendered against the row it
     resolves to now — a narrator-voiced substitution under this id would
     have returned `false` above regardless of today's roster. The only
     tier that means "fine" outright, with no marker to compare. */
  if (resolution.via === 'exact') return true;

  const stamp = segmentsFile?.castHistorySeq;
  /* `0` is a VALID stamp, not an absent one — a truthiness check here routes
     every legacy render to 'unknown' and ships #2128 dead. */
  if (!finite(stamp)) return 'unknown';

  /* `'normalised-id'` has no history entry, so there is no marker to compare
     against. Its hazard is different in kind: the render may predate the
     four-tier resolver EXISTING (pre-Wave-1 `resolveGroup` did a bare
     `castById.get()` and substituted the narrator). Per register row A22 that
     is `the-torment` (67 segments) and `lightning-dave` (1) — 68 of the 188
     known damaged segments. The substitution case for THIS tier is now
     caught by the hoisted check above; a finite stamp with no substitution
     recorded is complete affirmative evidence that a resolver ran and this
     id resolved live, so a plain `true` is correct here.

     Deliberately returns BEFORE the counter-reset guard below (`history.seq`
     is never consulted for this tier): this tier reads no `recordedAtSeq`
     marker at all, so it has nothing for the file's write counter to be
     "reset" relative to. Do not reorder this beneath the guard; that would
     make a resolution `res('normalised-id')` with a stale-looking
     `castHistorySeq` read `'unknown'` for a reason this tier's own contract
     has nothing to do with. */
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
 *  #2128 review round 1 (I1, owner-ruled) — an EMPTY list reads `'unknown'`,
 *  not `true`. The prior version returned `true` vacuously on the reasoning
 *  that every caller aggregates over at least one segment — an upstream
 *  invariant that is not part of THIS module's own contract, asserted about
 *  consumers (Tasks 7/9) that did not exist yet to verify it against. A
 *  consumer building its list with a `.filter` (e.g. chapters that actually
 *  have a segments file) can hand this `[]`, and reading that as `true`
 *  reports an orphaned id current on zero evidence — #2107's shape on the
 *  banner side. No evidence is not evidence of currency. */
export function aggregateAudioCurrency(values: readonly AudioCurrency[]): AudioCurrency {
  if (values.length === 0) return 'unknown';
  if (values.some((v) => v === false)) return false;
  if (values.some((v) => v === 'unknown')) return 'unknown';
  return true;
}
