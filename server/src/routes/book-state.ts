/* GET / PUT /api/books/:bookId/state

   GET returns a composite of all .audiobook/*.json files for a book, plus the
   manuscript sourceText so the analysis pipeline can re-run if the user
   re-opens a book whose in-memory ManuscriptRecord has been lost (server
   restart).

   PUT accepts `{ slice: 'cast'|'manuscript'|'revisions'|'state', patch }` and
   atomically writes the matching JSON file. Used by the persistence
   middleware in Phase 5. */

import { Router, type Request, type Response } from 'express';
import { mkdir, readFile, readdir, rm, rmdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  STANDALONES_SERIES,
  audioDir,
  bookDirByDisplay,
  castJsonPath,
  changeLogJsonPath,
  listenProgressJsonPath,
  manuscriptEditsJsonPath,
  revisionsJsonPath,
  slug,
  stateJsonPath,
} from '../workspace/paths.js';
import { readJson, writeJsonAtomic } from '../workspace/state-io.js';
import { renameWithRetry } from '../workspace/atomic-rename.js';
import { findBookByBookId, type BookStateJson } from '../workspace/scan.js';
import { writeStateJsonAtomic } from '../workspace/state-migrate.js';
import {
  putManuscript,
  getManuscript,
  getOrHydrateManuscript,
  type ManuscriptRecord,
} from '../store/manuscripts.js';
import { clearAnalysisCache, loadAnalysisCache } from '../store/analysis-cache.js';
import { readAnalysisState, type AnalysisStateFile } from '../store/analysis-state.js';
import { loadDroppedQuotes } from '../store/dropped-quotes.js';
import { parseManuscript } from '../parsers/index.js';
import { CHAPTER_TITLE_PARSER_VERSION } from '../parsers/version.js';
import { snapshotInFlightAnalysis } from './analysis.js';

export const bookStateRouter = Router();

/* Non-destructive title-only refresh. Invoked transparently from the
   book-state GET so users open a book and see real chapter names
   instead of "Chapter 1", "Chapter 2", … even when the book was
   imported before the parsers learned to extract names.

   Preserves everything except chapter titles: slug (audio file
   addressing stays valid), excluded flag, audio dir, cast.json,
   revisions.json, analysis cache, manuscript-edits.json. Bumps
   `state.chapterTitleParserVersion` so the next read short-circuits.

   Skips refresh (returns state unchanged) when ANY of:
   - State is already at the current parser version.
   - Source manuscript file missing on disk.
   - parseManuscript throws (corrupt file, etc.).
   - New chapter count differs from the existing count — splitting logic
     itself changed; aligning titles by index would silently mislabel
     chapters. Leave the version field as-is so a future fix can retry. */
async function refreshChapterTitles(state: BookStateJson, bookDir: string): Promise<BookStateJson> {
  const currentVersion = state.chapterTitleParserVersion ?? 1;
  if (currentVersion >= CHAPTER_TITLE_PARSER_VERSION) return state;

  const manuscriptPath = join(bookDir, state.manuscriptFile);
  if (!existsSync(manuscriptPath)) return state;

  try {
    /* Same legacy text-as-binary detection as the destructive reparse
       path (see PUT /:bookId/reparse). Pre-fix imports wrote raw text
       into .epub/.pdf, so route those through the text parser
       instead of crashing parseEpub on a non-zip file. */
    const buffer = await readFile(manuscriptPath);
    const looksLikeEpub =
      buffer.length >= 4 &&
      buffer[0] === 0x50 &&
      buffer[1] === 0x4b &&
      buffer[2] === 0x03 &&
      buffer[3] === 0x04;
    const looksLikePdf = buffer.length >= 5 && buffer.slice(0, 5).toString('ascii') === '%PDF-';
    const claimsBinary =
      state.manuscriptFile.endsWith('.epub') || state.manuscriptFile.endsWith('.pdf');
    const isLegacyTextMasqueradingAsBinary = claimsBinary && !looksLikeEpub && !looksLikePdf;
    const parsed = isLegacyTextMasqueradingAsBinary
      ? await parseManuscript({
          text: buffer.toString('utf8'),
          fileName: state.manuscriptFile.replace(/\.(epub|pdf)$/, '.txt'),
        })
      : await parseManuscript({
          buffer,
          fileName: state.manuscriptFile,
          sourcePath: manuscriptPath,
        });

    if (parsed.chapters.length !== state.chapters.length) {
      console.warn(
        `[book-state] title-refresh skipped for ${state.bookId}: parsed ${parsed.chapters.length} chapters, state has ${state.chapters.length}. Chapter split logic changed — won't risk misalignment.`,
      );
      return state;
    }

    /* Replace titles in order; everything else (slug, excluded, audio
       state) stays put. Skip the write when nothing actually changed
       to avoid touching mtime / triggering watchers. */
    const newChapters = state.chapters.map((c, i) => ({ ...c, title: parsed.chapters[i].title }));
    const titlesChanged = newChapters.some((c, i) => c.title !== state.chapters[i].title);
    const nextState: BookStateJson = {
      ...state,
      chapters: newChapters,
      chapterTitleParserVersion: CHAPTER_TITLE_PARSER_VERSION,
      updatedAt: titlesChanged ? new Date().toISOString() : state.updatedAt,
    };
    await writeStateJsonAtomic(stateJsonPath(bookDir), nextState);
    return nextState;
  } catch (err) {
    console.warn(`[book-state] title-refresh failed for ${state.bookId}:`, (err as Error).message);
    return state;
  }
}

