/* POST /api/manuscripts
   - multipart/form-data with `file` (and optional `title` override), OR
   - application/json with `text` (and optional `title`).
   Response shape matches UploadResponse in openapi.yaml. */

import { Router, type Request, type Response } from 'express';
import multer from 'multer';
import { nanoid } from 'nanoid';
import { parseManuscript, UnsupportedFormatError } from '../parsers/index.js';
import { putManuscript, type ManuscriptRecord } from '../store/manuscripts.js';

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

export const manuscriptsRouter = Router();

manuscriptsRouter.post('/', upload.single('file'), async (req: Request, res: Response) => {
  try {
    const titleOverride = typeof req.body?.title === 'string' ? req.body.title.trim() : undefined;
    let parsed;

    if (req.file) {
      parsed = await parseManuscript({
        buffer: req.file.buffer,
        fileName: req.file.originalname,
        mimeType: req.file.mimetype,
      });
    } else if (typeof req.body?.text === 'string') {
      const fileName = typeof req.body?.fileName === 'string' ? req.body.fileName : undefined;
      parsed = await parseManuscript({ text: req.body.text, fileName });
    } else {
      return res.status(400).json({ error: 'Provide either multipart `file` or JSON `text`.' });
    }

    const wordCount = parsed.sourceText.trim().split(/\s+/).filter(Boolean).length;
    const byteSize = req.file ? req.file.size : Buffer.byteLength(parsed.sourceText, 'utf8');

    const record: ManuscriptRecord = {
      manuscriptId: 'mns_' + nanoid(10),
      format: parsed.format,
      title: titleOverride || parsed.title,
      wordCount,
      byteSize,
      uploadedAt: new Date().toISOString(),
      sourceText: parsed.sourceText,
      chapterHints: parsed.chapters,
    };

    putManuscript(record);

    return res.json({
      manuscriptId: record.manuscriptId,
      format:       record.format,
      title:        record.title,
      wordCount:    record.wordCount,
      byteSize:     record.byteSize,
      uploadedAt:   record.uploadedAt,
      sourceText:   record.sourceText,
    });
  } catch (e) {
    if (e instanceof UnsupportedFormatError) {
      return res.status(415).json({ error: e.message });
    }
    console.error('[manuscripts] upload failed', e);
    return res.status(500).json({ error: (e as Error).message || 'Upload failed.' });
  }
});
