/* POST /api/books/:bookId/chapters/{merge,split,reorder}

   Applies a structural restructure operation to the persistent book layout:
   1. Pure transform via workspace/restructure.ts (state.json shape +
      ChapterHint[] + sentences + audio op plan + sentence remap).
   2. Atomically write manuscript-hints.json (the restructured chapter bodies,
      #3703; first, so its failure changes nothing), state.json (rotating
      backup) and manuscript-edits.json.
   3. Replace the in-memory ManuscriptRecord (putManuscript) so subsequent
      analysis / generation calls see the new structure.
   4. Apply the audio op plan via rewriteChapterSlugs (delete content-
      changed chapter audio; rename renumbered-only chapter audio +
      rewrite the embedded chapterId/chapterTitle in segments.json).
   5. Rebuild the analysis cache from the freshly-written manuscript-edits
      .json so its outer chapter-id keying tracks the new structure.
      Plan 70c — earlier behaviour wiped the cache outright, which broke
      post-restructure generation (generation reads the cache, not
      manuscript-edits.json, and halted on the empty file).

   The book's `book-op` lock (#3711) serialises concurrent restructure calls
   so the persistence writes can't interleave, and holds a folder rename
   off until the whole restructure has landed. Without the lock,
   two parallel reorders could each pick up the same `state.chapters`
   snapshot, both successfully write, and the second clobber the first
   silently.

   The route is synchronous — Phase 1 re-analysis is NOT triggered.
   See `docs/features/archive/51-restructure-chapters.md` for the full design. */

import { Router } from 'express';
import type { Request, Response } from '../http.js';
import {
  applyMerge,
  HintsOutOfSyncError,
  parseTitlesPairWithState,
  applySplit,
  applyReorder,
  applyExclude,
  backfillTitleSynthesized,
  GENERIC_TITLE_RE,
  applyRefreshTitles,
  applyRename,
  touchedChapterIds,
  pendingMovesAfterRestructure,
  staleTakeClearSlugs,
  carryMergedAwayKeys,
  type MergeOp,
  type SplitOp,
  type ReorderOp,
  type ExcludeOp,
  type RenameOp,
  type RestructureResult,
  type RestructureSentence,
} from '../workspace/restructure.js';
import type { BookStateJson } from '../workspace/scan.js';
import {
  BOOK_GONE,
  peekBook,
  readBookStateOrThrow,
  withBookOp,
  bookJobKinds,
  type BookHandle,
} from '../workspace/book-op-lock.js';
import { busySentence } from './book-state.js';
import { withBookLock } from '../workspace/book-lock.js';
import { beginRestructure, endRestructure } from '../workspace/restructure-gate.js';
import { reconcilePendingAfterRestructure } from '../workspace/revisions-store.js';
import {
  manuscriptFingerprint,
  sameFingerprint,
  type ManuscriptFingerprint,
} from '../workspace/manuscript-fingerprint.js';
import {
  audioDir,
  manuscriptEditsJsonPath,
  stateJsonPath,
} from '../workspace/paths.js';
import { readJson, writeJsonAtomic } from '../workspace/state-io.js';
import {
  buildHintsEntry,
  composeHintsFile,
  readManuscriptHints,
  removeManuscriptHints,
  sha256Hex,
  writeManuscriptHints,
} from '../workspace/manuscript-hints.js';
import { safeSegment } from '../util/safe-path.js';
import { writeStateJsonAtomic } from '../workspace/state-migrate.js';
import { requestFailureMessageFs, withStateJsonLock } from '../workspace/file-lock.js';
import { ensureChapterUuids } from '../workspace/chapter-uuid.js';
import { getOrHydrateManuscript, putManuscript } from '../store/manuscripts.js';
import { rebuildCacheFromEdits } from '../store/analysis-cache-rebuild.js';
import { rewriteChapterSlugs } from '../audio/rewrite-chapter-slugs.js';
import { parseManuscript } from '../parsers/index.js';
import { looksLikeTitle, MAX_SUBTITLE_LEN } from '../parsers/text.js';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

export const chaptersRestructureRouter = Router();

/* Best-effort: any parse failure leaves the state untouched. Skips the parse
   unless some keyless, non-user-titled chapter has a generic "Chapter N" title.
   Returns the parsed title/flag lists (or null) WITHOUT touching state: the parse
   is slow, so it runs outside the state-json lock (#3700) and the caller applies
   `backfillTitleSynthesized` to the fresh read inside it. */