bookStateRouter.get('/:bookId/state', async (req: Request, res: Response) => {
  try {
    const located = await findBookByBookId(req.params.bookId);
    if (!located) return res.status(404).json({ error: 'Book not found.' });

    const { bookDir } = located;
    const state = await refreshChapterTitles(located.state, bookDir);
    const cast = await readJson<{ characters: unknown[] }>(castJsonPath(bookDir));
    let edits = await readJson<{ sentences?: unknown[] }>(manuscriptEditsJsonPath(bookDir));
    const revs = await readJson<{
      pending?: unknown[];
      drift?: unknown[];
      dismissed?: string[];
      acceptedSelections?: Record<string, Record<number, 'A' | 'B'>>;
      /* Plan 55 — per-chapter timeline. Persisted by the frontend; surfaced
         on getBookState so the Revision History view can hydrate without an
         extra round-trip. */
      timeline?: Record<string, unknown[]>;
    }>(revisionsJsonPath(bookDir));
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
    /* Chapters whose Phase 0a cast detection failed across the analyzer's
       built-in retry. Surfaced so the analysing view can render a
       per-chapter Retry button that survives reload — without this, the
       failed-id set lives only on the in-flight SSE and is lost the
       moment the user navigates away. Sourced from the analysis cache,
       populated in analysis.ts:913 (full route) and the subset route. */
    let failedChapterIds: number[] = [];
    if (state.manuscriptId) {
      const cache = await loadAnalysisCache(state.manuscriptId);
      failedChapterIds = cache.failedChapterIds ?? [];
      const cachedSentences = Object.values(cache.chapters ?? {}).flat();
      if (edits && Array.isArray(edits.sentences) && edits.sentences.length > 0) {
        if (cachedSentences.length > 0) {
          const cacheIds = new Set<number>();
          let maxCacheId = 0;
          for (const s of cachedSentences) {
            cacheIds.add(s.id);
            if (s.id > maxCacheId) maxCacheId = s.id;
          }
          const filtered = (edits.sentences as Array<{ id?: number }>).filter((s) => {
            if (typeof s?.id !== 'number') return true; // malformed entries pass through; toolchain can deal
            if (cacheIds.has(s.id)) return true; // still a valid sentence
            return s.id > maxCacheId; // likely a split offspring
          });
          edits = { sentences: filtered };
        }
      } else if (cachedSentences.length > 0) {
        edits = { sentences: cachedSentences };
      }
      /* Prefer the post-fold sentence list (manuscript-edits.json, or the
         cache-seeded fallback above) because the analysis cache intentionally
         retains pre-fold descriptor ids ("the-jogger", "drooly-boy"). Those
         ids never reach the synth pipeline — `foldMinorCast` rewrote them to
         `unknown-male` / `unknown-female` before manuscript-edits.json was
         written. Seeding the Generate-view chapter rows from the raw cache
         would render phantom Queued pills for the descriptor ids, which the
         synth job never advances. Fall back to the cache only when no edits
         are available at all (analysis hasn't completed). */
      const editsForSpeakers = (edits?.sentences ?? []) as Array<{
        chapterId?: unknown;
        characterId?: unknown;
      }>;
      if (editsForSpeakers.length > 0) {
        const bucketByChapter = new Map<number, Set<string>>();
        for (const sent of editsForSpeakers) {
          if (typeof sent?.chapterId !== 'number') continue;
          if (typeof sent?.characterId !== 'string') continue;
          let bucket = bucketByChapter.get(sent.chapterId);
          if (!bucket) {
            bucket = new Set();
            bucketByChapter.set(sent.chapterId, bucket);
          }
          bucket.add(sent.characterId);
        }
        for (const [id, ids] of bucketByChapter) chapterCharacters[id] = [...ids];
      } else {
        for (const [chapterId, sentences] of Object.entries(cache.chapters ?? {})) {
          const id = Number(chapterId);
          if (Number.isNaN(id)) continue;
          const ids = new Set<string>();
          for (const sent of sentences) ids.add(sent.characterId);
          chapterCharacters[id] = [...ids];
        }
      }
    }

    // Derive which chapters have audio output on disk so the generation view
    // can render true progress on re-open. Matches chapters by slug.
    let completedSlugs: string[] = [];
    try {
      const files = existsSync(audioDir(bookDir)) ? await readdir(audioDir(bookDir)) : [];
      const audioFiles = files.filter((f) => /\.(mp3|m4a|opus)$/i.test(f));
      completedSlugs = state.chapters
        .filter((c) => audioFiles.some((f) => f.startsWith(c.slug)))
        .map((c) => c.slug);
    } catch {
      /* fall through with empty list */
    }

    /* Rehydrate the in-memory ManuscriptRecord if missing (after a server
       restart). Must parse the manuscript fully — a previous version read
       the file as utf-8 bytes with empty chapter bodies, which for EPUB
       meant the binary ZIP archive ended up in sourceText and the analyzer
       was handed empty chapters. Symptom: wordCount displayed orders of
       magnitude too low and Phase 0a logged "0 chars" per chapter. The
       analyzer route also calls getOrHydrateManuscript, but it short-
       circuits on whatever is already in the store, so the poisoned record
       persisted through the analysis run. */
    const rec = await getOrHydrateManuscript(state.manuscriptId);
    const manuscript = rec ? { wordCount: rec.wordCount, format: rec.format } : null;

    res.json({
      state,
      cast,
      manuscript,
      manuscriptEdits: edits,
      revisions: revs,
      completedSlugs,
      chapterCharacters,
      changeLog: changeLog?.events ?? null,
      analysis: { failedChapterIds },
    });
  } catch (e) {
    console.error('[book-state] GET failed', e);
    res.status(500).json({ error: (e as Error).message || 'Failed to read book state.' });
  }
});

