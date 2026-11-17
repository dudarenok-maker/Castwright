import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { requestFailureMessageFs } from '../workspace/file-lock.js';
import { parseEpub, UnusableEpubError } from './epub.js';
import { UnusableMediaError } from './errors.js';
import { DrmProtectedError, parseMobi } from './mobi.js';
import { parseInWorker, parseInWorkerWithThread } from './parse-in-worker.js';

const fixture = (name: string): Buffer =>
  readFileSync(fileURLToPath(new URL(`./__fixtures__/${name}`, import.meta.url)));
const workerFixture = (name: string): URL =>
  new URL(`./__fixtures__/workers/${name}`, import.meta.url);

const EPUB_CRASH = 'This EPUB could not be read: the file appears to be malformed.';
const TIMEOUT = 'This book took too long to read and was stopped.';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('parseInWorker', () => {
  it.each(['sample.epub', 'sample-opf-prefixed.epub'])(
    'parses %s off the main thread, identical to in-process',
    async (name) => {
      const buffer = fixture(name);
      const expected = await parseEpub(buffer, { fileName: name });
      const { parsed, threadId } = await parseInWorkerWithThread({
        format: 'epub',
        buffer,
        fileName: name,
      });
      expect(parsed).toStrictEqual(expected);
      expect(JSON.stringify(parsed)).toBe(JSON.stringify(expected));
      expect(threadId).not.toBe(0);
    },
    30_000,
  );

  describe('error classes cross the thread', () => {
    it('a DRM EPUB rejects as UnusableEpubError with the in-process message', async () => {
      const buffer = fixture('sample-epub-drm.epub');
      const inProcess = await parseEpub(buffer, { fileName: 'drm.epub' }).catch((e) => e);
      expect(inProcess).toBeInstanceOf(UnusableEpubError);
      const err = await parseInWorker({ format: 'epub', buffer, fileName: 'drm.epub' }).catch(
        (e) => e,
      );
      expect(err).toBeInstanceOf(UnusableEpubError);
      expect(err).toBeInstanceOf(UnusableMediaError);
      expect(err.message).toBe(inProcess.message);
    }, 30_000);

    it('an encrypted MOBI rejects as DrmProtectedError with the in-process message', async () => {
      const buffer = Buffer.alloc(256, 0);
      buffer.writeUInt32BE(96, 78);
      buffer.writeUInt16BE(2, 96 + 0x0c);
      const inProcess = await parseMobi(buffer, { fileName: 'drm.mobi' }).catch((e) => e);
      expect(inProcess).toBeInstanceOf(DrmProtectedError);
      const err = await parseInWorker({ format: 'mobi', buffer, fileName: 'drm.mobi' }).catch(
        (e) => e,
      );
      expect(err).toBeInstanceOf(DrmProtectedError);
      expect(err).toBeInstanceOf(UnusableMediaError);
      expect(err.message).toBe(inProcess.message);
    }, 30_000);

    it('an fs error keeps code and syscall and gets the fs sentence', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'parse-worker-'));
      const sourcePath = join(dir, 'missing.epub');
      const req = { format: 'epub' as const, buffer: Buffer.alloc(0), sourcePath };
      const inProcess = await parseEpub(req.buffer, { sourcePath }).catch((e) => e);
      const err = await parseInWorker(req).catch((e) => e);
      expect(err.code).toBe('ENOENT');
      expect(typeof err.syscall).toBe('string');
      expect(err.code).toBe(inProcess.code);
      expect(err.syscall).toBe(inProcess.syscall);
      expect(requestFailureMessageFs(err, 'x')).not.toBe('x');
    }, 30_000);
  });

  describe('crash, silent exit, timeout', () => {
    it.each(['throw-in-callback.mjs', 'exit-silently.mjs'])(
      '%s rejects with the fixed path-free EPUB sentence',
      async (name) => {
        const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
        const err = await parseInWorker(
          { format: 'epub', buffer: Buffer.alloc(1) },
          { workerUrl: workerFixture(name) },
        ).catch((e) => e);
        expect(err).toBeInstanceOf(UnusableEpubError);
        expect(err.message).toBe(EPUB_CRASH);
        expect(err.message).not.toContain('secret');
        expect(spy).toHaveBeenCalled();
      },
      30_000,
    );

    it('a MOBI crash is a plain UnusableMediaError with the MOBI sentence', async () => {
      vi.spyOn(console, 'error').mockImplementation(() => {});
      const err = await parseInWorker(
        { format: 'mobi', buffer: Buffer.alloc(1) },
        { workerUrl: workerFixture('exit-silently.mjs') },
      ).catch((e) => e);
      expect(err).toBeInstanceOf(UnusableMediaError);
      expect(err).not.toBeInstanceOf(UnusableEpubError);
      expect(err.name).toBe('UnusableMediaError');
      expect(err.message).toBe(
        'This MOBI/AZW3 file could not be read: the file appears to be malformed.',
      );
    }, 30_000);

    it('a hang is stopped by the timeout', async () => {
      vi.spyOn(console, 'error').mockImplementation(() => {});
      const err = await parseInWorker(
        { format: 'epub', buffer: Buffer.alloc(1) },
        { workerUrl: workerFixture('hang.mjs'), timeoutMs: 200 },
      ).catch((e) => e);
      expect(err).toBeInstanceOf(UnusableEpubError);
      expect(err.message).toBe(TIMEOUT);
    }, 10_000);

    it('two parses at once are independent: one crashes, the other fulfils', async () => {
      vi.spyOn(console, 'error').mockImplementation(() => {});
      const req = { format: 'epub' as const, buffer: Buffer.alloc(1) };
      const [a, b] = await Promise.allSettled([
        parseInWorker(req, { workerUrl: workerFixture('throw-in-callback.mjs') }),
        parseInWorker(req, { workerUrl: workerFixture('slow-ok.mjs') }),
      ]);
      expect(a.status).toBe('rejected');
      expect(a.status === 'rejected' && a.reason.message).toBe(EPUB_CRASH);
      expect(b.status).toBe('fulfilled');
    }, 30_000);
  });
});