async function parseForLegacyTitleFlags(
  state: Parameters<typeof backfillTitleSynthesized>[0],
  bookDir: string,
): Promise<{ titles: string[]; flags: boolean[] } | null> {
  /* Only a keyless, non-overridden chapter whose title looks generic can be
     flagged (renumbering and both refresh passes act on that shape alone), so
     a book without one never needs the parse. */
  if (
    !state.chapters.some(
      (c) =>
        !Object.hasOwn(c, 'titleSynthesized') &&
        !c.titleOverridden &&
        GENERIC_TITLE_RE.test(c.title.trim()),
    )
  ) {
    return null;
  }
  const manuscriptPath = join(bookDir, state.manuscriptFile);
  if (!existsSync(manuscriptPath)) return null;
  try {
    const parsed = await parseManuscript({
      buffer: await readFile(manuscriptPath),
      fileName: state.manuscriptFile,
      sourcePath: manuscriptPath,
    });
    return {
      titles: parsed.chapters.map((c) => c.title),
      flags: parsed.chapters.map((c) => c.titleSynthesized === true),
    };
  } catch {
    return null;
  }
}
/** The slow, write-free span of a restructure -- #3711's two-span pattern. It
    runs BEFORE `book-op`, off a `peekBook` that takes no lock and feeds no write:
    the ManuscriptRecord hydrate and the legacy-title parse (a full manuscript
    parse), plus the fingerprint they were taken against. */
interface RestructurePrep {
  fingerprint: ManuscriptFingerprint | null;
  legacyParse: { titles: string[]; flags: boolean[] } | null;
  /** The peeked book, for a route's own advisory parse (refresh-titles). */
  peeked: { bookDir: string; state: BookStateJson };
}

async function prepareRestructure(
  bookId: string,
): Promise<RestructurePrep | { early: { status: number; body: unknown } }> {
  const peeked = await peekBook(bookId);
  if (!peeked) return { early: { status: 404, body: { error: 'Book not found.' } } };
  if (!peeked.state.manuscriptId) {
    return {
      early: {
        status: 400,
        body: { error: 'Book has no manuscript id — cannot restructure.' },
      },
    };
  }

  /* Hydrate the manuscript record (the slow parse) before the lock, so the
     commit's lookup is usually warm. The commit re-reads the record for the id
     the locked state names (review pass 5); when the ids agree that is usually
     the record cached here. It is safe because a hydrate never caches a record
     a `putManuscript` / `removeManuscript` superseded while it was reading
     (review pass 6, `store/manuscripts.ts`). */
  const record = await getOrHydrateManuscript(peeked.state.manuscriptId);
  if (!record) {
    return {
      early: {
        status: 404,
        body: { error: 'Manuscript not found on disk.' },
      },
    };
  }

  /* #3628/#3700 — the legacy-title parse is slow (a full manuscript parse), so
     it runs BEFORE the locks, off the peeked state; only the cheap
     `backfillTitleSynthesized` application happens inside, on the fresh read.
     The fingerprint is taken BEFORE the parse, so a change during it is seen. */
  const fingerprint = await manuscriptFingerprint(peeked.bookDir, peeked.state.manuscriptFile);
  const legacyParse = await parseForLegacyTitleFlags(peeked.state, peeked.bookDir);
  return { fingerprint, legacyParse, peeked };
}

/** Shared "load → transform → write" body. Runs INSIDE the route's `withBookOp`
    (the lock is taken at the handler, one level only), then takes the
    restructure gate and main's per-book `book` lock itself (#3594), in the
    order book-op -> gate -> book. Writes manuscript-hints.json (#3703) +
    state.json + manuscript-edits.json, replaces the in-memory ManuscriptRecord (new chapterHints),
    applies audio ops, clears the analysis cache. `advisoryValid` is false when
    the manuscript changed since `prepareRestructure` parsed it: the advisory
    title flags (and a route's own parse) are then dropped silently -- they only
    tune "Chapter N" renumbering -- and the restructure still succeeds. */
