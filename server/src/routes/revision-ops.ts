/* Plan 285 (#3400) — server-owned revisions operations (spec §2). One route per
   operation. Accept and reject run the audio step (today's code,
   audio/previous-audio.ts) and then the JSON write, in that order; the JSON is
   written only if the audio step succeeded.

   PR 1: no client calls these yet (the client cuts over in PR 2), so the
   client remains the only writer of `pending` on main. */

import { Router } from 'express';
import type { Request, Response } from '../http.js';
import { audioDir } from '../workspace/paths.js';
import { findBookByBookId } from '../workspace/scan.js';
import { findChapterAudio } from '../workspace/chapter-audio-file.js';
import { requestFailureMessage } from '../workspace/file-lock.js';
import {
  acceptPreviousAudio,
  findPreviousChapterAudio,
  restorePreviousAudio,
} from '../audio/previous-audio.js';
import {
  beginRevisionOp,
  commitRevisionOp,
  dismissDriftId,
  parseSelection,
  readRevisions,
  toRevisionsState,
  type ChapterRef,
} from '../workspace/revisions-store.js';
import { isGenerationActive } from './generation.js';

export const revisionOpsRouter = Router();

const NOT_FOUND_MESSAGE = 'This take was replaced by a newer render or is no longer pending.';
const GONE_MESSAGE = 'This take was resolved or replaced while the operation ran.';

revisionOpsRouter.post('/:bookId/revisions/:revisionId/accept', async (req: Request, res: Response) => {
  const { bookId, revisionId } = req.params;
  try {
    const parsed = parseSelection((req.body ?? {}).selection);
    if (!parsed.ok) return res.status(400).json({ error: 'invalid_selection', message: parsed.message });
    const located = await findBookByBookId(bookId);
    if (!located) return res.status(404).json({ error: 'book_not_found', message: 'Book not found.' });
    const { bookDir, state } = located;
    const chapters: ChapterRef[] = state.chapters;

    /* Step 1 — under the lock. */
    const begin = await beginRevisionOp(bookDir, chapters, 'accept', revisionId);
    if (begin.kind === 'already-done') return res.json(toRevisionsState(bookId, begin.file));
    if (begin.kind === 'not-found') {
      return res
        .status(404)
        .json({ error: 'revision_not_found', message: NOT_FOUND_MESSAGE, state: toRevisionsState(bookId, begin.file) });
    }

    /* Step 2 — outside the lock. Refuse to delete the last copy: no live audio
       but a .previous still on disk (a failed restore or a failed finalize
       rename). The recovery is to retry Reject. Read-only pre-check; the audio
       code itself is unchanged. The body's state is a fresh lock-free read. */
    const root = audioDir(bookDir);
    if (!findChapterAudio(root, begin.chapter.slug) && findPreviousChapterAudio(root, begin.chapter.slug)) {
      const current = await readRevisions(bookDir, chapters);
      return res.status(409).json({
        error: 'live_audio_missing',
        message:
          "This chapter's current audio is missing. Reject restores the earlier take; re-rendering the chapter replaces it.",
        state: toRevisionsState(bookId, current),
      });
    }
    await acceptPreviousAudio(root, begin.chapter.slug); // 'deleted' and 'none' both proceed

    /* Step 3 — under the lock. */
    const commit = await commitRevisionOp(bookDir, chapters, 'accept', revisionId, parsed.value);
    if (commit.kind === 'gone') {
      return res
        .status(409)
        .json({ error: 'revision_gone', message: GONE_MESSAGE, state: toRevisionsState(bookId, commit.file) });
    }
    return res.json(toRevisionsState(bookId, commit.file));
  } catch (e) {
    console.error('[revision-ops] accept failed', e);
    /* Plan 285 — the store takes the per-book revisions lock, whose key embeds
       the absolute book path. Same curation as every whole-request site. */
    return res.status(500).json({ error: requestFailureMessage(e, (e as Error).message || 'Failed to accept revision.') });
  }
});

revisionOpsRouter.post('/:bookId/revisions/:revisionId/reject', async (req: Request, res: Response) => {
  const { bookId, revisionId } = req.params;
  try {
    const located = await findBookByBookId(bookId);
    if (!located) return res.status(404).json({ error: 'book_not_found', message: 'Book not found.' });
    const { bookDir, state } = located;
    const chapters: ChapterRef[] = state.chapters;

    const begin = await beginRevisionOp(bookDir, chapters, 'reject', revisionId);
    if (begin.kind === 'already-done') return res.json(toRevisionsState(bookId, begin.file));
    if (begin.kind === 'not-found') {
      return res
        .status(404)
        .json({ error: 'revision_not_found', message: NOT_FOUND_MESSAGE, state: toRevisionsState(bookId, begin.file) });
    }

    /* Step 2 — the same busy check today's restore route makes. */
    if (isGenerationActive(bookId)) {
      return res.status(409).json({
        error: 'chapter_busy',
        message: 'This chapter is busy — try again when it finishes.',
        state: toRevisionsState(bookId, begin.file),
      });
    }
    const root = audioDir(bookDir);
    let outcome: 'restored' | 'none';
    try {
      outcome = await restorePreviousAudio(root, begin.chapter.slug);
    } catch (err) {
      console.error('[revision-ops] reject: restore threw; revisions.json untouched', err);
      return res.status(500).json({ error: 'restore_failed', message: "Couldn't restore the original — try Reject again." });
    }
    if (outcome === 'none') {
      return res.status(409).json({
        error: 'no_previous_audio',
        message: 'Original audio not preserved.',
        state: toRevisionsState(bookId, begin.file),
      });
    }

    const commit = await commitRevisionOp(bookDir, chapters, 'reject', revisionId);
    if (commit.kind === 'gone') {
      console.warn(
        `[revision-ops] reject ${revisionId}: the restored take stands with no timeline record (entry gone before step 3; #3456)`,
      );
      return res
        .status(409)
        .json({ error: 'revision_gone', message: GONE_MESSAGE, state: toRevisionsState(bookId, commit.file) });
    }
    return res.json(toRevisionsState(bookId, commit.file));
  } catch (e) {
    console.error('[revision-ops] reject failed', e);
    return res.status(500).json({ error: requestFailureMessage(e, (e as Error).message || 'Failed to reject revision.') });
  }
});

revisionOpsRouter.post('/:bookId/drift/:driftId/dismiss', async (req: Request, res: Response) => {
  const { bookId, driftId } = req.params;
  try {
    const located = await findBookByBookId(bookId);
    if (!located) return res.status(404).json({ error: 'book_not_found', message: 'Book not found.' });
    const file = await dismissDriftId(located.bookDir, located.state.chapters, driftId);
    return res.json(toRevisionsState(bookId, file));
  } catch (e) {
    console.error('[revision-ops] dismiss failed', e);
    return res.status(500).json({ error: requestFailureMessage(e, (e as Error).message || 'Failed to dismiss drift.') });
  }
});
