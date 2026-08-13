/* Import + confirm-metadata flow.

   POST /api/import
     multipart/form-data { file } OR application/json { text, fileName? }
     → parses the manuscript (no disk write), extracts best-effort metadata,
       and stashes the result in the import-staging map under a short tempId.
     Response: { tempId, candidate: { format, title, author, series,
                 seriesPosition, sourceText, wordCount, byteSize, chapters } }

   POST /api/books
     application/json { tempId, author, series, seriesPosition, title, isStandalone }
     → drains the staging entry, writes manuscript.<ext> + .audiobook/state.json
       into workspace/books/<Author>/<Series>/<Title>/, registers a ManuscriptRecord
       so the existing analysis pipeline keeps working, evicts the staging entry.
     Response: { bookId, manuscriptId, paths: { bookDir, manuscript, dotAudiobook } } */

import { Router } from 'express';
import type { Request, Response } from '../http.js';
import multer from 'multer';
import { nanoid } from 'nanoid';
import { existsSync } from 'node:fs';
import { writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { parseManuscript, UnsupportedFormatError, DrmProtectedError } from '../parsers/index.js';
import { isLikelyFrontMatterTitle, FRONT_MATTER_WORD_THRESHOLD, countWords } from '../parsers/front-matter.js';
import { putManuscript, type ManuscriptRecord, type ChapterHint } from '../store/manuscripts.js';
import { getStaging, putStaging, dropStaging, type StagedImport } from '../store/import-staging.js';
import {
  STANDALONES_SERIES,
  bookDirByDisplay,
  dotAudiobook,
  ensureWorkspace,
  makeBookId,
  stateJsonPath,
  slug,
} from '../workspace/paths.js';
import { writeStateJsonAtomic } from '../workspace/state-migrate.js';
import type { BookStateJson } from '../workspace/scan.js';
import { normaliseBookLanguage } from '../tts/language.js';
import { detectManuscriptLanguageFromChapters } from '../tts/detect-language.js';
import { isSupportedLanguage, supportedLanguages } from '../tts/language-registry.js';
import { CHAPTER_TITLE_PARSER_VERSION } from '../parsers/version.js';
import { backgroundFetchCover } from '../cover/store.js';

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });

export const importRouter = Router();

const EXT_BY_FORMAT: Record<ManuscriptRecord['format'], string> = {
  markdown: 'md',
  plaintext: 'txt',
  epub: 'epub',
  pdf: 'pdf',
  mobi: 'mobi',
};

function deterministicGradient(seed: string): [string, string] {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = ((h << 5) - h + seed.charCodeAt(i)) | 0;
  const palette: Array<[string, string]> = [
    ['#3C194F', '#0F0E0D'],
    ['#6B6663', '#1A1A1A'],
    ['#D4A04E', '#7B5A26'],
    ['#A43C6C', '#3C194F'],
    ['#1F3A5F', '#0A1628'],
    ['#5C3A1E', '#2A1810'],
    ['#3E5F4A', '#162820'],
    ['#7A2E3C', '#2A0F14'],
  ];
  return palette[Math.abs(h) % palette.length];
}

