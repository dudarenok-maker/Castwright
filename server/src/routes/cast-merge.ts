/* POST /api/books/:bookId/cast/merge

   Resolves an analyzer-duplicate cast entry by folding `sourceId` into
   `targetId`. The duplicate ("Wren") disappears and its name is added
   to the survivor's ("Wren Sparrow") `aliases` list so the matcher can
   recognise the same person when later books in the series detect the
   character under either form.

   Touches three persisted files (atomic-rename each):
     1. cast.json                 — drop source, merge fields onto target
     2. manuscript-edits.json     — sentences[characterId=sourceId] → targetId
     3. .audiobook/analysis-cache — per-chapter sentences, the cached match
                                    plan and the rule-11 ledger (ONE
                                    `mutateAnalysisCache` op, #4031)

   We deliberately do NOT touch `chapterCast` (the raw per-chapter LLM
   outputs) or the raw `stage1.characters` roster. Those are historical record
   of what the analyzer saw; a resume applies the cached plan on top of them,
   and the plan is what this merge re-targets (`retargetPlanForMerge`). */

import { Router } from 'express';
import type { Request, Response } from '../http.js';
import { bookStateLanguage } from '../workspace/scan.js';
import { BOOK_GONE, withBookOp } from '../workspace/book-op-lock.js';
import type { BookStateJson } from '../workspace/scan.js';
import { castJsonPath, manuscriptEditsJsonPath } from '../workspace/paths.js';
import { readJson, writeJsonAtomic } from '../workspace/state-io.js';
import { withCastLock } from '../workspace/cast-lock.js';
import { withBookLock } from '../workspace/book-lock.js';
import { requestFailureMessageFs } from '../workspace/file-lock.js';
import { mutateAnalysisCache } from '../store/analysis-cache.js';
import { loadCastMerges, saveCastMerges, appendManualEntry } from '../store/cast-merges.js';
import { retireCharacterId, CastIdHistoryUnreadableError } from '../store/cast-id-history.js';
import { removeSuggestionPairsLocked } from '../store/cast-merge-suggestions.js';
import { clearNotLinkedEdgesForDroppedRejectionsLocked } from '../store/not-linked-edges.js';
import { retargetPlanForMerge } from '../store/plan-overlay.js';
import { unionNotLinkedTo } from '../store/cast-name-match.js';
import type { NotSamePersonRecord } from '../store/reanalysis-types.js';
import { normaliseForMatch } from './analysis.js';
import { castIdentityBusyRefusal } from './book-state.js';
import { makeBucket, MALE_BUCKET_ID, FEMALE_BUCKET_ID } from '../analyzer/fold-minor-cast.js';
import type { CharacterOutput, SentenceOutput } from '../handoff/schemas.js';

export const castMergeRouter = Router();

/* Same shape as cast.json on disk — Character[] with the same fields the
   frontend's Character type uses. We don't validate via Zod here because
   the file has already been through the analyzer-side validator and the
   merge is field-level only. */
interface CastFile {
  characters: CharacterOutput[];
}

interface EditsFile {
  sentences?: SentenceOutput[];
}

interface MergeBody {
  sourceId?: unknown;
  targetId?: unknown;
}

/** Result returned by `performCastMerge`. */
export interface CastMergeResult {
  characters: CharacterOutput[];
  /** The id folded away — §4.4 call site 5: a merge retires an id, so it
      must record one (this is what `retireCharacterId` is called with,
      alongside `targetId`). */
  sourceId: string;
}

/* #2260 FINAL ROUND (B1) — the marker that tells the two origins of a
   `LockAcquisitionTimeoutError` out of `performCastMerge` apart.

   `performCastMerge`'s whole body is `withCastLock(bookDir, …)`, so this class
   escapes it from TWO places, and the disk state at each is the exact opposite
   of the other:

     - the OUTER acquisition (`withCastLock` itself, before the `readJson` on
       the first line of the callback) — the callback never ran, NOTHING was
       written; and
     - the DEFERRED rethrow at the very end — the merge is fully applied.

   Round 4's accept route discriminated on the error CLASS alone and dismissed
   the suggestion on both, which destroys the suggestion for a merge that never
   happened (`removeSuggestionPairsLocked` is a load-filter-write; only a later analysis
   run can put it back). Contention on `cast:<bookDir>` — the very condition #2260
   exists to surface — was enough to reach it.

   Stamped as an own property on the parked error rather than returned in the
   result: `performCastMerge` must keep THROWING (round 4's own decision — a
   returned timeout makes the loud path opt-in, so a future caller that forgets
   to check it silently converts a timeout back into a 200), and the caller
   needs one more bit than the class carries. Non-enumerable so it never shows
   up in a `JSON.stringify` of the error in a log line.

   `didCastMergeApply` FAILS CLOSED, and that direction is deliberate: an
   unmarked escape means "no follow-up write", so a future rethrow added
   somewhere in the middle of this function (or a marker that fails to survive
   some wrapper) leaves the suggestion in place — recoverable by pressing Accept
   again — rather than deleting it. */