/* GET /api/books/:bookId/dropped-quotes
   Returns the full dropped-quotes ledger (every batch ever recorded for
   this book) so the analysing view can render the read-only audit
   panel and PowerShell scripts can grep the file directly during
   qwen3.5:4b reliability tuning. The envelope is append-only — see
   server/src/store/dropped-quotes.ts for the shape. Empty envelope
   when the file doesn't exist yet (book just uploaded, or all runs
   had zero drops). */
/* GET /api/books/:bookId/analysis/state
   Cold-boot rehydration for the top-bar AnalysisPill across browser
   reload + server restart. The sticky-analysis in-flight map and the
   client-side `analysis.activeStream` snapshot both evaporate on
   their respective restart — this endpoint re-seeds the pill from
   the live in-flight job (when the server is still alive) or from
   the per-book `analysis-state.json` snapshot (when it isn't).

   Resolution order:
   1. Look up manuscriptId from the book's state.json.
   2. If a live, non-aborted in-flight job exists, return its current
      phase + running state (memory wins over disk because it has
      the freshest progress).
   3. Else read .audiobook/analysis-state.json. Coerce `running` on
      disk → `paused` in the response because no live job means the
      analyzer didn't survive the restart — the user must click
      Resume to re-attach.
   4. Else 404 (no rehydratable state).

   See docs/features/32-sticky-analysis.md "Cold-boot rehydration"
   for the full invariant set. */
