/* /api/qwen install routes (qwen-default phase 3). Uses an injected
   QwenInstallBootstrap with a stubbed detect + spawn so the whole
   detect/install/poll/recheck surface runs offline. */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import express from 'express';
import request from 'supertest';
import {
  qwenInstallRouter,
  setQwenInstallBootstrap,
  _resetQwenInstallBootstrap,
} from './qwen-install.js';
import { QwenInstallBootstrap } from '../tts/qwen-install-bootstrap.js';
import {
  _resetUserSettingsCache,
  getLastKnownQwenInstallState,
} from '../workspace/user-settings.js';
import type { QwenInstallState } from '../workspace/user-settings.js';

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/qwen', qwenInstallRouter);
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
    const res = await request(app).get(`/api/qwen/install/${id}`);
    if (until(res.body.status)) return res.body;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error('poll timed out');
}

beforeEach(() => {
  _resetUserSettingsCache();
});

afterEach(() => {
  _resetQwenInstallBootstrap();
});

describe('GET /api/qwen/detect', () => {
  it('returns the install-state + installed flag and seeds the resolver cache', async () => {
    setQwenInstallBootstrap(
      new QwenInstallBootstrap({ repoRoot: '/repo', detectFn: () => 'ready' }),
    );
    const res = await request(makeApp()).get('/api/qwen/detect');
    expect(res.body).toEqual({ state: 'ready', installed: true });
    /* The resolver cache now reads 'ready' so the default flips to Qwen. */
    expect(getLastKnownQwenInstallState()).toBe('ready');
  });
});

describe('POST /api/qwen/install + poll', () => {
  it('starts a job (202) and reaches installed; recheck/poll flips the resolver cache to ready', async () => {
    const detectStates: QwenInstallState[] = ['not-installed', 'ready'];
    let i = 0;
    setQwenInstallBootstrap(
      new QwenInstallBootstrap({
        repoRoot: '/repo',
        detectFn: () => detectStates[Math.min(i++, detectStates.length - 1)],
        spawnFn: () => fakeChild(0) as never,
      }),
    );
    const app = makeApp();
    const start = await request(app).post('/api/qwen/install');
    expect(start.status).toBe(202);
    expect(start.body.id).toBeTruthy();

    const done = await poll(app, start.body.id, (s) => s === 'installed' || s === 'error');
    expect(done.status).toBe('installed');
    /* Polling an installed job syncs the resolver cache to ready. */
    expect(getLastKnownQwenInstallState()).toBe('ready');
  });

  it('404s polling an unknown job id', async () => {
    setQwenInstallBootstrap(new QwenInstallBootstrap({ repoRoot: '/repo', detectFn: () => 'ready' }));
    const res = await request(makeApp()).get('/api/qwen/install/does-not-exist');
    expect(res.status).toBe(404);
  });
});

describe('POST /api/qwen/install/:id/recheck', () => {
  it('promotes a stuck job to installed once weights are present', async () => {
    let cur: QwenInstallState = 'not-installed';
    setQwenInstallBootstrap(
      new QwenInstallBootstrap({
        repoRoot: '/repo',
        detectFn: () => cur,
        spawnFn: () => fakeChild(0) as never,
      }),
    );
    const app = makeApp();
    const start = await request(app).post('/api/qwen/install');
    await poll(app, start.body.id, (s) => s === 'error'); // exit 0 but still not-installed → error
    cur = 'ready';
    const res = await request(app).post(`/api/qwen/install/${start.body.id}/recheck`);
    expect(res.body.status).toBe('installed');
    expect(getLastKnownQwenInstallState()).toBe('ready');
  });
});
