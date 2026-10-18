/* POST /api/books/:bookId/chapters/{merge,split,reorder}

   Applies a structural restructure operation to the persistent book layout:
   1. Pure transform via workspace/restructure.ts (state.json shape +
      ChapterHint[] + sentences + audio op plan + sentence remap).
   2. Atomically write state.json (rotating backup) and manuscript-edits.json.
   3. Mutate the in-memory ManuscriptRecord.chapterHints so subsequent
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
   so the three persistence writes can't interleave, and holds a folder rename
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
  applySplit,
  applyReorder,
  applyExclude,
  backfillTitleSynthesized,
  GENERIC_TITLE_RE,
  applyRefreshTitles,
  applyRename,
  type MergeOp,
  type SplitOp,
  type ReorderOp,
  type ExcludeOp,
  type RenameOp,
  type RestructureResult,
  type RestructureSentence,
} from '../workspace/restructure.js';
import type { BookStateJson } from '../workspace/scan.js';
import { BOOK_GONE, peekBook, withBookOp, type BookHandle } from '../workspace/book-op-lock.js';
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
import { readStateJsonWithRecovery, writeStateJsonAtomic } from '../workspace/state-migrate.js';
import { withStateJsonLock } from '../workspace/file-lock.js';
import { ensureChapterUuids } from '../workspace/chapter-uuid.js';
import { getOrHydrateManuscript } from '../store/manuscripts.js';
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
  record: NonNullable<Awaited<ReturnType<typeof getOrHydrateManuscript>>>;
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

  // Hydrate manuscript record so we have current ChapterHint[]
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
  return { fingerprint, record, legacyParse, peeked };
}

/** Shared "load → transform → write" body. Runs INSIDE the route's `withBookOp`
    (the lock is taken at the handler, one level only). Writes state.json +
    manuscript-edits.json, mutates the in-memory ManuscriptRecord.chapterHints,
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
  ) => RestructureResult,
): Promise<{
  status: number;
  body: unknown;
}> {
  const { bookDir } = book;
  let { state } = book;
  const { record } = prep;
  const advisoryValid = sameFingerprint(
    prep.fingerprint,
    await manuscriptFingerprint(bookDir, state.manuscriptFile),
  );
  const legacyParse = advisoryValid ? prep.legacyParse : null;

  /* #3700 — state.json is read, transformed and rewritten as one span under
     the per-book state-json lock (leaf: nothing inside takes another lock), and
     the read is FRESH from disk rather than the resolve-time snapshot, so a
     sibling chapter render's stamp can't be reverted by the renumbered state. */
  const outcome = await withStateJsonLock(stateJsonPath(bookDir), async () => {
    // Legacy book: chapters imported before titleSynthesized existed carry no
    // flag. Recognise the app-made ones against a fresh parse (#3628) so every
    // operation below renumbers them like a freshly imported book's.
    const freshState = await readStateJsonWithRecovery(stateJsonPath(bookDir));
    /* #3700 review pass 2 — absent: the book was deleted or moved out of process
       after it was resolved. Writing the stale snapshot back would resurrect
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
    // for a fresh book — that's fine, transform handles it). Each transform
    // requires sentences for split when it needs to locate the body offset.
    const editsPath = manuscriptEditsJsonPath(bookDir);
    const edits = await readJson<{ sentences?: RestructureSentence[] }>(editsPath);
    const sentences = edits?.sentences ?? [];

    /* srv-35 — ensure the OLD chapters carry uuids before the transform so
       buildNewStateChapters can inherit them by identity (a book that has
       never been written since the upgrade has none yet). The result.state
       is persisted below, so this also migrates the book. */
    ensureChapterUuids(state);

    let result: RestructureResult;
    try {
      result = transform(state, alignedHints, sentences, advisoryValid);
    } catch (e) {
      return {
        early: {
          status: 400,
          body: { error: (e as Error).message || 'Invalid restructure operation.' },
        },
      };
    }

    // Write order: state.json (rotating backup) → manuscript-edits.json →
    // in-memory hints → audio ops → analysis cache. If any step throws past
    // here, earlier writes are already on disk; partial state is recoverable
    // via the reconciliation filter in book-state.ts:166-185.
    await writeStateJsonAtomic(stateJsonPath(bookDir), { ...result.state, language: result.state.language ?? null });
    await writeJsonAtomic(editsPath, { sentences: result.sentences });
    return { early: null, result, editsPath };
  });
  if (outcome.early) return outcome.early;
  const { result, editsPath } = outcome;

  // Update in-memory ManuscriptRecord so the next analysis/generation
  // pick up the new structure without a server restart.
  record.chapterHints = result.hints;

  // Apply audio ops (best-effort — errors are surfaced in the response).
  const audioSummary = await rewriteChapterSlugs(audioDir(bookDir), result.audioOps);

  // Plan 70c — re-derive the analysis cache from the freshly-written
  // manuscript-edits.json so subsequent generation runs still find
  // sentences keyed by the new chapter ids. Earlier code wiped the
  // cache outright, which made every post-restructure Generate halt
  // with "No analysed sentences cached for this book."
  // Plan 286 — 'replace': ids are renumbered, so prior keys cannot be kept.
  await rebuildCacheFromEdits(state.manuscriptId, editsPath, { mode: 'replace' }).catch((e) => {
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
        applyRestructure(book, prep, (state, hints, sentences) =>
          applyMerge(state, hints, sentences, op),
        ),
      );
      if (result === BOOK_GONE) return res.status(404).json({ error: 'Book not found.' });
      res.status(result.status).json(result.body);
    } catch (e) {
      console.error('[chapters-restructure] merge failed', e);
      res.status(500).json({ error: (e as Error).message || 'Merge failed.' });
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
        applyRestructure(book, prep, (state, hints, sentences) =>
          applySplit(state, hints, sentences, op),
        ),
      );
      if (result === BOOK_GONE) return res.status(404).json({ error: 'Book not found.' });
      res.status(result.status).json(result.body);
    } catch (e) {
      console.error('[chapters-restructure] split failed', e);
      res.status(500).json({ error: (e as Error).message || 'Split failed.' });
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
        } catch (parseErr) {
          console.warn(
            `[chapters-restructure] refresh-titles: manuscript parse failed for ${state.bookId}:`,
            (parseErr as Error).message,
          );
        }
      }

      const result = await withBookOp(req.params.bookId, (book) =>
        applyRestructure(book, prep, (s, hints, sentences, advisoryValid) =>
          applyRefreshTitles(s, hints, sentences, {
            parsedTitles: advisoryValid ? parsedTitles : [],
            parsedTitleSynthesized: advisoryValid ? parsedTitleSynthesized : [],
            useFirstLine,
            looksLikeTitle,
            maxLen: MAX_SUBTITLE_LEN,
          }),
        ),
      );
      if (result === BOOK_GONE) return res.status(404).json({ error: 'Book not found.' });
      res.status(result.status).json(result.body);
    } catch (e) {
      console.error('[chapters-restructure] refresh-titles failed', e);
      res.status(500).json({
        error: (e as Error).message || 'Refresh chapter titles failed.',
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
      res.status(500).json({ error: (e as Error).message || 'Exclude failed.' });
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
      const msg = (e as Error).message || 'Rename failed.';
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
        applyRestructure(book, prep, (state, hints, sentences) =>
          applyReorder(state, hints, sentences, op),
        ),
      );
      if (result === BOOK_GONE) return res.status(404).json({ error: 'Book not found.' });
      res.status(result.status).json(result.body);
    } catch (e) {
      console.error('[chapters-restructure] reorder failed', e);
      res.status(500).json({ error: (e as Error).message || 'Reorder failed.' });
    }
  },
);
