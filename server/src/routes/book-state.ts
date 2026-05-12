/* GET / PUT /api/books/:bookId/state

   GET returns a composite of all .audiobook/*.json files for a book, plus the
   manuscript sourceText so the analysis pipeline can re-run if the user
   re-opens a book whose in-memory ManuscriptRecord has been lost (server
   restart).

   PUT accepts `{ slice: 'cast'|'manuscript'|'revisions'|'state', patch }` and
   atomically writes the matching JSON file. Used by the persistence
   middleware in Phase 5. */

import { Router, type Request, type Response } from 'express';
import { readFile, readdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  audioDir,
  castJsonPath,
  manuscriptEditsJsonPath,
  revisionsJsonPath,
  stateJsonPath,
} from '../workspace/paths.js';
import { readJson, writeJsonAtomic } from '../workspace/state-io.js';
import { findBookByBookId, type BookStateJson } from '../workspace/scan.js';
import { putManuscript, getManuscript, type ManuscriptRecord } from '../store/manuscripts.js';
import { clearAnalysisCache, loadAnalysisCache } from '../store/analysis-cache.js';

export const bookStateRouter = Router();

bookStateRouter.get('/:bookId/state', async (req: Request, res: Response) => {
  try {
    const located = await findBookByBookId(req.params.bookId);
    if (!located) return res.status(404).json({ error: 'Book not found.' });

    const { bookDir, state } = located;
    const cast    = await readJson<{ characters: unknown[] }>(castJsonPath(bookDir));
    let   edits   = await readJson<{ sentences?: unknown[] }>(manuscriptEditsJsonPath(bookDir));
    const revs    = await readJson<{ pending?: unknown[]; drift?: unknown[] }>(revisionsJsonPath(bookDir));

    /* Fallback for books whose stage 2 ran on older code (or hasn't fully
       finished yet): pull the per-chapter sentences from the analysis cache
       so the manuscript view shows real text instead of mock fixtures. */
    if ((!edits || !edits.sentences?.length) && state.manuscriptId) {
      const cache = await loadAnalysisCache(state.manuscriptId);
      const cachedSentences = Object.values(cache.chapters ?? {}).flat();
      if (cachedSentences.length > 0) {
        edits = { sentences: cachedSentences };
      }
    }

    // Derive which chapters have audio output on disk so the generation view
    // can render true progress on re-open. Matches chapters by slug.
    let completedSlugs: string[] = [];
    try {
      const files = existsSync(audioDir(bookDir)) ? await readdir(audioDir(bookDir)) : [];
      const audioFiles = files.filter(f => /\.(mp3|m4a|wav|opus)$/i.test(f));
      completedSlugs = state.chapters
        .filter(c => audioFiles.some(f => f.startsWith(c.slug)))
        .map(c => c.slug);
    } catch { /* fall through with empty list */ }

    // Rehydrate the in-memory ManuscriptRecord if missing (after a server
    // restart). Lets the analysis route re-run end-to-end without forcing the
    // user to re-import their book.
    if (!getManuscript(state.manuscriptId)) {
      const manuscriptPath = join(bookDir, state.manuscriptFile);
      if (existsSync(manuscriptPath)) {
        const sourceText = await readFile(manuscriptPath, 'utf8');
        const record: ManuscriptRecord = {
          manuscriptId: state.manuscriptId,
          format: extToFormat(state.manuscriptFile),
          title: state.title,
          wordCount: sourceText.trim().split(/\s+/).filter(Boolean).length,
          byteSize: Buffer.byteLength(sourceText, 'utf8'),
          uploadedAt: state.createdAt,
          sourceText,
          chapterHints: state.chapters.map(c => ({ id: c.id, title: c.title, body: '' })),
          bookId: state.bookId,
          bookDir,
        };
        putManuscript(record);
      }
    }

    /* Surface lightweight manuscript metadata (wordCount, format) so the
       frontend can render size-aware copy on the Analysing screen without
       fetching the full sourceText. */
    const rec = getManuscript(state.manuscriptId);
    const manuscript = rec
      ? { wordCount: rec.wordCount, format: rec.format }
      : null;

    res.json({ state, cast, manuscript, manuscriptEdits: edits, revisions: revs, completedSlugs });
  } catch (e) {
    console.error('[book-state] GET failed', e);
    res.status(500).json({ error: (e as Error).message || 'Failed to read book state.' });
  }
});

bookStateRouter.put('/:bookId/state', async (req: Request, res: Response) => {
  try {
    const located = await findBookByBookId(req.params.bookId);
    if (!located) return res.status(404).json({ error: 'Book not found.' });

    const body = req.body as { slice?: 'cast' | 'manuscript' | 'revisions' | 'state'; patch?: unknown };
    if (!body?.slice || body.patch === undefined) {
      return res.status(400).json({ error: 'slice and patch are required.' });
    }

    const { bookDir, state } = located;
    switch (body.slice) {
      case 'cast':
        await writeJsonAtomic(castJsonPath(bookDir), body.patch);
        break;
      case 'manuscript':
        await writeJsonAtomic(manuscriptEditsJsonPath(bookDir), body.patch);
        break;
      case 'revisions':
        await writeJsonAtomic(revisionsJsonPath(bookDir), body.patch);
        break;
      case 'state': {
        // Whitelist: only allow updating known editorial fields, not bookId /
        // manuscriptId / paths.
        const patch = body.patch as Partial<BookStateJson>;
        const next: BookStateJson = {
          ...state,
          castConfirmed: patch.castConfirmed ?? state.castConfirmed,
          chapters: patch.chapters ?? state.chapters,
          updatedAt: new Date().toISOString(),
        };
        await writeJsonAtomic(stateJsonPath(bookDir), next);
        break;
      }
      default:
        return res.status(400).json({ error: `Unknown slice: ${body.slice}` });
    }

    res.status(204).end();
  } catch (e) {
    console.error('[book-state] PUT failed', e);
    res.status(500).json({ error: (e as Error).message || 'Failed to write book state.' });
  }
});

/* DELETE /api/books/:bookId — removes the book directory (Author/Series/Title/)
   and its analysis cache. Destructive; the frontend confirms with the user
   before calling. Idempotent: 204 even if the book isn't found, so a
   refresh-then-delete doesn't surface a noisy error. */
bookStateRouter.delete('/:bookId', async (req: Request, res: Response) => {
  try {
    const located = await findBookByBookId(req.params.bookId);
    if (!located) {
      res.status(204).end();
      return;
    }
    const { bookDir, state } = located;
    await rm(bookDir, { recursive: true, force: true });
    if (state?.manuscriptId) {
      await clearAnalysisCache(state.manuscriptId);
    }
    res.status(204).end();
  } catch (e) {
    console.error('[book-state] DELETE failed', e);
    res.status(500).json({ error: (e as Error).message || 'Failed to delete book.' });
  }
});

function extToFormat(manuscriptFile: string): ManuscriptRecord['format'] {
  const m = manuscriptFile.toLowerCase().match(/\.([a-z0-9]+)$/);
  if (!m) return 'plaintext';
  if (m[1] === 'epub') return 'epub';
  if (m[1] === 'pdf') return 'pdf';
  if (m[1] === 'md' || m[1] === 'markdown') return 'markdown';
  return 'plaintext';
}
