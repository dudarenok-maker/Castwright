/* POST /api/books/:bookId/cast/:characterId/link-orphan-match  (#2238)

   The orphaned-character-fallback banner (src/views/cast.tsx) shows a
   needs-your-decision row for an id that never resolved onto any live cast
   member at all. Until now the row offered exactly one action — "Not the
   same character" (`cast-reject-orphan.ts`'s POST) — with no way to say the
   opposite: "yes, this orphaned id IS that character." This route is the
   positive mirror. `retireCharacterId` (`store/cast-id-history.ts`) already
   does exactly the right thing (records `orphanedId -> characterId` in
   cast-id-history.json's `supersededBy`, transitively, so
   `buildCastResolver` picks it up at render/QA/splice time) and was already
   well-tested via its two existing callers (`analysis.ts`, `cast-merge.ts`)
   — this route is simply the third caller, reached from the banner instead
   of from analysis.

   Mirrors `cast-reject-orphan.ts`'s POST handler closely: same param shape
   (`:characterId` path + `{ orphanedId }` body), same validation order, same
   "recompute and return the resolution after the write lands" response
   shape. Deliberately does NOT get a DELETE undo of its own — once a link
   lands, the row moves into the banner's auto-reconciled section, which
   already renders the existing "Not the same character" button (targeting
   `info.resolvedCharacterId`, i.e. exactly the character this route just
   linked). Clicking that calls `cast-reject-orphan.ts`'s POST, which (a)
   forgets the alias this route just wrote — `forgotSupersededTo` is
   computed against the CURRENT `supersededBy[orphanedId]`, which is now
   `characterId` — and (b) records a pair-scoped rejection so the same link
   isn't silently re-offered; both are undoable via that route's own DELETE
   and the "Not <Name> · Undo" chip. So the accept action already gets a
   full undo path for free, by mirroring rather than inventing a parallel
   "undo the link" mechanism.

   Design decisions this route intentionally does NOT solve, per the design
   thread's ruling (issue #2238):

   1. Accepting a pair this exact row previously rejected. `rejectedPairs`
      (cast-id-history.json) + the one-sided `notLinkedTo` edge it wrote
      onto `characterId` (cast.json) both survive a plain `retireCharacterId`
      call — `rejectedPairsGoverning`/`buildCastResolver` (cast-resolve.ts)
      would keep blocking `orphanedId -> characterId` even after this route
      writes the alias (D2 in cast-reject-orphan.ts's own doc comment: a
      rejected pair's tier candidate returns `undefined` outright, no
      fall-through). Clearing a rejection needs BOTH halves removed together
      (#2133's "created together, destroyed together" invariant) and this
      route has no cast.json access to do that safely itself. Rather than a
      SECOND removal implementation living here in parallel with
      `cast-reject-orphan.ts`'s DELETE, the frontend reuses that existing
      undo path directly (`handleUndoOrphanRejection` in `src/views/cast.tsx`)
      — when the candidate being linked is already in `rejectedAgainst`, the
      client calls the existing DELETE and awaits it BEFORE calling this
      POST, so by the time this route's write lands, nothing is left to
      block it. This route stays unconditional either way (mirrors D3 on the
      reject route): it always attempts the write, and always reports
      whatever `orphanedId` resolves to afterwards — if a rejection is
      somehow still in place (a direct API caller that skips the undo step),
      the alias write still lands (harmlessly, idempotently) but
      `resolution` in the response comes back blocked (`null`) until the
      rejection is actually cleared, exactly like calling this route twice
      never corrupts anything.
   2. Reserved ids — both directions, not symmetric (fix round, F1/F4).
      `unknown-male`/`unknown-female` (`fold-minor-cast.ts`'s
      `MALE_BUCKET_ID`/`FEMALE_BUCKET_ID`) are never auto-recorded book-wide
      by the repair script (plan 122, `fold-minor-cast.ts:349-354`) because
      the bucket stands in for MULTIPLE unrelated background characters
      sharing one voice slot:
        - As the alias TARGET (`characterId`): aliasing a real, addressable
          orphaned id permanently onto a shared bucket is not a
          reconciliation, it is a lossy merge the user almost certainly
          doesn't intend. Refused here (400) as defence in depth; the UI
          also disables the control with a visible reason so the refusal is
          never the user's first signal.
        - As the alias SOURCE (`orphanedId`) — the actually dangerous
          direction, and the one this route originally missed entirely
          (fix round, CRITICAL): linking a bucket id AS SOURCE writes
          `supersededBy['unknown-male'] = characterId` book-wide, routing
          EVERY speaker who ever fell back to that bucket onto one voice in
          a single click — #2040's original damage class. `narrator`/
          `char-narrator` (`NARRATOR_CHARACTER_IDS`) are refused here too:
          the banner's own advisory text (`src/views/cast.tsx`) says an
          unresolved id "rendered in the narrator's voice instead" — the
          narrator id is the SAME many-to-one catch-all hazard shape as the
          two fold buckets (potentially many different mis-attributed
          speakers land there), not one addressable person, and
          `scripts/repair-cast-id-drift.mjs`'s own `reservedIds` (built from
          `NARRATOR_CHARACTER_IDS` + the two bucket ids, its own guard 1)
          already treats it as reserved on exactly this axis — matching that
          script's policy here rather than inventing a narrower one.
          Deliberately NOT added to the TARGET set: aliasing a real orphaned
          id ONTO the live narrator character is a normal, addressable
          linking decision (narrator names one specific cast row, not a
          many-to-one slot), so only the SOURCE direction gets the wider
          set.
      Both directions are compared through `normaliseIdKey` (fix round, F4)
      rather than raw `Set.has()` — a case/separator-drifted spelling
      (`Unknown_Male`) must still be caught, exactly the drift class #2040
      itself exists to catch, and `repair-cast-id-drift.mjs` already fixed
      this identical bug twice on both the source and target sides (that
      script's own guard-1 doc comment, :844-852 and :975-980) via the same
      normalise-once-per-set pattern used here, not a second hand-rolled
      comparator.
   3. `withCastLock`. This route holds no lock of its OWN. It reads
      cast.json ONCE, purely to validate `characterId` names a live
      character (a 404 otherwise), and that decision is never paired with a
      write in the same request — CLAUDE.md's cast-lock rule ("lock the
      innermost read-through-write") governs a read that a write DEPENDS
      on, and there is no such read-through-write cycle at this route's own
      layer. `retireCharacterId` is one write this route performs, and it
      owns its own `cast-id-history:<bookDir>` lock (`withKeyLock`,
      `store/cast-id-history.ts`), entirely independent of cast.json's
      lock. The only cast.json write this route can trigger — the
      self-loop cleanup below, via `clearNotLinkedEdgesForDroppedRejections`
      — takes its OWN `withCastLock` (`analysis.ts`), and this route never
      holds that lock itself, so there is no nesting or lock-order
      inversion. (Fix round, F6: this decision used to be justified by a
      now-false claim that the route "never writes cast.json" — it does,
      via that helper, whenever a link retires an id that was the `from` of
      an earlier rejected pair. The no-lock CONCLUSION above was always
      correct; only the stated REASON was wrong.)

   `retireCharacterId`'s `droppedSelfLoopRejections` return is handled: when
   a self-loop rejection is dropped (repointing a `rejectedPairs` entry into
   a self-loop, then dropping it), the matching one-sided `notLinkedTo` edge
   on cast.json is cleared via `clearNotLinkedEdgesForDroppedRejections`,
   mirroring the cleanup in `analysis.ts` and `cast-merge.ts`. This prevents
   a stale edge from re-suppressing future §4.4 name-matches. */

