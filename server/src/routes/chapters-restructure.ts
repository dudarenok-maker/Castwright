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

   A per-book write lock chain serialises concurrent restructure calls
   so the three persistence writes can't interleave. Without the lock,
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
  touchedChapterIds,
  carryMergedAwayKeys,
  type MergeOp,
  type SplitOp,
  type ReorderOp,
  type ExcludeOp,
  type RenameOp,
  type RestructureResult,
  type RestructureSentence,
} from '../workspace/restructure.js';
import { withBookLock } from '../workspace/book-lock.js';
import { beginRestructure, endRestructure } from '../workspace/restructure-gate.js';
import { dropPendingForChapters } from '../workspace/revisions-store.js';
import { findBookByBookId, type BookStateJson } from '../workspace/scan.js';
import {
  audioDir,
  manuscriptEditsJsonPath,
  stateJsonPath,
} from '../workspace/paths.js';
import { readJson, writeJsonAtomic } from '../workspace/state-io.js';
import { writeStateJsonAtomic } from '../workspace/state-migrate.js';
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
   unless some keyless, non-user-titled chapter has a generic "Chapter N" title. */
async function backfillLegacyTitleFlags(
  state: Parameters<typeof backfillTitleSynthesized>[0],
  bookDir: string,
): Promise<Parameters<typeof backfillTitleSynthesized>[0]> {
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
    return state;
  }
  const manuscriptPath = join(bookDir, state.manuscriptFile);
  if (!existsSync(manuscriptPath)) return state;
  try {
    const parsed = await parseManuscript({
      buffer: await readFile(manuscriptPath),
      fileName: state.manuscriptFile,
      sourcePath: manuscriptPath,
    });
    return backfillTitleSynthesized(
      state,
      parsed.chapters.map((c) => c.title),
      parsed.chapters.map((c) => c.titleSynthesized === true),
    );
  } catch {
    return state;
  }
}
/** Shared "load → transform → write" prologue. Returns the new result and
    side-effects: writes state.json + manuscript-edits.json, mutates the
    in-memory ManuscriptRecord.chapterHints, applies audio ops, clears the
    analysis cache. */
async function applyRestructure(
  bookId: string,
  transform: (
    state: Parameters<typeof applyMerge>[0],
    hints: Parameters<typeof applyMerge>[1],
    sentences: Parameters<typeof applyMerge>[2],
  ) => RestructureResult,
): Promise<{
  status: number;
  body: unknown;
}> {
  const located = await findBookByBookId(bookId);
  if (!located) return { status: 404, body: { error: 'Book not found.' } };

  const manuscriptId = located.state.manuscriptId;
  if (!manuscriptId) {
    return {
      status: 400,
      body: { error: 'Book has no manuscript id — cannot restructure.' },
    };
  }

  /* An analysis job's terminal persist rewrites manuscript-edits.json from
     the chapter structure it analysed, which would undo this remap — so a
     restructure is refused while one is registered for the book. Claimed
     synchronously with the check, inside the book lock, and held to the end so
     a job cannot start under it (workspace/restructure-gate.ts). */
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
    return await applyRestructureClaimed(located, manuscriptId, transform);
  } finally {
    endRestructure(manuscriptId);
  }
}