bookStateRouter.get('/:bookId/analysis/state', async (req: Request, res: Response) => {
  try {
    const located = await findBookByBookId(req.params.bookId);
    if (!located) return res.status(404).json({ error: 'Book not found.' });

    const { bookDir, state } = located;
    const manuscriptId = state.manuscriptId;
    if (!manuscriptId) {
      return res.status(404).json({ error: 'No analysis state.' });
    }

    /* Memory-first: live in-flight job is freshest. snapshotInFlightAnalysis
       returns null when no job exists or the controller is aborted. */
    const live = snapshotInFlightAnalysis(manuscriptId);
    if (live) return res.json(live);

    /* Disk-fallback. Coerce `running` → `paused` because no live job
       means the analyzer didn't survive whatever wiped the in-memory
       map (server restart, crash, kill). */
    const onDisk = await readAnalysisState(bookDir);
    if (onDisk) {
      const coerced: AnalysisStateFile =
        onDisk.state === 'running' ? { ...onDisk, state: 'paused' } : onDisk;
      return res.json(coerced);
    }

    return res.status(404).json({ error: 'No analysis state.' });
  } catch (e) {
    console.error('[book-state] analysis/state GET failed', e);
    res.status(500).json({ error: (e as Error).message || 'Failed to read analysis state.' });
  }
});

bookStateRouter.get('/:bookId/dropped-quotes', async (req: Request, res: Response) => {
  try {
    const located = await findBookByBookId(req.params.bookId);
    if (!located) return res.status(404).json({ error: 'Book not found.' });
    const file = await loadDroppedQuotes(located.bookDir, located.state.manuscriptId ?? '');
    res.json(file);
  } catch (e) {
    console.error('[book-state] dropped-quotes GET failed', e);
    res.status(500).json({ error: (e as Error).message || 'Failed to read dropped-quotes.' });
  }
});

