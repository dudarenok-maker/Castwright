import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express, { type Express } from 'express';
import request from 'supertest';

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

/* #3702 -- detectServedContext wraps its "Could not reach" message in the fs seam, but its
   only producer is an undici fetch rejection (`TypeError: fetch failed`, no `code`/`syscall`;
   the reason rides on `cause`), which the seam never curates: the wrap is inert by
   construction. Pin that the message passes through unchanged. */
describe('POST /api/analyzer/endpoints/detect-context -- a real undici rejection (#3702)', () => {
  it('answers the unchanged "Could not reach" message', async () => {
    h.fetch.mockRejectedValue(
      Object.assign(new TypeError('fetch failed'), {
        cause: Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:1'), {
          code: 'ECONNREFUSED',
          syscall: 'connect',
        }),
      }),
    );
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await request(app)
      .post('/api/analyzer/endpoints/detect-context')
      .send({ baseUrl: 'http://127.0.0.1:1/v1', flavor: 'llama.cpp' });
    quiet.mockRestore();
    expect(res.status).toBe(502);
    expect(res.body.code).toBe('detect-failed');
    expect(res.body.error).toBe('Could not reach http://127.0.0.1:1 (ECONNREFUSED).');
  });
});
