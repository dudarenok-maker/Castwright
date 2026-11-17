import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import type { Worker } from 'node:worker_threads';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { requestFailureMessageFs } from '../workspace/file-lock.js';
import { parseEpub, UnusableEpubError } from './epub.js';
import { UnusableMediaError } from './errors.js';
import { buildMinimalMobi } from '../test-utils/minimal-mobi.js';
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
      const expected = await parseEpub(buffer, { fileName: name, extractorVersion: 1 });
      const { parsed, threadId } = await parseInWorkerWithThread({
        format: 'epub',
        buffer,
        fileName: name,
        extractorVersion: 1,
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
      const inProcess = await parseEpub(buffer, { fileName: 'drm.epub', extractorVersion: 1 }).catch((e) => e);
      expect(inProcess).toBeInstanceOf(UnusableEpubError);
      const err = await parseInWorker({ format: 'epub', buffer, fileName: 'drm.epub', extractorVersion: 1 }).catch(
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
      const inProcess = await parseMobi(buffer, { fileName: 'drm.mobi', extractorVersion: 1 }).catch((e) => e);
      expect(inProcess).toBeInstanceOf(DrmProtectedError);
      const err = await parseInWorker({ format: 'mobi', buffer, fileName: 'drm.mobi', extractorVersion: 1 }).catch(
        (e) => e,
      );
      expect(err).toBeInstanceOf(DrmProtectedError);
      expect(err).toBeInstanceOf(UnusableMediaError);
      expect(err.message).toBe(inProcess.message);
    }, 30_000);

    it('an fs error keeps code and syscall and gets the fs sentence', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'parse-worker-'));
      const sourcePath = join(dir, 'missing.epub');
      const req = { format: 'epub' as const, buffer: Buffer.alloc(0), sourcePath, extractorVersion: 1 };
      const inProcess = await parseEpub(req.buffer, { sourcePath, extractorVersion: 1 }).catch((e) => e);
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
          { format: 'epub', buffer: Buffer.alloc(1), extractorVersion: 1 },
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
        { format: 'mobi', buffer: Buffer.alloc(1), extractorVersion: 1 },
        { workerUrl: workerFixture('exit-silently.mjs') },
      ).catch((e) => e);
      expect(err).toBeInstanceOf(UnusableMediaError);
      expect(err).not.toBeInstanceOf(UnusableEpubError);
      expect(err.name).toBe('UnusableMediaError');
      expect(err.message).toBe(
        'This MOBI/AZW3 file could not be read: the file appears to be malformed.',
      );
    }, 30_000);

    it('a hang is stopped by the timeout, and the worker is actually terminated', async () => {
      vi.spyOn(console, 'error').mockImplementation(() => {});
      let worker: Worker | undefined;
      let exited = false;
      const err = await parseInWorker(
        { format: 'epub', buffer: Buffer.alloc(1), extractorVersion: 1 },
        {
          workerUrl: workerFixture('hang.mjs'),
          timeoutMs: 200,
          onWorker: (w) => {
            worker = w;
            w.once('exit', () => (exited = true));
          },
        },
      ).catch((e) => e);
      expect(err).toBeInstanceOf(UnusableEpubError);
      expect(err.message).toBe(TIMEOUT);
      /* hang.mjs holds a setInterval forever: only terminate() ends it. */
      if (!exited) await Promise.race([once(worker!, 'exit'), new Promise((r) => setTimeout(r, 3000))]);
      expect(exited).toBe(true);
    }, 10_000);

    it('a stray unhandled rejection in the worker is logged, not fatal to the parse', async () => {
      const buffer = fixture('sample.epub');
      const expected = await parseEpub(buffer, { fileName: 'sample.epub', extractorVersion: 1 });
      const parsed = await parseInWorker(
        { format: 'epub', buffer, fileName: 'sample.epub', extractorVersion: 1 },
        { workerUrl: workerFixture('stray-rejection-then-real-parse.mjs') },
      );
      expect(parsed).toStrictEqual(expected);
    }, 30_000);

    describe('the per-parse scratch dir is removed whatever the outcome', () => {
      const roots: string[] = [];
      const freshRoot = (): string => {
        const r = mkdtempSync(join(tmpdir(), 'scratch-root-'));
        roots.push(r);
        return r;
      };
      /* The scratch rm runs in the background after the worker exits, so a
         test that inspects the root awaits it through the onCleanup seam. */
      const trackCleanup = (): { onCleanup: (p: Promise<void>) => void; done: () => Promise<void> } => {
        let pending: Promise<void> = Promise.resolve();
        return { onCleanup: (p) => (pending = p), done: () => pending };
      };
      afterEach(() => {
        for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
      });

      it('a worker crash after writing temp files leaves nothing behind', async () => {
        const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
        const scratchRoot = freshRoot();
        const cleanup = trackCleanup();
        const err = await parseInWorker(
          { format: 'epub', buffer: Buffer.alloc(1), extractorVersion: 1 },
          { workerUrl: workerFixture('crash-with-scratch.mjs'), scratchRoot, onCleanup: cleanup.onCleanup },
        ).catch((e) => e);
        await cleanup.done();
        expect(err.message).toBe(EPUB_CRASH);
        /* positive control: the fixture really wrote into the scratch dir */
        expect(JSON.stringify(spy.mock.calls.flat().map(String))).toContain('boom after scratch write');
        expect(readdirSync(scratchRoot)).toEqual([]);
      }, 30_000);

      it('a timed-out parse leaves nothing behind', async () => {
        vi.spyOn(console, 'error').mockImplementation(() => {});
        const scratchRoot = freshRoot();
        const cleanup = trackCleanup();
        let wrote = false;
        const err = await parseInWorker(
          { format: 'mobi', buffer: Buffer.alloc(1), extractorVersion: 1 },
          {
            workerUrl: workerFixture('hang-with-scratch.mjs'),
            scratchRoot,
            timeoutMs: 1500,
            onCleanup: cleanup.onCleanup,
            onWorker: (w) => {
              w.once('online', () => {
                /* hang-with-scratch writes immediately; poll until it shows */
                const t = setInterval(() => {
                  if (readdirSync(scratchRoot).length > 0) {
                    wrote = true;
                    clearInterval(t);
                  }
                }, 10);
                setTimeout(() => clearInterval(t), 1400);
              });
            },
          },
        ).catch((e) => e);
        await cleanup.done();
        expect(err.message).toBe(TIMEOUT);
        expect(wrote).toBe(true);
        expect(readdirSync(scratchRoot)).toEqual([]);
      }, 30_000);

      it('the parsers put their temp files inside a given scratchDir, not tmpdir()', async () => {
        const missing = join(freshRoot(), 'no-such-dir');
        const epub = await parseEpub(fixture('sample.epub'), {
          fileName: 'sample.epub',
          extractorVersion: 1,
          scratchDir: missing,
        }).catch((e) => e);
        expect(epub.code).toBe('ENOENT');
        const mobi = await parseMobi(buildMinimalMobi('<p>A</p>'), {
          fileName: 'a.mobi',
          extractorVersion: 1,
          scratchDir: missing,
        }).catch((e) => e);
        expect(mobi.code).toBe('ENOENT');
      });

      it('the timeout bounds the caller, and the scratch rm runs only after the worker has exited', async () => {
        vi.spyOn(console, 'error').mockImplementation(() => {});
        const scratchRoot = freshRoot();
        let exited = false;
        const cleanup = trackCleanup();
        const t0 = Date.now();
        const err = await parseInWorker(
          { format: 'epub', buffer: Buffer.alloc(1), extractorVersion: 1 },
          {
            workerUrl: workerFixture('hang-with-threadpool-io.mjs'),
            scratchRoot,
            timeoutMs: 150,
            onWorker: (w) => w.once('exit', () => (exited = true)),
            onCleanup: cleanup.onCleanup,
          },
        ).catch((e) => e);
        const elapsed = Date.now() - t0;
        expect(err.message).toBe(TIMEOUT);
        /* positive control: terminate() really is held up by the threadpool work */
        expect(exited).toBe(false);
        expect(elapsed).toBeLessThan(150 + 400);
        expect(readdirSync(scratchRoot)).not.toEqual([]);
        await cleanup.done();
        expect(exited).toBe(true);
        expect(readdirSync(scratchRoot)).toEqual([]);
      }, 30_000);

      it('the real worker forwards scratchDir to both parsers (not tmpdir())', async () => {
        const workerUrl = workerFixture('real-worker-missing-scratch.mjs');
        const epub = await parseInWorker(
          { format: 'epub', buffer: fixture('sample.epub'), fileName: 'sample.epub', extractorVersion: 1 },
          { workerUrl, scratchRoot: freshRoot() },
        ).catch((e) => e);
        expect(epub.code).toBe('ENOENT');
        const mobi = await parseInWorker(
          { format: 'mobi', buffer: buildMinimalMobi('<p>A</p>'), fileName: 'a.mobi', extractorVersion: 1 },
          { workerUrl, scratchRoot: freshRoot() },
        ).catch((e) => e);
        expect(mobi.code).toBe('ENOENT');
      }, 30_000);

      it('a successful real parse leaves nothing behind either', async () => {
        const scratchRoot = freshRoot();
        const cleanup = trackCleanup();
        await parseInWorker(
          { format: 'epub', buffer: fixture('sample.epub'), fileName: 'sample.epub', extractorVersion: 1 },
          { scratchRoot, onCleanup: cleanup.onCleanup },
        );
        await cleanup.done();
        expect(readdirSync(scratchRoot)).toEqual([]);
        expect(existsSync(scratchRoot)).toBe(true);
      }, 30_000);
    });

    it('two parses at once are independent: one crashes, the other fulfils', async () => {
      vi.spyOn(console, 'error').mockImplementation(() => {});
      const req = { format: 'epub' as const, buffer: Buffer.alloc(1), extractorVersion: 1 };
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
