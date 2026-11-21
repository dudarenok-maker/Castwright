import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { existsSync, mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir, networkInterfaces } from 'node:os';
import { join } from 'node:path';

/* #4446 — host paths collapse the home dir to `~` for non-loopback clients.
   Real assembled app over real sockets, modelled on app.health-loopback.test.ts.
   Later children of the chain extend this file. */

const lanIp = Object.values(networkInterfaces())
  .flat()
  .find((i) => i && i.family === 'IPv4' && !i.internal)?.address;

let home: string;
let server: http.Server;
let port: number;
const saved: Record<string, string | undefined> = {};
const KEYS = ['HOME', 'USERPROFILE', 'WORKSPACE_DIR', 'USER_SETTINGS_FILE', 'HF_HOME', 'OLLAMA_URL', 'LOCAL_TTS_URL'];

beforeAll(async () => {
  for (const k of KEYS) saved[k] = process.env[k];
  home = realpathSync(mkdtempSync(join(tmpdir(), 'cw-lan-path-')));
  mkdirSync(join(home, 'ws'), { recursive: true });
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  process.env.WORKSPACE_DIR = join(home, 'ws');
  process.env.USER_SETTINGS_FILE = join(home, 'user-settings.json');
  process.env.HF_HOME = join(home, 'hf');
  process.env.OLLAMA_URL = 'http://127.0.0.1:1';
  process.env.LOCAL_TTS_URL = 'http://127.0.0.1:1';
  vi.resetModules();
  const { app } = await import('./app.js');
  server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, '0.0.0.0', r));
  port = (server.address() as AddressInfo).port;
});
afterAll(async () => {
  await new Promise((r) => server.close(r));
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  rmSync(home, { recursive: true, force: true });
});

function getJson(host: string, path: string, headers: Record<string, string> = {}) {
  return new Promise<{ status: number; body: any }>((resolve, reject) => {
    http
      .get({ host, port, path, headers }, (res) => {
        let raw = '';
        res.on('data', (c) => (raw += c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: JSON.parse(raw) }));
      })
      .on('error', reject);
  });
}

describe('GET /api/workspace path collapse on the real app (#4446)', () => {
  it('a loopback connection gets full absolute paths under the fake home', async () => {
    const res = await getJson('127.0.0.1', '/api/workspace');
    expect(res.status).toBe(200);
    expect(res.body.root.startsWith(home)).toBe(true);
    expect(res.body.booksRoot.startsWith(home)).toBe(true);
  });

  it.runIf(!!process.env.CI)('CI host has a non-internal IPv4 (the LAN cases below must run)', () => {
    expect(lanIp).toBeTruthy();
  });

  describe.skipIf(!lanIp)(`from a LAN address (${lanIp ?? 'none: no non-internal IPv4 on this host'})`, () => {
    it('collapses home to ~ and keeps the rest', async () => {
      const lo = await getJson('127.0.0.1', '/api/workspace');
      const lan = await getJson(lanIp!, '/api/workspace');
      expect(lan.status).toBe(200);
      expect(lan.body.root).toBe('~' + lo.body.root.slice(home.length));
      expect(lan.body.booksRoot).toBe('~' + lo.body.booksRoot.slice(home.length));
      expect(lan.body.root.startsWith('~')).toBe(true);
    });

    it.each([
      ['X-Forwarded-For', '127.0.0.1'],
      ['Host', 'localhost'],
    ])('a spoofed %s: %s still collapses', async (name, value) => {
      const res = await getJson(lanIp!, '/api/workspace', { [name]: value });
      expect(res.body.root.startsWith('~')).toBe(true);
      expect(res.body.booksRoot.startsWith('~')).toBe(true);
    });
  });
});

type InvItem = { id: string; diskPath: string | null };