async function applyRestructure(
  book: BookHandle,
  prep: RestructurePrep,
  transform: (
    state: Parameters<typeof applyMerge>[0],
    hints: Parameters<typeof applyMerge>[1],
    sentences: Parameters<typeof applyMerge>[2],
    advisoryValid: boolean,
    parseTitles: ReadonlyArray<string | null> | undefined,
    hintsSource: 'persisted' | 'parse' | undefined,
    parseChapterCount: number | undefined,
  ) => RestructureResult,
  /* Rename and refresh-titles rewrite the very titles the pairing check reads, so on a
     book it already flags they would hide the mispairing from the next merge (#3791). */
  refuseWhenMispaired = false,
): Promise<{
  status: number;
  body: unknown;
}> {
  /* #3774 -- refuse while ANY long job is registered for the book, FIRST: a
     restructure renumbers slugs and rewrites or deletes chapter audio, and a
     render still finalizing would write its take to a stale slug. `runBookJob`
     registers its token inside `withBookOp`, so this check cannot race a
     registration. Every `BookJobKind` counts (analysis included); the gate
     claim below stays for the synchronous analysis-start exclusion. A bulk
     include is NOT exempt: its prune pass drops a chapter with no sentences
     and an empty body and renumbers the rest, moving audio. */
  const busyKinds = bookJobKinds(book.bookId);
  if (busyKinds.length > 0) {
    return {
      status: 409,
      body: { error: busySentence(busyKinds, 'restructure'), code: 'book_busy' },
    };
  }

  const manuscriptId = book.state.manuscriptId;
  if (!manuscriptId) {
    return {
      status: 400,
      body: { error: 'Book has no manuscript id — cannot restructure.' },
    };
  }

  /* An analysis job's terminal persist rewrites manuscript-edits.json from
     the chapter structure it analysed, which would undo this remap — so a
     restructure is refused while one is registered for the book. Claimed
     synchronously with the check, inside book-op and before the book lock, and
     held to the end so a job cannot start under it
     (workspace/restructure-gate.ts). Lock order: book-op -> gate -> book. */
  if (!beginRestructure(manuscriptId)) {
    return {
      status: 409,
      body: {
        error: 'Analysis is running on this book. Pause it or wait for it to finish, then change the chapters.',
        code: 'analysis_running',
      },
    };
  }
  try {
    return await withBookLock(book.bookId, () =>
      applyRestructureClaimed(book, prep, manuscriptId, transform, refuseWhenMispaired),
    );
  } finally {
    endRestructure(manuscriptId);
  }
}

