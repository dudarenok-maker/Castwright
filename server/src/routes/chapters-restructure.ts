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
   5. Clear the analysis cache for the manuscript (the cache's outer
      chapter-id keying is now stale and would surface phantom entries
      on the next book-state GET reconciliation). The cache is rebuilt
      from manuscript-edits.json + state.json on next access.

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
  type MergeOp,
  type SplitOp,
  type ReorderOp,
  type RestructureResult,
  type RestructureSentence,
} from '../workspace/restructure.js';
import { findBookByBookId } from '../workspace/scan.js';
import {
  audioDir,
  manuscriptEditsJsonPath,
  stateJsonPath,
} from '../workspace/paths.js';
import { readJson, writeJsonAtomic } from '../workspace/state-io.js';
import { writeStateJsonAtomic } from '../workspace/state-migrate.js';
import { getOrHydrateManuscript } from '../store/manuscripts.js';
import { clearAnalysisCache } from '../store/analysis-cache.js';
import { rewriteChapterSlugs } from '../audio/rewrite-chapter-slugs.js';

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

  // Wipe the analysis cache so the next book-state GET re-derives sentences
  // from the freshly-written manuscript-edits.json. The cache's outer
  // chapter-id keying is now stale and would surface zombie entries via
  // the GET handler's reconciliation logic.
  await clearAnalysisCache(state.manuscriptId).catch(() => {
    /* best effort */
  });

  return {
    status: 200,
    body: {
      chapters: result.state.chapters,
      sentenceRemap: result.remap,
      audioSummary, // not part of OpenAPI envelope — debug aid only
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
