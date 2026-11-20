/* #3702 / #4508 -- the dev worktrees route keeps absolute paths out of its 500 bodies.
   Both failures are driven with their REAL producers: git's own stderr from a real
   failing `git` child, and a real node fs error (EISDIR) from the route's own readFileSync. */

import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express, { type Express } from 'express';
import request from 'supertest';

const spawnSyncMock = vi.fn();
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, spawnSync: (...a: unknown[]) => spawnSyncMock(...a) };
});

let app: Express;
let scratch: string;

beforeAll(async () => {
  const { worktreesRouter } = await import('./worktrees.js');
  app = express();
  app.use('/api', worktreesRouter);
});

beforeEach(() => {
  spawnSyncMock.mockReset();
  scratch = mkdtempSync(join(tmpdir(), 'worktrees-route-test-'));
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  rmSync(scratch, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('worktrees route -- path-free 500 bodies', () => {
  it('a real non-zero git exit: its stderr (which names an absolute path) is scrubbed', async () => {
    const { spawnSync: realSpawnSync } = await vi.importActual<typeof import('node:child_process')>(
      'node:child_process',
    );
    const missing = join(scratch, 'not-a-repo');
    spawnSyncMock.mockImplementation(() =>
      realSpawnSync('git', ['-C', missing, 'worktree', 'list', '--porcelain'], { encoding: 'utf8' }),
    );

    const res = await request(app).get('/api/worktrees');

    expect(res.status).toBe(500);
    expect(res.body.error).toMatch(/^git worktree list failed: /);
    expect(res.body.error).not.toContain('not-a-repo');
    expect(res.body.error).not.toContain(scratch);
    expect(res.body.error).not.toMatch(/[A-Za-z]:[/\\]/);
  });

  it('a real node fs error while reading a worktree .env.local answers the curated fs sentence', async () => {
    const { FS_FAILURE_REQUEST_ERROR } = await import('../workspace/file-lock.js');
    const tree = join(scratch, 'tree');
    mkdirSync(join(tree, '.env.local'), { recursive: true }); // a directory: readFileSync -> EISDIR
    spawnSyncMock.mockReturnValue({
      status: 0,
      stdout: `worktree ${tree}
HEAD abc123
branch refs/heads/x
`,
      stderr: '',
    });

    const res = await request(app).get('/api/worktrees');

    expect(res.status).toBe(500);
    expect(res.body.error).toBe(FS_FAILURE_REQUEST_ERROR);
  });
});