async function applyRestructureClaimed(
  book: BookHandle,
  prep: RestructurePrep,
  manuscriptId: string,
  transform: (
    state: Parameters<typeof applyMerge>[0],
    hints: Parameters<typeof applyMerge>[1],
    sentences: Parameters<typeof applyMerge>[2],
    advisoryValid: boolean,
    parseTitles: ReadonlyArray<string | null> | undefined,
    hintsSource: 'persisted' | 'parse' | undefined,
    parseChapterCount: number | undefined,
  ) => RestructureResult,
  refuseWhenMispaired: boolean,
): Promise<{
  status: number;
  body: unknown;
}> {
  const { bookDir } = book;
  let { state } = book;
  /* PR #3714 review passes 4-5 -- the record is the current one for the
     manuscript the LOCKED state names (`manuscriptId` is `book.state`'s, resolved
     under book-op), never the one `prepareRestructure` hydrated: an op this one
     queued behind may have replaced the store entry (reparse / replace-manuscript
     `putManuscript`) or the whole book (a bundle overwrite, possibly under a NEW
     manuscriptId; the prepared record belongs to the old one). The new
     chapter list is built from these hints, so a stale record rewrites
     `state.chapters` from another manuscript. The store answers when warm; a
     cold one (the overwrite drops the entries it replaced) hydrates here, under
     the lock. */
  const record = await getOrHydrateManuscript(manuscriptId);
  if (!record) return { status: 404, body: { error: 'Manuscript not found on disk.' } };
  const advisoryValid = sameFingerprint(
    prep.fingerprint,
    await manuscriptFingerprint(bookDir, state.manuscriptFile),
  );
  const legacyParse = advisoryValid ? prep.legacyParse : null;

  /* #3700 -- state.json is read, transformed and rewritten as one span under
     the per-book state-json lock (leaf: nothing inside takes another lock; this
     function already runs inside the book lock, which is OUTSIDE it), and the
     read is FRESH from disk rather than the resolve-time snapshot, so a
     sibling chapter render's stamp can't be reverted by the renumbered state. */
  const outcome = await withStateJsonLock(stateJsonPath(bookDir), async () => {
    // Legacy book: chapters imported before titleSynthesized existed carry no
    // flag. Recognise the app-made ones against a fresh parse (#3628) so every
    // operation below renumbers them like a freshly imported book's.
    /* PR #3714 review pass 4 -- a read failure is the curated, path-free
       BookStateUnreadableError; the route answers its message verbatim. */
    const freshState = await readBookStateOrThrow(bookDir);
    /* #3700 review pass 2 -- absent: the book was deleted or moved out of
       process after it was resolved. Writing the stale snapshot back would resurrect
       it; refuse and write nothing. */
    if (!freshState) return { early: { status: 404, body: { error: 'Book not found.' } } };
    state = legacyParse
      ? backfillTitleSynthesized(freshState, legacyParse.titles, legacyParse.flags)
      : freshState;
    // Align hint titles with state.json's user-facing chapter titles.
    // The parser-derived hint titles can diverge (e.g. when state.json
    // captures a more refined title from a later parser-version refresh,
    // or the user has renamed chapters inline). State titles are the
    // source of truth for slugs and display; hints contribute the body
    // text only.
    const alignedHints = record.chapterHints.map((h) => {
      const sc = state.chapters.find((c) => c.id === h.id);
      return sc ? { ...h, title: sc.title } : h;
    });

    // Read current sentences from manuscript-edits.json (may be empty/missing
    // for a fresh book -- that's fine, transform handles it). Each transform
    // requires sentences for split when it needs to locate the body offset.
    const editsPath = manuscriptEditsJsonPath(bookDir);
    const edits = await readJson<{ sentences?: RestructureSentence[]; mergedAwayKeys?: string[] }>(editsPath);
    const sentences = edits?.sentences ?? [];

    /* srv-35 -- ensure the OLD chapters carry uuids before the transform so
       buildNewStateChapters can inherit them by identity (a book that has
       never been written since the upgrade has none yet). The result.state
       is persisted below, so this also migrates the book. */
    ensureChapterUuids(state);

    /* Plan 286 -- captured before transform(...) in case the transform
       mutates `state` in place. */
    const oldChapters = state.chapters.map((c) => ({ ...c }));

    /* #3828 -- the chapter count of the parse the hints' `parseIndex` values index
       into: remembered by the record once a restructure has persisted it, else
       (hints still an unrestructured parse, every one stamped) the hint count
       now. Taken before the transform, which merges and splits. */
    const parseChapterCount =
      record.parseChapterCount ??
      (record.chapterHints.length > 0 && record.chapterHints.every((h) => h.parseIndex !== undefined)
        ? record.chapterHints.length
        : undefined);

    /* Read before the transform, which may rewrite `state`. */
    const hintsMispaired =
      record.hintsSource === 'parse' &&
      record.parseTitles !== undefined &&
      !parseTitlesPairWithState(state, record.parseTitles);
    /* Nothing is written yet: the refusal is the same 409 merge, split and reorder answer. */
    if (refuseWhenMispaired && hintsMispaired) {
      const e = new HintsOutOfSyncError();
      return { early: { status: 409, body: { error: e.message, code: e.code } } };
    }
    let result: RestructureResult;
    try {
      result = transform(
        state,
        alignedHints,
        sentences,
        advisoryValid,
        record.hintsSource === 'parse' ? record.parseTitles : undefined,
        record.hintsSource,
        parseChapterCount,
      );
    } catch (e) {
      /* #3791 -- nothing is written: this is before the hints/state/edits writes. */
      if (e instanceof HintsOutOfSyncError) {
        return { early: { status: 409, body: { error: e.message, code: e.code } } };
      }
      return {
        early: {
          status: 400,
          body: { error: (e as Error).message || 'Invalid restructure operation.' },
        },
      };
    }

    /* #3703 -- persist the restructured bodies so a restart does not rebuild
       them from a manuscript that knows nothing about this restructure. Hints
       FIRST, state.json second: if this write fails the restructure answers 500
       having changed nothing on disk. The file keeps the entry for the structure
       state.json holds NOW next to the new one, so if the state.json write then
       fails, a reader still finds the entry matching the state that landed
       (staleness is checked per entry, by uuid sequence) -- never a body on the
       wrong chapter and never a fresh parse against a restructured state.json.
       The entry is stamped with the sha the record's bodies were PARSED from
       (`record.sourceSha256`), never the file's sha now: a manuscript edited
       since the record was cached would otherwise carry the old bodies under
       the new file's sha, and a restart would trust them. A record with no sha,
       or one that no longer matches the file (or whose file is gone, so the
       book cannot hydrate after a restart anyway), has no entry worth writing:
       the file is removed (best-effort, once the state.json write has landed)
       and the restructure proceeds. */
    let diskSha256: string | null = null;
    try {
      diskSha256 = sha256Hex(await readFile(join(bookDir, safeSegment(state.manuscriptFile))));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    }
    const sourceSha256 = record.sourceSha256;
    const bodiesCurrent = sourceSha256 !== undefined && sourceSha256 === diskSha256;
    if (!bodiesCurrent) {
      console.warn(
        `[chapters-restructure] ${manuscriptId}: chapter bodies are not from the manuscript on disk; skipping manuscript-hints.json`,
      );
    }
    /* A book whose state.json chapters never matched the parse (e.g. 2 chapters
       against a 3-chapter manuscript) has no coherent id pairing to persist, and
       the restructure itself is still valid -- skip rather than fail it. Only
       exclude, rename and refresh-titles get here with such a book: they hand the
       hints back unchanged (so the counts still differ). Merge, split and reorder
       rebuild state from the hints and refuse it with a 409 before this point
       (#3791), including a same-count book whose parse-fallback titles disagree
       with state (`hintsMispaired`). That second case is skipped as well: a file
       written here would make the mispaired bodies `persisted`, which no later
       check looks at. A file written here persists whatever pairing the
       in-memory record already had: a pre-upgrade restructure is not repaired. */
    const aligned = result.hints.length === result.state.chapters.length;
    if (bodiesCurrent && !aligned) {
      console.warn(`[chapters-restructure] ${manuscriptId}: hints/state chapter counts differ; skipping manuscript-hints.json`);
    }
    if (bodiesCurrent && aligned && hintsMispaired) {
      console.warn(`[chapters-restructure] ${manuscriptId}: parsed titles do not pair with state; skipping manuscript-hints.json`);
    }
    const hintsWritten = bodiesCurrent && aligned && !hintsMispaired;
    if (hintsWritten) {
      /* An unreadable previous file just means no previous entry to keep. */
      const previousFile = await readManuscriptHints(bookDir).catch(() => null);
      await writeManuscriptHints(
        bookDir,
        composeHintsFile(
          buildHintsEntry({
            manuscriptId,
            manuscriptFile: state.manuscriptFile,
            sourceSha256,
            hints: result.hints,
            parseChapterCount,
            stateChapters: result.state.chapters,
          }),
          previousFile,
          { manuscriptId, manuscriptFile: state.manuscriptFile, chapters: oldChapters },
          sourceSha256,
        ),
      );
    }

    // Write order: manuscript-hints.json -> state.json (rotating backup) ->
    // manuscript-edits.json -> in-memory hints -> audio ops -> analysis cache.
    // If any step throws past here, earlier writes are already on disk; partial
    // state is recoverable via the reconciliation filter in
    // book-state.ts:166-185.
    await writeStateJsonAtomic(stateJsonPath(bookDir), { ...result.state, language: result.state.language ?? null });
    /* A stale record means the manuscript on disk changed, so the kept entry
       does not validate against its sha today. The order is load-bearing: if the
       edit is reverted before a restart the kept entry validates again, and
       removing it before a failed state write would lose the structure that
       landed (#3703). Best-effort. */
    if (!bodiesCurrent) {
      await removeManuscriptHints(bookDir).catch((err) => {
        console.warn(`[chapters-restructure] ${manuscriptId}: could not remove manuscript-hints.json`, err);
      });
    }
    /* #3400 -- merged-away tombstones ride along (the client's save after the
       remap applies the same rule), so a restructure no longer wipes them. */
    await writeJsonAtomic(editsPath, {
      sentences: result.sentences,
      ...(edits?.mergedAwayKeys
        ? { mergedAwayKeys: carryMergedAwayKeys(edits.mergedAwayKeys, result.remap) }
        : {}),
    });
    return { early: null, result, editsPath, oldChapters, hintsWritten, parseChapterCount };
  });
  if (outcome.early) return outcome.early;
  const { result, editsPath, oldChapters, hintsWritten, parseChapterCount } = outcome;

  // Update in-memory ManuscriptRecord so the next analysis/generation
  // pick up the new structure without a server restart.
  /* Replace the record, never mutate it in place: a cold hydrate still parsing
     checks the store's per-id version before it caches, and only `putManuscript`
     moves that (#3703). The spread keeps `sourceSha256` and every other field. */
  /* Once the file is written these hints are what a restart hydrates, so the
     record is `persisted` and no longer carries the parser's raw titles. */
  const { parseTitles: _parseTitles, ...recordRest } = record;
  const originCount = parseChapterCount !== undefined ? { parseChapterCount } : {};
  putManuscript(
    hintsWritten
      ? { ...recordRest, chapterHints: result.hints, hintsSource: 'persisted', ...originCount }
      : { ...record, chapterHints: result.hints, ...originCount },
  );

  // Apply audio ops (best-effort — errors are surfaced in the response).
  const audioSummary = await rewriteChapterSlugs(
    audioDir(bookDir),
    result.audioOps,
    staleTakeClearSlugs(result.state.chapters, result.audioOps, oldChapters),
  );

  /* Plan 286 / #3704 — a renamed or renumbered chapter's pending entry moves to its new id with its
     `.previous.mp3`; every other touched chapter's entry no longer pairs with the live take and is
     dropped. Best-effort: logged, never in a response (the six handlers
     return raw messages, so a lock-key path must not reach them). A deliberate
     swallow of LockAcquisitionTimeoutError (CLAUDE.md swallow list). An entry
     that survives a failed drop is NOT left to act on whichever chapter now
     holds its id: a server-recorded entry carries the chapter's uuid +
     audioRenderedAt and revisions-store's entryMatchesChapter refuses it
     (revision_not_found) once the chapter at that id differs (#3400). A legacy
     client-written entry has no stamps and is not covered. */
  try {
    const touched = touchedChapterIds(oldChapters, result.state.chapters, result.audioOps);
    const previousMovedFrom = new Set(
      audioSummary.renamed.filter((r) => r.suffix === 'previous.mp3').map((r) => r.from),
    );
    const moves = pendingMovesAfterRestructure(oldChapters, result.audioOps, previousMovedFrom);
    if (touched.length > 0) await reconcilePendingAfterRestructure(bookDir, result.state.chapters, touched, moves);
  } catch (e) {
    console.error('[chapters-restructure] could not reconcile A/B review entries', e);
  }

  // Plan 70c — re-derive the analysis cache from the freshly-written
  // manuscript-edits.json so subsequent generation runs still find
  // sentences keyed by the new chapter ids. Earlier code wiped the
  // cache outright, which made every post-restructure Generate halt
  // with "No analysed sentences cached for this book."
  // Plan 287 — 'replace': ids are renumbered, so prior keys cannot be kept.
  await rebuildCacheFromEdits(manuscriptId, editsPath, { mode: 'replace' }).catch((e) => {
    console.error('[chapters-restructure] cache rebuild failed', e);
  });

  return {
    status: 200,
    body: {
      chapters: result.state.chapters,
      sentenceRemap: result.remap,
      audioSummary, // not part of OpenAPI envelope — debug aid only
      // Non-fatal advisories: orphan recovery counts, prune-empty
      // counts, generic-title renumber counts. Empty array on clean ops.
      warnings: result.warnings,
    },
  };
}

