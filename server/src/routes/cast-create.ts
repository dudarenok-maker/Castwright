/* POST /api/books/:bookId/cast/create

   Mint a brand-new cast member and append it to the book's cast.json.
   Unlike cast-add-from-roster (which copies an existing character from a
   prior series-mate), this route creates a character from scratch using
   only the supplied name / gender / ageRange / role fields.

   Request body: { name: string, gender?, ageRange?, role? }
   Response:     { character: <full new record> }

   The new character gets:
   - id: minted via safeId (server/src/util/safe-id.ts) — the same
     Unicode-preserving-kebab minter every other id-minting path uses
     (#2040 RC2), disambiguated against the existing cast ids.
   - voiceState: 'generated'
   - color: 'unset'
   - no matchedFrom (this is a net-new entry, not a reuse)

   409 when the book has no cast.json yet (cast not confirmed). */

import { Router } from 'express';
import type { Request, Response } from '../http.js';
import { findBookByBookId } from '../workspace/scan.js';
import { castJsonPath } from '../workspace/paths.js';
import { readJson, writeJsonAtomic } from '../workspace/state-io.js';
import { withCastLock } from '../workspace/cast-lock.js';
import type { CharacterOutput } from '../handoff/schemas.js';
import { safeId } from '../util/safe-id.js';
import { loadCastIdHistory } from '../store/cast-id-history.js';
import { normaliseIdKey } from '../util/character-id.js';

export const castCreateRouter = Router();

type PersistedCharacter = CharacterOutput & {
  voiceState?: 'generated' | 'tuned' | 'reused' | 'locked';
  gender?: 'male' | 'female' | 'neutral';
  ageRange?: 'child' | 'teen' | 'adult' | 'elderly';
};

interface CastFile {
  characters: PersistedCharacter[];
}

