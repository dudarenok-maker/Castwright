/* #3702 -- `ollama rm` failing: Node's execFile rejection puts the child's STDERR in
   `.message` (`Command failed: <cmd>\n<stderr>`) with a NUMERIC `code` (the exit
   status), so the fs seam in the 500 body can never fire and a path in that stderr
   (Go's `remove <abs path>: <reason>`) would reach the client. The failing child here
   is a REAL one (node writing to stderr and exiting 1), run through the real execFile. */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';

const execFileMock = vi.fn();
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, execFile: (...a: unknown[]) => execFileMock(...a) };
});

import { modelsInventoryRouter } from './models-inventory.js';

const TAG = 'tinyllama:latest';

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string) => {
      if (String(url).endsWith('/api/tags')) {
        return Promise.resolve(
          new Response(JSON.stringify({ models: [{ name: TAG, size: 1 }] }), { status: 200 }),
        );
      }
      if (String(url).endsWith('/api/ps')) {
        return Promise.resolve(new Response(JSON.stringify({ models: [] }), { status: 200 }));
      }
      return Promise.reject(new Error('offline'));
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  execFileMock.mockReset();
});

async function realFailingChild(script: string) {
  const real = await vi.importActual<typeof import('node:child_process')>('node:child_process');
  execFileMock.mockImplementation(((_cmd: string, _args: string[], opts: object, cb: unknown) =>
    real.execFile(process.execPath, ['-e', script], opts, cb as never)) as never);
}

function app() {
  const a = express();
  a.use(express.json());
  a.use('/api/models', modelsInventoryRouter);
  return a;
}

describe('POST /api/models/:id/remove -- ollama rm failure body (#3702)', () => {
  it('a real failing child: its multi-line stderr is kept line by line, with no absolute path', async () => {
    const lines = [
      'Error: remove C:\\Users\\someone\\.ollama\\models\\blobs\\sha256-abc: The process cannot access the file',
      'hint: close any running ollama session and retry',
    ];
    await realFailingChild(`console.error(${JSON.stringify(lines.join('\n'))}); process.exit(1)`);

    const res = await request(app()).post(`/api/models/ollama:${TAG}/remove`);

    expect(res.status).toBe(500);
    expect(res.body.error).toContain('hint: close any running ollama session and retry');
    expect(res.body.error).not.toContain('someone');
    expect(res.body.error).not.toContain('.ollama');
    expect(res.body.error).not.toContain(process.execPath);
    expect(res.body.error).not.toMatch(/[A-Za-z]:[/\\]/);
  });

  it('a POSIX path in the stderr is scrubbed too', async () => {
    await realFailingChild(
      "console.error('Error: remove /home/someone/.ollama/models/blobs/sha256-abc: permission denied'); process.exit(1)",
    );

    const res = await request(app()).post(`/api/models/ollama:${TAG}/remove`);

    expect(res.status).toBe(500);
    expect(res.body.error).not.toContain('/home/someone');
    expect(res.body.error).not.toContain('.ollama');
  });
});