chaptersRestructureRouter.post(
  '/:bookId/chapters/merge',
  async (req: Request, res: Response) => {
    const body = req.body as Partial<MergeOp>;
    if (!Array.isArray(body?.chapterIds)) {
      return res.status(400).json({ error: 'chapterIds (array) is required.' });
    }
    const op: MergeOp = {
      chapterIds: body.chapterIds,
      ...(typeof body.mergedTitle === 'string' ? { mergedTitle: body.mergedTitle } : {}),
    };
    try {
      const prep = await prepareRestructure(req.params.bookId);
      if ('early' in prep) return res.status(prep.early.status).json(prep.early.body);
      const result = await withBookOp(req.params.bookId, (book) =>
        applyRestructure(book, prep, (state, hints, sentences, _advisoryValid, parseTitles) =>
          applyMerge(state, hints, sentences, op, parseTitles),
        ),
      );
      if (result === BOOK_GONE) return res.status(404).json({ error: 'Book not found.' });
      res.status(result.status).json(result.body);
    } catch (e) {
      console.error('[chapters-restructure] merge failed', e);
      res.status(500).json({
        error: requestFailureMessageFs(e, (e as Error).message || 'Merge failed.'),
      });
    }
  },
);

chaptersRestructureRouter.post(
  '/:bookId/chapters/split',
  async (req: Request, res: Response) => {
    const body = req.body as Partial<SplitOp>;
    if (typeof body?.chapterId !== 'number' || typeof body?.afterSentenceId !== 'number') {
      return res
        .status(400)
        .json({ error: 'chapterId (integer) and afterSentenceId (integer) are required.' });
    }
    const op: SplitOp = {
      chapterId: body.chapterId,
      afterSentenceId: body.afterSentenceId,
      ...(typeof body.newTitle === 'string' ? { newTitle: body.newTitle } : {}),
    };
    try {
      const prep = await prepareRestructure(req.params.bookId);
      if ('early' in prep) return res.status(prep.early.status).json(prep.early.body);
      const result = await withBookOp(req.params.bookId, (book) =>
        applyRestructure(book, prep, (state, hints, sentences, _advisoryValid, parseTitles) =>
          applySplit(state, hints, sentences, op, parseTitles),
        ),
      );
      if (result === BOOK_GONE) return res.status(404).json({ error: 'Book not found.' });
      res.status(result.status).json(result.body);
    } catch (e) {
      console.error('[chapters-restructure] split failed', e);
      res.status(500).json({
        error: requestFailureMessageFs(e, (e as Error).message || 'Split failed.'),
      });
    }
  },
);