import { Router } from 'express';
import type { Request, Response } from '../http.js';
import { findBookByBookId } from '../workspace/scan.js';
import { castJsonPath } from '../workspace/paths.js';
import { readJson } from '../workspace/state-io.js';
import { retireCharacterId, loadCastIdHistory } from '../store/cast-id-history.js';
import { buildCastResolver } from '../store/cast-resolve.js';
import { clearNotLinkedEdgesForDroppedRejections } from './analysis.js';
import { MALE_BUCKET_ID, FEMALE_BUCKET_ID } from '../analyzer/fold-minor-cast.js';
import { NARRATOR_CHARACTER_IDS } from '../analyzer/narrator-identity.js';
import { normaliseIdKey } from '../util/character-id.js';
import type { CharacterOutput } from '../handoff/schemas.js';

export const castLinkOrphanRouter = Router();

type PersistedCharacter = CharacterOutput & { voiceId?: string };
interface CastFile {
  characters: PersistedCharacter[];
}

interface LinkOrphanMatchBody {
  orphanedId?: unknown;
}

/** Decision 2 above — the reserved minor-cast fold buckets, refused as an
    alias TARGET (`characterId`). Mirrors `voice-override-linked.ts`'s own
    local `BUCKET_IDS` convention (a small, file-local `Set` rather than
    importing a shared one) except this file DOES import the two ids from
    their single source of truth (`fold-minor-cast.ts`) rather than
    re-typing the literals. `narrator` is deliberately NOT in this set — see
    `NORMALISED_RESERVED_SOURCE_IDS`'s doc comment below for why the two
    directions carry different reserved sets. */