describe('/api/models diskPath collapse on the real app (#4446)', () => {
  it('loopback: every non-null diskPath is absolute and unchanged; some live under the fake home', async () => {
    const lo = await getJson('127.0.0.1', '/api/models/inventory');
    expect(lo.status).toBe(200);
    const paths = (lo.body.items as InvItem[]).map((i) => i.diskPath).filter((p): p is string => p !== null);
    expect(paths.length).toBeGreaterThan(0);
    expect(paths.some((p) => p.startsWith(home))).toBe(true); // non-vacuity
    expect(paths.every((p) => !p.startsWith('~'))).toBe(true);
  });

  describe.skipIf(!lanIp)('from a LAN address', () => {
    it('collapses home to ~, leaves non-home paths and null alone', async () => {
      const lo = (await getJson('127.0.0.1', '/api/models/inventory')).body.items as InvItem[];
      const lan = (await getJson(lanIp!, '/api/models/inventory')).body.items as InvItem[];
      expect(lan.length).toBe(lo.length);
      for (const l of lan) {
        const orig = lo.find((i) => i.id === l.id)!;
        if (orig.diskPath === null) expect(l.diskPath).toBeNull();
        else if (orig.diskPath.startsWith(home)) expect(l.diskPath).toBe('~' + orig.diskPath.slice(home.length));
        else expect(l.diskPath).toBe(orig.diskPath);
        if (l.diskPath !== null) expect(l.diskPath.startsWith(home)).toBe(false);
      }
      expect(lan.some((i) => i.diskPath?.startsWith('~'))).toBe(true);
      const kokoro = lan.find((i) => i.id === 'kokoro')!;
      const kokoroLo = lo.find((i) => i.id === 'kokoro')!;
      if (kokoroLo.diskPath && !kokoroLo.diskPath.startsWith(home)) {
        expect(kokoro.diskPath).toBe(kokoroLo.diskPath);
      }
    });

    it('POST /:id/remove of a not-present model returns a collapsed item.diskPath', async () => {
      // qwen-base under the empty fake HF_HOME is not present -> removed:false + item, nothing deleted.
      const lan = await postJson(lanIp!, '/api/models/qwen-base/remove');
      expect(lan.status).toBe(200);
      expect(lan.body.removed).toBe(false);
      expect(lan.body.item.diskPath.startsWith('~')).toBe(true);
      expect(lan.body.item.diskPath.startsWith(home)).toBe(false);
      const lo = await postJson('127.0.0.1', '/api/models/qwen-base/remove');
      expect(lo.body.item.diskPath.startsWith(home)).toBe(true);
    });
  });
});

function postJson(host: string, path: string) {
  return new Promise<{ status: number; body: any }>((resolve, reject) => {
    const r = http.request({ host, port, path, method: 'POST' }, (res) => {
      let raw = '';
      res.on('data', (c) => (raw += c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: JSON.parse(raw) }));
    });
    r.on('error', reject);
    r.end();
  });
}