chaptersRestructureRouter.post(
  '/:bookId/chapters/refresh-titles',
  async (req: Request, res: Response) => {
    const body = (req.body ?? {}) as { useFirstLine?: boolean };
    const useFirstLine = body.useFirstLine !== false; // default true
    try {
      const prep = await prepareRestructure(req.params.bookId);
      if ('early' in prep) return res.status(prep.early.status).json(prep.early.body);
      const { bookDir, state } = prep.peeked;

      // Re-parse the manuscript from disk so we have authoritative titles
      // for the parser-aligned pass. Failure modes (missing file, parse
      // error) downgrade gracefully — we still run the first-line
      // promotion pass on the in-memory state. Like the legacy-title parse,
      // this is a two-span advisory: it ran against `prep.fingerprint`'s
      // manuscript, and is dropped inside the lock if that has changed.
      let parsedTitles: string[] = [];
      let parsedTitleSynthesized: boolean[] = [];
      let parsedBodies: string[] = [];
      const manuscriptPath = join(bookDir, state.manuscriptFile);
      if (existsSync(manuscriptPath)) {
        try {
          const buffer = await readFile(manuscriptPath);
          const parsed = await parseManuscript({
            buffer,
            fileName: state.manuscriptFile,
            sourcePath: manuscriptPath,
          });
          parsedTitles = parsed.chapters.map((c) => c.title);
          parsedTitleSynthesized = parsed.chapters.map((c) => c.titleSynthesized === true);
          parsedBodies = parsed.chapters.map((c) => c.body);
        } catch (parseErr) {
          console.warn(
            `[chapters-restructure] refresh-titles: manuscript parse failed for ${state.bookId}:`,
            (parseErr as Error).message,
          );
        }
      }

      const result = await withBookOp(req.params.bookId, (book) =>
        applyRestructure(book, prep, (s, hints, sentences, advisoryValid, _parseTitles, hintsSource, parseChapterCount) =>
          applyRefreshTitles(s, hints, sentences, {
            parsedTitles: advisoryValid ? parsedTitles : [],
            parsedTitleSynthesized: advisoryValid ? parsedTitleSynthesized : [],
            /* #3828 -- pairing through the hints (origin, or body for a file without origins) only where they are the book's own restructure:
               a never-restructured book keeps the positional pairing. */
            ...(hintsSource === 'persisted'
              ? { parsedBodies: advisoryValid ? parsedBodies : [], parseChapterCount }
              : {}),
            useFirstLine,
            looksLikeTitle,
            maxLen: MAX_SUBTITLE_LEN,
          }),
          true,
        ),
      );
      if (result === BOOK_GONE) return res.status(404).json({ error: 'Book not found.' });
      res.status(result.status).json(result.body);
    } catch (e) {
      console.error('[chapters-restructure] refresh-titles failed', e);
      res.status(500).json({
        error: requestFailureMessageFs(e, (e as Error).message || 'Refresh chapter titles failed.'),
      });
    }
  },
);

