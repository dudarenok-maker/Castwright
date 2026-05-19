/* Plan 61 — install-bootstrap state machine.
 *
 * Drives the full
 *   idle → detecting → downloading → installing → installed
 * sweep with fully stubbed http + spawn + detect. No real network, no
 * real process spawn — the suite must pass on CI runners with no
 * Ollama installed. */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import {
  InstallBootstrap,
  defaultResolveAssetUrl,
  type HttpFn,
  type SpawnFn,
} from './install-bootstrap.js';

function makeFakeChild(opts: { exitCode?: number; stdout?: string; err?: Error } = {}) {
  const emitter = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter;
    stderr: EventEmitter;
  };
  emitter.stdout = new EventEmitter();
  emitter.stderr = new EventEmitter();
  setImmediate(() => {
    if (opts.err) {
      emitter.emit('error', opts.err);
      return;
    }
    if (opts.stdout) emitter.stdout.emit('data', Buffer.from(opts.stdout, 'utf8'));
    emitter.emit('close', opts.exitCode ?? 0);
  });
  return emitter;
}

function makeBytes(size: number): Buffer {
  return Buffer.alloc(size, 'x');
}

function makeHttpFn(opts: {
  ok?: boolean;
  status?: number;
  body?: Buffer;
}): HttpFn {
  return () => {
    const body = opts.body ?? makeBytes(4096);
    /* Readable.from([Buffer]) defaults to object mode. We need a real
       byte stream so pipe() into a fs WriteStream actually writes
       bytes and stat() sees the on-disk size. */
    return Promise.resolve({
      ok: opts.ok ?? true,
      status: opts.status ?? 200,
      contentLength: body.length,
      body: new Readable({
        read() {
          this.push(body);
          this.push(null);
        },
      }),
    });
  };
}

/* Pure helper for the unit-suite that doesn't poke the state machine. */
describe('defaultResolveAssetUrl', () => {
  it('returns the macOS zip on darwin', () => {
    expect(defaultResolveAssetUrl('darwin', 'arm64')).toContain('Ollama-darwin.zip');
  });
  it('returns the linux amd64 tarball on linux/x64', () => {
    expect(defaultResolveAssetUrl('linux', 'x64')).toContain('linux-amd64.tgz');
  });
  it('returns the linux arm64 tarball on linux/arm64', () => {
    expect(defaultResolveAssetUrl('linux', 'arm64')).toContain('linux-arm64.tgz');
  });
  it('returns the windows .exe on win32', () => {
    expect(defaultResolveAssetUrl('win32', 'x64')).toContain('OllamaSetup.exe');
  });
  it('throws for unknown platforms', () => {
    expect(() => defaultResolveAssetUrl('freebsd' as NodeJS.Platform, 'x64')).toThrow();
  });
});

describe('InstallBootstrap.detect', () => {
  it('returns installed=true with the version when `ollama -v` succeeds', async () => {
    const spawnFn = vi.fn().mockReturnValue(
      makeFakeChild({ stdout: 'ollama version 0.5.4\n', exitCode: 0 }),
    ) as unknown as SpawnFn;
    const boot = new InstallBootstrap({ spawnFn });
    const r = await boot.detect();
    expect(r.installed).toBe(true);
    expect(r.version).toBe('ollama version 0.5.4');
  });

  it('returns installed=false when the spawn throws', async () => {
    const spawnFn = vi.fn().mockImplementation(() => {
      throw new Error('ENOENT');
    }) as unknown as SpawnFn;
    const boot = new InstallBootstrap({ spawnFn });
    const r = await boot.detect();
    expect(r.installed).toBe(false);
    expect(r.version).toBeNull();
  });

  it('returns installed=false when the child exits non-zero', async () => {
    const spawnFn = vi
      .fn()
      .mockReturnValue(makeFakeChild({ exitCode: 1 })) as unknown as SpawnFn;
    const boot = new InstallBootstrap({ spawnFn });
    const r = await boot.detect();
    expect(r.installed).toBe(false);
  });
});