function sendJson(host: string, method: string, path: string, payload?: unknown) {
  return new Promise<{ status: number; body: any }>((resolve, reject) => {
    const data = payload === undefined ? undefined : JSON.stringify(payload);
    const r = http.request(
      { host, port, path, method, headers: data ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {} },
      (res) => {
        let raw = '';
        res.on('data', (c) => (raw += c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: raw ? JSON.parse(raw) : null }));
      },
    );
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

describe('/api/user/settings workspaceRoot collapse on the real app (#4446)', () => {
  it('loopback GET: workspaceRoot is absolute, under the fake home', async () => {
    const lo = await getJson('127.0.0.1', '/api/user/settings');
    expect(lo.status).toBe(200);
    expect(lo.body.workspaceRoot.startsWith(home)).toBe(true);
  });

  describe.skipIf(!lanIp)('from a LAN address', () => {
    it('GET collapses home to ~ and keeps the rest', async () => {
      const lo = await getJson('127.0.0.1', '/api/user/settings');
      const lan = await getJson(lanIp!, '/api/user/settings');
      expect(lan.status).toBe(200);
      expect(lan.body.workspaceRoot).toBe('~' + lo.body.workspaceRoot.slice(home.length));
    });

    it('PUT answers with the collapsed real root and an echoed `~/evil` is not persisted', async () => {
      const lo = await getJson('127.0.0.1', '/api/user/settings');
      const put = await sendJson(lanIp!, 'PUT', '/api/user/settings', { workspaceRoot: '~/evil', displayName: 'x' });
      expect(put.status).toBe(200);
      expect(put.body.workspaceRoot).toBe('~' + lo.body.workspaceRoot.slice(home.length));
      const after = await getJson('127.0.0.1', '/api/user/settings');
      expect(after.body.workspaceRoot).toBe(lo.body.workspaceRoot);
    });

  });
});

describe('envDerived(settings, req) direct (#4446)', () => {
  it('collapses for a LAN-shaped request, not for loopback', async () => {
    const { envDerived } = await import('./routes/user-settings.js');
    const { readUserSettings } = await import('./workspace/user-settings.js');
    const settings = await readUserSettings();
    const mk = (ip: string) => ({ ip, socket: { remoteAddress: ip }, headers: {} }) as any;
    const lo = envDerived(settings, mk('127.0.0.1'));
    const lan = envDerived(settings, mk('192.168.1.50'));
    expect(lo.workspaceRoot.startsWith(home)).toBe(true);
    expect(lan.workspaceRoot).toBe('~' + lo.workspaceRoot.slice(home.length));
  });
});

/* ---- Batch A (#4484): import confirm, portable import, export job, voices override ---- */

function multipartJson(host: string, path: string, fileName: string, bytes: Buffer) {
  return new Promise<{ status: number; body: any }>((resolve, reject) => {
    const boundary = '----cwlan4446';
    const head = Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${fileName}"\r\nContent-Type: application/zip\r\n\r\n`,
    );
    const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
    const data = Buffer.concat([head, bytes, tail]);
    const r = http.request(
      { host, port, path, method: 'POST', headers: { 'content-type': `multipart/form-data; boundary=${boundary}`, 'content-length': data.length } },
      (res) => {
        let raw = '';
        res.on('data', (c) => (raw += c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: raw ? JSON.parse(raw) : null }));
      },
    );
    r.on('error', reject);
    r.end(data);
  });
}

function getBytes(host: string, path: string) {
  return new Promise<{ status: number; buf: Buffer }>((resolve, reject) => {
    http
      .get({ host, port, path }, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, buf: Buffer.concat(chunks) }));
      })
      .on('error', reject);
  });
}

async function importAndConfirm(host: string, title: string) {
  const imp = await sendJson(host, 'POST', '/api/import', { text: `# ${title}\n\n## Chapter One\n\nText.\n`, fileName: 'm.md' });
  expect(imp.status).toBe(200);
  return sendJson(host, 'POST', '/api/books', {
    tempId: imp.body.tempId,
    author: 'Lan Author',
    title,
    seriesPosition: null,
    isStandalone: true,
  });
}

describe('POST /api/books (import confirm) paths collapse on the real app (#4446, real-app test)', () => {
  it('loopback: three absolute paths under the fake home', async () => {
    const lo = await importAndConfirm('127.0.0.1', 'Loop Book');
    expect(lo.status).toBe(201);
    for (const k of ['bookDir', 'manuscript', 'dotAudiobook']) expect(lo.body.paths[k].startsWith(home)).toBe(true);
  });

  describe.skipIf(!lanIp)('from a LAN address', () => {
    it('collapses all three paths to ~ and keeps the rest', async () => {
      const lan = await importAndConfirm(lanIp!, 'Lan Book');
      expect(lan.status).toBe(201);
      for (const k of ['bookDir', 'manuscript', 'dotAudiobook']) {
        expect(lan.body.paths[k].startsWith('~')).toBe(true);
        expect(lan.body.paths[k]).not.toContain(home);
      }
      expect(lan.body.paths.manuscript.startsWith(lan.body.paths.bookDir)).toBe(true);
    });
  });
});

