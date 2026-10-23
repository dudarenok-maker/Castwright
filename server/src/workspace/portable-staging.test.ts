/* #3711 -- the portable-import staging directory and its startup sweep. */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

let workspaceRoot: string;
let staging: typeof import('./portable-staging.js');

beforeAll(async () => {
  workspaceRoot = mkdtempSync(join(tmpdir(), 'audiobook-portable-staging-'));
  process.env.WORKSPACE_DIR = workspaceRoot;
  staging = await import('./portable-staging.js');
});

afterAll(() => {
  if (workspaceRoot) rmSync(workspaceRoot, { recursive: true, force: true });
  delete process.env.WORKSPACE_DIR;
});

beforeEach(() => {
  rmSync(staging.STAGING_ROOT, { recursive: true, force: true });
});

const HOUR = 60 * 60 * 1000;

/** A staging entry whose mtime is `ageMs` old, holding a file so removal is recursive. */
function entry(name: string, ageMs: number): string {
  const dir = join(staging.STAGING_ROOT, name);
  mkdirSync(join(dir, '.audiobook'), { recursive: true });
  writeFileSync(join(dir, '.audiobook', 'state.json'), '{}');
  const when = new Date(Date.now() - ageMs);
  utimesSync(dir, when, when);
  return dir;
}

describe('sweepStaleStaging', () => {
  it('lives under the workspace, outside books/', () => {
    expect(staging.STAGING_ROOT).toBe(join(workspaceRoot, '.staging'));
  });

  it('removes entries older than an hour and keeps younger ones (one may be a live import)', async () => {
    const old = entry('old-import', 2 * HOUR);
    const justOver = entry('just-over', HOUR + 60_000);
    const young = entry('young-import', 5 * 60_000);
    const fresh = entry('fresh-import', 0);

    const removed = await staging.sweepStaleStaging();

    expect(removed.sort()).toEqual(['just-over', 'old-import']);
    expect(existsSync(old)).toBe(false);
    expect(existsSync(justOver)).toBe(false);
    expect(existsSync(young)).toBe(true);
    expect(existsSync(fresh)).toBe(true);
  });

  it('is a no-op (and does not throw) when there is no .staging directory', async () => {
    expect(existsSync(staging.STAGING_ROOT)).toBe(false);
    await expect(staging.sweepStaleStaging()).resolves.toEqual([]);
  });

  it('honours an explicit age and clock (the knobs the sweep exposes)', async () => {
    const dir = entry('x', 10_000);
    expect(await staging.sweepStaleStaging(60_000, Date.now())).toEqual([]);
    expect(existsSync(dir)).toBe(true);
    expect(await staging.sweepStaleStaging(5_000, Date.now())).toEqual(['x']);
  });

  it('makeStagingDir creates a distinct, empty directory per call', async () => {
    const a = await staging.makeStagingDir();
    const b = await staging.makeStagingDir();
    expect(a).not.toBe(b);
    expect(dirname(a)).toBe(staging.STAGING_ROOT);
    expect(existsSync(a)).toBe(true);
  });
});

describe('server boot order', () => {
  it('index.ts awaits the staging sweep BEFORE the server starts listening', () => {
    const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'index.ts'), 'utf8');
    const sweep = src.indexOf('await sweepStaleStaging()');
    const listen = src.indexOf('listenWithAutoRebind(server');
    expect(sweep).toBeGreaterThan(-1);
    expect(listen).toBeGreaterThan(-1);
    expect(sweep).toBeLessThan(listen);
    // ...and it is a statement of main(), not fire-and-forget.
    expect(src).not.toMatch(/void\s+sweepStaleStaging/);
  });
});