const RESERVED_FOLD_BUCKET_IDS = new Set<string>([MALE_BUCKET_ID, FEMALE_BUCKET_ID]);

/** F4 — compared through `normaliseIdKey`, not raw `Set.has()`, so a
    case/separator-drifted spelling of a reserved TARGET id (`Unknown_Male`)
    is still caught. Built once at module load, mirroring
    `repair-cast-id-drift.mjs`'s own `normalisedReservedIds` (its guard 1 doc
    comment, :844-852). */
const NORMALISED_RESERVED_TARGET_IDS = new Set([...RESERVED_FOLD_BUCKET_IDS].map(normaliseIdKey));

/** F1 (fix round, CRITICAL) — the reserved-bucket refusal above only ever
    covered `characterId` (the alias TARGET). It never covered `orphanedId`
    (the alias SOURCE) — see this file's own header, decision 2, for the full
    hazard writeup: linking a bucket id AS SOURCE routes every speaker who
    ever fell back to that bucket onto one voice, book-wide, in one click.
    `narrator`/`char-narrator` (`NARRATOR_CHARACTER_IDS`) join the two fold
    buckets here, on the SOURCE side only — narrator is the same many-to-one
    catch-all hazard shape, and `repair-cast-id-drift.mjs`'s own `reservedIds`
    already treats it as reserved on this same axis. Also normalisation-safe
    (F4), same reasoning as the target set above. */
const NORMALISED_RESERVED_SOURCE_IDS = new Set(
  [...RESERVED_FOLD_BUCKET_IDS, ...NARRATOR_CHARACTER_IDS].map(normaliseIdKey),
);

/** Mirrors `cast-reject-orphan.ts`'s own local `ResolutionTier` — see that
    file's doc comment for the tier semantics. Duplicated rather than
    imported for the same reason the frontend duplicates it in `api.ts`: a
    small, stable literal union isn't worth a cross-module dependency. */
type ResolutionTier = 'exact' | 'history' | 'normalised-id' | 'normalised-history';

interface LinkOrphanMatchResponse {
  characterId: string;
  orphanedId: string;
  resolution: ResolutionTier | null;
  resolvedCharacterId?: string;
}