describe('POST /api/import/portable targetPath collapse on the real app (#4446, real-app test)', () => {
  describe.skipIf(!lanIp)('from a LAN address', () => {
    it('loopback gets the absolute targetPath, LAN gets ~', async () => {
      const book = await importAndConfirm('127.0.0.1', 'Portable Book');
      const zip = await getBytes('127.0.0.1', `/api/books/${encodeURIComponent(book.body.bookId)}/export/portable`);
      expect(zip.status).toBe(200);
      const lo = await multipartJson('127.0.0.1', '/api/import/portable?onConflict=rename', 'b.zip', zip.buf);
      expect(lo.status).toBe(201);
      expect(lo.body.targetPath.startsWith(home)).toBe(true);
      const lan = await multipartJson(lanIp!, '/api/import/portable?onConflict=rename', 'b.zip', zip.buf);
      expect(lan.status).toBe(201);
      expect(lan.body.targetPath.startsWith('~')).toBe(true);
      expect(lan.body.targetPath).not.toContain(home);
    });
  });
});

describe('export job syncPath collapse (#4446, unit test of exportJobForClient with a fake req)', () => {
  const mk = (ip: string) => ({ ip, socket: { remoteAddress: ip }, headers: {} }) as any;
  it('collapses syncPath for LAN, keeps loopback absolute, passes null and non-home paths through, never mutates the job', async () => {
    const { exportJobForClient } = await import('./routes/export.js');
    const job = { id: 'e1', syncPath: join(home, 'Sync', 'b.m4b') } as any;
    expect(exportJobForClient(mk('127.0.0.1'), job).syncPath).toBe(job.syncPath);
    expect(exportJobForClient(mk('192.168.1.50'), job).syncPath).toBe('~' + job.syncPath.slice(home.length));
    expect(job.syncPath.startsWith(home)).toBe(true);
    expect(exportJobForClient(mk('192.168.1.50'), { ...job, syncPath: null }).syncPath).toBeNull();
    const outside = process.platform === 'win32' ? 'D:\\sync\\b.m4b' : '/srv/sync/b.m4b';
    expect(exportJobForClient(mk('192.168.1.50'), { ...job, syncPath: outside }).syncPath).toBe(outside);
  });
});

describe('voices override skipped[].bookDir collapse (#4446, unit test of skippedForWire with a fake req)', () => {
  const mk = (ip: string) => ({ ip, socket: { remoteAddress: ip }, headers: {} }) as any;
  it('collapses bookDir for LAN, keeps loopback absolute, leaves placeholders and other fields', async () => {
    const { skippedForWire } = await import('./routes/voices.js');
    const skipped = [
      { bookDir: join(home, 'ws', 'A', 'B'), characterId: 'c1', reason: 'already_cloned' },
      { bookDir: '(unknown)', characterId: 'c2', reason: 'already_cloned' },
    ];
    expect(skippedForWire(mk('127.0.0.1'), skipped)).toEqual(skipped);
    const lan = skippedForWire(mk('192.168.1.50'), skipped);
    expect(lan[0]).toEqual({ ...skipped[0], bookDir: '~' + skipped[0].bookDir.slice(home.length) });
    expect(lan[1]).toEqual(skipped[1]);
  });
});

/* ---- Batch B (#4485): worktrees, diagnostics, lan-cert error text ---- */

describe('textForClient free-text collapse (#4446, unit test with fake req)', () => {
  const mk = (ip: string) => ({ ip, socket: { remoteAddress: ip }, headers: {} }) as any;
  it('collapses every home occurrence for LAN, keeps loopback and non-home text', async () => {
    const { textForClient } = await import('./lan-paths.js');
    const msg = `spawn failed: ${join(home, 'a', 'x.js')} and ${join(home, 'b')}`;
    expect(textForClient(mk('127.0.0.1'), msg)).toBe(msg);
    const lan = textForClient(mk('192.168.1.50'), msg);
    expect(lan).not.toContain(home);
    expect(lan.match(/~/g)!.length).toBe(2);
    expect(textForClient(mk('192.168.1.50'), 'no paths here')).toBe('no paths here');
  });
});