chaptersRestructureRouter.post(
  '/:bookId/chapters/exclude',
  async (req: Request, res: Response) => {
    const body = req.body as Partial<ExcludeOp>;
    if (!Array.isArray(body?.chapterIds) || body.chapterIds.length === 0) {
      return res
        .status(400)
        .json({ error: 'chapterIds (non-empty array) is required.' });
    }
    if (typeof body.excluded !== 'boolean') {
      return res.status(400).json({ error: '`excluded` (boolean) is required.' });
    }
    const op: ExcludeOp = {
      chapterIds: body.chapterIds,
      excluded: body.excluded,
    };
    try {
      const prep = await prepareRestructure(req.params.bookId);
      if ('early' in prep) return res.status(prep.early.status).json(prep.early.body);
      const result = await withBookOp(req.params.bookId, (book) =>
        applyRestructure(book, prep, (state, hints, sentences) =>
          applyExclude(state, hints, sentences, op),
        ),
      );
      if (result === BOOK_GONE) return res.status(404).json({ error: 'Book not found.' });
      res.status(result.status).json(result.body);
    } catch (e) {
      console.error('[chapters-restructure] exclude failed', e);
      res.status(500).json({
        error: requestFailureMessageFs(e, (e as Error).message || 'Exclude failed.'),
      });
    }
  },
);