castCreateRouter.post('/:bookId/cast/create', async (req: Request, res: Response) => {
  const bookId = req.params.bookId;
  const body = (req.body ?? {}) as {
    name?: unknown;
    gender?: unknown;
    ageRange?: unknown;
    role?: unknown;
  };

  const name = typeof body.name === 'string' ? body.name.trim() : '';
  if (!name) return res.status(400).json({ error: 'name is required.' });

  const located = await findBookByBookId(bookId);
  if (!located) return res.status(404).json({ error: `Book "${bookId}" not found.` });

  /* #1981 — the read is inside the lock; the minted id and the whole
     `nextCharacters` build are decisions derived from it. */
  return withCastLock(located.bookDir, async () => {
    const cast = await readJson<CastFile>(castJsonPath(located.bookDir));
    if (!cast?.characters) {
      return res.status(409).json({ error: 'Book has no cast.json yet. Confirm cast before adding.' });
    }

    /* `cast` is an unvalidated `readJson<CastFile>` read — `characterSchema` is
       never applied on this route — so a row's `id` can be missing or
       non-string on a corrupt/hand-edited cast.json. Pre-#2085 this was safe
       because `existingIds` was only ever `.has()`-tested; review round 2
       caught that the `normaliseIdKey` calls below now DEREFERENCE every id in
       the set, so a non-string id would throw a `TypeError` into the route's
       error handler instead of 500ing gracefully. Filter here, at the source —
       the same guard `cast-resolve.ts`'s `resolve()` entry point applies for
       the identical reason. */
    const existingIds = new Set(
      cast.characters.map((c) => c.id).filter((id): id is string => typeof id === 'string'),
    );

    /* srv-86 (#2040 follow-up) — an id retired by a merge (cast-id-history.json's
       `supersededBy`) is still actively protecting every segment the retired
       character rendered: resolution is exact-id-first (spec §4.3), so a LIVE
       row minted with that exact id always wins over the history redirect,
       silently, with no tie and no warning. This route mints ids from
       user-supplied names, so a merge followed by an ordinary re-create (the
       issue's repro: merge "anton" into "антон", then create a new "Anton")
       would otherwise re-mint the retired id for a brand-new, unrelated
       character and hijack the original's recorded audio.
       Unlike the analyzer paths (`dropSupersededIdsReclaimedByLiveCast`),
       which don't control the mint — the LLM produces the id, and a fresh
       roster has legitimately reclaimed it — THIS route does control the
       mint, and already has a collision-suffix path (below) for live-id
       collisions. So the fix here is to never mint a history-protected id in
       the first place, rather than drop the history entry that is actively
       guarding real rendered segments to hand the id to an empty new
       character. Treat history keys as additional "taken" ids for exactly
       that reason.

       Review round 1 (Critical) — the check must be NORMALISED, not raw. A
       mint is always a `normaliseIdKey` fixed point (`safeId`'s output, and
       both its own and this route's collision suffixes are already in
       normal form), but a history key — or a pre-RC2 live id — is whatever
       string was on disk, e.g. an underscore slug (`the_torment`) or LLM
       free text. A raw-only check leaves the gap open in exactly the
       dangerous direction: cast.json has `the_torment`, frozen segments
       carry `the-torment` (tier-4 normalised match); merging `the_torment`
       into some other character records `{the_torment: <target>}`;
       re-creating "The Torment" mints `the-torment` (safeId's normal form),
       which isn't a raw match for `the_torment` in either `existingIds` or
       `historyKeys` — so the raw-only check would have let it through, tier
       1 would then beat the tier-4 history redirect, and every segment
       carrying the drifted spelling would hijack onto the new, empty
       character. This is the exact `Unknown_Male`-vs-normalised defect
       shape `repair-cast-id-drift.mjs`'s guard was already fixed for
       (#2040 Wave 3 review) — carried over here.

       This also closes a pre-existing SIBLING bug with no history involved
       at all: a live `the_torment` with nothing retired, re-created as "The
       Torment", used to mint `the-torment` — tier 1 then beats tier 4 for
       the drifted-spelling segments AND collapses `byNormId` for both
       spellings to `undefined` (two live rows sharing a normalised key),
       killing tier 3 resolution for both. The normalised taken-check below
       covers this case too, since it also normalises `existingIds`, not
       only `historyKeys`. */
    const history = await loadCastIdHistory(located.bookDir);
    const historyKeys = new Set(Object.keys(history.supersededBy));
    /* C1 (fix round, #2158) — `displaced` keys are just as taken as
       `supersededBy` keys. `dropSupersededTargetsNoLongerLive` deletes an
       entry from `supersededBy` and files it under `displaced` the moment
       its target stops being live — but a key that leaves `supersededBy`
       is a key this route would otherwise happily re-mint, and that key is
       exactly what every already-rendered segment covered by the pruned
       alias still carries on disk. Without this, the prune doesn't close
       the #2110 hazard, it just relocates it one write later: the id
       becomes free again, a same-name re-create mints it bare, and
       `buildCastResolver` resolves it via the `exact` tier — which
       `segments-io.ts` treats as "rendered bytes are fine, nothing to
       report" (#2107), so the hijack produces no orphan row, no chip, and
       no `repair-cast-id-drift.mjs` listing at all. Folding `displaced`
       into `takenIds` is a no-op for the sibling
       `dropSupersededIdsReclaimedByLiveCast`: that function only ever
       drops a key that was RECLAIMED as a live cast id, so it's already in
       `existingIds` by the time it could appear in `displaced` too. */
    const displacedKeys = new Set(Object.keys(history.displaced ?? {}));
    /* F1 (fix round 2, #2163) — a `rejectedPairs[].from` id needs the same
       reservation, for a THIRD path to the same #2110 end state that C1
       (`displacedKeys`, above) closed for the drop path: the banner's "Not
       the same character" button (`cast-reject-orphan.ts`'s POST) calls
       `forgetSupersededId`, which unconditionally deletes
       `supersededBy[from]` on every successful reject — so `from` leaves
       `historyKeys` too, the same way a drop leaves it. After that, the
       pair's `from` survives ONLY inside `rejectedPairs`, which this route
       never read. Reachable by UI clicks alone, no analysis run: reject an
       auto-reconciled orphan as "not the same", then create a new character
       whose name mints that same id bare — `resolve()` lands `exact`, and
       `segments-io.ts`'s `if (resolution?.via === 'exact') continue` makes
       the hijacked segments invisible on every surface (banner, chips,
       repair-pass listing).

       Only `from` needs reserving here, not `to` or `forgotSupersededTo` —
       the other two fields on a `RejectedPair` name where `from` resolves
       (or used to resolve) TO, not an id any rendered segment carries as
       ITS OWN character id. `to` is always a live character id at reject
       time (`cast-reject-orphan.ts` 404s otherwise) and so is already in
       `existingIds`; `forgotSupersededTo` was `supersededBy[from]`'s
       target, i.e. also a `to`-shaped value, not a second orphaned key.
       Reserving them too would protect ids nothing here needs protected. */
    const rejectedPairFromKeys = new Set((history.rejectedPairs ?? []).map((p) => p.from));
    const takenIds = new Set([
      ...existingIds,
      ...historyKeys,
      ...displacedKeys,
      ...rejectedPairFromKeys,
    ]);
    const takenNorm = new Set([...takenIds].map(normaliseIdKey));
    const isTaken = (id: string) => takenIds.has(id) || takenNorm.has(normaliseIdKey(id));

    // safeId's own collision suffix is a hash of the NAME, checked once — a
    // second character sharing a name gets a distinct id, but a third
    // collides with the second (same name -> same hash, and safeId never
    // re-checks its own output). Guarantee uniqueness here regardless of how
    // many characters share a name (or how many retired/live ids share a
    // normalised name).
    let newId = safeId(name, { taken: takenIds });
    if (isTaken(newId)) {
      let n = 2;
      while (isTaken(`${newId}-${n}`)) n += 1;
      newId = `${newId}-${n}`;
    }

    /* Report, not silent (issue acceptance) — mirrors the operator-visible
       log line Wave 2 added around `dropSupersededIdsReclaimedByLiveCast`,
       though nothing is dropped here: the history entry (if any) survives
       untouched and keeps protecting whatever it protects. Only the id this
       NEW character receives differs from what an unprotected mint would have
       picked. Computed against `existingIds` alone (not `takenIds`) so this
       reports exactly the delta the fix above introduces — matched by
       NORMALISED key (review round 1).

       Review round 2 (M4) — this used to fire only for a history match, so
       the sibling defect's avoidance (a live row that normalises the same,
       no history involved — test 5) minted a suffixed id with no stated
       reason, even though invariant 8 documents the report firing "when the
       avoidance fires" for both. Widened to name whichever of the two this
       route's `isTaken` check actually caught. Deliberately NOT widened to
       every `unprotectedId !== newId`: a live id colliding on a RAW (not
       merely normalised) match is the ordinary, pre-#2085 "second/third
       character shares a name" path — already silently handled before this
       fix existed, and not part of what it reports on. */
    const unprotectedId = safeId(name, { taken: existingIds });
    const unprotectedNorm = normaliseIdKey(unprotectedId);
    const collidingHistoryKey = [...historyKeys].find((k) => normaliseIdKey(k) === unprotectedNorm);
    const collidingLiveId = !existingIds.has(unprotectedId)
      ? [...existingIds].find((id) => normaliseIdKey(id) === unprotectedNorm)
      : undefined;

    if (unprotectedId !== newId && collidingHistoryKey) {
      /* Review round 2 (M3) — `history.supersededBy[collidingHistoryKey]` is
         only what was RECORDED, not a guarantee the target is still a live
         character (a chained or since-deleted target resolves nowhere per
         `cast-resolve.ts`'s own liveness check). Describe the recorded entry,
         not an active redirect, so this can't claim something untrue. */
      console.log(
        `[cast-create] ${bookId} avoided re-minting "${unprotectedId}" — collides with ` +
          `history-protected "${collidingHistoryKey}", recorded as retired in favour of ` +
          `"${history.supersededBy[collidingHistoryKey]}"; minted "${newId}" instead.`,
      );
    } else if (unprotectedId !== newId && collidingLiveId) {
      console.log(
        `[cast-create] ${bookId} avoided re-minting "${unprotectedId}" — normalises the same as ` +
          `live character id "${collidingLiveId}"; minted "${newId}" instead.`,
      );
    }

    const newCharacter: PersistedCharacter = {
      id: newId,
      name,
      role: typeof body.role === 'string' && body.role.trim() ? body.role.trim() : 'character',
      color: 'unset',
      gender:
        body.gender === 'male' || body.gender === 'female' || body.gender === 'neutral'
          ? body.gender
          : undefined,
      ageRange: ['child', 'teen', 'adult', 'elderly'].includes(body.ageRange as string)
        ? (body.ageRange as PersistedCharacter['ageRange'])
        : undefined,
      voiceState: 'generated',
    };

    await writeJsonAtomic(castJsonPath(located.bookDir), {
      ...cast,
      characters: [...cast.characters, newCharacter],
    });

    console.log(`[cast-create] ${bookId} + "${newId}"`);
    return res.json({ character: newCharacter });
  });
});
