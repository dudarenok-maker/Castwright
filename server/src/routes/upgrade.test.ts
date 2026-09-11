/* fs-1 — pin the /api/upgrade router's HTTP surface + state-file bookkeeping.
   The destructive helpers (zip-validate, apply, busy-probe, path resolution)
   are mocked so the test asserts ONLY the route logic: status-code mapping
   (409 busy, 412 downgrade, 400 bad zip), the staged→applying transition, and
   the 202 dispatch. Their real logic is covered by the upgrade/*.test.ts units. */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, existsSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express, { type Express } from 'express';
import request from 'supertest';

// Mutable holders the hoisted mock factories read at call time.
const h = vi.hoisted(() => ({
  paths: null as null | Record<string, unknown>,
  validate: null as null | (() => Promise<unknown>),
  busy: { busy: false, generationBooks: [] as string[], analysisManuscripts: [] as string[] },
  applyResult: { ok: false, version: '1.6.0', releaseDir: '/r', phase: 'extract', error: 'stub' } as Record<string, unknown>,
  applyCalls: [] as unknown[],
  /* #3174 G3 — an applyUpgrade rejection, forced by a test rather than by the
     stubbed applyResult shape above. */
  applyThrows: null as null | Error,
  /* #3174 G3 — writeFileSync failure injection, targeted at the upgrade
     state file only and gated on call count (not time), same idiom as
     single-design.test.ts's readJsonFailAfter: `writeFileSyncFailAfterCalls`
     lets a fixture write and the route's own pre-response 'applying' write
     pass through untouched, and only the detached IIFE's OWN writeState
     call(s) — which start after that count — fail. */
  writeFileSyncFailPath: null as null | string,
  writeFileSyncFailAfterCalls: null as null | number,
}));
let stateWriteCallCount = 0;

vi.mock('../upgrade/paths.js', () => ({ resolveUpgradePaths: () => h.paths }));
vi.mock('../upgrade/busy-probe.js', () => ({ anyJobInFlight: () => h.busy }));
vi.mock('../upgrade/zip-validate.js', () => ({ validateUpgradeZip: (...a: unknown[]) => (h.validate ?? (async () => ({ ok: false, code: 'bad-structure', reason: 'no stub' })))(...(a as [])) }));
vi.mock('../upgrade/apply.js', () => ({
  applyUpgrade: async (ctx: unknown) => {
    h.applyCalls.push(ctx);
    if (h.applyThrows) throw h.applyThrows;
    return h.applyResult;
  },
  createApplySteps: () => ({ readReqHash: () => 'old-hash' }),
}));
vi.mock('../app-version.js', () => ({ getAppVersion: () => '1.6.0' }));
/* #3174 G3 — node:fs's writeFileSync export isn't configurable under
   Vitest's ESM module namespace (`vi.spyOn(fs, 'writeFileSync')` throws
   "Cannot redefine property"), so mock the whole module through a
   pass-through delegate, same convention as
   server/src/tts/restart-breadcrumb.test.ts / state-io.test.ts. */
vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  return {
    ...actual,
    writeFileSync: (...args: Parameters<typeof actual.writeFileSync>) => {
      const [target] = args;
      if (h.writeFileSyncFailPath && target === h.writeFileSyncFailPath) {
        stateWriteCallCount++;
        if (
          h.writeFileSyncFailAfterCalls !== null &&
          stateWriteCallCount > h.writeFileSyncFailAfterCalls
        ) {
          throw new Error('simulated disk-full writing upgrade state.json');
        }
      }
      return actual.writeFileSync(...args);
    },
  };
});

let app: Express;
let stagingDir: string;

function readState() {
  return JSON.parse(readFileSync(join(stagingDir, 'state.json'), 'utf8'));
}

beforeEach(async () => {
  const root = mkdtempSync(join(tmpdir(), 'fs1-route-'));
  stagingDir = join(root, '.upgrade-staging');
  mkdirSync(stagingDir, { recursive: true });
  h.paths = {
    repoRoot: root,
    installRoot: root,
    releasesDir: join(root, 'releases'),
    isVersioned: true,
    stagingDir,
    stagedZip: join(stagingDir, 'incoming.zip'),
    stateFile: join(stagingDir, 'state.json'),
    venvDir: join(root, 'venv'),
    serverPidFile: join(root, '.run', 'server.pid'),
  };
  h.busy = { busy: false, generationBooks: [], analysisManuscripts: [] };
  h.validate = null;
  h.applyResult = { ok: false, version: '1.6.0', releaseDir: '/r', phase: 'extract', error: 'stub' };
  h.applyCalls = [];
  h.applyThrows = null;
  h.writeFileSyncFailPath = null;
  h.writeFileSyncFailAfterCalls = null;
  stateWriteCallCount = 0;

  const { upgradeRouter } = await import('./upgrade.js');
  app = express();
  app.use(express.json());
  app.use('/api/upgrade', upgradeRouter);
});

