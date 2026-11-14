/* Guard (#3712): no test may reach the real VenvBootstrap spawn or its real
   Python lookup. node:child_process is mocked so even the red run spawns
   nothing real. */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import request from 'supertest';

vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:child_process')>()),
  spawn: vi.fn(),
  spawnSync: vi.fn(() => ({ status: 1, stdout: '', stderr: '' })),
}));
vi.mock('../diagnostics/venv.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../diagnostics/venv.js')>()),
  sidecarVenvPresent: () => false,
}));

import { spawn, spawnSync } from 'node:child_process';
import { VenvBootstrap } from './venv-bootstrap.js';
import { venvBootstrapRouter, _resetVenvBootstrap } from '../routes/venv-bootstrap.js';

function fakeChild(code: number) {
  const child = new EventEmitter() as EventEmitter & { stdout: EventEmitter; stderr: EventEmitter };
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  queueMicrotask(() => child.emit('close', code));
  return child;
}

beforeEach(() => {
  vi.mocked(spawn).mockClear();
  vi.mocked(spawnSync).mockClear();
});
afterEach(() => {
  _resetVenvBootstrap();
});

describe('VenvBootstrap never reaches a real spawn / Python lookup under vitest', () => {
  it('G0: running under vitest', () => {
    expect(process.env.VITEST).toBeTruthy();
  });

  it('G1: default spawnFn is refused', async () => {
    const b = new VenvBootstrap({
      repoRoot: mkdtempSync(join(tmpdir(), 'vb-')),
      detectVenvFn: () => false,
      findPythonFn: () => ({ cmd: 'python3.12', args: [] }),
    });
    const job = b.start();
    await vi.waitFor(() => {
      if (b.getJob(job.id)?.status !== 'error') throw new Error('not yet');
    });
    expect(b.getJob(job.id)?.error).toMatch(/real spawn refused under vitest/);
    expect(spawn).toHaveBeenCalledTimes(0);
  });

  it('G2: default findPythonFn is refused', () => {
    const b = new VenvBootstrap({
      repoRoot: mkdtempSync(join(tmpdir(), 'vb-')),
      detectVenvFn: () => false,
    });
    expect(() => b.detect()).toThrow(/real Python lookup refused under vitest/);
    expect(spawnSync).toHaveBeenCalledTimes(0);
  });

  it("G3: the app's default instance is refused", async () => {
    _resetVenvBootstrap();
    const app = express();
    app.use(express.json());
    app.use('/api/setup/venv', venvBootstrapRouter);
    const res = await request(app).post('/api/setup/venv/bootstrap');
    expect(res.status).toBe(202);
    let body: { status?: string; error?: string } = {};
    await vi.waitFor(async () => {
      body = (await request(app).get(`/api/setup/venv/bootstrap/${res.body.id}`)).body;
      if (body.status !== 'error') throw new Error('not yet');
    });
    expect(body.error).toMatch(/real Python lookup refused under vitest/);
    expect(spawn).toHaveBeenCalledTimes(0);
    expect(spawnSync).toHaveBeenCalledTimes(0);
  });

  it('G4: injected stubs still work', async () => {
    let present = false;
    const spawnFn = vi.fn(() => {
      present = true;
      return fakeChild(0) as never;
    });
    const b = new VenvBootstrap({
      repoRoot: mkdtempSync(join(tmpdir(), 'vb-')),
      detectVenvFn: () => present,
      findPythonFn: () => ({ cmd: 'python3.12', args: [] }),
      spawnFn,
    });
    const job = b.start();
    await vi.waitFor(() => {
      if (b.getJob(job.id)?.status !== 'installed') throw new Error('not yet');
    });
    expect(spawnFn).toHaveBeenCalledTimes(1);
  });
});