/* ── POST /api/import — parse-only, no disk write ─────────────────────── */
importRouter.post('/import', upload.single('file'), async (req: Request, res: Response) => {
  try {
    let parsed;
    let originalFileName: string | null = null;
    let byteSize = 0;
    /* Hold the uploaded bytes so we can persist them verbatim to the
       workspace book directory on confirm. Required for ALL formats —
       EPUB/PDF need the binary so re-parse can feed it back to the
       binary parsers, and markdown/plaintext need it too because
       parseText strips headings and injects audio tags into sourceText
       (so sourceText is not a faithful copy of the original input). */
    let originalBuffer: Buffer;

    if (req.file) {
      parsed = await parseManuscript({
        buffer: req.file.buffer,
        fileName: req.file.originalname,
        mimeType: req.file.mimetype,
      });
      originalFileName = req.file.originalname;
      byteSize = req.file.size;
      originalBuffer = req.file.buffer;
    } else if (typeof req.body?.text === 'string') {
      const fileName = typeof req.body?.fileName === 'string' ? req.body.fileName : undefined;
      parsed = await parseManuscript({ text: req.body.text, fileName });
      originalFileName = fileName ?? null;
      byteSize = Buffer.byteLength(req.body.text, 'utf8');
      originalBuffer = Buffer.from(req.body.text, 'utf8');
    } else {
      return res.status(400).json({ error: 'Provide either multipart `file` or JSON `text`.' });
    }

    const tempId = 'imp_' + nanoid(10);
    /* #2263 — the whole-document sample (byte 0 onward) is dominated by
       front matter (title page, copyright, dedication, TOC, epigraph,
       foreword) on a book whose front matter isn't in the book's own
       language, and was silently deciding the wrong language whenever that
       front matter outweighed the body within the sample window. Detect
       per chapter and vote instead — see detectManuscriptLanguageFromChapters.

       Computed BEFORE the staging entry (it used to run after `putStaging`)
       so the result can be stored on it rather than only returned to the
       client — see StagedImport.detectedLanguage for why that matters. */
    const detected = detectManuscriptLanguageFromChapters(parsed.chapters, {
      author: parsed.author,
      title: parsed.title,
    });
    const entry: StagedImport = {
      tempId,
      format: parsed.format,
      title: parsed.title,
      author: parsed.author,
      series: parsed.series,
      seriesPosition: parsed.seriesPosition,
      seriesFromTitle: parsed.seriesFromTitle,
      sourceText: parsed.sourceText,
      chapters: parsed.chapters,
      originalFileName,
      byteSize,
      originalBuffer,
      detectedLanguage: detected.language,
      detectedLanguageSupported: detected.supported,
      detectedLanguageFallback: detected.fallback,
      createdAt: Date.now(),
    };
    putStaging(entry);

    res.json({
      tempId,
      candidate: {
        format: entry.format,
        title: entry.title,
        author: entry.author,
        series: entry.series,
        seriesPosition: entry.seriesPosition,
        seriesFromTitle: entry.seriesFromTitle,
        sourceText: entry.sourceText,
        wordCount: countWords(entry.sourceText),
        byteSize: entry.byteSize,
        language: detected.language,
        languageSupported: detected.supported,
        languageFallback: detected.fallback,
        supportedLanguages: supportedLanguages(),
        chapters: entry.chapters.map((c) => {
          const wordCount = countWords(c.body);
          return {
            id: c.id,
            title: c.title,
            /* Per-chapter wordCount lets the confirm view auto-suggest
               front/back-matter exclusion (short Dedication/Copyright
               pages stand out). Stripped to int to keep the wire shape
               simple. */
            wordCount,
            /* seam 3b — server-computed flag so the confirm view can
               pre-tick front/back-matter chapters without a client-side
               regex mirror. Title union (language-aware) OR short body. */
            isLikelyFrontMatter:
              isLikelyFrontMatterTitle(c.title) ||
              (wordCount > 0 && wordCount <= FRONT_MATTER_WORD_THRESHOLD),
          };
        }),
      },
    });
  } catch (e) {
    if (e instanceof DrmProtectedError) {
      return res.status(415).json({ error: 'drm_protected', message: e.message });
    }
    if (e instanceof UnsupportedFormatError) {
      return res.status(415).json({ error: e.message });
    }
    console.error('[import] parse failed', e);
    return res.status(500).json({ error: (e as Error).message || 'Import failed.' });
  }
});

