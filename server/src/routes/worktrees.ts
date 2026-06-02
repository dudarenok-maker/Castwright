/* Plan 86 — dev-only worktree dashboard server route. Lists every git
   worktree visible to `git worktree list --porcelain` plus each tree's
   port assignments (parsed from its .env.local) and a TCP probe against
   the dev server's port. Mounted at /api/worktrees in dev mode only; the
   handler 404s in production so released zips never expose git internals
   to non-dev users. */

import { Router } from 'express';
import type { Request, Response } from '../http.js';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import net from 'node:net';

const PORT_VARS = ['VITE_PORT', 'PORT', 'LOCAL_TTS_PORT', 'PLAYWRIGHT_PORT'] as const;

export interface WorktreeRow {
  path: string;
  branch: string | null;
  head: string | null;
  ports: Record<string, string>;
  vitePort: number;
  alive: boolean;
}

/* Mirror of the parsers in scripts/wt-list.mjs (lines 23 + 43). We don't
   import the .mjs because the server compiles to .js and ts-node-friendly
   ESM-from-CJS interop is fragile; the parsers are simple enough to
   inline-keep. */
export function parseWorktreePorcelain(text: string): Array<{
  path: string;
  branch: string | null;
  head: string | null;
}> {
  const trees: Array<{ path: string; branch: string | null; head: string | null }> = [];
  let current: { path: string; branch: string | null; head: string | null } | null = null;
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith('worktree ')) {
      if (current) trees.push(current);
      current = { path: line.slice('worktree '.length), branch: null, head: null };
    } else if (line.startsWith('branch ') && current) {
      current.branch = line.slice('branch '.length).replace(/^refs\/heads\//, '');
    } else if (line.startsWith('HEAD ') && current) {
      current.head = line.slice('HEAD '.length);
    } else if (line === 'detached' && current) {
      current.branch = '(detached)';
    }
  }
  if (current) trees.push(current);
  return trees;
}

export function parseEnvLocal(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq < 0) continue;
    out[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
  }
  return out;
}

function probePort(port: number, timeoutMs = 500): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = net.connect({ port, host: '127.0.0.1' });
    const done = (ok: boolean) => {
      sock.destroy();
      resolve(ok);
    };
    sock.once('connect', () => done(true));
    sock.once('error', () => done(false));
    sock.setTimeout(timeoutMs, () => done(false));
  });
}

export const worktreesRouter = Router();

worktreesRouter.get('/worktrees', async (_req: Request, res: Response) => {
  if (process.env.NODE_ENV === 'production') {
    return res.status(404).end();
  }
  try {
    const porcelain = spawnSync('git', ['worktree', 'list', '--porcelain'], { encoding: 'utf8' });
    if (porcelain.status !== 0) {
      return res
        .status(500)
        .json({ error: `git worktree list failed: ${porcelain.stderr || porcelain.stdout}` });
    }
    const trees = parseWorktreePorcelain(porcelain.stdout);
    const enriched: WorktreeRow[] = await Promise.all(
      trees.map(async (tree) => {
        const envPath = join(tree.path, '.env.local');
        const ports = existsSync(envPath) ? parseEnvLocal(readFileSync(envPath, 'utf8')) : {};
        const vitePort = parseInt(ports.VITE_PORT, 10) || 5173;
        const alive = await probePort(vitePort);
        return {
          path: tree.path,
          branch: tree.branch,
          head: tree.head,
          ports: Object.fromEntries(PORT_VARS.map((k) => [k, ports[k] ?? ''])),
          vitePort,
          alive,
        };
      }),
    );
    res.json({ worktrees: enriched });
  } catch (e) {
    console.error('[worktrees] GET failed', e);
    res.status(500).json({ error: (e as Error).message || 'Failed to list worktrees.' });
  }
});
