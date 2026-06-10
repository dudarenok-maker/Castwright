/* GET / PUT /api/books/:bookId/state

   GET returns a composite of all .audiobook/*.json files for a book, plus the
   manuscript sourceText so the analysis pipeline can re-run if the user
   re-opens a book whose in-memory ManuscriptRecord has been lost (server
   restart).

   PUT accepts `{ slice: 'cast'|'manuscript'|'revisions'|'state', patch }` and
   atomically writes the matching JSON file. Used by the persistence
   middleware in Phase 5. */

import { Router } from 'express';
import type { Request, Response } from '../http.js';
import { mkdir, readFile, readdir, rm, rmdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  STANDALONES_SERIES,
  audioDir,
  bookDirByDisplay,
  castJsonPath,
  castReuseCarryoverJsonPath,
  changeLogJsonPath,
  listenProgressJsonPath,
  manuscriptEditsJsonPath,
  queueJsonPath,
  revisionsJsonPath,
  slug,
  stateJsonPath,
} from '../workspace/paths.js';
import { readJson, writeJsonAtomic } from '../workspace/state-io.js';
import { readQueueFile, writeQueueFile } from '../workspace/queue-migrate.js';
import { pruneByBook } from '../workspace/queue-io.js';
import { renameWithRetry } from '../workspace/atomic-rename.js';
import { findBookByBookId, type BookStateJson } from '../workspace/scan.js';
import { writeStateJsonAtomic } from '../workspace/state-migrate.js';
import { ensureChapterUuids, reconcileChapterUuids } from '../workspace/chapter-uuid.js';
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
import { hydrateCastReusedVoices } from '../tts/hydrate-reused-voice-workspace.js';
import { DEFAULT_NARRATOR_CREDIT } from '../export/narrator-credit.js';
import type { ReuseHydratable } from '../tts/hydrate-reused-voice.js';
import { PRESERVED_VOICE_FIELDS } from '../store/merge-analysis-cast.js';
import { preserveDesignedVoicesOnCastWrite } from '../workspace/preserve-cast-voices.js';
import {
  collectRenderedFallbackEngines,
  collectRenderedSpeakerMaps,
} from '../audio/segments-io.js';
import type { LoudnormSidecarJson } from '../tts/loudnorm.js';

export const bookStateRouter = Router();

/* Denormalise the bespoke (qwen) voice onto any REUSED character before the
   cast persist (srv-14). The auto-match apply path stamps `matchedFrom` +
   `voiceId` + `voiceState:'reused'` on the frontend, then persists through this
   generic PUT — but it never copies the source character's designed voice
   (`ttsEngine` + `overrideTtsVoices.qwen`). Without it, the on-disk cast.json
   resolves to '' at generation and falls back to Kokoro until read-time
   hydration patches it. Stamping here (via the shared `resolveReusedVoiceFields`
   chain-walker that cast-link-prior already uses) makes cast.json self-complete
   after an auto-match — belt-and-suspenders alongside runtime hydration. The
   persona (`voiceStyle`) is denormalised the same way (srv-18).

   No-op for any character that already owns a qwen voice, isn't a reuse, or
   whose source can't be resolved. Tolerates a non-cast-shaped patch (returns it
   untouched) so the funnel stays generic. */
async function denormaliseCastReusedVoices(patch: unknown): Promise<unknown> {
  if (!patch || typeof patch !== 'object' || !Array.isArray((patch as { characters?: unknown }).characters)) {
    return patch;
  }
  const cast = patch as { characters: ReuseHydratable[] };
  const characters = await hydrateCastReusedVoices(cast.characters);
  return { ...cast, characters };
}

/* Fill any incoming character's missing voice-DESIGN fields from the on-disk
   cast.json before the persist (the durable guard against the 2026-06-05
   Stellarlune strip, where the analysing→cast-confirm flow persisted a
   voiceless in-memory cast and erased the designed Qwen voices). INCOMING WINS
   when present; the existing value fills only the gap. Reuse-link fields are
   left to `denormaliseCastReusedVoices` so unlink still works. Tolerates a
   non-cast-shaped patch (returns it untouched) so the funnel stays generic. */