const CAST_MERGE_APPLIED = 'castMergeApplied';

/** True only for the DEFERRED rethrow out of `performCastMerge` (a parked
 *  history-write failure: a lock timeout, or since #4031 C3 any other error),
 *  i.e. the case where the merge IS fully applied on disk. False for an outer
 *  `withCastLock` acquisition expiry, where nothing was written. See the
 *  comment above for why this is an own property and why it fails closed. */
export function didCastMergeApply(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    (err as Record<string, unknown>)[CAST_MERGE_APPLIED] === true
  );
}

/** Shared merge parameters — passed by both the manual-merge route and the
    accept-suggestion route so the logic lives in exactly one place. */
export interface CastMergeArgs {
  bookId: string;
  bookDir: string;
  /** The book's state object (needed for language-aware bucket names). */
  state: BookStateJson;
  /** The id of the character to fold away (the "source" / duplicate). */
  sourceId: string;
  /** The id of the surviving character (the "target" / canonical). */
  targetId: string;
}

/** Perform the cast merge: fold `sourceId` into `targetId`, rewriting
    cast.json, manuscript-edits.json, the analysis cache, and the
    cast-merges journal. Returns the updated character list.

    Throws with a shape `{ status: number; error: string }` on semantic
    errors (404 / 409) so the caller can propagate the right HTTP status. */
