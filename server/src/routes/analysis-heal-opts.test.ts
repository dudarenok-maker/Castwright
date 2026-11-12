/* #4031 A11 — the run-start name heal's read of its refusals (`readHealOpts`): an
   unreadable cast-merge-suggestions.json must not fail the run start, but must
   switch the heal off for the run (a heal never merges across a decision it
   cannot read). The refusal rules are unit-tested in
   store/merge-analysis-cast.test.ts. */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readHealOpts } from '../workspace/analysis-cast-io.js';
import { dedupePriorCastByName } from '../store/merge-analysis-cast.js';

let bookDir: string;

beforeEach(() => {
  bookDir = mkdtempSync(join(tmpdir(), 'audiobook-heal-opts-'));
  mkdirSync(join(bookDir, '.audiobook'), { recursive: true });
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(bookDir, { recursive: true, force: true });
});

const pair = [
  { id: 'anton', name: 'Антон', voiceState: 'tuned', lines: 40 },
  { id: 'антон', name: 'Антон', voiceState: 'generated', lines: 2 },
];

describe('readHealOpts (#4031 A11)', () => {
  it('a malformed suggestions file: the heal merges nothing, the run goes on, the error is logged', async () => {
    writeFileSync(join(bookDir, '.audiobook', 'cast-merge-suggestions.json'), '{ not json');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const opts = await readHealOpts(bookDir);
    const { cast, retirements } = dedupePriorCastByName(pair, undefined, opts);

    expect(cast).toHaveLength(2);
    expect(retirements).toEqual([]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('cast-merge-suggestions.json'));
  });

  it('a readable (absent) suggestions file leaves the heal on', async () => {
    const opts = await readHealOpts(bookDir);
    expect(dedupePriorCastByName(pair, undefined, opts).cast).toHaveLength(1);
  });
});