castLinkOrphanRouter.post(
  '/:bookId/cast/:characterId/link-orphan-match',
  async (req: Request, res: Response<LinkOrphanMatchResponse | { error: string }>) => {
    const { bookId, characterId } = req.params;
    const body = (req.body ?? {}) as LinkOrphanMatchBody;
    const orphanedId = typeof body.orphanedId === 'string' ? body.orphanedId.trim() : '';

    if (!bookId || !characterId || !orphanedId) {
      return res.status(400).json({
        error: 'bookId (path), characterId (path), and orphanedId are required.',
      });
    }
    /* Mirrors cast-reject-orphan.ts's self-pair 400 — a self-alias would
       resolve nowhere (retireCharacterId itself no-ops on from === to) and
       signals a client-side bug rather than a real reconciliation. */
    if (characterId === orphanedId) {
      return res.status(400).json({ error: 'characterId and orphanedId must differ (self-pair).' });
    }

    const located = await findBookByBookId(bookId);
    if (!located) return res.status(404).json({ error: `Book "${bookId}" not found.` });
    const { bookDir } = located;

    /* Decision 3 — plain, unlocked read: this route never writes cast.json,
       only validates that `characterId` is a live character (404
       otherwise). See this file's own header for why no withCastLock is
       owed here. */
    const cast = await readJson<CastFile>(castJsonPath(bookDir));
    if (!cast?.characters?.length) {
      return res.status(409).json({
        error: 'Book has no cast on disk yet. Run analysis before linking a match.',
      });
    }
    const character = cast.characters.find((c) => c.id === characterId);
    if (!character) {
      return res.status(404).json({ error: `Character "${characterId}" not found.` });
    }

    /* F11 — both reserved-id checks below moved to AFTER every 404 (unknown
       book, unknown character): a bucket-id request against a book/character
       that doesn't exist should 404 like every sibling check in this route,
       not 400 on the reserved-id rule first (which it did while this check
       ran ahead of `findBookByBookId`). */

    /* Decision 2 — refuse a reserved fold bucket as the alias TARGET outright
       rather than silently recording a lossy alias. */
    if (NORMALISED_RESERVED_TARGET_IDS.has(normaliseIdKey(characterId))) {
      return res.status(400).json({
        error:
          `"${characterId}" is a shared fallback voice for several minor characters, not one person — ` +
          'link the orphaned id to a specific cast member instead.',
      });
    }
    /* F1 (CRITICAL) — refuse a reserved id as the alias SOURCE. See
       NORMALISED_RESERVED_SOURCE_IDS's own doc comment above for why this is
       the actually-dangerous direction. */
    if (NORMALISED_RESERVED_SOURCE_IDS.has(normaliseIdKey(orphanedId))) {
      return res.status(400).json({
        error:
          `"${orphanedId}" is a shared fallback id — a minor-cast fold bucket, or the narrator's own ` +
          "catch-all — not one addressable character, so it can't be linked as the source of an alias.",
      });
    }

    try {
      const result = await retireCharacterId(bookDir, orphanedId, characterId);
      if (result.droppedSelfLoopRejections.length) {
        await clearNotLinkedEdgesForDroppedRejections(bookDir, bookId, result.droppedSelfLoopRejections);
      }
    } catch (retireErr) {
      console.error(
        '[cast-link-orphan] failed to record the alias in cast-id-history.json — surfacing as a failure',
        retireErr,
      );
      return res.status(500).json({
        error: 'Failed to durably record the link. Retry — the write is idempotent.',
      });
    }

    const resolution = await resolveOrphanedId(bookDir, cast.characters, orphanedId);

    /* F3 — `resolution: null` means the alias write landed but is still
       blocked by a live rejection (decision 1 above) — a genuinely different
       outcome from a clean link, not a cosmetic one. The log line used to say
       "linked" unconditionally either way; branch on it like the response
       body already does. */
    console.log(
      `[cast-link-orphan] book=${bookId} linked "${orphanedId}" -> ${characterId}` +
        (resolution
          ? ''
          : ' (write landed, but still blocked by an active rejection — resolution: null)'),
    );

    return res.json({
      characterId,
      orphanedId,
      resolution: resolution?.via ?? null,
      resolvedCharacterId: resolution?.character.id,
    });
  },
);

/** Shared shape with cast-reject-orphan.ts's own helper of the same name —
    resolve `orphanedId` against the live cast + the CURRENT (post-write)
    cast-id-history.json, a fresh load rather than anything read earlier in
    the handler. Kept as its own small copy (rather than exported/imported
    from the sibling route module) for the same reason that module keeps its
    own local `appendNotLinked`/`removeNotLinked`: a one-line helper used by
    exactly one file's handler(s) isn't worth a cross-route dependency. */
async function resolveOrphanedId(
  bookDir: string,
  characters: ReadonlyArray<{ id: string }>,
  orphanedId: string,
) {
  const history = await loadCastIdHistory(bookDir);
  return buildCastResolver(characters, history).resolve(orphanedId);
}