export async function performCastMerge(args: CastMergeArgs): Promise<CastMergeResult> {
  const { bookId, bookDir, state, sourceId, targetId } = args;

  /* #1981 — the read is inside the lock; every decision below (404s, the
     downgrade-bucket synthesis, the merged fields, the remapped sentences)
     is derived from it. The inner `writeJsonAtomic(manuscriptEditsJsonPath(...))`
     is a DIFFERENT file — the cast lock doesn't cover it; its read -> write
     takes the per-book lock beneath this one (cast -> book, #3400). */
  return withCastLock(bookDir, async () => {
    const cast = await readJson<CastFile>(castJsonPath(bookDir));
    if (!cast?.characters?.length) {
      throw { status: 409, error: 'Book has no cast on disk yet. Run analysis before merging characters.' };
    }

    const source = cast.characters.find((c) => c.id === sourceId);
    let target = cast.characters.find((c) => c.id === targetId);
    if (!source) throw { status: 404, error: `Character "${sourceId}" not found.` };
    /* Downgrade-to-bucket path: when the caller targets one of the standing
       `unknown-male` / `unknown-female` buckets and that bucket doesn't yet
       exist in cast.json (the book had no auto-folded background speakers),
       synthesise it on the fly using the same factory the analyser's
       post-stage-2 fold uses. Keeps the manual downgrade UI from having to
       special-case "book has never had a background voice before". */
    let createdBucket: CharacterOutput | null = null;
    if (!target && (targetId === MALE_BUCKET_ID || targetId === FEMALE_BUCKET_ID)) {
      /* Localize the minted bucket's display name to the book's language so a
         manual downgrade on a non-English book produces the SAME name the
         analyser's fold would (e.g. Russian "Незнакомый Парень"). Resolved via
         the canonical seam; defaults to English when state has no language. */
      const language = bookStateLanguage(state);
      createdBucket = makeBucket(targetId, targetId === MALE_BUCKET_ID ? 'male' : 'female', language);
      cast.characters.push(createdBucket);
      target = createdBucket;
    }
    if (!target) throw { status: 404, error: `Character "${targetId}" not found.` };

    /* Build the merged target. Field rules mirror mergeRosterChapter, with
       two twists for the manual-merge case:
         - aliases: target's existing + source's name + source's existing,
           deduped on lower-case. Captures the human's intent ("these are the
           same person") so the matcher can use it later.
         - lines/scenes: recomputed below once we know the remapped sentence
           set. Stored on the merged Character at the end. */
    const merged: CharacterOutput = { ...target };

    /* Aliases — keep target's, then source.name (the new alias), then
       anything source had already learned. Drop target.name itself (no point
       listing a name as its own alias) and dedup case-insensitively. */
    merged.aliases = mergeAliases(target, source);

    /* Declines: the source's `notLinkedTo` is unioned into the target's, so a
       person the source was declined against stays declined once it is the
       survivor. A SAME-BOOK entry naming either of the two merging rows is
       dropped (it would become a self-edge, or a dangling one for the id that
       is about to retire); a same-book entry naming a THIRD row, and every
       cross-book entry — including one whose characterId happens to equal
       `targetId` — survives. */
    const declines = unionNotLinkedTo(target.notLinkedTo, source.notLinkedTo ?? []).filter(
      (e) => !namesSameBookRow(e, bookId, [sourceId, targetId]),
    );
    if (declines.length) merged.notLinkedTo = declines as CharacterOutput['notLinkedTo'];
    else if (target.notLinkedTo) merged.notLinkedTo = [];

    /* Description: longer wins. The longer one usually carries more context. */
    if (
      source.description &&
      (!target.description || source.description.length > target.description.length)
    ) {
      merged.description = source.description;
    }

    /* Attributes: union, case-insensitive dedup. Target order first. */
    merged.attributes = unionStrings(target.attributes, source.attributes);

    /* Evidence: union, dedup on normalised quote text. */
    merged.evidence = mergeEvidence(target.evidence, source.evidence);

    /* Tone: target wins per field; missing fields filled from source. */
    if (source.tone || target.tone) {
      merged.tone = { ...source.tone, ...target.tone };
    }

    /* Identity fields: only adopt source's value when target lacks one. */
    if (!merged.gender && source.gender) merged.gender = source.gender;
    if (!merged.ageRange && source.ageRange) merged.ageRange = source.ageRange;

    /* Filter source out of the cast (in-place build for stable order). */
    const nextCharacters: CharacterOutput[] = [];
    for (const c of cast.characters) {
      if (c.id === sourceId) continue;
      nextCharacters.push(c.id === targetId ? merged : c);
    }

    /* Remap sentence attributions in manuscript-edits.json. The edits file
       is the authoritative per-sentence record once stage 2 has completed —
       we rewrite it first so the lines/scenes recompute below sees the new
       state. */
    /* #3400 — manuscript-edits.json is also rewritten, whole, by a chapter
       restructure under the per-book lock. The read, the remap and the write
       are one locked span (innermost read-through-write; nothing else is taken
       inside it). Lock order: cast (held here) -> book; no book-lock holder
       ever takes the cast lock, so this cannot deadlock. */
    const remapped = await withBookLock(bookId, async () => {
      let touched = false;
      let after: SentenceOutput[] | null = null;
      /* srv-1 — chapter-qualified ids of the sentences this merge rewrites
         source → target. Sentence ids are unique only within a chapter, so we
         keep the chapterId alongside each id. */
      const rewritten: Array<{ chapterId: number; sentenceId: number }> = [];
      const edits = await readJson<EditsFile>(manuscriptEditsJsonPath(bookDir));
      if (edits?.sentences?.length) {
        let changed = 0;
        after = edits.sentences.map((s) => {
          if (s.characterId === sourceId) {
            changed += 1;
            rewritten.push({ chapterId: s.chapterId, sentenceId: s.id });
            return { ...s, characterId: targetId };
          }
          return s;
        });
        if (changed > 0) {
          touched = true;
          await writeJsonAtomic(manuscriptEditsJsonPath(bookDir), { sentences: after });
        }
      }
      return { touched, after, rewritten };
    });
    const editsTouched = remapped.touched;
    const editsAfter = remapped.after;
    const affected = remapped.rewritten;

    /* Recompute lines / scenes on the merged character from the up-to-date
       sentence list. Avoids the over-count that a naive sum produces when
       the same chapter contained both ids. */
    if (editsAfter?.length) {
      let lines = 0;
      const scenes = new Set<number>();
      for (const s of editsAfter) {
        if (s.characterId === targetId) {
          lines += 1;
          scenes.add(s.chapterId);
        }
      }
      merged.lines = lines;
      merged.scenes = scenes.size;
    } else {
      /* No edits on disk — best effort: sum lines, sum scenes (will
         over-count if they overlapped, but that recomputes the moment
         stage 2 lands). */
      merged.lines = (target.lines ?? 0) + (source.lines ?? 0);
      merged.scenes = (target.scenes ?? 0) + (source.scenes ?? 0);
    }

    await writeJsonAtomic(castJsonPath(bookDir), { ...cast, characters: nextCharacters });

    /* §4.4 call site 5 — a merge drops sourceId outright; every segment that
       row already rendered would otherwise orphan the instant this lands.
       Record the retirement through the same choke point every other
       id-losing path uses, so the resolver (§4.3) picks it up at render time.
       Kind `'user'` (a deliberate merge), so a later run's matcher joins the
       source's id onto the survivor. A fold bucket source is retired too, but
       its entry is render-only: see R56 below.

       Lock order: this runs INSIDE the cast lock, and `retireCharacterId`
       takes `cast-id-history` beneath it — `cast` -> `cast-id-history`, the
       documented direction. Kept HERE rather than after the lock is released:
       the position is correct (record after the authoritative cast.json
       write, #2040 Task 8 fix round 1 item 1) and the dropped-record edge
       cleanup below needs the roster this function already holds.

       #4031 C3 — ANY failure here is PARKED, not swallowed. This used to
       `console.warn` a non-timeout error and carry on, which reported a 200
       for a merge whose retirement was never recorded (the id-of-record
       divergence #2040 exists to prevent). Now the cache reconciliation and
       the journal below still run, so disk is whole, and then the error is
       rethrown — the request fails, the client reloads, and the half that
       could not be written is visible rather than silent. */
    /* The FIRST error parked wins (the history write is the one a user can act
       on); every later step still runs. */
    let parkedError: unknown;
    let hasParkedError = false;
    const park = (err: unknown): void => {
      if (hasParkedError) return;
      parkedError = err;
      hasParkedError = true;
    };
    /* R53 (PR #4103 pass 4) and R56 (pass 5, owner rulings 2026-11-12) — a merge of a
       fold bucket (`unknown-male` / `unknown-female`) is ONE-SHOT for later runs: the
       bucket's lines move to the target above, and no matching, planning or retirement
       path follows the merge afterwards. It IS retired (R56, reversing R53's "no
       record" half), as on `main`: the chapters already rendered with the bucket's lines,
       and with any character downgraded into it before (whose entry the retirement
       repoints), persist the bucket id, and the history entry is what resolves them to
       the target. The entry is render-only: `followableHistory()` keeps it out of every
       matching, planning and retirement read, so a later run's background lines land on
       a fresh bucket and a downgrade into the bucket lands on the bucket; the persist's
       reclaim moves it to `displaced` once the bucket is live again, and a user delete of
       a re-added bucket sticks (R4). Its cached plan decisions and its ledger entry go
       with it in the cache op below. */
    const sourceIsBucket = sourceId === MALE_BUCKET_ID || sourceId === FEMALE_BUCKET_ID;
    try {
      const historyResult = await retireCharacterId(bookDir, sourceId, targetId, 'user');
      /* #2133/#2239 — a reject's two writes (the `rejectedPairs` entry on
         cast-id-history.json and the one-sided `notLinkedTo` edge on
         cast.json) are created together and must be destroyed together (see
         `docs/features/278-cast-character-identity.md`'s invariant of the
         same name). `retireCharacterId` reports a dropped self-loop pair but
         never touches cast.json itself — this merge already holds the cast
         lock and has `nextCharacters` in hand, so the cleanup uses the
         LOCK-FREE `clearNotLinkedEdgesForDroppedRejectionsLocked` plus a
         second write in the SAME lock span, not a new `withCastLock` call
         (rule 1: a locked function must not call another locked function on
         the same book).

         #4031 — the same reasoning for a dropped `notSamePerson` record (a
         dismissed pair this merge collapses): its two `notLinkedTo` edges are
         removed together with it. BOTH clears always run (no `||`
         short-circuit): each owns a different set of edges. */
      const clearedRejections =
        historyResult.droppedSelfLoopRejections.length > 0 &&
        clearNotLinkedEdgesForDroppedRejectionsLocked(
          nextCharacters,
          bookId,
          historyResult.droppedSelfLoopRejections,
        );
      const clearedDismissals = clearNotSamePersonEdgesLocked(
        nextCharacters,
        bookId,
        historyResult.droppedNotSamePerson,
      );
      if (clearedRejections || clearedDismissals) {
        await writeJsonAtomic(castJsonPath(bookDir), { ...cast, characters: nextCharacters });
      }
    } catch (historyErr) {
      if (historyErr instanceof CastIdHistoryUnreadableError) {
        /* A degraded / unreadable history is not a merge failure: the
           retirement is skipped and logged server-side (spec "Retirements are
           skipped and logged"; the dismiss route does the same) and the merge
           answers success. Only a real write error is parked. */
        console.warn('[cast-merge] cast-id-history is unreadable; retirement skipped', historyErr);
      } else {
        park(historyErr);
      }
    }

    /* R32 — a manual merge removes ITS OWN pair's suggestion (the accept route
       already did; the manual route left it dangling). Under the cast lock we
       already hold; a failure is parked like every other step here. */
    try {
      await removeSuggestionPairsLocked(bookDir, [[sourceId, targetId]]);
    } catch (suggestionErr) {
      park(suggestionErr);
    }

    /* Analysis cache — ONE `mutateAnalysisCache` op (R7): the source's cached
       takes are re-attributed to the target, the cached match plan is
       re-targeted by `retargetPlanForMerge` (so a resume maps the source's raw
       rows onto the survivor), and the source's rule-11 ledger entry is
       dropped. Plan and takes must move together, so the plan is re-targeted
       in `transform` INSIDE the op — never read-then-patched as two steps. The
       target's own ledger entry is left alone: its fingerprint is of the job's
       last write, so the fields this merge just changed make it read as a user
       edit at the next persist (sticky `added-once`), which is correct.
       `chapterCast` and the raw `stage1` roster are not touched (header). A
       cache that does not exist is left absent (the op returns null).
       A fold bucket source is the exception (R49, PR #4103 pass 2 P2-1): it
       settles by its own id only, so its decisions are deleted, never
       re-targeted, and the next persist re-plans it as its own row. A
       re-targeted `join` would leave the bucket's raw key decided for another
       id and the persist with an undecided roster row. */
    let cacheTouched = false;
    try {
      const cacheResult = await mutateAnalysisCache(state.manuscriptId, {
        remapCharacterIds: { [sourceId]: targetId },
        ledger: { [sourceId]: null },
        transform: (c) => {
          if (!c.matchPlan) return c;
          if (!sourceIsBucket) return { ...c, matchPlan: retargetPlanForMerge(c.matchPlan, sourceId, targetId) };
          const decisions = Object.fromEntries(
            Object.entries(c.matchPlan.decisions).filter(([, d]) => (d.kind === 'join' ? d.priorId : d.id) !== sourceId),
          );
          return { ...c, matchPlan: { ...c.matchPlan, decisions } };
        },
      });
      cacheTouched = cacheResult !== null;
    } catch (cacheErr) {
      /* Parked, not thrown: cast.json and manuscript-edits.json are already
         written, so aborting here would skip the journal below and leave a
         merge that can never be unlinked (and, via the accept route, a
         suggestion that 404s on every retry). */
      park(cacheErr);
    }

    /* srv-1 — append this merge to the deterministic lineage journal so the
       unlink-alias route can later surface exactly these sentences. Non-fatal:
       cast.json / edits / cache already persisted above, so a journal failure
       must never fail the merge (mirrors the reuse-link precedent). */
    try {
      const journal = await loadCastMerges(bookDir);
      await saveCastMerges(
        bookDir,
        appendManualEntry(journal, {
          ts: new Date().toISOString(),
          kind: 'manual',
          sourceId,
          sourceName: source.name,
          targetId,
          affected,
        }),
      );
    } catch (journalErr) {
      console.warn('[cast-merge] failed to write cast-merges journal', journalErr);
    }

    console.log(
      `[cast-merge] book=${bookId} merged ${sourceId} → ${targetId}` +
        (editsTouched ? ' (remapped sentences)' : '') +
        (cacheTouched ? ' (rewrote cache)' : ''),
    );

    /* #2260 round 3 (C2) — the deferred rethrow. AFTER the journal, not after
       the cache: both are part of "the merge is fully applied". Rethrowing
       between them would leave a merge that resumes correctly but can never
       be unlinked, which is still half-applied — the thing the wrap exists to
       avoid. Placed after the log line too, so the operator breadcrumb still
       records what actually reached disk before the request fails.

       Round 4 (C1) — nothing below this point writes anything IN THIS
       FUNCTION, and an earlier version of this comment stopped there and
       reasoned only about `POST /cast/merge`, whose route body is a bare
       `return res.json(result)`. That is not the whole caller set. THE
       CONTRACT THIS THROW IMPOSES ON CALLERS: by the time it fires the merge
       is fully applied on disk, so a caller with follow-up writes of its own
       must perform them BEFORE letting it escape — otherwise the deferred
       rethrow just moves the skipped-write bug up one frame, which is exactly
       what it happened to do at the second caller,
       `cast-merge-suggestions.ts`'s accept route (its `removeSuggestionPairsLocked`
       never ran, so the merged-away character kept a live suggestion that
       404'd on every subsequent Accept). Both callers turn this into a 500
       with a curated body (`requestFailureMessageFs`: round 5 — NOT the
       error's own message, which names the lock key or the file and hence the
       absolute workspace path); see that route's own handler for the accept
       flow's extra step.

       FINAL ROUND (B1) — the contract above is only safe for a caller that can
       tell this rethrow apart from an OUTER `withCastLock` expiry, which
       escapes the same function with the same class and NOTHING written. Stamp
       it, so "the merge is fully applied" is a fact the caller can test rather
       than an assumption it has to make. See `CAST_MERGE_APPLIED` above. */
    if (hasParkedError) {
      /* #4031 C3 — the parked error is no longer only a lock timeout: any
         failure of the history write, the pair removal or the cache write
         lands here. A thrown non-object (never
         produced by node or this repo) is wrapped so the marker below has
         something to sit on. */
      const parked =
        typeof parkedError === 'object' && parkedError !== null
          ? parkedError
          : new Error(String(parkedError));
      try {
        Object.defineProperty(parked, CAST_MERGE_APPLIED, {
          value: true,
          enumerable: false,
          configurable: true,
          writable: true,
        });
      } catch {
        /* Defensive — a non-extensible/frozen error here would throw a
           TypeError that REPLACES the parked error, losing the deferred
           rethrow's whole contract: the route would answer the generic body
           and skip the dismiss for a merge that DID land. Unreachable today
           (these errors are freshly constructed, never frozen); swallowing
           keeps the original throw below intact either way. */
      }
      throw parked;
    }

    return { characters: nextCharacters, sourceId };
  });
}

