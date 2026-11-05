/* #4029 item 4 -- a fan-out request that already carries the current repair epoch is never refused, so
   refuseGatedSeriesFanOut returns before it walks the library (one state.json read per gated id). */
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Request, Response } from 'express';

const findAuthorSeriesForBookId = vi.fn();
vi.mock('./series-cast-scan.js', () => ({ findAuthorSeriesForBookId }));

let root: string;
let gate: typeof import('./repaired-book-gate.js');
let refusal: typeof import('./repaired-series-refusal.js');

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'audiobook-repaired-series-refusal-'));
  process.env.WORKSPACE_DIR = root;
  gate = await import('./repaired-book-gate.js');
  refusal = await import('./repaired-series-refusal.js');
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterAll(() => {
  vi.restoreAllMocks();
  rmSync(root, { recursive: true, force: true });
  delete process.env.WORKSPACE_DIR;
});

beforeEach(async () => {
  findAuthorSeriesForBookId.mockReset();
  findAuthorSeriesForBookId.mockResolvedValue({ author: 'Auth', series: 'Ser' });
  gate.__resetRepairedBookGateForTest();
  await gate.registerRepairedBook('auth__ser__a', null);
  await gate.registerRepairedBook('auth__ser__b', null);
});

const reqWith = (epoch: string | undefined) => ({ get: (h: string) => (h.toLowerCase() === 'x-repair-epoch' ? epoch : undefined) }) as unknown as Request;
const makeRes = () => {
  const res = { status: vi.fn(), json: vi.fn() };
  res.status.mockReturnValue(res);
  return res as unknown as Response & typeof res;
};
const series = { author: 'Auth', series: 'Ser' };

describe('refuseGatedSeriesFanOut (#4029)', () => {
  it('a request carrying the current epoch is let through without walking the library', async () => {
    const res = makeRes();
    expect(await refusal.refuseGatedSeriesFanOut(series, reqWith(gate.currentRepairEpoch()!), res)).toBe(false);
    expect(findAuthorSeriesForBookId).not.toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
  });

  it('a STALE epoch is not "carries the epoch": it walks and answers 409', async () => {
    const res = makeRes();
    expect(await refusal.refuseGatedSeriesFanOut(series, reqWith('previous-boot-epoch'), res)).toBe(true);
    expect(findAuthorSeriesForBookId).toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(409);
  });

  it('CONTROL: without the epoch it walks, finds the gated mate in scope and answers 409', async () => {
    const res = makeRes();
    expect(await refusal.refuseGatedSeriesFanOut(series, reqWith(undefined), res)).toBe(true);
    expect(findAuthorSeriesForBookId).toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(409);
  });
});
