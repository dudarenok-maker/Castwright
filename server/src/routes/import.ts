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
import { isLikelyFrontMatterTitle } from '../parsers/front-matter.js';
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
import { detectManuscriptLanguage } from '../tts/detect-language.js';
import { supportedLanguages } from '../tts/language-registry.js';
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

function countWords(s: string): number {
  return s.trim().split(/\s+/).filter(Boolean).length;
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
      createdAt: Date.now(),
    };
    putStaging(entry);

    const detected = detectManuscriptLanguage(entry.sourceText, {
      author: entry.author,
      title: entry.title,
    });

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
        supportedLanguages: supportedLanguages(),
        chapters: entry.chapters.map((c) => ({
          id: c.id,
          title: c.title,
          /* Per-chapter wordCount lets the confirm view auto-suggest
             front/back-matter exclusion (short Dedication/Copyright
             pages stand out). Stripped to int to keep the wire shape
             simple. */
          wordCount: countWords(c.body),
        })),
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
         on the frontend, user-overridable). Defaults to 'en' when absent. */
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

    const author = (body.author ?? '').trim();
    const title = (body.title ?? '').trim();
    if (!author || !title) {
      return res.status(400).json({ error: 'author and title are required.' });
    }
    const isStandalone = !!body.isStandalone;
    const series = isStandalone ? STANDALONES_SERIES : (body.series ?? '').trim();
    if (!isStandalone && !series) {
      return res.status(400).json({ error: 'series is required (or set isStandalone=true).' });
    }
    const seriesPosition = isStandalone
      ? null
      : typeof body.seriesPosition === 'number' && Number.isFinite(body.seriesPosition)
        ? body.seriesPosition
        : null;

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
      language: normaliseBookLanguage(body.language),
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