castMergeRouter.post('/:bookId/cast/merge', async (req: Request, res: Response) => {
  const { bookId } = req.params;
  const body = (req.body ?? {}) as MergeBody;
  const sourceId = typeof body.sourceId === 'string' ? body.sourceId.trim() : '';
  const targetId = typeof body.targetId === 'string' ? body.targetId.trim() : '';

  if (!sourceId || !targetId) {
    return res.status(400).json({ error: 'sourceId and targetId are required.' });
  }
  if (sourceId === targetId) {
    return res.status(400).json({ error: 'sourceId and targetId must differ.' });
  }

  try {
    /* #3711 — book-op outermost (inside the try so its own acquisition timeout
       takes the curated-failure seam below, like every other lock timeout). */
    const result = await withBookOp(bookId, async ({ bookDir, state }) => {
      /* R55 — refused while an analysis runs, checked inside this book-op span. */
      const busy = castIdentityBusyRefusal(bookId);
      if (busy) return busy;
      return performCastMerge({ bookId, bookDir, state, sourceId, targetId });
    });
    if (result === BOOK_GONE) return res.status(404).json({ error: 'Book not found.' });
    if ('code' in result) return res.status(409).json(result);
    return res.json(result);
  } catch (err) {
    const e = err as { status?: number; error?: string };
    if (e.status && e.error) {
      return res.status(e.status).json({ error: e.error });
    }
    /* #2292 (owner decision), CORRECTED in review round 5 — the rationale
       recorded here through round 4 was false, and the code it justified was a
       leak. Both are retracted.

       THE FALSE CLAIM: "this used to `throw err`; anything without
       `{status, error}` then reached Express 5's DEFAULT handler, which answers
       `500 text/html`, so the user got a blank failure." That never happened in
       production. `app.ts:350` registers `errorHandler` (`error-handler.ts`)
       last, and it ends `res.status(500).json({ error: 'Internal server
       error.' })` — so a bare `throw err` out of this route has ALWAYS come
       back as JSON, just wordless. The `text/html` was an artefact of this
       route's own fixtures, which mount a bare `express()` + router with no
       `errorHandler`; no server test mounted the assembled app, so the
       mutation proofs measured the harness. `cast-merge.lock-timeout.test.ts`
       now mounts the real `app.ts` for exactly that reason.

       WHAT THE CHANGE ACTUALLY DOES, therefore, is choose the WORDS — and
       round 4 chose `err.message`, which is the leak: a
       `LockAcquisitionTimeoutError` message embeds the lock key, i.e. the
       absolute path of the user's workspace, and #2260 made this class
       reachable by ORDINARY CONTENTION over a LAN the app serves by design.
       Any other unstructured throw (an `EACCES`, an `ENOSPC` naming a temp
       path) round-tripped verbatim too.

       So: the one class a user can act on gets a curated body; everything else
       gets the same generic body `errorHandler` would have produced. Returned
       explicitly rather than rethrown so this route's contract does not depend
       on app-level middleware wiring — which is precisely what went unchecked
       here. The full error, key and all, still goes to the server log. */
    console.error('[cast-merge] merge failed', err);
    /* #4031 C3 — `requestFailureMessageFs` curates the lock-timeout class AND a
       node fs error (a parked history write, EPERM/ENOSPC, whose own message
       embeds the absolute path); anything else keeps the generic body. */
    return res.status(500).json({ error: requestFailureMessageFs(err, 'Internal server error.') });
  }
});