/* User-supplied rename. The route is intentionally a single-chapter
   POST under the restructure cluster (rather than a slice patch in PUT
   /:bookId/state) because it's the same persistence shape as exclude
   and benefits from the same per-book write lock against concurrent
   chapter-restructure ops. Returns the updated chapter envelope —
   mirrors the setChapterExcluded response shape, plus `titleOverridden`
   so the frontend can confirm the lock landed. */
chaptersRestructureRouter.post(
  '/:bookId/chapters/:chapterId/rename',
  async (req: Request, res: Response) => {
    const chapterId = Number.parseInt(req.params.chapterId, 10);
    if (!Number.isInteger(chapterId) || chapterId <= 0) {
      return res.status(400).json({ error: 'chapterId must be a positive integer.' });
    }
    const body = (req.body ?? {}) as { title?: unknown };
    if (typeof body.title !== 'string') {
      return res.status(400).json({ error: '`title` (string) is required.' });
    }
    const op: RenameOp = { chapterId, title: body.title };
    try {
      const prep = await prepareRestructure(req.params.bookId);
      if ('early' in prep) return res.status(prep.early.status).json(prep.early.body);
      const result = await withBookOp(req.params.bookId, (book) =>
        applyRestructure(book, prep, (state, hints, sentences) =>
          applyRename(state, hints, sentences, op),
          true,
        ),
      );
      if (result === BOOK_GONE) return res.status(404).json({ error: 'Book not found.' });
      if (result.status !== 200) {
        // `applyRestructure` wraps applyRename's "Chapter X not found"
        // throw as a 400; remap to 404 for unknown chapter ids so the
        // route's HTTP semantics match the rest of the cluster.
        const body = result.body as { error?: string };
        if (result.status === 400 && /not found/i.test(body?.error ?? '')) {
          return res.status(404).json(body);
        }
        return res.status(result.status).json(result.body);
      }
      // Project the updated chapter into the setChapterExcluded-shaped
      // response envelope. Cheaper for the frontend than rehydrating
      // the whole chapter list when only one title moved.
      const chapters = (result.body as { chapters: BookStateJson['chapters'] }).chapters;
      const updated = chapters.find((c) => c.id === chapterId);
      if (!updated) {
        return res.status(500).json({ error: 'Updated chapter missing from response.' });
      }
      res.status(200).json({
        id: updated.id,
        title: updated.title,
        slug: updated.slug,
        titleOverridden: updated.titleOverridden === true,
      });
    } catch (e) {
      const msg = requestFailureMessageFs(e, (e as Error).message || 'Rename failed.');
      // Surface validation errors from applyRename as 400, anything
      // else (filesystem write failures, etc.) as 500.
      if (/not found/.test(msg)) {
        return res.status(404).json({ error: msg });
      }
      if (/required|empty|characters or fewer|integer/.test(msg)) {
        return res.status(400).json({ error: msg });
      }
      console.error('[chapters-restructure] rename failed', e);
      res.status(500).json({ error: msg });
    }
  },
);

chaptersRestructureRouter.post(
  '/:bookId/chapters/reorder',
  async (req: Request, res: Response) => {
    const body = req.body as Partial<ReorderOp>;
    if (!Array.isArray(body?.order)) {
      return res.status(400).json({ error: 'order (array of integers) is required.' });
    }
    const op: ReorderOp = { order: body.order };
    try {
      const prep = await prepareRestructure(req.params.bookId);
      if ('early' in prep) return res.status(prep.early.status).json(prep.early.body);
      const result = await withBookOp(req.params.bookId, (book) =>
        applyRestructure(book, prep, (state, hints, sentences, _advisoryValid, parseTitles) =>
          applyReorder(state, hints, sentences, op, parseTitles),
        ),
      );
      if (result === BOOK_GONE) return res.status(404).json({ error: 'Book not found.' });
      res.status(result.status).json(result.body);
    } catch (e) {
      console.error('[chapters-restructure] reorder failed', e);
      res.status(500).json({
        error: requestFailureMessageFs(e, (e as Error).message || 'Reorder failed.'),
      });
    }
  },
);
