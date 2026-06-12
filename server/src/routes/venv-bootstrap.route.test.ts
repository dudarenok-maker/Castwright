/* /api/setup/venv bootstrap routes (fs-21 decision Z). Injects a VenvBootstrap
   with a stubbed detect + spawn so the whole detect/bootstrap/poll/recheck
   surface runs offline (no real Python or venv needed).

   Pinned to the slow pool (vitest.config.slow.ts) — integration route test
   that supertest's a live Express instance, same class as
   setup-readiness.route.test.ts and kokoro-install.route.test.ts. */

import { describe, it, expect, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import express from 'express';
import request from 'supertest';
import {
  venvBootstrapRouter,
  setVenvBootstrap,
  _resetVenvBootstrap,
} from './venv-bootstrap.js';
import {
  VenvBootstrap,
  type VenvBootstrapJobStatus,
} from '../tts/venv-bootstrap.js';

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/setup/venv', venvBootstrapRouter);
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
  until: (s: VenvBootstrapJobStatus) => boolean,
) {
  for (let i = 0; i < 200; i++) {
    const res = await request(app).get(`/api/setup/venv/bootstrap/${id}`);
    if (until(res.body.status)) return res.body;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error('poll timed out');
}

afterEach(() => {
  _resetVenvBootstrap();
});

describe('GET /api/setup/venv/detect', () => {
  it('returns venvPresent:true and pythonFound:true when both are present', async () => {
    setVenvBootstrap(
      new VenvBootstrap({
        repoRoot: '/repo',
        detectVenvFn: () => true,
        findPythonFn: () => ({ cmd: 'python3.11', args: [] }),
      }),
    );
    const res = await request(makeApp()).get('/api/setup/venv/detect');
    expect(res.status).toBe(200);
    expect(res.body.venvPresent).toBe(true);
    expect(res.body.pythonFound).toBe(true);
    expect(res.body.state).toBe('present');
  });

  it('returns venvPresent:false and pythonFound:false when both are absent', async () => {
    setVenvBootstrap(
      new VenvBootstrap({
        repoRoot: '/repo',
        detectVenvFn: () => false,
        findPythonFn: () => null,
      }),
    );
    const res = await request(makeApp()).get('/api/setup/venv/detect');
    expect(res.status).toBe(200);
    expect(res.body.venvPresent).toBe(false);
    expect(res.body.pythonFound).toBe(false);
    expect(res.body.state).toBe('absent');
  });
});

describe('POST /api/setup/venv/bootstrap + poll', () => {
  it('starts a job (202) and returns a job with id and status', async () => {
    setVenvBootstrap(
      new VenvBootstrap({
        repoRoot: '/repo',
        detectVenvFn: () => true,
        findPythonFn: () => ({ cmd: 'python3.11', args: [] }),
      }),
    );
    const app = makeApp();
    const start = await request(app).post('/api/setup/venv/bootstrap');
    expect(start.status).toBe(202);
    expect(start.body.id).toBeTruthy();
    expect(start.body.status).toBeTruthy();
  });

  it('reaches installed once venv lands (python present, spawn exits 0)', async () => {
    let calls = 0;
    setVenvBootstrap(
      new VenvBootstrap({
        repoRoot: '/repo',
        /* First call (pre-install probe) → absent; second call (post-
           bootstrap probe) → present. */
        detectVenvFn: () => calls++ > 0,
        findPythonFn: () => ({ cmd: 'python3.11', args: [] }),
        spawnFn: () => fakeChild(0) as never,
      }),
    );
    const app = makeApp();
    const start = await request(app).post('/api/setup/venv/bootstrap');
    expect(start.status).toBe(202);

    const done = await poll(app, start.body.id, (s) => s === 'installed' || s === 'error');
    expect(done.status).toBe('installed');
  });

  it('404s polling an unknown job id', async () => {
    setVenvBootstrap(
      new VenvBootstrap({
        repoRoot: '/repo',
        detectVenvFn: () => true,
        findPythonFn: () => ({ cmd: 'python3.11', args: [] }),
      }),
    );
    const res = await request(makeApp()).get('/api/setup/venv/bootstrap/does-not-exist');
    expect(res.status).toBe(404);
  });

  it('error job carries instructions string when Python is not found', async () => {
    setVenvBootstrap(
      new VenvBootstrap({
        repoRoot: '/repo',
        detectVenvFn: () => false,
        findPythonFn: () => null,
      }),
    );
    const app = makeApp();
    const start = await request(app).post('/api/setup/venv/bootstrap');
    expect(start.status).toBe(202);

    const done = await poll(app, start.body.id, (s) => s === 'error' || s === 'installed');
    expect(done.status).toBe('error');
    expect(typeof done.error).toBe('string');
    expect(done.error.length).toBeGreaterThan(0);
  });
});

describe('POST /api/setup/venv/bootstrap/:id/recheck', () => {
  it('promotes a stuck job to installed once the venv appears', async () => {
    let present = false;
    setVenvBootstrap(
      new VenvBootstrap({
        repoRoot: '/repo',
        detectVenvFn: () => present,
        findPythonFn: () => ({ cmd: 'python3.11', args: [] }),
        spawnFn: () => fakeChild(0) as never,
      }),
    );
    const app = makeApp();
    const start = await request(app).post('/api/setup/venv/bootstrap');
    // detectVenvFn always returns false → bootstrap exits 0 but venv still
    // missing → job lands in 'error'
    await poll(app, start.body.id, (s) => s === 'error');
    present = true;
    const res = await request(app).post(`/api/setup/venv/bootstrap/${start.body.id}/recheck`);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('installed');
  });
});