afterEach(() => {
  vi.resetModules();
  if (h.paths) rmSync((h.paths.repoRoot as string), { recursive: true, force: true });
});

describe('GET /api/upgrade/state', () => {
  it('reports idle with no staged upgrade', async () => {
    const res = await request(app).get('/api/upgrade/state');
    expect(res.status).toBe(200);
    expect(res.body.phase).toBe('idle');
    expect(res.body.busy).toBe(false);
  });
});

describe('POST /api/upgrade/stage', () => {
  it('refuses with 409 while a job is in flight', async () => {
    h.busy = { busy: true, generationBooks: ['book-a'], analysisManuscripts: [] };
    const res = await request(app).post('/api/upgrade/stage').attach('zip', Buffer.from('PK'), 'x.zip');
    expect(res.status).toBe(409);
    expect(res.body.generationBooks).toEqual(['book-a']);
  });

  it('returns 412 for a downgrade and clears the staged file', async () => {
    h.validate = async () => ({ ok: false, code: 'downgrade', reason: 'older', isDowngrade: true });
    const res = await request(app).post('/api/upgrade/stage').attach('zip', Buffer.from('PK'), 'x.zip');
    expect(res.status).toBe(412);
    expect(res.body.code).toBe('downgrade');
    expect(existsSync(join(stagingDir, 'incoming.zip'))).toBe(false);
  });

  it('returns 400 for a structurally invalid zip', async () => {
    h.validate = async () => ({ ok: false, code: 'bad-structure', reason: 'two top dirs' });
    const res = await request(app).post('/api/upgrade/stage').attach('zip', Buffer.from('PK'), 'x.zip');
    expect(res.status).toBe(400);
  });

  it('stages a valid candidate and records it', async () => {
    h.validate = async () => ({ ok: true, code: 'ok', candidateVersion: '1.6.0', reqHash: 'new-hash', topDir: 'castwright-v1.6.0', isDowngrade: false });
    const res = await request(app).post('/api/upgrade/stage').attach('zip', Buffer.from('PK'), 'x.zip');
    expect(res.status).toBe(200);
    expect(res.body.candidateVersion).toBe('1.6.0');
    expect(res.body.requiresPipInstall).toBe(true); // new-hash != old-hash
    expect(readState().phase).toBe('staged');
  });
});

describe('POST /api/upgrade/abort', () => {
  it('drops the staged zip and resets to idle', async () => {
    writeFileSync(join(stagingDir, 'incoming.zip'), 'zip');
    writeFileSync(join(stagingDir, 'state.json'), JSON.stringify({ phase: 'staged', candidateVersion: '1.6.0' }));
    const res = await request(app).post('/api/upgrade/abort');
    expect(res.status).toBe(200);
    expect(existsSync(join(stagingDir, 'incoming.zip'))).toBe(false);
    expect(readState().phase).toBe('idle');
  });
});

describe('POST /api/upgrade/apply', () => {
  it('refuses with 409 when nothing is staged', async () => {
    const res = await request(app).post('/api/upgrade/apply');
    expect(res.status).toBe(409);
  });

  it('refuses with 409 while a job is in flight', async () => {
    h.busy = { busy: true, generationBooks: ['b'], analysisManuscripts: [] };
    const res = await request(app).post('/api/upgrade/apply');
    expect(res.status).toBe(409);
  });

  it('accepts a staged candidate with 202 and dispatches applyUpgrade', async () => {
    writeFileSync(
      join(stagingDir, 'state.json'),
      JSON.stringify({ phase: 'staged', candidateVersion: '1.6.0', topDir: 'castwright-v1.6.0', reqHash: 'h' }),
    );
    const res = await request(app).post('/api/upgrade/apply');
    expect(res.status).toBe(202);
    expect(res.body.toVersion).toBe('1.6.0');
    // Background apply (mocked ok:false → no SIGTERM) was invoked with the ctx.
    await vi.waitFor(() => expect(h.applyCalls.length).toBe(1));
    expect((h.applyCalls[0] as { candidateVersion: string }).candidateVersion).toBe('1.6.0');
    await vi.waitFor(() => expect(readState().phase).toBe('error')); // ok:false → error state
  });
});

