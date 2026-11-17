/* Unit tests for slugKeepingTake (#4230). Real temp dir, no mocks. Each test
   names the mutation that turns it red. */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { slugKeepingTake } from './keep-take-slug.js';

let audioRoot: string;

beforeEach(() => {
  audioRoot = mkdtempSync(join(tmpdir(), 'keep-take-slug-'));
});
afterEach(() => {
  rmSync(audioRoot, { recursive: true, force: true });
});

const touch = (name: string) => writeFileSync(join(audioRoot, name), 'x');
const prev2 = [{ id: 2, slug: '02-old' }];

describe('slugKeepingTake', () => {
  it('keeps the old slug when a live mp3 exists (red if the probe is replaced by a constant false)', () => {
    touch('02-old.mp3');
    expect(slugKeepingTake(prev2, audioRoot, 2, '02-new')).toBe('02-old');
  });

  it('probes m4a and ogg too (red if only .mp3 is probed)', () => {
    touch('02-old.m4a');
    expect(slugKeepingTake(prev2, audioRoot, 2, '02-new')).toBe('02-old');
    rmSync(join(audioRoot, '02-old.m4a'));
    touch('02-old.ogg');
    expect(slugKeepingTake(prev2, audioRoot, 2, '02-new')).toBe('02-old');
  });

  it('returns the computed slug when no audio exists (red if the probe is replaced by true)', () => {
    expect(slugKeepingTake(prev2, audioRoot, 2, '02-new')).toBe('02-new');
  });

  it('a .previous take or a segments sidecar is not a live take (red if the probe is replaced by true)', () => {
    touch('02-old.previous.mp3');
    expect(slugKeepingTake(prev2, audioRoot, 2, '02-new')).toBe('02-new');
    rmSync(join(audioRoot, '02-old.previous.mp3'));
    touch('02-old.segments.json');
    expect(slugKeepingTake(prev2, audioRoot, 2, '02-new')).toBe('02-new');
  });

  it('returns computed when prev slug equals computed, without needing the audio root (red if the equality short-circuit is removed and the probe throws/misbehaves)', () => {
    const missing = join(audioRoot, 'does-not-exist');
    expect(slugKeepingTake(prev2, missing, 2, '02-old')).toBe('02-old');
  });

  it('returns computed when no previous chapter has that id (red if the lookup ignores id)', () => {
    touch('02-new.mp3');
    touch('02-old.mp3');
    expect(slugKeepingTake([{ id: 1, slug: '02-old' }], audioRoot, 2, '02-new')).toBe('02-new');
  });

  it('matches by id, not by scanning files: audio at id 3 old slug does not affect id 2 (red if lookup is by index or true probe)', () => {
    touch('03-old.mp3');
    const prev = [{ id: 3, slug: '03-old' }];
    expect(slugKeepingTake(prev, audioRoot, 2, '02-new')).toBe('02-new');
  });
});