describe('GET /api/worktrees path collapse (#4446, unit test of worktreesForWire with a fake req)', () => {
  const mk = (ip: string) => ({ ip, socket: { remoteAddress: ip }, headers: {} }) as any;
  it('collapses row paths for LAN, keeps loopback absolute', async () => {
    const { worktreesForWire } = await import('./routes/worktrees.js');
    const rows = [{ path: join(home, 'wt', 'one'), branch: 'b', head: 'h', ports: {}, vitePort: 1, alive: false }];
    expect(worktreesForWire(mk('127.0.0.1'), rows)[0].path).toBe(rows[0].path);
    expect(worktreesForWire(mk('192.168.1.50'), rows)[0].path).toBe('~' + rows[0].path.slice(home.length));
    expect(rows[0].path.startsWith(home)).toBe(true);
  });
});

describe('GET /api/diagnostics detail collapse on the real app (#4446, real-app test)', () => {
  describe.skipIf(!lanIp)('from a LAN address', () => {
    it('no check detail leaks the fake home to a LAN client', async () => {
      const lan = await getJson(lanIp!, '/api/diagnostics');
      expect(lan.status).toBe(200);
      for (const c of lan.body.checks) expect(String(c.detail ?? '')).not.toContain(home);
    });
  });
});

/* ---- #4486: stored writable paths (workspaceDirOverride, exportSyncFolder) ---- */

describe('stored settings paths: collapse for LAN, expand ~ on LAN write only (#4446/#4486)', () => {
  let wsOverride: string;
  let syncFolder: string;
  beforeAll(() => {
    wsOverride = join(home, 'Audiobooks', 'Lib');
    syncFolder = join(home, 'syncdir');
    mkdirSync(syncFolder, { recursive: true });
  });
  afterAll(async () => {
    await sendJson('127.0.0.1', 'PUT', '/api/user/settings', { workspaceDirOverride: null, exportSyncFolder: null });
  });

  it('loopback PUT stores the original absolute values; loopback GET returns them', async () => {
    const put = await sendJson('127.0.0.1', 'PUT', '/api/user/settings', { workspaceDirOverride: wsOverride, exportSyncFolder: syncFolder });
    expect(put.status).toBe(200);
    const lo = await getJson('127.0.0.1', '/api/user/settings');
    expect(lo.body.workspaceDirOverride).toBe(wsOverride);
    expect(lo.body.exportSyncFolder).toBe(syncFolder);
  });

  it('loopback PUT of a literal ~ path is stored exactly as sent (no expansion)', async () => {
    const put = await sendJson('127.0.0.1', 'PUT', '/api/user/settings', { workspaceDirOverride: '~\\x', exportSyncFolder: '~/y' });
    expect(put.status).toBe(200);
    const lo = await getJson('127.0.0.1', '/api/user/settings');
    expect(lo.body.workspaceDirOverride).toBe('~\\x');
    expect(lo.body.exportSyncFolder).toBe('~/y');
    await sendJson('127.0.0.1', 'PUT', '/api/user/settings', { workspaceDirOverride: wsOverride, exportSyncFolder: syncFolder });
  });

  describe.skipIf(!lanIp)('from a LAN address', () => {
    it('GET shows both as ~..., and a LAN PUT echoing them round-trips byte-identical', async () => {
      const lan = await getJson(lanIp!, '/api/user/settings');
      expect(lan.body.workspaceDirOverride).toBe('~' + wsOverride.slice(home.length));
      expect(lan.body.exportSyncFolder).toBe('~' + syncFolder.slice(home.length));
      const put = await sendJson(lanIp!, 'PUT', '/api/user/settings', {
        displayName: 'phone',
        workspaceDirOverride: lan.body.workspaceDirOverride,
        exportSyncFolder: lan.body.exportSyncFolder,
      });
      expect(put.status).toBe(200);
      expect(put.body.workspaceDirOverride.startsWith('~')).toBe(true);
      const lo = await getJson('127.0.0.1', '/api/user/settings');
      expect(lo.body.workspaceDirOverride).toBe(wsOverride);
      expect(lo.body.exportSyncFolder).toBe(syncFolder);
    });

    it('LAN POST /sync-folder/test with ~/<existing subdir> is ok and creates no literal ~ dir', async () => {
      const res = await sendJson(lanIp!, 'POST', '/api/user/settings/sync-folder/test', { path: '~' + syncFolder.slice(home.length) });
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(existsSync(join(process.cwd(), '~'))).toBe(false);
      expect(existsSync(join(home, 'ws', '~'))).toBe(false);
    });
  });
});

