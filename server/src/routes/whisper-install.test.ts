/* /api/whisper install routes (srv-31, plan 186). Injects a WhisperInstall-
   Bootstrap with a stubbed detect + spawn so the whole detect/install/poll/
   recheck surface runs offline (no real pip/download). */

import { describe, it, expect, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import express from 'express';
import request from 'supertest';
import {
  whisperInstallRouter,
  setWhisperInstallBootstrap,
  _resetWhisperInstallBootstrap,
} from './whisper-install.js';
import {
  WhisperInstallBootstrap,
  type WhisperInstallJobStatus,
} from '../tts/whisper-install-bootstrap.js';
import type { WhisperInstallState } from '../tts/whisper-install-detect.js';
import { _setUserSettingsCacheForTest, _resetUserSettingsCache } from '../workspace/user-settings.js';

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/whisper', whisperInstallRouter);
  return app;
}

function fakeChild(code: number) {
  const child = new EventEmitter() as EventEmitter & { stdout: EventEmitter; stderr: EventEmitter };
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  queueMicrotask(() => child.emit('close', code));
  return child;
}

async function poll(app: express.Express, id: string, until: (s: WhisperInstallJobStatus) => boolean) {
  for (let i = 0; i < 200; i++) {
    const res = await request(app).get(`/api/whisper/install/${id}`);
    if (until(res.body.status)) return res.body;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error('poll timed out');
}

afterEach(() => {
  _resetWhisperInstallBootstrap();
});

describe('GET /api/whisper/detect', () => {
  it('returns the install-state + installed flag', async () => {
    setWhisperInstallBootstrap(
      new WhisperInstallBootstrap({ repoRoot: '/repo', detectFn: () => 'ready' }),
    );
    const res = await request(makeApp()).get('/api/whisper/detect');
    expect(res.body).toEqual({ state: 'ready', installed: true });
  });

  it('reports not-installed as installed:false', async () => {
    setWhisperInstallBootstrap(
      new WhisperInstallBootstrap({ repoRoot: '/repo', detectFn: () => 'not-installed' }),
    );
    const res = await request(makeApp()).get('/api/whisper/detect');
    expect(res.body).toEqual({ state: 'not-installed', installed: false });
  });
});

describe('POST /api/whisper/install + poll', () => {
  it('starts a job (202) and reaches installed once the model lands', async () => {
    const states: WhisperInstallState[] = ['not-installed', 'ready'];
    let i = 0;
    setWhisperInstallBootstrap(
      new WhisperInstallBootstrap({
        repoRoot: '/repo',
        detectFn: () => states[Math.min(i++, states.length - 1)],
        spawnFn: () => fakeChild(0) as never,
      }),
    );
    const app = makeApp();
    const start = await request(app).post('/api/whisper/install');
    expect(start.status).toBe(202);
    expect(start.body.id).toBeTruthy();
    const done = await poll(app, start.body.id, (s) => s === 'installed' || s === 'error');
    expect(done.status).toBe('installed');
  });

  it('surfaces an error when the installer exits 0 but the model is still missing', async () => {
    setWhisperInstallBootstrap(
      new WhisperInstallBootstrap({
        repoRoot: '/repo',
        detectFn: () => 'model-missing',
        spawnFn: () => fakeChild(0) as never,
      }),
    );
    const app = makeApp();
    const start = await request(app).post('/api/whisper/install');
    const done = await poll(app, start.body.id, (s) => s === 'installed' || s === 'error');
    expect(done.status).toBe('error');
    expect(done.error).toMatch(/model is still missing/i);
  });

  it('404s polling an unknown job id', async () => {
    setWhisperInstallBootstrap(new WhisperInstallBootstrap({ repoRoot: '/repo', detectFn: () => 'ready' }));
    const res = await request(makeApp()).get('/api/whisper/install/nope');
    expect(res.status).toBe(404);
  });

  it('re-resolves --model at SPAWN time, not construction time, from the LIVE qa.asr.model override (PR #2008 re-review, M1)', async () => {
    /* Before the Major-1 fix, no installArgs were passed at all, so
       install-whisper.mjs fell back to `process.env.ASR_MODEL || 'base'` —
       the in-app installer could never fetch a model configured only via
       Advanced Configuration.

       The FIRST version of this test constructed the bootstrap AFTER seeding
       the override, so a construction-time-frozen `--model` (the exact
       regression the docblock at whisper-install-bootstrap.ts warns against)
       would have produced an identical answer and passed anyway — a placebo
       for the specific "resolved per call, not cached" property being
       pinned. This version constructs the bootstrap FIRST, runs an install
       with the override still at its default, THEN changes the override and
       runs a second install — so a construction-time freeze and a spawn-time
       resolution provably diverge: freezing would spawn 'base' both times;
       resolving per call spawns 'base' then 'small'. */
    _resetUserSettingsCache(); // ensure no override is seeded yet
    const capturedArgs: (readonly string[])[] = [];
    const bootstrap = new WhisperInstallBootstrap({
      repoRoot: '/repo',
      detectFn: () => 'not-installed',
      spawnFn: (_cmd, args) => {
        capturedArgs.push(args);
        return fakeChild(0) as never;
      },
    });
    setWhisperInstallBootstrap(bootstrap);
    const app = makeApp();

    try {
      // Run 1: no override yet → the registry default ('base').
      const start1 = await request(app).post('/api/whisper/install');
      await poll(app, start1.body.id, (s) => s === 'installed' || s === 'error');

      // Change the LIVE override, then run a second, independent install job
      // against the SAME already-constructed bootstrap instance.
      _setUserSettingsCacheForTest({ configOverrides: { 'qa.asr.model': 'small' } });
      const start2 = await request(app).post('/api/whisper/install');
      await poll(app, start2.body.id, (s) => s === 'installed' || s === 'error');

      expect(start1.body.id).not.toBe(start2.body.id); // genuinely two separate runs
      expect(capturedArgs).toHaveLength(2);
      expect(capturedArgs[0].slice(-2)).toEqual(['--model', 'base']);
      expect(capturedArgs[1].slice(-2)).toEqual(['--model', 'small']); // proves per-call resolution
    } finally {
      // try/finally, not an inline reset — a poll() timeout must not leak
      // the 'small' override into later tests in this file (PR #2008
      // re-review, m3; matches the pattern already used in
      // whisper-install-detect.test.ts).
      _resetUserSettingsCache();
    }
  });
});

describe('POST /api/whisper/install/:id/recheck', () => {
  it('promotes a stuck job to installed once the model is present', async () => {
    let cur: WhisperInstallState = 'not-installed';
    setWhisperInstallBootstrap(
      new WhisperInstallBootstrap({
        repoRoot: '/repo',
        detectFn: () => cur,
        spawnFn: () => fakeChild(0) as never,
      }),
    );
    const app = makeApp();
    const start = await request(app).post('/api/whisper/install');
    await poll(app, start.body.id, (s) => s === 'error'); // exit 0 but still not-installed → error
    cur = 'ready';
    const res = await request(app).post(`/api/whisper/install/${start.body.id}/recheck`);
    expect(res.body.status).toBe('installed');
  });
});