bookStateRouter.put('/:bookId/state', async (req: Request, res: Response) => {
  try {
    const located = await findBookByBookId(req.params.bookId);
    if (!located) return res.status(404).json({ error: 'Book not found.' });

    const body = req.body as {
      slice?: 'cast' | 'manuscript' | 'revisions' | 'state' | 'changeLog';
      patch?: unknown;
    };
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
        const pickNullable = (
          incoming: unknown,
          fallback: string | null | undefined,
        ): string | null => {
          if (incoming === undefined) return fallback ?? null;
          if (incoming === null) return null;
          if (typeof incoming !== 'string') return fallback ?? null;
          const trimmed = incoming.trim();
          return trimmed ? trimmed : null;
        };
        const pickSeriesPosition = (incoming: unknown, fallback: number | null): number | null => {
          if (incoming === undefined) return fallback;
          if (incoming === null) return null;
          /* Empty string from a cleared number input — treat as null. */
          if (typeof incoming === 'string' && incoming.trim() === '') return null;
          const n = typeof incoming === 'number' ? incoming : Number(incoming);
          if (!Number.isFinite(n)) return fallback;
          return Math.trunc(n);
        };
        const pickStandalone = (incoming: unknown, fallback: boolean): boolean => {
          if (typeof incoming === 'boolean') return incoming;
          return fallback;
        };

        /* When the book is flipped to standalone, the on-disk series folder
           must be the literal 'Standalones' (see workspace/paths.ts) and
           seriesPosition is meaningless. We do NOT overwrite state.series —
           the user-typed label is preserved in state.json so a future
           "un-standalone" doesn't lose the series name they had. */
        const nextIsStandalone = pickStandalone(patch.isStandalone, state.isStandalone);
        const next: BookStateJson = {
          ...state,
          castConfirmed: patch.castConfirmed ?? state.castConfirmed,
          chapters: patch.chapters ?? state.chapters,
          title: pickString(patch.title, state.title),
          author: pickString(patch.author, state.author),
          series: pickString(patch.series, state.series),
          seriesPosition: nextIsStandalone
            ? null
            : pickSeriesPosition(patch.seriesPosition, state.seriesPosition),
          isStandalone: nextIsStandalone,
          narratorCredit: pickNullable(patch.narratorCredit, state.narratorCredit),
          genre: pickNullable(patch.genre, state.genre),
          publicationDate: pickNullable(patch.publicationDate, state.publicationDate),
          description: pickNullable(patch.description, state.description),
          updatedAt: new Date().toISOString(),
        };

        /* On-disk folder layout follows the displayed metadata: Author/Series/
           Title. When any of those changes (or isStandalone flips), move the
           folder before writing state.json so the new state lands at its new
           path atomically. The bookId itself is unchanged — it's persisted
           inside state.json and findBookByBookId resolves it regardless of
           where the folder sits. */
        const folderSeries = nextIsStandalone ? STANDALONES_SERIES : next.series;
        const newDir = bookDirByDisplay(next.author, folderSeries, next.title);
        if (newDir !== bookDir) {
          if (existsSync(newDir)) {
            return res.status(409).json({
              error:
                'A book already exists at that Author/Series/Title path. Pick a different title or series.',
            });
          }
          /* Make sure the new parent (and grandparent) directories exist
             before the rename — fs.rename on Windows fails with ENOENT if
             they don't. */
          await mkdir(dirname(newDir), { recursive: true });
          /* renameWithRetry handles OneDrive's EPERM/EBUSY/ENOENT windows
             (atomic-rename.ts). Any other failure surfaces immediately. */
          await renameWithRetry(bookDir, newDir);
          /* Refresh the in-memory ManuscriptRecord so subsequent analysis /
             generation requests find the manuscript file at the new path.
             Direct mutation is safe — the store holds the record by
             reference. */
          if (state.manuscriptId) {
            const rec = getManuscript(state.manuscriptId);
            if (rec) {
              rec.bookDir = newDir;
              putManuscript(rec);
            }
          }
          /* Write the new state.json to the post-rename location BEFORE
             trying to clean up empty parents — writeJsonAtomic creates the
             tmp file then renames into place, and we want the destination
             stable on disk before we start removing sibling parent dirs.
             Empty-parent cleanup is best-effort: rmdir refuses on non-
             empty directories so it naturally leaves siblings alone, and
             errors are swallowed (orphan empty dirs are cosmetic, not a
             correctness problem). */
          await writeStateJsonAtomic(stateJsonPath(newDir), next);
          const oldSeriesDir = dirname(bookDir);
          const oldAuthorDir = dirname(oldSeriesDir);
          await rmdir(oldSeriesDir).catch(() => {
            /* not empty or locked → leave it */
          });
          await rmdir(oldAuthorDir).catch(() => {
            /* not empty or locked → leave it */
          });
        } else {
          await writeStateJsonAtomic(stateJsonPath(bookDir), next);
        }
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
      return res
        .status(409)
        .json({ error: `Manuscript file missing on disk: ${state.manuscriptFile}` });
    }

    /* Snapshot the edits file count BEFORE we clear analysis cache so the
       change-log entry below can summarise what's carrying forward. We don't
       touch the edits file itself — the GET-side merge reconciles ids on the
       next book-state read once a fresh analysis populates the cache. */
    const existingEdits = await readJson<{ sentences?: unknown[] }>(
      manuscriptEditsJsonPath(bookDir),
    );
    const preservedEditCount = Array.isArray(existingEdits?.sentences)
      ? existingEdits!.sentences!.length
      : 0;

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
    const looksLikeEpub =
      buffer.length >= 4 &&
      buffer[0] === 0x50 &&
      buffer[1] === 0x4b &&
      buffer[2] === 0x03 &&
      buffer[3] === 0x04;
    const looksLikePdf = buffer.length >= 5 && buffer.slice(0, 5).toString('ascii') === '%PDF-';
    const claimsBinary =
      state.manuscriptFile.endsWith('.epub') || state.manuscriptFile.endsWith('.pdf');
    const isLegacyTextMasqueradingAsBinary = claimsBinary && !looksLikeEpub && !looksLikePdf;
    let parsed;
    if (isLegacyTextMasqueradingAsBinary) {
      console.warn(
        `[book-state] reparse: ${state.manuscriptFile} is plain text on disk (pre-fix import). Routing through parseText.`,
      );
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
      state.chapters.filter((c) => c.excluded).map((c) => c.id),
    );
    const prevExcludedSlugs = new Set<string>(
      state.chapters.filter((c) => c.excluded).map((c) => c.slug),
    );
    const newChapters: BookStateJson['chapters'] = parsed.chapters.map((c) => {
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
      chapterTitleParserVersion: CHAPTER_TITLE_PARSER_VERSION,
      castConfirmed: false, // cast keys to chapters; force re-confirm.
      updatedAt: new Date().toISOString(),
    };
    await writeStateJsonAtomic(stateJsonPath(bookDir), nextState);

    /* Wipe the analysis cache and any per-book state that's now stale.
       Audio dir is removed wholesale; cast.json + revisions.json are deleted
       so the cast view re-runs voice matching against the fresh chapter list
       and stale drift events don't survive a reshuffle. manuscript-edits.json
       is intentionally kept — its sentence ids are filtered against the next
       analysis cache on GET, so surviving edits carry their characterId to
       the new sentence list and the rest fall away.
       Run the four cleanup operations in parallel — they're independent
       (different files) and on a book with a chapter-full audio dir +
       a fat cache file this serialised loop was tacking 100-300ms onto
       the reparse latency. */
    const ad = audioDir(bookDir);
    await Promise.all([
      clearAnalysisCache(state.manuscriptId),
      existsSync(castJsonPath(bookDir))
        ? rm(castJsonPath(bookDir), { force: true })
        : Promise.resolve(),
      existsSync(revisionsJsonPath(bookDir))
        ? rm(revisionsJsonPath(bookDir), { force: true })
        : Promise.resolve(),
      existsSync(ad) ? rm(ad, { recursive: true, force: true }) : Promise.resolve(),
    ]);

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
      chapterHints: parsed.chapters.map((c) => ({
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
      chapterTitles: newChapters.map((c) => c.title),
      /* Rich chapter records so the re-parse dialog can render
         checkboxes (preserved excluded + auto-suggest by wordCount)
         identical to the confirm-stage form. */
      chapters: newChapters.map((c) => ({
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
bookStateRouter.post(
  '/:bookId/chapters/:chapterId/exclude',
  async (req: Request, res: Response) => {
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

      const idx = state.chapters.findIndex((c) => c.id === chapterId);
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
      await writeStateJsonAtomic(stateJsonPath(bookDir), nextState);

      /* Propagate to the live ManuscriptRecord if it's loaded. The
       analysis route reads chapterHints directly from this; without
       the propagation we'd have to wait for a server restart or a
       book-state GET to pick up the change. */
      if (state.manuscriptId) {
        const rec = getManuscript(state.manuscriptId);
        if (rec) {
          rec.chapterHints = rec.chapterHints.map((h) =>
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
        const audioCandidates = ['mp3', 'm4a', 'opus'].map((ext) =>
          join(audioRoot, `${current.slug}.${ext}`),
        );
        for (const p of [segmentsPath, ...audioCandidates]) {
          if (existsSync(p)) {
            await rm(p, { force: true }).catch(() => {
              /* best effort */
            });
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
  },
);

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

/* GET / PUT /:bookId/listen-progress — per-book resume bookmark
   (plan 47). Sibling JSON to state.json (`.audiobook/listen-progress.json`)
   so it stays out of plan 27's rotating-backup contract. GET returns
   null on first read for a book; PUT body is `{ chapterId, currentSec }`
   and the server stamps `updatedAt` on write. */

interface ListenProgressFile {
  chapterId: number;
  currentSec: number;
  updatedAt: string;
}

bookStateRouter.get('/:bookId/listen-progress', async (req: Request, res: Response) => {
  try {
    const located = await findBookByBookId(req.params.bookId);
    if (!located) return res.status(404).json({ error: 'Book not found.' });
    const progress = await readJson<ListenProgressFile>(listenProgressJsonPath(located.bookDir));
    res.json(progress);
  } catch (e) {
    console.error('[book-state] GET listen-progress failed', e);
    res.status(500).json({ error: (e as Error).message || 'Failed to read listen-progress.' });
  }
});

bookStateRouter.put('/:bookId/listen-progress', async (req: Request, res: Response) => {
  try {
    const located = await findBookByBookId(req.params.bookId);
    if (!located) return res.status(404).json({ error: 'Book not found.' });
    const body = req.body as Partial<{ chapterId: unknown; currentSec: unknown }> | undefined;
    if (!body || typeof body.chapterId !== 'number' || !Number.isFinite(body.chapterId)) {
      return res.status(400).json({ error: 'chapterId must be a finite number.' });
    }
    if (typeof body.currentSec !== 'number' || !Number.isFinite(body.currentSec) || body.currentSec < 0) {
      return res.status(400).json({ error: 'currentSec must be a finite number >= 0.' });
    }
    const record: ListenProgressFile = {
      chapterId: body.chapterId,
      currentSec: body.currentSec,
      updatedAt: new Date().toISOString(),
    };
    await writeJsonAtomic(listenProgressJsonPath(located.bookDir), record);
    res.json(record);
  } catch (e) {
    console.error('[book-state] PUT listen-progress failed', e);
    res.status(500).json({ error: (e as Error).message || 'Failed to write listen-progress.' });
  }
});