/* True when `entry` is a same-book decline naming one of `ids`. A bare string
   (a series link id) and an entry for another book are never same-book. */
function namesSameBookRow(entry: unknown, bookId: string, ids: readonly string[]): boolean {
  if (!entry || typeof entry !== 'object') return false;
  const e = entry as { bookId?: unknown; characterId?: unknown };
  return e.bookId === bookId && typeof e.characterId === 'string' && ids.includes(e.characterId);
}

/* Remove the `notLinkedTo` edges a dropped `notSamePerson` record backed: on
   each of its two rows (when still on the roster), the same-book entries
   naming either side. In place, no fs; true when anything changed. */
function clearNotSamePersonEdgesLocked(
  characters: CharacterOutput[],
  bookId: string,
  dropped: ReadonlyArray<NotSamePersonRecord>,
): boolean {
  let changed = false;
  for (const record of dropped) {
    const pair = [record.a, record.b];
    for (const c of characters) {
      if (!pair.includes(c.id) || !c.notLinkedTo?.length) continue;
      const kept = c.notLinkedTo.filter((e) => !namesSameBookRow(e, bookId, pair));
      if (kept.length !== c.notLinkedTo.length) {
        c.notLinkedTo = kept;
        changed = true;
      }
    }
  }
  return changed;
}