describe('POST /api/upgrade/apply — background failure containment (#3174 G3)', () => {
  /* Before the fix, the detached apply IIFE's catch block called the
     unguarded writeState() to record the failure — and writeState() itself
     can throw (mkdirSync/writeFileSync, both unguarded). When it did, the
     IIFE (void'd, nothing awaits it) rejected uncaught: an unhandledRejection
     at the process level, AND the state file was left wherever it last
     landed successfully ('applying', from the synchronous pre-response
     write) with no error ever recorded — GET /state would report 'applying'
     forever with no way to tell the user or retry. */
  it('when applyUpgrade throws AND the catch block\'s own writeState also fails, no unhandled rejection reaches the process and the failure is logged loudly', async () => {
    writeFileSync(
      join(stagingDir, 'state.json'),
      JSON.stringify({ phase: 'staged', candidateVersion: '1.6.0', topDir: 'castwright-v1.6.0', reqHash: 'h' }),
    );
    h.applyThrows = new Error('simulated apply crash');
    // Armed AFTER the fixture write above: call #1 is the route's own
    // synchronous 'applying' write (must succeed so the 202 response is
    // sent); only call #2+ — the detached IIFE's own catch-block write —
    // is made to fail.
    h.writeFileSyncFailPath = (h.paths as Record<string, unknown>).stateFile as string;
    h.writeFileSyncFailAfterCalls = 1;

    let unhandledRejection: unknown = null;
    const onUnhandledRejection = (reason: unknown) => {
      unhandledRejection = reason;
    };
    process.on('unhandledRejection', onUnhandledRejection);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    try {
      const res = await request(app).post('/api/upgrade/apply');
      expect(res.status).toBe(202); // the pre-response write succeeded

      await vi.waitFor(() =>
        expect(errorSpy).toHaveBeenCalledWith(
          '[upgrade] could not record upgrade state',
          expect.any(Error),
        ),
      );
      // The apply failure itself was also logged (pre-existing behaviour,
      // unchanged by this fix).
      expect(errorSpy).toHaveBeenCalledWith('[upgrade] apply threw:', h.applyThrows);

      // The state file is stuck at 'applying' — the error write failed, so
      // nothing recorded why. This is the in-memory/on-disk status GET
      // /state reads; there is no separate in-memory status surface.
      expect(readState().phase).toBe('applying');

      await new Promise((r) => setTimeout(r, 0));
      expect(unhandledRejection).toBeNull();
    } finally {
      process.removeListener('unhandledRejection', onUnhandledRejection);
      errorSpy.mockRestore();
    }
  });

  /* Only the catch-block branch above had a test. This covers the OTHER
     tryWriteState call inside the IIFE: the success branch's 'restarting'
     write. Same shape — if that write fails, the failure must be logged
     loudly, must not reject the IIFE, and must not stop the restart from
     being scheduled (the SIGTERM that lets the detached restarter take
     over is unrelated to whether the state file could record it). */
  it('when applyUpgrade succeeds but the restarting-state write fails, no unhandled rejection reaches the process, the failure is logged loudly, and the restart SIGTERM still fires', async () => {
    writeFileSync(
      join(stagingDir, 'state.json'),
      JSON.stringify({ phase: 'staged', candidateVersion: '1.6.0', topDir: 'castwright-v1.6.0', reqHash: 'h' }),
    );
    h.applyResult = { ok: true, version: '1.7.0', releaseDir: '/r' };
    // Armed AFTER the fixture write above: call #1 is the route's own
    // synchronous 'applying' write (must succeed so the 202 response is
    // sent); only call #2+ — the detached IIFE's own success-branch write —
    // is made to fail.
    h.writeFileSyncFailPath = (h.paths as Record<string, unknown>).stateFile as string;
    h.writeFileSyncFailAfterCalls = 1;

    let unhandledRejection: unknown = null;
    const onUnhandledRejection = (reason: unknown) => {
      unhandledRejection = reason;
    };
    process.on('unhandledRejection', onUnhandledRejection);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    // Never let the test really signal the test process.
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true as never);

    try {
      const res = await request(app).post('/api/upgrade/apply');
      expect(res.status).toBe(202); // the pre-response write succeeded

      await vi.waitFor(() =>
        expect(errorSpy).toHaveBeenCalledWith(
          '[upgrade] could not record upgrade state',
          expect.any(Error),
        ),
      );

      // The state file is stuck at 'applying' — the 'restarting' write
      // failed, so the successful apply was never recorded either.
      expect(readState().phase).toBe('applying');

      // The restart is still scheduled despite the failed write — a lost
      // state-file record must not also lose the restart itself.
      await vi.waitFor(() => expect(killSpy).toHaveBeenCalledWith(process.pid, 'SIGTERM'));

      await new Promise((r) => setTimeout(r, 0));
      expect(unhandledRejection).toBeNull();
    } finally {
      process.removeListener('unhandledRejection', onUnhandledRejection);
      errorSpy.mockRestore();
      killSpy.mockRestore();
    }
  });
});