/* ---- #4498: sweep Overflow rows (device-store, install jobs, ollama, clone-derive) ---- */

const realUser = (process.env.USERNAME ?? process.env.USER ?? '').trim();

describe('DeviceStoreDegradedError text collapse on the real app (#4446/#4498, rows 27-28)', () => {
  const devFile = () => join(home, 'ws', 'device-tokens.json');
  async function degrade() {
    writeFileSync(devFile(), '{not json');
    const dt = await import('./workspace/device-tokens.js');
    dt._resetDeviceTokenCacheForTests();
  }
  async function heal() {
    rmSync(devFile(), { force: true });
    const dt = await import('./workspace/device-tokens.js');
    dt._resetDeviceTokenCacheForTests();
  }
  afterAll(heal);

  /* `DeviceStoreDegradedError`'s own message (workspace/device-tokens.ts) is a fixed
     path-free sentence for EVERY client (loopback included), so the #4446 collapse is a
     no-op layered on top; what matters is that the body names no home dir and no username. */
  it('loopback GET /api/devices answers the curated, path-free 503 text', async () => {
    await degrade();
    const lo = await getJson('127.0.0.1', '/api/devices');
    expect(lo.status).toBe(503);
    expect(lo.body.error).toContain('could not be read');
    expect(lo.body.error).not.toContain(home);
  });

  describe.skipIf(!lanIp)('from a LAN address', () => {
    it('GET /api/devices 503 text has neither the fake home nor the real username', async () => {
      await degrade();
      const lan = await getJson(lanIp!, '/api/devices');
      expect(lan.status).toBe(503);
      expect(lan.body.error).toContain('could not be read');
      expect(lan.body.error).not.toContain(home);
      if (realUser) expect(lan.body.error).not.toContain(realUser);
    });

    it('unauthenticated POST /api/pair/redeem degraded-store 503 body leaks neither home nor username', async () => {
      await degrade();
      const { createPairingSession } = await import('./workspace/pairing-sessions.js');
      const { code } = createPairingSession('phone');
      const res = await sendJson(lanIp!, 'POST', '/api/pair/redeem', { code });
      expect(res.status).toBe(503);
      const raw = JSON.stringify(res.body);
      expect(raw).toContain('could not be read');
      expect(raw).not.toContain(home);
      if (realUser) expect(raw.toLowerCase()).not.toContain(realUser.toLowerCase());
    });

    it('unauthenticated POST /api/pair/redeem-browser degraded-store text is collapsed too (or not reachable)', async () => {
      await degrade();
      const { createPairingSession } = await import('./workspace/pairing-sessions.js');
      const { code } = createPairingSession('phone', Date.now(), 10);
      const res = await sendJson(lanIp!, 'POST', '/api/pair/redeem-browser', { code });
      expect(JSON.stringify(res.body)).not.toContain(home);
    });
  });
});

describe('jobForClient (#4446/#4498, unit test with fake req)', () => {
  const mk = (ip: string) => ({ ip, socket: { remoteAddress: ip }, headers: {} }) as any;
  it('collapses step, error and manualInstallerPath for LAN; loopback untouched; input never mutated', async () => {
    const { jobForClient } = await import('./lan-paths.js');
    const job = {
      id: 'j1',
      status: 'failed',
      step: `running ${join(home, 'venv', 'bin', 'pip')}`,
      error: `spawn ${join(home, 'x')} ENOENT`,
      manualInstallerPath: join(home, 'Downloads', 'OllamaSetup.exe'),
      progress: 3,
    };
    const lo = jobForClient(mk('127.0.0.1'), job);
    expect(lo).toEqual(job);
    const lan = jobForClient(mk('192.168.1.50'), job);
    expect(lan.step).not.toContain(home);
    expect(lan.step.startsWith('running ~')).toBe(true);
    expect(lan.error).not.toContain(home);
    expect(lan.manualInstallerPath.startsWith('~')).toBe(true);
    expect(lan.manualInstallerPath).not.toContain(home);
    expect(lan.progress).toBe(3);
    expect(job.step).toContain(home);
  });
});

