/* #3625 review — a lock-acquisition timeout in the portable-import handler is
   answered with the curated contention sentence (requestFailureMessage), not
   the generic failure text, and never carries the lock key (which embeds the
   absolute workspace path). importPortableBundle is mocked: a real 10s lock
   budget would race vitest's own timeout. */

import { describe, it, expect, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { LOCK_CONTENTION_REQUEST_ERROR, LockAcquisitionTimeoutError } from '../workspace/file-lock.js';

const SECRET_KEY = 'state:C:/Users/someone/Castwright/books/A/S/T';

vi.mock('../import/scan-import-folder.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../import/scan-import-folder.js')>();
  return {
    ...actual,
    importPortableBundle: vi.fn(async () => {
      throw new LockAcquisitionTimeoutError(SECRET_KEY, 10_000);
    }),
  };
});

import { portableImportRouter } from './exports-portable.js';

describe('POST /api/import/portable — lock contention (#3625)', () => {
  it('answers a state-lock timeout with the contention sentence and no path', async () => {
    const app = express();
    app.use('/api/import', portableImportRouter);
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const res = await request(app)
        .post('/api/import/portable')
        .attach('file', Buffer.from('zip-bytes'), 'bundle.zip');
      expect(res.status).toBe(500);
      expect(res.body.message).toBe(LOCK_CONTENTION_REQUEST_ERROR);
      expect(JSON.stringify(res.body)).not.toContain('Castwright');
      expect(JSON.stringify(res.body)).not.toContain('someone');
    } finally {
      errSpy.mockRestore();
    }
  });
});
