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
   See `docs/features/51-restructure-chapters.md` for the full design. */

import { Router, type Request, type Response } from 'express';
import {
  applyMerge,
  applySplit,
  applyReorder,
  applyExclude,
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
import { findBookByBookId, type BookStateJson } from '../workspace/scan.js';
import {
  audioDir,
  manuscriptEditsJsonPath,
  stateJsonPath,
} from '../workspace/paths.js';
import { readJson, writeJsonAtomic } from '../workspace/state-io.js';
import { writeStateJsonAtomic } from '../workspace/state-migrate.js';
import { getOrHydrateManuscript } from '../store/manuscripts.js';
import { rebuildCacheFromEdits } from '../store/analysis-cache-rebuild.js';
import { rewriteChapterSlugs } from '../audio/rewrite-chapter-slugs.js';
import { parseManuscript } from '../parsers/index.js';
import { looksLikeTitle, MAX_SUBTITLE_LEN } from '../parsers/text.js';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

export const chaptersRestructureRouter = Router();

/* Per-book write lock — serialises concurrent restructure requests on the
   same book so the three-file write order (state.json → manuscript-edits.json
   → in-memory hints) can't interleave between requests. Lock is held for
   the duration of one handler call; releases happen in finally{} so a
   throw inside the handler doesn't leak. */
const bookWriteLock = new Map<string, Promise<void>>();

async function withBookLock<T>(bookId: string, fn: () => Promise<T>): Promise<T> {
  const prev = bookWriteLock.get(bookId) ?? Promise.resolve();
  let release!: () => void;
  const next = new Promise<void>((resolve) => {
    release = resolve;
  });
  bookWriteLock.set(bookId, prev.then(() => next));
  try {
    await prev;
    return await fn();
  } finally {
    release();
    // Best-effort cleanup: if no further requests queued behind us, drop
    // the entry so the map doesn't grow unboundedly over a long server
    // lifetime.
    if (bookWriteLock.get(bookId) === prev.then(() => next)) {
      bookWriteLock.delete(bookId);
    }
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

  const { bookDir, state } = located;
  if (!state.manuscriptId) {
    return {
      status: 400,
      body: { error: 'Book has no manuscript id — cannot restructure.' },
    };
  }

  // Hydrate manuscript record so we have current ChapterHint[]
  const record = await getOrHydrateManuscript(state.manuscriptId);
  if (!record) {
    return {
      status: 404,
      body: { error: 'Manuscript not found on disk.' },
    };
  }

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
  await writeStateJsonAtomic(stateJsonPath(bookDir), result.state);
  await writeJsonAtomic(editsPath, { sentences: result.sentences });

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
  await rebuildCacheFromEdits(state.manuscriptId, editsPath).catch((e) => {
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
