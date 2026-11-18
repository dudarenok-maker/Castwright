/* #4319 review pass 3 — `unlinkWithRetry` and its two callers (`preserveExistingAsPrevious`'s
   stale-previous removal, `discardStaleLiveAudio`'s stale-live removal). `unlink` is mocked
   so a failure can be scripted: a transient one that clears on retry, a permanent one, and
   ENOENT (the goal state of an unlink, so it counts as success at once). Each test names
   the mutation that turns it red. */
import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll, vi } from 'vitest';
import { mkdtempSync, writeFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const plan = { failTimes: 0, always: false, code: 'EBUSY', calls: 0 };

vi.mock('node:fs/promises', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...real,
    unlink: vi.fn(async (...args: Parameters<typeof real.unlink>) => {
      plan.calls += 1;
      if (plan.always || plan.failTimes > 0) {
        plan.failTimes -= 1;
        throw Object.assign(new Error(`${plan.code}: injected unlink failure`), { code: plan.code });
      }
      return real.unlink(...args);
    }),
  };
});

const SLUG = 'ch-01';
let workspaceRoot: string;
let audioRoot: string;
let take: typeof import('./chapter-take.js');

beforeAll(async () => {
  workspaceRoot = mkdtempSync(join(tmpdir(), 'audiobook-unlink-retry-'));
  process.env.WORKSPACE_DIR = workspaceRoot;
  take = await import('./chapter-take.js');
});

beforeEach(() => {
  plan.failTimes = 0;
  plan.always = false;
  plan.code = 'EBUSY';
  plan.calls = 0;
  audioRoot = mkdtempSync(join(workspaceRoot, 'audio-'));
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(() => {
  rmSync(workspaceRoot, { recursive: true, force: true });
  delete process.env.WORKSPACE_DIR;
});

const touch = (name: string) => writeFileSync(join(audioRoot, name), 'x');
const files = () => readdirSync(audioRoot).sort();

describe('unlinkWithRetry at the preserve site (stale previous of another extension)', () => {
  it('ENOENT is the goal state: the stale previous that vanished counts as removed at once, with no retry wait (unlinkWithRetry retrying ENOENT turns this red)', async () => {
    touch(`${SLUG}.m4a`);
    touch(`${SLUG}.previous.mp3`);
    plan.always = true;
    plan.code = 'ENOENT';
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const t0 = Date.now();

    const r = await take.preserveExistingAsPrevious(audioRoot, SLUG);

    expect(plan.calls).toBe(1);
    expect(Date.now() - t0).toBeLessThan(500);
    expect(r.preserved).toBe(true);
    expect(warn).not.toHaveBeenCalled();
  });
});

describe('unlinkWithRetry at the discard site (stale live audio after a format switch)', () => {
  it('ENOENT counts as removed at once: no retry, no warning, no .stale (unlinkWithRetry retrying ENOENT turns this red)', async () => {
    touch(`${SLUG}.mp3`);
    touch(`${SLUG}.m4a`);
    plan.always = true;
    plan.code = 'ENOENT';
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const t0 = Date.now();

    await take.discardStaleLiveAudio(audioRoot, SLUG, 'm4a');

    expect(plan.calls).toBe(1);
    expect(Date.now() - t0).toBeLessThan(500);
    expect(warn).not.toHaveBeenCalled();
    expect(files().some((f) => f.endsWith('.stale'))).toBe(false);
  });

});