async function applyRestructureClaimed(
  located: NonNullable<Awaited<ReturnType<typeof findBookByBookId>>>,
  manuscriptId: string,
  transform: (
    state: Parameters<typeof applyMerge>[0],
    hints: Parameters<typeof applyMerge>[1],
    sentences: Parameters<typeof applyMerge>[2],
  ) => RestructureResult,
): Promise<{
  status: number;
  body: unknown;
}> {
  const { bookDir } = located;
  let { state } = located;

  // Hydrate manuscript record so we have current ChapterHint[]
  const record = await getOrHydrateManuscript(manuscriptId);
  if (!record) {
    return {
      status: 404,
      body: { error: 'Manuscript not found on disk.' },
    };
  }

  // Legacy book: chapters imported before titleSynthesized existed carry no
  // flag. Recognise the app-made ones against a fresh parse (#3628) so every
  // operation below renumbers them like a freshly imported book's.
  state = await backfillLegacyTitleFlags(state, bookDir);
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
  const edits = await readJson<{ sentences?: RestructureSentence[]; mergedAwayKeys?: string[] }>(editsPath);
  const sentences = edits?.sentences ?? [];

  /* srv-35 — ensure the OLD chapters carry uuids before the transform so
     buildNewStateChapters can inherit them by identity (a book that has
     never been written since the upgrade has none yet). The result.state
     is persisted below, so this also migrates the book. */
  ensureChapterUuids(state);

  /* Plan 286 — captured before transform(...) in case the transform
     mutates `state` in place. */
  const oldChapters = state.chapters.map((c) => ({ ...c }));

  let result: RestructureResult;
  try {
    result = transform(state, alignedHints, sentences);
  } catch (e) {
    return {
      status: 400,
      body: { error: (e as Error).message || 'Invalid restructure operation.' },
    };
  }

  // Write order: state.json (rotating backup) → manuscript-edits.json →
  // in-memory hints → audio ops → analysis cache. If any step throws past
  // here, earlier writes are already on disk; partial state is recoverable
  // via the reconciliation filter in book-state.ts:166-185.
  await writeStateJsonAtomic(stateJsonPath(bookDir), { ...result.state, language: result.state.language ?? null });
  /* #3400 — merged-away tombstones ride along (the client's save after the
     remap applies the same rule), so a restructure no longer wipes them. */
  await writeJsonAtomic(editsPath, {
    sentences: result.sentences,
    ...(edits?.mergedAwayKeys
      ? { mergedAwayKeys: carryMergedAwayKeys(edits.mergedAwayKeys, result.remap) }
      : {}),
  });

  // Update in-memory ManuscriptRecord so the next analysis/generation
  // pick up the new structure without a server restart.
  record.chapterHints = result.hints;

  // Apply audio ops (best-effort — errors are surfaced in the response).
  const audioSummary = await rewriteChapterSlugs(audioDir(bookDir), result.audioOps);

  /* Plan 286 — entries for chapters this op touched no longer pair with the
     live take. Best-effort: logged, never in a response (the six handlers
     return raw messages, so a lock-key path must not reach them). A deliberate
     swallow of LockAcquisitionTimeoutError (CLAUDE.md swallow list). An entry
     that survives a failed drop is NOT left to act on whichever chapter now
     holds its id: a server-recorded entry carries the chapter's uuid +
     audioRenderedAt and revisions-store's entryMatchesChapter refuses it
     (revision_not_found) once the chapter at that id differs (#3400). A legacy
     client-written entry has no stamps and is not covered. */
  try {
    const touched = touchedChapterIds(oldChapters, result.state.chapters, result.audioOps);
    if (touched.length > 0) await dropPendingForChapters(bookDir, oldChapters, touched);
  } catch (e) {
    console.error('[chapters-restructure] could not drop stale A/B review entries', e);
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
      const result = await withBookLock(req.params.bookId, () =>
        applyRestructure(req.params.bookId, (state, hints, sentences) =>
          applyMerge(state, hints, sentences, op),
        ),
      );
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
      const result = await withBookLock(req.params.bookId, () =>
        applyRestructure(req.params.bookId, (state, hints, sentences) =>
          applySplit(state, hints, sentences, op),
        ),
      );
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
      const located = await findBookByBookId(req.params.bookId);
      if (!located) return res.status(404).json({ error: 'Book not found.' });
      const { bookDir, state } = located;

      // Re-parse the manuscript from disk so we have authoritative titles
      // for the parser-aligned pass. Failure modes (missing file, parse
      // error) downgrade gracefully — we still run the first-line
      // promotion pass on the in-memory state.
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

      const result = await withBookLock(req.params.bookId, () =>
        applyRestructure(req.params.bookId, (s, hints, sentences) =>
          applyRefreshTitles(s, hints, sentences, {
            parsedTitles,
            parsedTitleSynthesized,
            useFirstLine,
            looksLikeTitle,
            maxLen: MAX_SUBTITLE_LEN,
          }),
        ),
      );
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
      const result = await withBookLock(req.params.bookId, () =>
        applyRestructure(req.params.bookId, (state, hints, sentences) =>
          applyExclude(state, hints, sentences, op),
        ),
      );
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
      const result = await withBookLock(req.params.bookId, () =>
        applyRestructure(req.params.bookId, (state, hints, sentences) =>
          applyRename(state, hints, sentences, op),
        ),
      );
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
      const result = await withBookLock(req.params.bookId, () =>
        applyRestructure(req.params.bookId, (state, hints, sentences) =>
          applyReorder(state, hints, sentences, op),
        ),
      );
      res.status(result.status).json(result.body);
    } catch (e) {
      console.error('[chapters-restructure] reorder failed', e);
      res.status(500).json({ error: (e as Error).message || 'Reorder failed.' });
    }
  },
);
