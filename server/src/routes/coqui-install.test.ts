/* /api/coqui install routes. Uses an injected CoquiInstallBootstrap with a
   stubbed detect + spawn so the whole detect/install/poll/recheck surface runs
   offline. */

import { describe, it, expect, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import express from 'express';
import request from 'supertest';
import {
  coquiInstallRouter,
  setCoquiInstallBootstrap,
  _resetCoquiInstallBootstrap,
} from './coqui-install.js';
import { CoquiInstallBootstrap } from '../tts/coqui-install-bootstrap.js';
import type { CoquiInstallState } from '../tts/coqui-install-detect.js';

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/coqui', coquiInstallRouter);
  return app;
}

function fakeChild(code: number) {
  const child = new EventEmitter() as EventEmitter & { stdout: EventEmitter; stderr: EventEmitter };
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  queueMicrotask(() => child.emit('close', code));
  return child;
}

async function poll(app: express.Express, id: string, until: (s: string) => boolean) {
  for (let i = 0; i < 200; i++) {
    const res = await request(app).get(`/api/coqui/install/${id}`);
    if (until(res.body.status)) return res.body;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error('poll timed out');
}

afterEach(() => {
  _resetCoquiInstallBootstrap();
});

describe('GET /api/coqui/detect', () => {
  it('returns the install-state + installed flag', async () => {
    setCoquiInstallBootstrap(
      new CoquiInstallBootstrap({ repoRoot: '/repo', detectFn: () => 'ready' }),
    );
    const res = await request(makeApp()).get('/api/coqui/detect');
    expect(res.body).toEqual({ state: 'ready', installed: true });
  });

  it('reports installed:false for weights-missing', async () => {
    setCoquiInstallBootstrap(
      new CoquiInstallBootstrap({ repoRoot: '/repo', detectFn: () => 'weights-missing' }),
    );
    const res = await request(makeApp()).get('/api/coqui/detect');
    expect(res.body).toEqual({ state: 'weights-missing', installed: false });
  });
});

describe('POST /api/coqui/install + poll', () => {
  it('starts a job (202) and reaches installed', async () => {
    const detectStates: CoquiInstallState[] = ['weights-missing', 'ready'];
    let i = 0;
    setCoquiInstallBootstrap(
      new CoquiInstallBootstrap({
        repoRoot: '/repo',
        detectFn: () => detectStates[Math.min(i++, detectStates.length - 1)],
        spawnFn: () => fakeChild(0) as never,
      }),
    );
    const app = makeApp();
    const start = await request(app).post('/api/coqui/install');
    expect(start.status).toBe(202);
    expect(start.body.id).toBeTruthy();

    const done = await poll(app, start.body.id, (s) => s === 'installed' || s === 'error');
    expect(done.status).toBe('installed');
  });

  it('404s polling an unknown job id', async () => {
    setCoquiInstallBootstrap(
      new CoquiInstallBootstrap({ repoRoot: '/repo', detectFn: () => 'ready' }),
    );
    const res = await request(makeApp()).get('/api/coqui/install/does-not-exist');
    expect(res.status).toBe(404);
  });
});

describe('POST /api/coqui/install/:id/recheck', () => {
  it('promotes a stuck job to installed once weights are present', async () => {
    let cur: CoquiInstallState = 'weights-missing';
    setCoquiInstallBootstrap(
      new CoquiInstallBootstrap({
        repoRoot: '/repo',
        detectFn: () => cur,
        spawnFn: () => fakeChild(0) as never,
      }),
    );
    const app = makeApp();
    const start = await request(app).post('/api/coqui/install');
    await poll(app, start.body.id, (s) => s === 'error'); // exit 0 but still weights-missing → error
    cur = 'ready';
    const res = await request(app).post(`/api/coqui/install/${start.body.id}/recheck`);
    expect(res.body.status).toBe('installed');
  });
});
