/* fs-22 — load a committed sample book (samples/<slug>/) into the workspace.
   Copies the manuscript + .audiobook/{state,cast,manuscript-edits} into the
   workspace book dir, merges the bundle's qwen voice files into the shared
   voices/qwen/ (no-clobber), mints a fresh manuscriptId, and registers a
   ManuscriptRecord — mirroring POST /api/books. Idempotent: a re-load of an
   existing book is a no-op 200. No audio ships; the analysis cache rebuilds
   from manuscript-edits.json on the first generate. */
import { Router } from 'express';
import type { Request, Response } from '../http.js';
import { existsSync } from 'node:fs';
import { readFile, mkdir, copyFile, readdir } from 'node:fs/promises';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { nanoid } from 'nanoid';
import { safeSegment, assertContained, sanitizeIdSegment } from '../util/safe-path.js';
import {
  WORKSPACE_ROOT,
  bookDirByDisplay,
  dotAudiobook,
  ensureWorkspace,
  makeBookId,
  stateJsonPath,
} from '../workspace/paths.js';
import { writeStateJsonAtomic } from '../workspace/state-migrate.js';
import { putManuscript, type ManuscriptRecord } from '../store/manuscripts.js';
import { parseManuscript } from '../parsers/index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SAMPLES_ROOT = resolve(__dirname, '..', '..', '..', 'samples');

export const samplesRouter = Router();

/* GET /api/samples — list the committed sample books. */
samplesRouter.get('/', async (_req: Request, res: Response) => {
  if (!existsSync(SAMPLES_ROOT)) return res.json({ samples: [] });
  const entries = await readdir(SAMPLES_ROOT, { withFileTypes: true });
  const samples: Array<{ slug: string; title: string; author: string }> = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const statePath = join(SAMPLES_ROOT, e.name, '.audiobook', 'state.json');
    if (!existsSync(statePath)) continue;
    const st = JSON.parse(await readFile(statePath, 'utf8'));
    samples.push({ slug: e.name, title: st.title, author: st.author });
  }
  res.json({ samples });
});

/* POST /api/samples/:slug/load — copy the sample into the workspace. */
samplesRouter.post('/:slug/load', async (req: Request, res: Response) => {
  try {
    const slug = req.params.slug;
    let src: string;
    try {
      src = join(SAMPLES_ROOT, sanitizeIdSegment(safeSegment(slug)));
      assertContained(SAMPLES_ROOT, src);
    } catch {
      return res.status(400).json({ error: 'Invalid sample slug.' });
    }
    if (!existsSync(join(src, '.audiobook', 'state.json'))) {
      return res.status(404).json({ error: `Sample not found: ${slug}` });
    }
    ensureWorkspace();

    const bundleState = JSON.parse(await readFile(join(src, '.audiobook', 'state.json'), 'utf8'));
    const { author, series, title, manuscriptFile } = bundleState;
    let safeManuscriptFile: string;
    try {
      safeManuscriptFile = sanitizeIdSegment(safeSegment(manuscriptFile));
    } catch {
      return res.status(400).json({ error: 'Invalid bundle manuscript file.' });
    }
    const bookDir = bookDirByDisplay(author, series, title);
    const bookId = makeBookId(author, series, title);

    // Idempotent: already present → no-op (never clobber a user's edited copy).
    if (existsSync(stateJsonPath(bookDir))) {
      return res.json({ bookId, alreadyLoaded: true });
    }

    await mkdir(dotAudiobook(bookDir), { recursive: true });

    // 1. Manuscript.
    const srcManuscript = join(src, safeManuscriptFile);
    const dstManuscript = join(bookDir, safeManuscriptFile);
    assertContained(src, srcManuscript);
    assertContained(bookDir, dstManuscript);
    await copyFile(srcManuscript, dstManuscript);

    // 2. .audiobook/{cast,manuscript-edits}.
    for (const f of ['cast.json', 'manuscript-edits.json']) {
      const srcAudiobookFile = join(src, '.audiobook', f);
      assertContained(src, srcAudiobookFile);
      if (existsSync(srcAudiobookFile)) {
        const dstAudiobookFile = join(dotAudiobook(bookDir), f);
        assertContained(bookDir, dstAudiobookFile);
        await copyFile(srcAudiobookFile, dstAudiobookFile);
      }
    }

    // 3. Fresh manuscriptId + state.json.
    const manuscriptId = `mns_${nanoid(10)}`;
    const now = new Date().toISOString();
    const state = {
      ...bundleState,
      bookId,
      manuscriptId,
      createdAt: now,
      updatedAt: now,
    };
    await writeStateJsonAtomic(stateJsonPath(bookDir), state);

    // 4. Merge bundle voices into workspace voices/qwen (no clobber).
    const srcVoices = join(src, 'voices', 'qwen');
    assertContained(src, srcVoices);
    if (existsSync(srcVoices)) {
      const dstVoices = join(WORKSPACE_ROOT, 'voices', 'qwen');
      await mkdir(dstVoices, { recursive: true });
      for (const f of await readdir(srcVoices)) {
        const srcVoiceFile = join(srcVoices, sanitizeIdSegment(safeSegment(f)));
        const dstVoiceFile = join(dstVoices, sanitizeIdSegment(safeSegment(f)));
        assertContained(srcVoices, srcVoiceFile);
        assertContained(dstVoices, dstVoiceFile);
        if (!existsSync(dstVoiceFile)) {
          await copyFile(srcVoiceFile, dstVoiceFile);
        }
      }
    }

    // 5. Register the ManuscriptRecord so the analysis/generation pipeline is wired.
    const buffer = await readFile(dstManuscript);
    const parsed = await parseManuscript({
      buffer,
      fileName: safeManuscriptFile,
      sourcePath: dstManuscript,
    });
    const record: ManuscriptRecord = {
      manuscriptId,
      format: parsed.format,
      title,
      wordCount: parsed.sourceText.trim().split(/\s+/).filter(Boolean).length,
      byteSize: Buffer.byteLength(parsed.sourceText, 'utf8'),
      uploadedAt: now,
      sourceText: parsed.sourceText,
      chapterHints: parsed.chapters.map((c) => ({ ...c })),
      bookId,
      bookDir,
    };
    putManuscript(record);

    res.json({ bookId, manuscriptId, alreadyLoaded: false });
  } catch (e) {
    console.error('[samples] load failed', e);
    res.status(500).json({ error: (e as Error).message || 'Failed to load sample.' });
  }
});
