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
  changeLogJsonPath,
  manuscriptEditsJsonPath,
  revisionsJsonPath,
  slug,
  stateJsonPath,
} from '../workspace/paths.js';
import { readJson, writeJsonAtomic } from '../workspace/state-io.js';
import { findBookByBookId, type BookStateJson } from '../workspace/scan.js';
import { putManuscript, getManuscript, type ManuscriptRecord } from '../store/manuscripts.js';
import { clearAnalysisCache, loadAnalysisCache } from '../store/analysis-cache.js';
import { parseManuscript } from '../parsers/index.js';

export const bookStateRouter = Router();

bookStateRouter.get('/:bookId/state', async (req: Request, res: Response) => {
  try {
    const located = await findBookByBookId(req.params.bookId);
    if (!located) return res.status(404).json({ error: 'Book not found.' });

    const { bookDir, state } = located;
    const cast      = await readJson<{ characters: unknown[] }>(castJsonPath(bookDir));
    let   edits     = await readJson<{ sentences?: unknown[] }>(manuscriptEditsJsonPath(bookDir));
    const revs      = await readJson<{ pending?: unknown[]; drift?: unknown[]; dismissed?: string[] }>(revisionsJsonPath(bookDir));
    const changeLog = await readJson<{ events?: unknown[] }>(changeLogJsonPath(bookDir));

    /* Fallback for books whose stage 2 ran on older code (or hasn't fully
       finished yet): pull the per-chapter sentences from the analysis cache
       so the manuscript view shows real text instead of mock fixtures.

       When edits and cache BOTH exist, reconcile: keep edits whose sentence
       id still appears in the cache (the user's reassignment / split is
       still valid), and keep edits whose id is greater than the cache's
       max id (likely a user-created split offspring whose id was assigned
       above the analyzer's range — see splitSentence's `maxId + 1` rule).
       Drop edits whose id falls inside the cache-id range but no longer
       exists — those are orphans from a previous chapter shape (post-reparse
       or post-reanalyse) and silently keeping them would resurrect zombie
       sentences in the manuscript view.

       Also derive the per-chapter speaker map so the Generate view's chapter
       rows can seed only the characters that actually appear in each chapter
       — without this the reducer falls back to all-cast and the pill list
       flickers from "filtered" to "everyone" on hydrate. */
    const chapterCharacters: Record<number, string[]> = {};
    if (state.manuscriptId) {
      const cache = await loadAnalysisCache(state.manuscriptId);
      const cachedSentences = Object.values(cache.chapters ?? {}).flat();
      if (edits && Array.isArray(edits.sentences) && edits.sentences.length > 0) {
        if (cachedSentences.length > 0) {
          const cacheIds = new Set<number>();
          let maxCacheId = 0;
          for (const s of cachedSentences) {
            cacheIds.add(s.id);
            if (s.id > maxCacheId) maxCacheId = s.id;
          }
          const filtered = (edits.sentences as Array<{ id?: number }>).filter(s => {
            if (typeof s?.id !== 'number') return true;       // malformed entries pass through; toolchain can deal
            if (cacheIds.has(s.id)) return true;              // still a valid sentence
            return s.id > maxCacheId;                         // likely a split offspring
          });
          edits = { sentences: filtered };
        }
      } else if (cachedSentences.length > 0) {
        edits = { sentences: cachedSentences };
      }
      for (const [chapterId, sentences] of Object.entries(cache.chapters ?? {})) {
        const id = Number(chapterId);
        if (Number.isNaN(id)) continue;
        const ids = new Set<string>();
        for (const sent of sentences) ids.add(sent.characterId);
        chapterCharacters[id] = [...ids];
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
          /* Carry the excluded flag forward so analysis/generation that
             happens after this rehydrate honours the user's choices.
             Body is intentionally empty here — this path is the lightweight
             "page loaded, no analysis run yet" hydrate; the full re-parse
             with bodies happens in store/manuscripts.ts. */
          chapterHints: state.chapters.map(c => ({
            id: c.id, title: c.title, body: '',
            excluded: c.excluded || undefined,
          })),
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

    res.json({
      state,
      cast,
      manuscript,
      manuscriptEdits: edits,
      revisions: revs,
      completedSlugs,
      chapterCharacters,
      changeLog: changeLog?.events ?? null,
    });
  } catch (e) {
    console.error('[book-state] GET failed', e);
    res.status(500).json({ error: (e as Error).message || 'Failed to read book state.' });
  }
});

bookStateRouter.put('/:bookId/state', async (req: Request, res: Response) => {
  try {
    const located = await findBookByBookId(req.params.bookId);
    if (!located) return res.status(404).json({ error: 'Book not found.' });

    const body = req.body as { slice?: 'cast' | 'manuscript' | 'revisions' | 'state' | 'changeLog'; patch?: unknown };
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
      case 'changeLog':
        await writeJsonAtomic(changeLogJsonPath(bookDir), body.patch);
        break;
      case 'state': {
        // Whitelist: only allow updating known editorial fields, not bookId /
        // manuscriptId / paths.
        const patch = body.patch as Partial<BookStateJson>;
        const pickString = (incoming: unknown, fallback: string): string =>
          typeof incoming === 'string' && incoming.trim() ? incoming : fallback;
        const pickNullable = (incoming: unknown, fallback: string | null | undefined): string | null => {
          if (incoming === undefined) return fallback ?? null;
          if (incoming === null) return null;
          if (typeof incoming !== 'string') return fallback ?? null;
          const trimmed = incoming.trim();
          return trimmed ? trimmed : null;
        };
        const next: BookStateJson = {
          ...state,
          castConfirmed: patch.castConfirmed ?? state.castConfirmed,
          chapters: patch.chapters ?? state.chapters,
          title:           pickString(patch.title,  state.title),
          author:          pickString(patch.author, state.author),
          series:          pickString(patch.series, state.series),
          narratorCredit:  pickNullable(patch.narratorCredit,  state.narratorCredit),
          genre:           pickNullable(patch.genre,           state.genre),
          publicationDate: pickNullable(patch.publicationDate, state.publicationDate),
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

/* POST /api/books/:bookId/reparse — re-runs the parser against the on-disk
   manuscript so chapter detection picks up parser-rule updates without
   forcing the user to delete and re-upload. Destructive in the sense that
   it discards any analysis cache, cast, and audio output (chapter slugs
   change when titles change, so old audio files no longer line up). The
   manuscript file itself is untouched.

   Manuscript edits ARE preserved: the sentence ids in manuscript-edits.json
   are reconciled against whatever sentences the next analysis run produces
   (see the GET handler's merge). Edits whose ids survive the fresh analysis
   carry their characterId forward; edits whose ids are dropped fall away
   silently. The reparse logs how many edits were carried forward.

   Frontend confirms with the user before calling. Returns the fresh state
   so the library / open-book flow can re-hydrate without a second round-trip. */
bookStateRouter.post('/:bookId/reparse', async (req: Request, res: Response) => {
  try {
    const located = await findBookByBookId(req.params.bookId);
    if (!located) return res.status(404).json({ error: 'Book not found.' });
    const { bookDir, state } = located;

    const manuscriptPath = join(bookDir, state.manuscriptFile);
    if (!existsSync(manuscriptPath)) {
      return res.status(409).json({ error: `Manuscript file missing on disk: ${state.manuscriptFile}` });
    }

    /* Snapshot the edits file count BEFORE we clear analysis cache so the
       change-log entry below can summarise what's carrying forward. We don't
       touch the edits file itself — the GET-side merge reconciles ids on the
       next book-state read once a fresh analysis populates the cache. */
    const existingEdits = await readJson<{ sentences?: unknown[] }>(manuscriptEditsJsonPath(bookDir));
    const preservedEditCount = Array.isArray(existingEdits?.sentences) ? existingEdits!.sentences!.length : 0;

    /* Read the original file as a Buffer so the parser dispatcher can route
       binary formats (PDF, EPUB) the same way the upload route does. The
       text parsers will utf8-decode internally when format calls for it.
       Also pass sourcePath so the EPUB parser can read directly from the
       workspace location — bypasses the %TEMP%-roundtrip that races
       against AV/OneDrive on Windows ("Invalid/missing file" errors).

       Legacy fallback: pre-fix versions of the import route wrote the
       extracted *sourceText* to manuscript.epub instead of the original
       binary. Detect that here by sniffing the magic bytes and route to
       parseText when the file is actually plain UTF-8 text — avoids
       crashing those books and still gives the user a fresh chapter
       split from the persisted text. */
    const buffer = await readFile(manuscriptPath);
    const looksLikeEpub = buffer.length >= 4 && buffer[0] === 0x50 && buffer[1] === 0x4b && buffer[2] === 0x03 && buffer[3] === 0x04;
    const looksLikePdf  = buffer.length >= 5 && buffer.slice(0, 5).toString('ascii') === '%PDF-';
    const claimsBinary  = state.manuscriptFile.endsWith('.epub') || state.manuscriptFile.endsWith('.pdf');
    const isLegacyTextMasqueradingAsBinary = claimsBinary && !looksLikeEpub && !looksLikePdf;
    let parsed;
    if (isLegacyTextMasqueradingAsBinary) {
      console.warn(`[book-state] reparse: ${state.manuscriptFile} is plain text on disk (pre-fix import). Routing through parseText.`);
      parsed = await parseManuscript({
        text: buffer.toString('utf8'),
        fileName: state.manuscriptFile.replace(/\.(epub|pdf)$/, '.txt'),
      });
    } else {
      parsed = await parseManuscript({
        buffer,
        fileName: state.manuscriptFile,
        sourcePath: manuscriptPath,
      });
    }

    /* Replace the chapter list with whatever the parser produced. Slugs are
       regenerated from the new titles so the audio dir layout stays in
       lockstep. Old audio files (if any) become orphaned and get removed
       below — keeping them would mislead the library into reporting wrong
       completed counts.

       Preserve the user's per-chapter excluded flag across re-parse.
       Re-parsing the same manuscript usually produces the same id-to-
       chapter mapping (the parser is deterministic), so id-match is
       the primary key. Slug-match acts as a tie-breaker when the
       parser changed numbering (e.g. a heading rule update merged two
       sections) but the new side still has a chapter whose title-derived
       slug matches an old excluded one. New chapters default to included. */
    const prevExcludedIds = new Set<number>(
      state.chapters.filter(c => c.excluded).map(c => c.id),
    );
    const prevExcludedSlugs = new Set<string>(
      state.chapters.filter(c => c.excluded).map(c => c.slug),
    );
    const newChapters: BookStateJson['chapters'] = parsed.chapters.map(c => {
      const newSlug = `${String(c.id).padStart(2, '0')}-${slug(c.title)}`;
      const carryover = prevExcludedIds.has(c.id) || prevExcludedSlugs.has(newSlug);
      return {
        id: c.id,
        title: c.title,
        slug: newSlug,
        duration: '00:00',
        excluded: carryover ? true : undefined,
      };
    });

    const nextState: BookStateJson = {
      ...state,
      chapters: newChapters,
      castConfirmed: false,    // cast keys to chapters; force re-confirm.
      updatedAt: new Date().toISOString(),
    };
    await writeJsonAtomic(stateJsonPath(bookDir), nextState);

    /* Wipe the analysis cache and any per-book state that's now stale.
       Audio dir is removed wholesale; cast.json + revisions.json are deleted
       so the cast view re-runs voice matching against the fresh chapter list
       and stale drift events don't survive a reshuffle. manuscript-edits.json
       is intentionally kept — its sentence ids are filtered against the next
       analysis cache on GET, so surviving edits carry their characterId to
       the new sentence list and the rest fall away. */
    await clearAnalysisCache(state.manuscriptId);
    for (const p of [castJsonPath(bookDir), revisionsJsonPath(bookDir)]) {
      if (existsSync(p)) await rm(p, { force: true });
    }
    const ad = audioDir(bookDir);
    if (existsSync(ad)) await rm(ad, { recursive: true, force: true });

    /* Append a change-log entry summarising what carried forward. The note
       reads naturally in the Activity view; entries with no edits to preserve
       are skipped so a vanilla reparse on a fresh book doesn't clutter the
       log. */
    if (preservedEditCount > 0) {
      const logPath = changeLogJsonPath(bookDir);
      const existingLog = await readJson<{ events?: Array<{ id?: number }> }>(logPath);
      const prior = Array.isArray(existingLog?.events) ? existingLog!.events! : [];
      const nextId = prior.reduce((m, e) => Math.max(m, e?.id ?? 0), 0) + 1;
      const noun = preservedEditCount === 1 ? 'edit' : 'edits';
      const newEntry = {
        id: nextId,
        at: new Date().toISOString(),
        ts: 'Just now',
        date: 'today',
        type: 'reparse',
        title: 'Re-parsed manuscript',
        note: `Preserved ${preservedEditCount} manuscript ${noun}; ids will be reconciled against the next analysis run.`,
        actor: 'system',
      };
      await writeJsonAtomic(logPath, { events: [newEntry, ...prior] });
    }

    /* Refresh the in-memory ManuscriptRecord so a follow-up analysis run
       sees the new chapter bodies, not the cached pre-reparse copy.
       Carry the (preserved) excluded flag from the new state so the
       analysis route's skip path fires correctly without a separate
       hydrate. */
    const newExcludedById = new Map<number, boolean>();
    for (const c of newChapters) {
      if (c.excluded) newExcludedById.set(c.id, true);
    }
    const sourceText = parsed.sourceText;
    const record: ManuscriptRecord = {
      manuscriptId: state.manuscriptId,
      format: parsed.format,
      title: state.title,
      wordCount: sourceText.trim().split(/\s+/).filter(Boolean).length,
      byteSize: Buffer.byteLength(sourceText, 'utf8'),
      uploadedAt: state.createdAt,
      sourceText,
      chapterHints: parsed.chapters.map(c => ({
        ...c,
        excluded: newExcludedById.get(c.id) || undefined,
      })),
      bookId: state.bookId,
      bookDir,
    };
    putManuscript(record);

    /* Per-chapter wordCount lets the re-parse dialog auto-suggest
       front/back-matter exclusion against the *new* chapter list —
       the parser may have re-split sections in ways that flip what's
       short or what's recognised by title. parsed.chapters carries
       the body verbatim from the parser; word count is cheap. */
    const wordCountByChapterId = new Map<number, number>();
    for (const c of parsed.chapters) {
      const body = (c.body ?? '').trim();
      wordCountByChapterId.set(c.id, body ? body.split(/\s+/).filter(Boolean).length : 0);
    }

    res.json({
      state: nextState,
      chapterCount: newChapters.length,
      chapterTitles: newChapters.map(c => c.title),
      /* Rich chapter records so the re-parse dialog can render
         checkboxes (preserved excluded + auto-suggest by wordCount)
         identical to the confirm-stage form. */
      chapters: newChapters.map(c => ({
        id: c.id,
        title: c.title,
        slug: c.slug,
        wordCount: wordCountByChapterId.get(c.id) ?? 0,
        excluded: !!c.excluded,
      })),
    });
  } catch (e) {
    console.error('[book-state] reparse failed', e);
    res.status(500).json({ error: (e as Error).message || 'Failed to re-parse manuscript.' });
  }
});

/* POST /api/books/:bookId/chapters/:chapterId/exclude — toggle the
   excluded flag on a single chapter. Used by the Generate-view toggle
   so the user can opt out of (or back into) narrating front/back-matter
   without re-running anything.

   Side effects:
   - Updates state.json atomically.
   - Propagates the flag into the in-memory ManuscriptRecord so the
     next analysis / generation request honours it without a hydrate
     round-trip.
   - When excluded becomes true: deletes the chapter's audio file +
     segments.json so the library card's completed-chapters count
     reconciles immediately and a future un-exclude can re-synthesize
     cleanly.

   Idempotent — calling with the same value twice is a no-op (still
   returns 200 with the current chapter entry). */
bookStateRouter.post('/:bookId/chapters/:chapterId/exclude', async (req: Request, res: Response) => {
  try {
    const chapterId = Number(req.params.chapterId);
    if (!Number.isInteger(chapterId)) {
      return res.status(400).json({ error: 'chapterId must be an integer.' });
    }
    const rawExcluded = (req.body as { excluded?: unknown })?.excluded;
    if (typeof rawExcluded !== 'boolean') {
      return res.status(400).json({ error: '`excluded` is required and must be a boolean.' });
    }
    const excluded: boolean = rawExcluded;

    const located = await findBookByBookId(req.params.bookId);
    if (!located) return res.status(404).json({ error: 'Book not found.' });
    const { bookDir, state } = located;

    const idx = state.chapters.findIndex(c => c.id === chapterId);
    if (idx === -1) return res.status(404).json({ error: 'Chapter not found.' });

    const current = state.chapters[idx];
    const updated = { ...current, excluded: excluded ? true : undefined };
    const nextChapters = state.chapters.map((c, i) => (i === idx ? updated : c));

    /* Write state.json first so a crash mid-call leaves the user's
       choice on disk; audio cleanup is best-effort below. */
    const nextState: BookStateJson = {
      ...state,
      chapters: nextChapters,
      updatedAt: new Date().toISOString(),
    };
    await writeJsonAtomic(stateJsonPath(bookDir), nextState);

    /* Propagate to the live ManuscriptRecord if it's loaded. The
       analysis route reads chapterHints directly from this; without
       the propagation we'd have to wait for a server restart or a
       book-state GET to pick up the change. */
    if (state.manuscriptId) {
      const rec = getManuscript(state.manuscriptId);
      if (rec) {
        rec.chapterHints = rec.chapterHints.map(h =>
          h.id === chapterId ? { ...h, excluded: excluded ? true : undefined } : h,
        );
      }
    }

    /* When newly excluded, delete the chapter's audio + segments so the
       library / chapter list don't keep counting it as "done". The user
       can re-include later; audio regenerates from the (still-cached)
       sentence attribution. */
    if (excluded) {
      const audioRoot = audioDir(bookDir);
      const segmentsPath = join(audioRoot, `${current.slug}.segments.json`);
      const audioCandidates = ['mp3', 'm4a', 'wav', 'opus'].map(ext => join(audioRoot, `${current.slug}.${ext}`));
      for (const p of [segmentsPath, ...audioCandidates]) {
        if (existsSync(p)) {
          await rm(p, { force: true }).catch(() => { /* best effort */ });
        }
      }
    }

    res.json({
      id: updated.id,
      title: updated.title,
      slug: updated.slug,
      excluded: !!updated.excluded,
    });
  } catch (e) {
    console.error('[book-state] exclude toggle failed', e);
    res.status(500).json({ error: (e as Error).message || 'Failed to toggle exclude.' });
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