describe('install job routes collapse step/error on the real app (#4446/#4498, rows 8a/9a/9b)', () => {
  const job = () => ({
    id: 'jx',
    status: 'failed',
    step: `pip at ${join(home, 'venv')}`,
    error: `failed in ${join(home, 'venv', 'x')}`,
    manualInstallerPath: join(home, 'Downloads', 'OllamaSetup.exe'),
  });
  const stub = () => ({ getJob: () => job(), recheck: async () => job(), start: () => job(), detect: async () => ({}) }) as any;

  it('venv bootstrap, kokoro and ollama job GETs: loopback full, LAN ~', async () => {
    (await import('./routes/venv-bootstrap.js')).setVenvBootstrap(stub());
    (await import('./routes/kokoro-install.js')).setKokoroInstallBootstrap(stub());
    (await import('./routes/ollama-health.js')).setOllamaBootstraps({ install: stub() });
    for (const p of ['/api/setup/venv/bootstrap/jx', '/api/kokoro/install/jx', '/api/ollama/install/jx']) {
      const lo = await getJson('127.0.0.1', p);
      expect(lo.body.step, p).toContain(home);
      if (lanIp) {
        const lan = await getJson(lanIp, p);
        expect(lan.body.step, p).not.toContain(home);
        expect(lan.body.error, p).not.toContain(home);
        expect(lan.body.manualInstallerPath ?? "~", p).not.toContain(home);
        expect(lan.body.step, p).toContain('~');
        expect(lan.body.error, p).toContain('~');
      }
    }
  });
});

/* ---- #4446: unauthenticated GET /cert/root.crt 404 `probed` paths ---- */

describe('GET /cert/root.crt 404 probed paths collapse on the real app (#4446, real-app test)', () => {
  const envKeys = ['MKCERT_CAROOT', 'LOCALAPPDATA', 'XDG_DATA_HOME', 'PATH'];
  const prev: Record<string, string | undefined> = {};
  beforeAll(() => {
    for (const k of envKeys) prev[k] = process.env[k];
    // Force the no-CA 404: no env CA, a fake default dir under the fake home, no mkcert on PATH.
    process.env.MKCERT_CAROOT = join(home, 'caroot');
    process.env.LOCALAPPDATA = join(home, 'AppData', 'Local');
    process.env.XDG_DATA_HOME = join(home, '.local', 'share');
    process.env.PATH = join(home, 'empty-bin');
  });
  afterAll(() => {
    for (const k of envKeys) {
      if (prev[k] === undefined) delete process.env[k];
      else process.env[k] = prev[k];
    }
  });

  it('loopback: probed.env and probed.defaultForPlatform stay absolute under the fake home', async () => {
    const lo = await getJson('127.0.0.1', '/cert/root.crt');
    expect(lo.status).toBe(404);
    expect(lo.body.probed.env.startsWith(home)).toBe(true);
    expect(lo.body.probed.defaultForPlatform.startsWith(home)).toBe(true);
  });

  describe.skipIf(!lanIp)('from a LAN address', () => {
    it('collapses home to ~ in every probed field and leaks neither the fake home nor the real username', async () => {
      const lo = await getJson('127.0.0.1', '/cert/root.crt');
      const lan = await getJson(lanIp!, '/cert/root.crt');
      expect(lan.status).toBe(404);
      expect(lan.body.probed.env).toBe('~' + lo.body.probed.env.slice(home.length));
      expect(lan.body.probed.defaultForPlatform).toBe('~' + lo.body.probed.defaultForPlatform.slice(home.length));
      expect(lan.body.probed.mkcertCli).toBeNull();
      const raw = JSON.stringify(lan.body);
      expect(raw).not.toContain(home);
      if (realUser) expect(raw.toLowerCase()).not.toContain(realUser.toLowerCase());
    });
  });
});
