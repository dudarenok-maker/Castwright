/* PR #4007 pass 13 — the separated-voice record: one empty file per uuid under the
   workspace, read from disk every time (so it survives a restart), and failing
   closed when it cannot be read. */

import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const statFault = vi.hoisted(() => ({ code: null as string | null }));
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  const stat = (async (...args: Parameters<typeof actual.stat>) => {
    if (statFault.code) throw Object.assign(new Error('injected stat failure'), { code: statFault.code });
    return actual.stat(...args);
  }) as typeof actual.stat;
  return { ...actual, stat, default: { ...actual, stat } };
});

let workspaceRoot: string;
let mod: typeof import('./separated-voices.js');

beforeAll(async () => {
  workspaceRoot = mkdtempSync(join(tmpdir(), 'castwright-separated-'));
  process.env.WORKSPACE_DIR = workspaceRoot;
  mod = await import('./separated-voices.js');
});
afterEach(() => {
  statFault.code = null;
});
afterAll(() => {
  rmSync(workspaceRoot, { recursive: true, force: true });
});

const recordPath = (u: string) => join(workspaceRoot, 'voices', 'separated', u);

describe('separated-voices', () => {
  it('records a uuid as one empty file, reads it back, and forgets it', async () => {
    expect(await mod.isSeparatedVoice('uA')).toBe(false);
    await mod.recordSeparatedVoice('uA');
    expect(existsSync(recordPath('uA'))).toBe(true);
    expect(await mod.isSeparatedVoice('uA')).toBe(true);
    expect(await mod.isSeparatedVoice('uB')).toBe(false);
    await mod.forgetSeparatedVoice('uA');
    expect(existsSync(recordPath('uA'))).toBe(false);
    expect(await mod.isSeparatedVoice('uA')).toBe(false);
  });

  it('reads a record a previous process wrote (nothing is cached in memory)', async () => {
    mkdirSync(join(workspaceRoot, 'voices', 'separated'), { recursive: true });
    writeFileSync(recordPath('uPrev'), '');
    expect(await mod.isSeparatedVoice('uPrev')).toBe(true);
  });

  it('recording twice is idempotent; forgetting an absent record does not throw', async () => {
    await mod.recordSeparatedVoice('uTwice');
    await mod.recordSeparatedVoice('uTwice');
    expect(await mod.isSeparatedVoice('uTwice')).toBe(true);
    await expect(mod.forgetSeparatedVoice('uNever')).resolves.toBeUndefined();
  });

  it('fails closed: a record that cannot be read (not ENOENT) counts as present', async () => {
    statFault.code = 'EACCES';
    expect(await mod.isSeparatedVoice('uUnreadable')).toBe(true);
    statFault.code = 'ENOENT';
    expect(await mod.isSeparatedVoice('uUnreadable')).toBe(false);
  });

  it('review pass 4: a stamped record is "own" only for the book and edit epoch it names', async () => {
    const own = { bookId: 'b1', editEpoch: 'e1' };
    await mod.recordSeparatedVoice('uStamped', own);
    expect(await mod.isSeparatedVoice('uStamped')).toBe(true); // every other reader still sees a record
    expect(await mod.isOwnSeparatedVoice('uStamped', own)).toBe(true);
    expect(await mod.isOwnSeparatedVoice('uStamped', { bookId: 'b2', editEpoch: 'e1' })).toBe(false);
    expect(await mod.isOwnSeparatedVoice('uStamped', { bookId: 'b1', editEpoch: 'e2' })).toBe(false);
  });

  it('review pass 4: an empty ("Don\'t reuse"), absent or unparseable record is never own', async () => {
    const own = { bookId: 'b1', editEpoch: '' };
    await mod.recordSeparatedVoice('uEmpty');
    expect(await mod.isOwnSeparatedVoice('uEmpty', own)).toBe(false);
    expect(await mod.isOwnSeparatedVoice('uAbsentOwn', own)).toBe(false);
    writeFileSync(recordPath('uGarbage'), '{not json');
    expect(await mod.isOwnSeparatedVoice('uGarbage', own)).toBe(false);
    expect(await mod.isSeparatedVoice('uGarbage')).toBe(true);
  });

  it('a uuid cannot name a path outside the record folder', async () => {
    await mod.recordSeparatedVoice('../escape').catch(() => {}); // refused or sanitised, never outside
    expect(existsSync(join(workspaceRoot, 'voices', 'escape'))).toBe(false);
  });
});
