/* /api/kokoro install routes (fs-21). Injects a KokoroInstallBootstrap with a
   stubbed detect + spawn so the whole detect/install/poll/recheck surface runs
   offline (no real download or weight files needed).

   Pinned to the slow pool (vitest.config.slow.ts) — integration route test
   that supertest's a live Express instance, same class as
   setup-readiness.route.test.ts and the coqui/whisper install tests. */

import { describe, it, expect, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import express from 'express';
import request from 'supertest';
import {
  kokoroInstallRouter,
  setKokoroInstallBootstrap,
  _resetKokoroInstallBootstrap,
} from './kokoro-install.js';
import {
  KokoroInstallBootstrap,
  type KokoroInstallJobStatus,
} from '../tts/kokoro-install-bootstrap.js';

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/kokoro', kokoroInstallRouter);
  return app;
}

function fakeChild(code: number) {
  const child = new EventEmitter() as EventEmitter & { stdout: EventEmitter; stderr: EventEmitter };
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  queueMicrotask(() => child.emit('close', code));
  return child;
}

async function poll(
  app: express.Express,
  id: string,
  until: (s: KokoroInstallJobStatus) => boolean,
) {
  for (let i = 0; i < 200; i++) {
    const res = await request(app).get(`/api/kokoro/install/${id}`);
    if (until(res.body.status)) return res.body;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error('poll timed out');
}

afterEach(() => {
  _resetKokoroInstallBootstrap();
});

describe('GET /api/kokoro/detect', () => {
  it('returns installed:true when weights are present', async () => {
    setKokoroInstallBootstrap(
      new KokoroInstallBootstrap({ repoRoot: '/repo', detectFn: () => true }),
    );
    const res = await request(makeApp()).get('/api/kokoro/detect');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ state: 'installed', installed: true });
  });

  it('returns installed:false when weights are absent', async () => {
    setKokoroInstallBootstrap(
      new KokoroInstallBootstrap({ repoRoot: '/repo', detectFn: () => false }),
    );
    const res = await request(makeApp()).get('/api/kokoro/detect');
    expect(res.body).toEqual({ state: 'not-installed', installed: false });
  });
});

describe('POST /api/kokoro/install + poll', () => {
  it('starts a job (202) and reaches installed once weights land', async () => {
    let calls = 0;
    setKokoroInstallBootstrap(
      new KokoroInstallBootstrap({
        repoRoot: '/repo',
        /* First call (pre-install probe) → not installed; second call (post-
           install probe) → installed. */
        detectFn: () => calls++ > 0,
        spawnFn: () => fakeChild(0) as never,
      }),
    );
    const app = makeApp();
    const start = await request(app).post('/api/kokoro/install');
    expect(start.status).toBe(202);
    expect(start.body.id).toBeTruthy();
    expect(start.body.status).toBeTruthy();

    const done = await poll(app, start.body.id, (s) => s === 'installed' || s === 'error');
    expect(done.status).toBe('installed');
  });

  it('404s polling an unknown job id', async () => {
    setKokoroInstallBootstrap(
      new KokoroInstallBootstrap({ repoRoot: '/repo', detectFn: () => true }),
    );
    const res = await request(makeApp()).get('/api/kokoro/install/does-not-exist');
    expect(res.status).toBe(404);
  });
});

describe('POST /api/kokoro/install/:id/recheck', () => {
  it('promotes a stuck job to installed once the weights appear', async () => {
    let installed = false;
    setKokoroInstallBootstrap(
      new KokoroInstallBootstrap({
        repoRoot: '/repo',
        detectFn: () => installed,
        spawnFn: () => fakeChild(0) as never,
      }),
    );
    const app = makeApp();
    const start = await request(app).post('/api/kokoro/install');
    // detectFn always returns false → installer exits 0 but weights still
    // missing → job lands in 'error'
    await poll(app, start.body.id, (s) => s === 'error');
    installed = true;
    const res = await request(app).post(`/api/kokoro/install/${start.body.id}/recheck`);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('installed');
  });
});