/* Build the merged aliases list. Lower-case dedup, target first, then the
   source's name, then any aliases the source had already accumulated. The
   target's own name is filtered out so a self-alias never appears. */
function mergeAliases(target: CharacterOutput, source: CharacterOutput): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const push = (name: string) => {
    const trimmed = name.trim();
    if (!trimmed) return;
    if (trimmed.toLowerCase() === target.name.trim().toLowerCase()) return;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push(trimmed);
  };
  for (const a of target.aliases ?? []) push(a);
  push(source.name);
  for (const a of source.aliases ?? []) push(a);
  return out;
}

/* Union two evidence lists, dedup on normalised quote so smart/straight
   quote variants don't double up. Mirrors mergeRosterChapter's behaviour. */
function mergeEvidence(
  a: CharacterOutput['evidence'] | undefined,
  b: CharacterOutput['evidence'] | undefined,
): CharacterOutput['evidence'] {
  if (!a?.length && !b?.length) return undefined;
  const seen = new Set<string>();
  const out: NonNullable<CharacterOutput['evidence']> = [];
  for (const e of [...(a ?? []), ...(b ?? [])]) {
    const norm = normaliseForMatch(e.quote);
    if (!norm || seen.has(norm)) continue;
    seen.add(norm);
    out.push({ ...e });
  }
  return out.length ? out : undefined;
}

/* Union two string lists, lower-case dedup, preserving first-seen order
   and casing. */
function unionStrings(a: string[] | undefined, b: string[] | undefined): string[] | undefined {
  if (!a?.length && !b?.length) return undefined;
  const seen = new Set<string>();
  const out: string[] = [];
  for (const s of [...(a ?? []), ...(b ?? [])]) {
    const key = s.trim().toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(s);
  }
  return out.length ? out : undefined;
}
