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

import { Router, type Request, type Response } from 'express';
import multer from 'multer';
import { nanoid } from 'nanoid';
import { existsSync } from 'node:fs';
import { writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { parseManuscript, UnsupportedFormatError } from '../parsers/index.js';
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
import { writeJsonAtomic } from '../workspace/state-io.js';
import type { BookStateJson } from '../workspace/scan.js';

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });

export const importRouter = Router();

const EXT_BY_FORMAT: Record<ManuscriptRecord['format'], string> = {
  markdown: 'md',
  plaintext: 'txt',
  epub: 'epub',
  pdf: 'pdf',
};

function deterministicGradient(seed: string): [string, string] {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = ((h << 5) - h + seed.charCodeAt(i)) | 0;
  const palette: Array<[string, string]> = [
    ['#3C194F', '#0F0E0D'], ['#6B6663', '#1A1A1A'], ['#D4A04E', '#7B5A26'],
    ['#A43C6C', '#3C194F'], ['#1F3A5F', '#0A1628'], ['#5C3A1E', '#2A1810'],
    ['#3E5F4A', '#162820'], ['#7A2E3C', '#2A0F14'],
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

    if (req.file) {
      parsed = await parseManuscript({
        buffer: req.file.buffer,
        fileName: req.file.originalname,
        mimeType: req.file.mimetype,
      });
      originalFileName = req.file.originalname;
      byteSize = req.file.size;
    } else if (typeof req.body?.text === 'string') {
      const fileName = typeof req.body?.fileName === 'string' ? req.body.fileName : undefined;
      parsed = await parseManuscript({ text: req.body.text, fileName });
      originalFileName = fileName ?? null;
      byteSize = Buffer.byteLength(parsed.sourceText, 'utf8');
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
      sourceText: parsed.sourceText,
      chapters: parsed.chapters,
      originalFileName,
      byteSize,
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
        sourceText: entry.sourceText,
        wordCount: countWords(entry.sourceText),
        byteSize: entry.byteSize,
        chapters: entry.chapters.map(c => ({ id: c.id, title: c.title })),
      },
    });
  } catch (e) {
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
    };

    if (!body?.tempId || typeof body.tempId !== 'string') {
      return res.status(400).json({ error: 'tempId is required.' });
    }
    const entry = getStaging(body.tempId);
    if (!entry) {
      return res.status(410).json({ error: 'Import expired or already consumed. Please re-upload.' });
    }

    const author = (body.author ?? '').trim();
    const title  = (body.title  ?? '').trim();
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
      : (typeof body.seriesPosition === 'number' && Number.isFinite(body.seriesPosition))
        ? Math.floor(body.seriesPosition)
        : null;

    ensureWorkspace();
    const bookDir = bookDirByDisplay(author, series, title);
    if (existsSync(bookDir)) {
      const suggestedTitle = `${title} (2)`;
      return res.status(409).json({ error: 'slug_collision', suggestedTitle });
    }

    const manuscriptId = 'mns_' + nanoid(10);
    const bookId = makeBookId(author, series, title);
    const manuscriptFile = `manuscript.${EXT_BY_FORMAT[entry.format]}`;
    const manuscriptPath = join(bookDir, manuscriptFile);

    await mkdir(bookDir, { recursive: true });
    await mkdir(dotAudiobook(bookDir), { recursive: true });
    await mkdir(join(bookDir, 'audio'), { recursive: true });
    await writeFile(manuscriptPath, entry.sourceText, 'utf8');

    const now = new Date().toISOString();
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
      chapters: entry.chapters.map(c => ({
        id: c.id,
        title: c.title,
        slug: `${String(c.id).padStart(2, '0')}-${slug(c.title)}`,
      })),
      coverGradient: deterministicGradient(bookId),
      createdAt: now,
      updatedAt: now,
    };
    await writeJsonAtomic(stateJsonPath(bookDir), state);

    const record: ManuscriptRecord = {
      manuscriptId,
      format: entry.format,
      title,
      wordCount: countWords(entry.sourceText),
      byteSize: entry.byteSize,
      uploadedAt: now,
      sourceText: entry.sourceText,
      chapterHints: entry.chapters as ChapterHint[],
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