async function preserveDesignedVoices(bookDir: string, patch: unknown): Promise<unknown> {
  if (!patch || typeof patch !== 'object' || !Array.isArray((patch as { characters?: unknown }).characters)) {
    return patch;
  }
  const cast = patch as { characters: Array<{ id: string } & Record<string, unknown>> };
  const existing = await readJson<{ characters?: Array<{ id: string } & Record<string, unknown>> }>(
    castJsonPath(bookDir),
  );
  const existingChars = existing?.characters ?? [];
  const characters = preserveDesignedVoicesOnCastWrite(existingChars, cast.characters);
  return { ...cast, characters };
}

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
       to avoid touching mtime / triggering watchers.

       Chapters with `titleOverridden: true` are pass-through — the user
       has manually renamed them and the heuristic refresh MUST NOT
       clobber their work. The chapterTitleParserVersion bump below
       still happens so the refresh isn't re-attempted on every GET. */
    const newChapters = state.chapters.map((c, i) =>
      c.titleOverridden ? c : { ...c, title: parsed.chapters[i].title },
    );
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
    /* srv-35 — lazy-migrate chapter uuids on the canonical book read (the
       web player's source of truth), persisting once so the Listen view's
       resume can resolve by uuid. Idempotent. */
    if (ensureChapterUuids(state)) {
      await writeStateJsonAtomic(stateJsonPath(bookDir), state);
    }
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
    /* Total attributed-sentence count per character id, derived from the same
       post-fold sentence list used for chapterCharacters. Used below to
       backfill the denormalised `lines` field on cast rows that were created
       WITHOUT one — a roster-added / cross-book-linked row (cast-add-from-
       roster.ts mints `<id>_from_<book>` with no `lines`, and nothing rewrites
       it after attribution), which otherwise renders a blank line count in the
       cast view even though the manuscript attributes lines to it. */
    const lineCountById = new Map<string, number>();
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
          lineCountById.set(sent.characterId, (lineCountById.get(sent.characterId) ?? 0) + 1);
        }
        for (const [id, ids] of bucketByChapter) chapterCharacters[id] = [...ids];
      } else {
        for (const [chapterId, sentences] of Object.entries(cache.chapters ?? {})) {
          const id = Number(chapterId);
          if (Number.isNaN(id)) continue;
          const ids = new Set<string>();
          for (const sent of sentences) {
            ids.add(sent.characterId);
            lineCountById.set(sent.characterId, (lineCountById.get(sent.characterId) ?? 0) + 1);
          }
          chapterCharacters[id] = [...ids];
        }
      }
    }

    /* Derive the denormalised `lines` count on every cast row from the
       attribution above, so the cast view always reflects the CURRENT
       manuscript-edits attribution rather than a stale value stamped at
       analysis time. This fixes two classes of wrong count at once:
         - roster-added / cross-book-linked rows (`<id>_from_<book>`, minted by
           cast-add-from-roster.ts with no `lines` field) that read as blank;
         - any row whose stored count drifted after a manual reattribution /
           boundary move that never rewrote the cast.

       Gated on having an attribution source: `lineCountById` is only populated
       when a non-empty sentence list (manuscript-edits.json, or the cache
       fallback) was loaded above. When analysis hasn't produced sentences yet
       the map is empty — leave the stored counts alone rather than wiping every
       row to 0. A row with an attribution source but no sentences of its own
       becomes a truthful 0. */
    if (lineCountById.size > 0 && cast?.characters && Array.isArray(cast.characters)) {
      for (const c of cast.characters as Array<{ id?: unknown; lines?: unknown }>) {
        if (typeof c?.id !== 'string') continue;
        c.lines = lineCountById.get(c.id) ?? 0;
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

    /* Plan 77 — per-chapter EBU R128 loudness sidecar payloads keyed by
       chapter id. Read once on book-open so the LUFS report card in the
       Listen view doesn't have to N-fan-out one chapter-audio meta fetch
       per chapter row. Missing/malformed sidecar → null entry; the
       frontend uses absence to render a neutral "no data" badge and
       gates drift comparisons on `twoPass === true`. Tolerant of
       directory absence (no audio generated yet) — `chapterLufs` stays
       empty in that case. */
    const chapterLufs: Record<number, LoudnormSidecarJson | null> = {};
    try {
      if (existsSync(audioDir(bookDir))) {
        for (const ch of state.chapters) {
          const lufsPath = join(audioDir(bookDir), `${ch.slug}.lufs.json`);
          if (!existsSync(lufsPath)) {
            chapterLufs[ch.id] = null;
            continue;
          }
          try {
            const payload = await readJson<LoudnormSidecarJson>(lufsPath);
            if (
              payload &&
              typeof payload.i === 'number' &&
              typeof payload.target === 'number'
            ) {
              chapterLufs[ch.id] = payload;
            } else {
              chapterLufs[ch.id] = null;
            }
          } catch {
            /* malformed sidecar — degrade to null rather than failing
               the whole book-state request. */
            chapterLufs[ch.id] = null;
          }
        }
      }
    } catch {
      /* fall through — chapterLufs stays {} */
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

    /* fe-16 — per-character render-time fallback engine, aggregated across the
       book's rendered chapters' segments files. `'kokoro'` for a character
       that fell back from Qwen on any rendered chapter; the cast view threads
       it into resolveVoiceStatus so the live Status pill reads
       "Fallback (Kokoro)". Empty `{}` when nothing has rendered / fallen back.
       Tolerant of missing audio dir (loadSegmentsFiles returns []). */
    const renderedFallbackByCharacter = await collectRenderedFallbackEngines(
      bookDir,
      state.chapters,
    ).catch(() => ({}));

    /* Render-time sentence→speaker map per rendered chapter (#650). The frontend
       diffs it against the live manuscript to flag a `done` chapter whose
       sentences were reassigned after it rendered — precise (no false positives)
       and immediate (recomputed from the live manuscript), superseding the
       time-based change-log heuristic. Tolerant of a missing audio dir. */
    const renderedSpeakersByChapter = await collectRenderedSpeakerMaps(
      bookDir,
      state.chapters,
    ).catch(() => ({}));

    /* Apply the brand default for narratorCredit in the GET response so the
       frontend always sees 'Castwright' when no explicit credit has been set.
       The on-disk value is left untouched — the PATCH/write path persists the
       explicit value on the next save. */
    const stateView = {
      ...state,
      narratorCredit:
        state.narratorCredit && state.narratorCredit.trim()
          ? state.narratorCredit
          : DEFAULT_NARRATOR_CREDIT,
    };

    res.json({
      state: stateView,
      cast,
      manuscript,
      manuscriptEdits: edits,
      revisions: revs,
      completedSlugs,
      chapterCharacters,
      chapterLufs,
      renderedFallbackByCharacter,
      renderedSpeakersByChapter,
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

   See docs/features/archive/32-sticky-analysis.md "Cold-boot rehydration"
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
      case 'cast': {
        const guarded = await preserveDesignedVoices(bookDir, body.patch);
        await writeJsonAtomic(castJsonPath(bookDir), await denormaliseCastReusedVoices(guarded));
        break;
      }
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
        /* Notes preserve interior whitespace verbatim (markdown line breaks
           matter), unlike pickNullable which trims. Empty / whitespace-only
           strings still collapse to null so the editor "clear" flow has a
           clean cleared-value signal. Plan 67. */
        const pickNotes = (
          incoming: unknown,
          fallback: string | null | undefined,
        ): string | null => {
          if (incoming === undefined) return fallback ?? null;
          if (incoming === null) return null;
          if (typeof incoming !== 'string') return fallback ?? null;
          return incoming.trim() === '' ? null : incoming;
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
        const pickAudioFormat = (
          incoming: unknown,
          fallback: BookStateJson['audioFormat'],
        ): BookStateJson['audioFormat'] => {
          if (incoming === undefined) return fallback;
          if (incoming === 'mp3' || incoming === 'aac-m4a' || incoming === 'opus') return incoming;
          return fallback;
        };
        /* Plan 73 — tags accept the full array on patch; non-string
           entries are dropped, duplicates collapsed, surrounding
           whitespace trimmed. Empty string → dropped (the chip editor
           emits these only on a stray Enter, never on intentional
           input). Undefined → preserve prior value. */
        const pickTags = (incoming: unknown, fallback: string[] | undefined): string[] => {
          if (incoming === undefined) return fallback ?? [];
          if (!Array.isArray(incoming)) return fallback ?? [];
          const out: string[] = [];
          const seen = new Set<string>();
          for (const entry of incoming) {
            if (typeof entry !== 'string') continue;
            const trimmed = entry.trim();
            if (!trimmed) continue;
            if (seen.has(trimmed)) continue;
            seen.add(trimmed);
            out.push(trimmed);
          }
          return out;
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
          /* srv-35 — the frontend round-trips state.chapters but doesn't
             track the server-only `uuid`, so a wholesale replace would
             strip it. reconcileChapterUuids carries each uuid across by id
             (and mints for a genuinely-new chapter). */
          chapters: patch.chapters
            ? reconcileChapterUuids(patch.chapters, state.chapters)
            : state.chapters,
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
          notes: pickNotes(patch.notes, state.notes),
          audioFormat: pickAudioFormat(patch.audioFormat, state.audioFormat),
          tags: pickTags(patch.tags, state.tags),
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

/* Shared post-parse core for reparse + replace-manuscript. Given a freshly
   parsed manuscript, regenerates the chapter list, snapshots the srv-13
   reuse/voice carryover, wipes the now-stale analysis cache / cast / audio,
   reconciles manuscript-edits (via the GET-side merge — the file is left in
   place here), appends a change-log entry, refreshes the in-memory
   ManuscriptRecord, and returns the response payload both routes send.

   The caller is responsible for everything BEFORE this point: locating the
   book, getting the manuscript bytes onto disk (or confirming they're there),
   updating state.manuscriptFile if the file changed, and parsing. */
async function applyReparse(
  bookDir: string,
  state: BookStateJson,
  parsed: Awaited<ReturnType<typeof parseManuscript>>,
  opts: { changeLogType: string; changeLogTitle: string },
) {
  const existingEdits = await readJson<{ sentences?: unknown[] }>(
    manuscriptEditsJsonPath(bookDir),
  );
  const preservedEditCount = Array.isArray(existingEdits?.sentences)
    ? existingEdits!.sentences!.length
    : 0;

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
    castConfirmed: false,
    updatedAt: new Date().toISOString(),
  };
  await writeStateJsonAtomic(stateJsonPath(bookDir), nextState);

  const carryoverPath = castReuseCarryoverJsonPath(bookDir);
  const existingCast = await readJson<{
    characters?: Array<{ id?: string; name?: string } & Record<string, unknown>>;
  }>(castJsonPath(bookDir));
  const reuseRows = (existingCast?.characters ?? [])
    .filter((c) => typeof c.id === 'string')
    .map((c) => {
      const row: Record<string, unknown> = { id: c.id, name: c.name };
      if (c.aliases !== undefined) row.aliases = c.aliases;
      for (const key of PRESERVED_VOICE_FIELDS) {
        if (c[key] !== undefined) row[key] = c[key];
      }
      return row;
    });
  if (reuseRows.length) {
    await writeJsonAtomic(carryoverPath, { characters: reuseRows });
  } else if (existsSync(carryoverPath)) {
    await rm(carryoverPath, { force: true });
  }

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
      type: opts.changeLogType,
      title: opts.changeLogTitle,
      note: `Preserved ${preservedEditCount} manuscript ${noun}; ids will be reconciled against the next analysis run.`,
      actor: 'system',
    };
    await writeJsonAtomic(logPath, { events: [newEntry, ...prior] });
  }

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

  const wordCountByChapterId = new Map<number, number>();
  for (const c of parsed.chapters) {
    const body = (c.body ?? '').trim();
    wordCountByChapterId.set(c.id, body ? body.split(/\s+/).filter(Boolean).length : 0);
  }

  return {
    state: nextState,
    chapterCount: newChapters.length,
    chapterTitles: newChapters.map((c) => c.title),
    chapters: newChapters.map((c) => ({
      id: c.id,
      title: c.title,
      slug: c.slug,
      wordCount: wordCountByChapterId.get(c.id) ?? 0,
      excluded: !!c.excluded,
    })),
  };
}

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

    const payload = await applyReparse(bookDir, state, parsed, {
      changeLogType: 'reparse',
      changeLogTitle: 'Re-parsed manuscript',
    });
    res.json(payload);
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

/* POST /api/books/:bookId/chapters/:chapterId/held — toggle the "Not queued"
   hold on an un-rendered chapter (see scan.ts chapter `held`).

   Mirrors the exclude handler above, minus the audio cleanup: held is a
   queue-membership choice, not a content removal, so a held chapter keeps any
   audio it has (typically none — the hold is set when the user deletes its
   queue entry before it renders). Unlike `excluded` it is NOT propagated to
   the in-memory ManuscriptRecord chapterHints: analysis still processes a held
   chapter (it's part of the book), so nothing on the analysis path reads it.

   Idempotent — same value twice is a no-op (still 200 with the chapter entry). */
bookStateRouter.post(
  '/:bookId/chapters/:chapterId/held',
  async (req: Request, res: Response) => {
    try {
      const chapterId = Number(req.params.chapterId);
      if (!Number.isInteger(chapterId)) {
        return res.status(400).json({ error: 'chapterId must be an integer.' });
      }
      const rawHeld = (req.body as { held?: unknown })?.held;
      if (typeof rawHeld !== 'boolean') {
        return res.status(400).json({ error: '`held` is required and must be a boolean.' });
      }
      const held: boolean = rawHeld;

      const located = await findBookByBookId(req.params.bookId);
      if (!located) return res.status(404).json({ error: 'Book not found.' });
      const { bookDir, state } = located;

      const idx = state.chapters.findIndex((c) => c.id === chapterId);
      if (idx === -1) return res.status(404).json({ error: 'Chapter not found.' });

      const current = state.chapters[idx];
      const updated = { ...current, held: held ? true : undefined };
      const nextChapters = state.chapters.map((c, i) => (i === idx ? updated : c));

      const nextState: BookStateJson = {
        ...state,
        chapters: nextChapters,
        updatedAt: new Date().toISOString(),
      };
      await writeStateJsonAtomic(stateJsonPath(bookDir), nextState);

      res.json({
        id: updated.id,
        title: updated.title,
        slug: updated.slug,
        held: !!updated.held,
      });
    } catch (e) {
      console.error('[book-state] held toggle failed', e);
      res.status(500).json({ error: (e as Error).message || 'Failed to toggle held.' });
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
    /* Plan 102 — prune any queue entries that target the just-deleted book.
       Same write transaction shape (read → mutate → atomic write) as the
       directory drop above; runs after the directory is gone so a partial
       failure can't leave orphaned entries pointing at a still-extant book.
       Best-effort: if the queue write fails, log + continue — the book is
       already deleted and the stale entries surface on the next read as
       "book not found" rather than corrupting the queue. */
    try {
      const queue = await readQueueFile(queueJsonPath());
      const pruned = pruneByBook(queue, req.params.bookId);
      if (pruned.entries.length !== queue.entries.length) {
        await writeQueueFile(queueJsonPath(), pruned);
      }
    } catch (queueErr) {
      console.warn(
        `[book-state] queue prune failed for ${req.params.bookId}: ${(queueErr as Error).message}`,
      );
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

/* Plan 53 — marker kind enum. Server keeps its own copy (rather
   than reaching into the frontend slice) so the route boundary is
   self-contained. Frontend mirror lives in
   src/store/listen-progress-slice.ts (LISTEN_MARKER_KINDS). */
const LISTEN_MARKER_KINDS = ['note', 'rerecord'] as const;
type ListenMarkerKind = (typeof LISTEN_MARKER_KINDS)[number];

interface ListenMarker {
  id: string;
  chapterId: number;
  sec: number;
  label: string;
  kind: ListenMarkerKind;
  createdAt: string;
}

interface ListenProgressFile {
  chapterId: number;
  /* srv-35 (plan 190) — the stable uuid of the resume chapter, derived on
     PUT from the current chapterId. GET resolves it back to the CURRENT
     chapterId so a resume position survives a chapter restructure (the
     positional id shifts, the uuid doesn't). Absent on legacy records and
     on a PUT whose chapterId doesn't map to a chapter — GET then falls
     back to the stored chapterId. */
  chapterUuid?: string;
  currentSec: number;
  updatedAt: string;
  /* Plan 53 — per-book playback rate
     (`HTMLMediaElement.playbackRate`). Optional; absent on
     pre-plan-53 records, in which case clients default to 1.0. */
  playbackRate?: number;
  /* Plan 53 — user-placed bookmarks. Optional; absent on pre-plan-53
     records. */
  markers?: ListenMarker[];
}

/* Plan 53 — bounds on playback rate. Mirrors the openapi.yaml
   schema (0.25 - 4.0). The bottom matches HTMLMediaElement's
   browser-supported floor; the top is well past what any audiobook
   listener would realistically pick but generous enough to allow
   user experimentation without 400s. */
const PLAYBACK_RATE_MIN = 0.25;
const PLAYBACK_RATE_MAX = 4.0;

/* srv-34 (plan 188) — a small tolerance for a client-supplied
   `listenedAt`. A device clock a little ahead is fine; one absurdly in
   the future is rejected so it can't poison last-write-wins ordering. */
const LISTENED_AT_FUTURE_SKEW_MS = 5 * 60 * 1000;

/* Plan 53 — server-side validator for an individual marker payload.
   Returns null when valid, or a short reason string for the 400. */
function validateMarker(raw: unknown): string | null {
  if (!raw || typeof raw !== 'object') return 'marker must be an object';
  const m = raw as Record<string, unknown>;
  if (typeof m.id !== 'string' || m.id.length === 0) return 'marker.id must be a non-empty string';
  if (typeof m.chapterId !== 'number' || !Number.isFinite(m.chapterId) || m.chapterId < 0) {
    return 'marker.chapterId must be a finite number >= 0';
  }
  if (typeof m.sec !== 'number' || !Number.isFinite(m.sec) || m.sec < 0) {
    return 'marker.sec must be a finite number >= 0';
  }
  if (typeof m.label !== 'string') return 'marker.label must be a string';
  if (typeof m.kind !== 'string' || !(LISTEN_MARKER_KINDS as readonly string[]).includes(m.kind)) {
    return `marker.kind must be one of: ${LISTEN_MARKER_KINDS.join(', ')}`;
  }
  if (typeof m.createdAt !== 'string' || m.createdAt.length === 0) {
    return 'marker.createdAt must be a non-empty string';
  }
  return null;
}

bookStateRouter.get('/:bookId/listen-progress', async (req: Request, res: Response) => {
  try {
    const located = await findBookByBookId(req.params.bookId);
    if (!located) return res.status(404).json({ error: 'Book not found.' });
    const progress = await readJson<ListenProgressFile>(listenProgressJsonPath(located.bookDir));
    /* srv-35 — resolve the stored chapterUuid to the chapter's CURRENT id,
       so a resume position made before a restructure lands on the right
       chapter. Falls back to the stored chapterId when the record predates
       uuids or the chapter has since been deleted. */
    if (progress?.chapterUuid) {
      const current = await readJson<BookStateJson>(stateJsonPath(located.bookDir));
      const match = current?.chapters.find((c) => c.uuid === progress.chapterUuid);
      if (match && match.id !== progress.chapterId) {
        return res.json({ ...progress, chapterId: match.id });
      }
    }
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
    const body = req.body as
      | Partial<{
          chapterId: unknown;
          currentSec: unknown;
          playbackRate: unknown;
          markers: unknown;
          listenedAt: unknown;
        }>
      | undefined;
    if (!body || typeof body.chapterId !== 'number' || !Number.isFinite(body.chapterId)) {
      return res.status(400).json({ error: 'chapterId must be a finite number.' });
    }
    if (typeof body.currentSec !== 'number' || !Number.isFinite(body.currentSec) || body.currentSec < 0) {
      return res.status(400).json({ error: 'currentSec must be a finite number >= 0.' });
    }
    /* Plan 53 — optional playbackRate. Absent / undefined is fine
       (legacy callers); when present, must be a finite number in the
       documented browser-supported range. NaN/Infinity rejected. */
    let playbackRate: number | undefined;
    if (body.playbackRate !== undefined) {
      if (
        typeof body.playbackRate !== 'number' ||
        !Number.isFinite(body.playbackRate) ||
        body.playbackRate < PLAYBACK_RATE_MIN ||
        body.playbackRate > PLAYBACK_RATE_MAX
      ) {
        return res.status(400).json({
          error: `playbackRate must be a finite number between ${PLAYBACK_RATE_MIN} and ${PLAYBACK_RATE_MAX}.`,
        });
      }
      playbackRate = body.playbackRate;
    }
    /* Plan 53 — optional markers. Each entry validated through
       validateMarker; first failure short-circuits with 400 so the
       on-disk record never contains a partially-valid list. */
    let markers: ListenMarker[] | undefined;
    if (body.markers !== undefined) {
      if (!Array.isArray(body.markers)) {
        return res.status(400).json({ error: 'markers must be an array.' });
      }
      for (let i = 0; i < body.markers.length; i++) {
        const reason = validateMarker(body.markers[i]);
        if (reason) return res.status(400).json({ error: `markers[${i}]: ${reason}` });
      }
      markers = body.markers as ListenMarker[];
    }
    /* srv-34 (plan 188) — optional client `listenedAt`. When present it
       stamps `updatedAt` (the wall-clock time the user actually listened,
       which may be earlier than this request when a phone flushes offline
       progress on reconnect) instead of receive-time. Validated as a real
       date and rejected if absurdly future (clock-skew guard). */
    let effectiveUpdatedAt = new Date().toISOString();
    let listenedAtMs: number | null = null;
    if (body.listenedAt !== undefined) {
      if (typeof body.listenedAt !== 'string' || Number.isNaN(Date.parse(body.listenedAt))) {
        return res.status(400).json({ error: 'listenedAt must be an ISO date-time string.' });
      }
      listenedAtMs = Date.parse(body.listenedAt);
      if (listenedAtMs > Date.now() + LISTENED_AT_FUTURE_SKEW_MS) {
        return res.status(400).json({ error: 'listenedAt is too far in the future.' });
      }
      effectiveUpdatedAt = new Date(listenedAtMs).toISOString();
    }
    /* srv-34 — guarded compare-and-set. ONLY when the caller supplies a
       `listenedAt` (the companion's offline-correct ordering signal) do we
       refuse to overwrite a strictly-newer stored record, returning that
       record so the client reconciles. Legacy callers that omit
       `listenedAt` keep last-write-wins-by-receive-time. */
    if (listenedAtMs !== null) {
      const existing = await readJson<ListenProgressFile>(
        listenProgressJsonPath(located.bookDir),
      );
      if (existing && Date.parse(existing.updatedAt) >= listenedAtMs) {
        return res.json(existing);
      }
    }
    /* srv-35 — stamp the resume chapter's stable uuid (resolved from the
       current chapterId) so GET can re-derive the chapterId after a
       restructure. Absent when the chapterId doesn't map to a chapter (or
       a legacy book without uuids) — GET then keeps the stored chapterId. */
    const stateForUuid = await readJson<BookStateJson>(stateJsonPath(located.bookDir));
    const chapterUuid = stateForUuid?.chapters.find((c) => c.id === body.chapterId)?.uuid;
    const record: ListenProgressFile = {
      chapterId: body.chapterId,
      ...(chapterUuid ? { chapterUuid } : {}),
      currentSec: body.currentSec,
      updatedAt: effectiveUpdatedAt,
      ...(playbackRate !== undefined ? { playbackRate } : {}),
      ...(markers !== undefined ? { markers } : {}),
    };
    await writeJsonAtomic(listenProgressJsonPath(located.bookDir), record);
    res.json(record);
  } catch (e) {
    console.error('[book-state] PUT listen-progress failed', e);
    res.status(500).json({ error: (e as Error).message || 'Failed to write listen-progress.' });
  }
});
