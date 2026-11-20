import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express, { type Express } from 'express';
import request from 'supertest';
import { FS_FAILURE_REQUEST_ERROR } from '../workspace/file-lock.js';

const h = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock('undici', async (importOriginal) => ({
  ...(await importOriginal<typeof import('undici')>()),
  fetch: h.fetch,
}));

let workspaceRoot: string;
let app: Express;

beforeAll(async () => {
  workspaceRoot = mkdtempSync(join(tmpdir(), 'audiobook-detect-fs-test-'));
  process.env.WORKSPACE_DIR = workspaceRoot;
  const { analyzerEndpointsRouter } = await import('./analyzer-endpoints.js');
  app = express();
  app.use(express.json());
  app.use('/api/analyzer/endpoints', analyzerEndpointsRouter);
});

afterAll(() => {
  if (workspaceRoot) rmSync(workspaceRoot, { recursive: true, force: true });
  delete process.env.WORKSPACE_DIR;
});

describe('POST /api/analyzer/endpoints/detect-context fs failure (#3702)', () => {
  it('answers the curated sentence for a node fs error, never the raw path', async () => {
    h.fetch.mockRejectedValue(
      Object.assign(
        new Error("EPERM: operation not permitted, rename 'C:\\Users\\someone\\castwright-workspace\\x' -> 'y'"),
        { code: 'EPERM', syscall: 'rename', path: 'C:\\Users\\someone\\castwright-workspace\\x' },
      ),
    );
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await request(app)
      .post('/api/analyzer/endpoints/detect-context')
      .send({ baseUrl: 'http://127.0.0.1:1/v1', flavor: 'llama.cpp' });
    quiet.mockRestore();
    expect(res.status).toBe(502);
    expect(res.body.code).toBe('detect-failed');
    expect(res.body.error).toBe(FS_FAILURE_REQUEST_ERROR);
    expect(JSON.stringify(res.body)).not.toContain('someone');
  });
});