/* ── POST /api/books — confirm metadata, write to disk ─────────────────── */
importRouter.post('/books', async (req: Request, res: Response) => {
  try {
    const body = req.body as {
      tempId?: string;
      author?: string;
      series?: string;
      seriesPosition?: number | null;
      title?: string;
      isStandalone?: boolean;
      /* fs-2 — BCP-47 manuscript language chosen at confirm (auto-detected
         on the frontend, user-overridable). Saying nothing here — absent,
         null, empty or whitespace — falls back to /import's own detection,
         not to English; see the resolution below. */
      language?: string;
      /* Slugs (matching the server-derived `${id-pad}-${slug(title)}`
         form) for chapters the user pre-excluded from analysis at the
         confirm stage. The slug is the stable cross-parse key; ids can
         shift after a re-parse but slug is title-derived. */
      excludedSlugs?: string[];
    };

    if (!body?.tempId || typeof body.tempId !== 'string') {
      return res.status(400).json({ error: 'tempId is required.' });
    }
    const entry = getStaging(body.tempId);
    if (!entry) {
      return res
        .status(410)
        .json({ error: 'Import expired or already consumed. Please re-upload.' });
    }

    /* #2337 review N2 — `author`, `title` and `series` share the identical
       shape as the `language` field C2 guarded: `(body.X ?? '').trim()`
       only catches null/undefined via `??`; a number, boolean, array or
       object sails past it and hits `.trim()` unguarded, throwing a raw
       TypeError the handler's generic `catch` below surfaces as an HTTP 500
       carrying an internal message. Reject the whole non-string, non-null
       shape here, per field, before any `.trim()` runs — never a 500. */
    if (body.author != null && typeof body.author !== 'string') {
      return res.status(400).json({ error: 'author must be a string.' });
    }
    if (body.title != null && typeof body.title !== 'string') {
      return res.status(400).json({ error: 'title must be a string.' });
    }
    const author = (body.author ?? '').trim();
    const title = (body.title ?? '').trim();
    if (!author || !title) {
      return res.status(400).json({ error: 'author and title are required.' });
    }
    const isStandalone = !!body.isStandalone;
    if (!isStandalone && body.series != null && typeof body.series !== 'string') {
      return res.status(400).json({ error: 'series must be a string.' });
    }
    const series = isStandalone ? STANDALONES_SERIES : (body.series ?? '').trim();
    if (!isStandalone && !series) {
      return res.status(400).json({ error: 'series is required (or set isStandalone=true).' });
    }
    const seriesPosition = isStandalone
      ? null
      : typeof body.seriesPosition === 'number' && Number.isFinite(body.seriesPosition)
        ? body.seriesPosition
        : null;

    /* Issue #1955 — the confirm-screen dropdown only constrains the browser;
       a direct API call can send any BCP-47 tag. Gate at the import
       boundary (before any disk write) so an unsupported language is
       rejected here instead of persisting onto state.json and only
       surfacing later as an opaque chapter_failed at render time
       (sidecarLanguageName's throw in generation.ts — that backstop stays
       in place unchanged; this is an earlier, additional gate, not a
       replacement for it). Checked before ensureWorkspace()/mkdir so a
       rejected request writes nothing and leaves the staging entry intact
       for a corrected retry. */
    /* An OMITTED `language` now falls back to what `/import` detected from the
       chapter bodies, not to English.

       The confirm screen always sends the field (pre-filled from the detection,
       user-overridable), so the UI path is unchanged — an explicit value still
       wins outright, including an explicit 'en' over a Russian detection.
       What changes is the caller that leaves it out: it used to get English
       while the server held the correct answer from seconds earlier. Silently
       guessing the language is not a small wrong: it picks the voices, the
       pronunciation, the dialogue conventions and the script the cast is
       spelled in. A Russian book confirmed this way ran for 20 hours as an
       English one (#2306) — no language preamble, so stage 1 romanised every
       name and stage 2 read dash-marked dialogue as narration.

       Two conditions gate the fallback, and NEITHER is load-bearing today
       (#2337 review N1 — an earlier version of this comment claimed the
       second was; it is not, see below). SUPPORTED: an unsupported detection
       would turn a previously-succeeding request into a 400 below — a
       breaking change for a caller that never asked about language. Every
       registry entry is currently `supported: true`, so this cannot fire
       yet; it is defence for the moment one lands unsupported, as
       es/fr/de/zh/ja each once were. NOT-A-FALLBACK: a detection that
       surrendered is a confidence-floor guess, not a decision, and this
       route is a writer — see DetectionResult.fallback. `detectManuscriptLanguageFromChapters`'s
       own surrender path — what this route actually calls, not the
       single-call `detectManuscriptLanguage` it calls internally — stamps
       `language: 'en'` alongside `fallback: true` on every branch (see the
       N2 paragraph below for why `detectManuscriptLanguage` itself is NOT
       this uniform since C1), so both branches of this condition currently
       produce the SAME `normaliseBookLanguage(entry.detectedLanguage)`
       result the fallback-less path below would also produce — deleting
       this clause changes no observable output today, which is why it is
       not load-bearing yet. **#2337 review N2 (round 3): a prior version of this
       paragraph claimed review C1 changed that** — that `entry.detectedLanguage`
       could now be a coerced guess (e.g. `'es'`) alongside
       `entry.detectedLanguageFallback: true`, making this clause load-bearing.
       That is false for the path this field is actually populated from. C1's
       coercion check lives inside `detectManuscriptLanguage` (the single-call
       detector), but this route stores whatever
       `detectManuscriptLanguageFromChapters` returns, and that function's
       surrender branches — including the one an all-coerced book takes,
       since `voteLanguage` filters every `fallback: true` ballot out of the
       vote before it runs — are ALL hardcoded `resultFor('en', true)` (see
       `detect-language.ts`). A coerced ballot lives only transiently inside
       that per-chapter filtering; it is never this function's own return
       value. So `entry.detectedLanguageFallback: true` still always pairs
       with `entry.detectedLanguage === 'en'`, exactly as before C1, and this
       clause is still inert for this route — matching openapi.yaml's
       documented rule (`language`'s description above `excludedSlugs`), which
       names only the SUPPORTED gate and says nothing about a surrender ever
       carrying a non-`'en'` language. See
       `detect-language.test.ts`'s "#2337 review N3" test for the pinned
       all-coerced-surrenders-to-en behaviour.

       "No choice" is the CLASS, not one spelling of it: absent, `null`, `''`
       and whitespace all mean the caller did not pick a language, and
       `normaliseBookLanguage` maps every one of them to 'en' (see its own
       doc: "Missing, empty, or whitespace → 'en'"). Testing only `=== undefined`
       would have left `{"language": ""}` — an unfilled form field, or
       `detected ?? ''` — silently persisting English over a Russian detection,
       i.e. this exact defect surviving under a different spelling. */
    /* #2337 review C2 — a caller sending a non-string, non-null `language`
       (a number, boolean, array, object) used to reach `normaliseBookLanguage`
       unguarded below, which calls `.trim()` on whatever it was handed and
       throws a raw TypeError that surfaced as an HTTP 500 carrying an
       internal message on a client-facing body. `null`/`undefined` are
       handled below (the "no choice" class); anything else non-string is
       simply not a language the caller could have meant, so it gets the same
       400 `unsupported_language` an unsupported STRING gets. */
    if (body.language != null && typeof body.language !== 'string') {
      return res.status(400).json({
        error: 'unsupported_language',
        message: `Unsupported language "${JSON.stringify(body.language)}". Supported languages: ${supportedLanguages()
          .map((l) => l.code)
          .join(', ')}.`,
        supportedLanguages: supportedLanguages(),
      });
    }
    // The C2 guard above already rejected every non-null, non-string
    // `language` with a 400, so by this point a non-string value can only be
    // `null`/`undefined` — the `: body.language != null` alternative a prior
    // version had here was the exact pre-fix C2 bug expression (see
    // import.test.ts's "#2337 review C2" describe block) kept on as dead
    // code: always `false` post-guard, never reachable as `true`.
    const languageChosen = typeof body.language === 'string' && body.language.trim() !== '';
    const language =
      !languageChosen && entry.detectedLanguageSupported && !entry.detectedLanguageFallback
        ? normaliseBookLanguage(entry.detectedLanguage)
        : normaliseBookLanguage(body.language);
    if (!isSupportedLanguage(language)) {
      return res.status(400).json({
        error: 'unsupported_language',
        message: `Unsupported language "${language}". Supported languages: ${supportedLanguages()
          .map((l) => l.code)
          .join(', ')}.`,
        supportedLanguages: supportedLanguages(),
      });
    }

    ensureWorkspace();
    const bookDir = bookDirByDisplay(author, series, title);
    if (existsSync(bookDir)) {
      const suggestedTitle = `${title} (2)`;
      return res.status(409).json({ error: 'slug_collision', suggestedTitle });
    }

    const manuscriptId = 'mns_' + nanoid(10);
    const bookId = makeBookId(author, series, title);
    /* MOBI and AZW3 share the same ManuscriptFormat ('mobi') but the file
       extension matters at re-parse time: .azw3 routes to initKf8File,
       .mobi routes to initMobiFile. Preserve the original extension when
       it is .azw3; otherwise fall back to the format → ext map. */
    const originalExt = entry.originalFileName?.match(/\.([a-z0-9]+)$/i)?.[1]?.toLowerCase();
    const manuscriptExt =
      entry.format === 'mobi' && originalExt === 'azw3' ? 'azw3' : EXT_BY_FORMAT[entry.format];
    const manuscriptFile = `manuscript.${manuscriptExt}`;
    const manuscriptPath = join(bookDir, manuscriptFile);

    await mkdir(bookDir, { recursive: true });
    await mkdir(dotAudiobook(bookDir), { recursive: true });
    await mkdir(join(bookDir, 'audio'), { recursive: true });
    /* Persist the ORIGINAL uploaded bytes verbatim — re-parse later
       needs the unmodified input. Earlier versions wrote sourceText
       (the *extracted* text), which broke EPUB re-parse outright (plain
       text isn't a valid ZIP) and silently corrupted markdown re-parse
       too (parseText strips headings + injects audio tags, so re-parsing
       the already-stripped-and-tagged text produces wrong chapters). */
    await writeFile(manuscriptPath, entry.originalBuffer);

    const now = new Date().toISOString();
    const excludedSet = new Set<string>(
      Array.isArray(body.excludedSlugs)
        ? body.excludedSlugs.filter((s) => typeof s === 'string')
        : [],
    );
    const chaptersWithSlug = entry.chapters.map((c) => {
      const slugStr = `${String(c.id).padStart(2, '0')}-${slug(c.title)}`;
      /* Auto-exclude EPUB/PDF back-matter the user didn't already opt out of
         (Acknowledgments, Copyright, CONTENTS, a next-book teaser, …). These
         carry no narratable prose — left in, they queue pointlessly and can
         hang synthesis on degenerate input (plan 148). The user can always
         re-include one via the per-chapter exclude toggle. */
      const isExcluded = excludedSet.has(slugStr) || isLikelyFrontMatterTitle(c.title);
      return {
        id: c.id,
        title: c.title,
        slug: slugStr,
        body: c.body,
        excluded: isExcluded || undefined,
      };
    });
    const state: BookStateJson = {
      bookId,
      manuscriptId,
      title,
      author,
      series,
      seriesPosition,
      isStandalone,
      manuscriptFile,
      castConfirmed: false,
      chapters: chaptersWithSlug.map((c) => ({
        id: c.id,
        title: c.title,
        slug: c.slug,
        excluded: c.excluded,
      })),
      coverGradient: deterministicGradient(bookId),
      createdAt: now,
      updatedAt: now,
      chapterTitleParserVersion: CHAPTER_TITLE_PARSER_VERSION,
      language,
    };
    await writeStateJsonAtomic(stateJsonPath(bookDir), state);

    /* Fire-and-forget cover fetch from OpenLibrary. The import response
       does NOT wait for this — covers can be slow and OpenLibrary can be
       flaky, but the user should be able to land on the analysing screen
       immediately. On success, state.json picks up a `coverImage` field
       and the next library scan surfaces `coverImageUrl` so the card
       fills in. On failure, the gradient remains and the user can
       always retry via "Find cover image" on the library card. */
    void backgroundFetchCover(bookDir, title, author, bookId);

    const record: ManuscriptRecord = {
      manuscriptId,
      format: entry.format,
      title,
      wordCount: countWords(entry.sourceText),
      byteSize: entry.byteSize,
      uploadedAt: now,
      sourceText: entry.sourceText,
      /* Mirror the excluded flag onto chapterHints so the in-memory
         analysis route sees it without re-reading state.json. */
      chapterHints: chaptersWithSlug.map((c) => ({
        id: c.id,
        title: c.title,
        body: c.body,
        excluded: c.excluded,
      })) as ChapterHint[],
      bookId,
      bookDir,
    };
    putManuscript(record);

    dropStaging(body.tempId);

    res.status(201).json({
      bookId,
      manuscriptId,
      title,
      author,
      series,
      seriesPosition,
      isStandalone,
      format: entry.format,
      wordCount: record.wordCount,
      byteSize: record.byteSize,
      uploadedAt: now,
      sourceText: entry.sourceText,
      paths: {
        bookDir,
        manuscript: manuscriptPath,
        dotAudiobook: dotAudiobook(bookDir),
      },
    });
  } catch (e) {
    console.error('[import] confirm failed', e);
    res.status(500).json({ error: (e as Error).message || 'Confirm failed.' });
  }
});
