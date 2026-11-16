/* #4236 -- POST /api/models/:id/remove's catch-all 500 echoed `err.message`. An fs
   failure while deleting a weight dir (EACCES / EIO on a path under the HF cache or
   the repo) embeds that absolute path, and this app is served over LAN HTTPS. The 500
   now answers via `requestFailureMessageFs`; EBUSY / EPERM / ENOTEMPTY keep their own
   409 `files-locked` branch. */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const rm = vi.hoisted(() => ({ boom: null as unknown }));

vi.mock('node:fs', async (orig) => {
  const actual = await orig<typeof import('node:fs')>();
  return {
    ...actual,
    rmSync: ((p: string, o?: Parameters<typeof actual.rmSync>[1]) => {
      if (rm.boom) throw rm.boom;
      return actual.rmSync(p, o);
    }) as typeof actual.rmSync,
  };
});

import { modelsInventoryRouter } from './models-inventory.js';
import { whisperRepoDir } from '../tts/model-paths.js';

const WEIGHTS = 'C:\\Users\\someone\\hf-cache\\The Quota\\models--Systran--faster-whisper-base';
const fsErr = (code: string) =>
  Object.assign(new Error(`${code}: permission denied, rmdir '${WEIGHTS}'`), {
    code,
    syscall: 'rmdir',
    path: WEIGHTS,
  });

let hfCache: string;
const savedHfHubCache = process.env.HF_HUB_CACHE;
const savedHfHome = process.env.HF_HOME;

beforeEach(() => {
  hfCache = mkdtempSync(join(tmpdir(), 'mm-rm-hf-'));
  process.env.HF_HUB_CACHE = hfCache;
  delete process.env.HF_HOME;
  const dir = join(whisperRepoDir(), 'snapshots', 'abc');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'model.bin'), Buffer.alloc(16, 1));
  /* Both probes fail fast: the sidecar and Ollama are unreachable. */
  vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('offline'))));
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  rm.boom = null;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  rmSync(hfCache, { recursive: true, force: true });
  if (savedHfHubCache === undefined) delete process.env.HF_HUB_CACHE;
  else process.env.HF_HUB_CACHE = savedHfHubCache;
  if (savedHfHome === undefined) delete process.env.HF_HOME;
  else process.env.HF_HOME = savedHfHome;
});

function app() {
  const a = express();
  a.use(express.json());
  a.use('/api/models', modelsInventoryRouter);
  return a;
}

describe('POST /api/models/:id/remove error bodies (#4236)', () => {
  it('an fs error that is not a lock answers the curated permanent sentence, never the path', async () => {
    rm.boom = fsErr('EACCES');
    const res = await request(app()).post('/api/models/whisper/remove');
    expect(res.status).toBe(500);
    expect(res.body.error).toBe(
      'Files could not be read or written. Check free disk space and folder permissions.',
    );
    expect(res.text).not.toContain('Quota');
    expect(res.text).not.toContain('hf-cache');
  });

  it('EBUSY keeps its own files-locked 409', async () => {
    rm.boom = fsErr('EBUSY');
    const res = await request(app()).post('/api/models/whisper/remove');
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('files-locked');
  });

  it('an ordinary error keeps its own message', async () => {
    rm.boom = new Error('disk exploded');
    const res = await request(app()).post('/api/models/whisper/remove');
    expect(res.status).toBe(500);
    expect(res.body.error).toBe('disk exploded');
  });
});