describe('InstallBootstrap.start — state machine', () => {
  let downloadDir: string;
  beforeEach(() => {
    downloadDir = mkdtempSync(join(tmpdir(), 'ollama-install-test-'));
  });

  it('short-circuits to "installed" when ollama is already on PATH', async () => {
    const detect = vi.fn().mockResolvedValue('ollama version 0.5.4');
    const httpFn = vi.fn() as unknown as HttpFn;
    const boot = new InstallBootstrap({
      detectOllama: detect,
      httpFn,
      downloadDir,
    });
    const job = boot.start();
    /* run() is async — give it a tick to complete the short-circuit. */
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    const finalJob = boot.getJob(job.id);
    expect(finalJob?.status).toBe('installed');
    /* No network roundtrip — we short-circuited. */
    expect(httpFn).not.toHaveBeenCalled();
  });

  it('walks detecting → downloading → installing → installed on linux', async () => {
    /* First detect call (in run): returns null = not installed.
       Second detect call (post-install): returns the version. */
    const detect = vi
      .fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce('ollama version 0.5.4');
    const httpFn = makeHttpFn({ ok: true, body: makeBytes(8 * 1024) });
    /* The installer subprocess (bash <path>) — return success. */
    const spawnFn = vi.fn().mockImplementation(() =>
      makeFakeChild({ exitCode: 0 }),
    ) as unknown as SpawnFn;
    const boot = new InstallBootstrap({
      detectOllama: detect,
      httpFn,
      spawnFn,
      getPlatform: () => 'linux',
      getArch: () => 'x64',
      downloadDir,
    });
    const job = boot.start();
    expect(job.status).toBe('detecting');
    /* Drain microtasks until the state machine completes. We bound
       this to 200 ticks so a hung test fails loudly. */
    for (let i = 0; i < 200; i++) {
      await new Promise((r) => setTimeout(r, 5));
      const j = boot.getJob(job.id);
      if (j?.status === 'installed' || j?.status === 'error') break;
    }
    const finalJob = boot.getJob(job.id);
    expect(finalJob?.status).toBe('installed');
    expect(finalJob?.error).toBeNull();
    expect(detect).toHaveBeenCalledTimes(2);
    expect(spawnFn).toHaveBeenCalledWith('bash', expect.any(Array));
  });

  it('windows path stays in "installing" with manualInstallerPath set after download', async () => {
    const detect = vi.fn().mockResolvedValue(null);
    const httpFn = makeHttpFn({ ok: true, body: makeBytes(8 * 1024) });
    const spawnFn = vi.fn() as unknown as SpawnFn;
    const boot = new InstallBootstrap({
      detectOllama: detect,
      httpFn,
      spawnFn,
      getPlatform: () => 'win32',
      getArch: () => 'x64',
      downloadDir,
    });
    const job = boot.start();
    for (let i = 0; i < 200; i++) {
      await new Promise((r) => setTimeout(r, 5));
      const j = boot.getJob(job.id);
      if (j?.status === 'installing' && j.manualInstallerPath) break;
    }
    const finalJob = boot.getJob(job.id);
    expect(finalJob?.status).toBe('installing');
    expect(finalJob?.manualInstallerPath).toMatch(/OllamaSetup\.exe$/);
    /* We did NOT call spawn — Windows installer is GUI-only. */
    expect(spawnFn).not.toHaveBeenCalled();
    /* The downloaded bytes really landed on disk. */
    expect(readFileSync(finalJob!.manualInstallerPath!).length).toBeGreaterThanOrEqual(8 * 1024);
  });

  it('windows recheck promotes installing → installed when ollama appears on PATH', async () => {
    /* Stage the job in "installing" then flip the detector. */
    const detect = vi
      .fn()
      .mockResolvedValueOnce(null) // first call inside run()
      .mockResolvedValueOnce('ollama version 0.5.4'); // recheck call
    const httpFn = makeHttpFn({ body: makeBytes(8 * 1024) });
    const spawnFn = vi.fn() as unknown as SpawnFn;
    const boot = new InstallBootstrap({
      detectOllama: detect,
      httpFn,
      spawnFn,
      getPlatform: () => 'win32',
      getArch: () => 'x64',
      downloadDir,
    });
    const job = boot.start();
    for (let i = 0; i < 200; i++) {
      await new Promise((r) => setTimeout(r, 5));
      if (boot.getJob(job.id)?.status === 'installing') break;
    }
    const after = await boot.recheck(job.id);
    expect(after?.status).toBe('installed');
  });

  it('transitions to error when the download HTTP call fails', async () => {
    const detect = vi.fn().mockResolvedValue(null);
    const httpFn = makeHttpFn({ ok: false, status: 502 });
    const boot = new InstallBootstrap({
      detectOllama: detect,
      httpFn,
      getPlatform: () => 'linux',
      downloadDir,
    });
    const job = boot.start();
    for (let i = 0; i < 200; i++) {
      await new Promise((r) => setTimeout(r, 5));
      if (boot.getJob(job.id)?.status === 'error') break;
    }
    const j = boot.getJob(job.id);
    expect(j?.status).toBe('error');
    expect(j?.error).toMatch(/502/);
  });

  it('transitions to error when the downloaded bytes are < 1KB (looks like an error page)', async () => {
    const detect = vi.fn().mockResolvedValue(null);
    const httpFn = makeHttpFn({ ok: true, body: makeBytes(100) });
    const boot = new InstallBootstrap({
      detectOllama: detect,
      httpFn,
      getPlatform: () => 'linux',
      downloadDir,
    });
    const job = boot.start();
    for (let i = 0; i < 200; i++) {
      await new Promise((r) => setTimeout(r, 5));
      if (boot.getJob(job.id)?.status === 'error') break;
    }
    const j = boot.getJob(job.id);
    expect(j?.status).toBe('error');
    expect(j?.error).toMatch(/100 bytes/);
  });

  it('reports bytesReceived progressively while downloading', async () => {
    /* Use a 512 KB body so two progress ticks fire (256 KB threshold). */
    const httpFn = makeHttpFn({ body: makeBytes(512 * 1024) });
    const spawnFn = vi.fn().mockImplementation(() =>
      makeFakeChild({ exitCode: 0 }),
    ) as unknown as SpawnFn;
    const detectAfter = vi.fn().mockResolvedValue('ollama version 0.5.4');
    const boot = new InstallBootstrap({
      detectOllama: vi.fn().mockResolvedValueOnce(null).mockImplementation(detectAfter),
      httpFn,
      spawnFn,
      getPlatform: () => 'linux',
      downloadDir,
    });
    const job = boot.start();
    for (let i = 0; i < 400; i++) {
      await new Promise((r) => setTimeout(r, 5));
      if (boot.getJob(job.id)?.status === 'installed') break;
    }
    const j = boot.getJob(job.id);
    expect(j?.bytesReceived).toBe(512 * 1024);
    expect(j?.bytesTotal).toBe(512 * 1024);
  });

  it('coalesces parallel start() calls — only one active job at a time', () => {
    const httpFn = vi.fn(() =>
      Promise.resolve({
        ok: true,
        status: 200,
        contentLength: 4096,
        /* Never-resolving body keeps the job pinned in "downloading" */
        body: new Readable({ read() { /* idle */ } }),
      }),
    ) as unknown as HttpFn;
    const boot = new InstallBootstrap({
      detectOllama: () => Promise.resolve(null),
      httpFn,
      getPlatform: () => 'linux',
      downloadDir,
    });
    const a = boot.start();
    const b = boot.start();
    expect(b.id).toBe(a.id);
  });
});
