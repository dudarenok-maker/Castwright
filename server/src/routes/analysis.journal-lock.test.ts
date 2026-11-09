/* Plan 291 Task 14 (#4031) - the analysis job's fold and dedup journal writes are
   read-modify-writes of cast-merges.json, so they take the cast lock like the manual
   merge's append does. Unlocked, a manual append that reads the journal before the
   fold/dedup write lands overwrites it (or is overwritten), and rule 8 keeps the
   journal across Start fresh, so the lost entry stays lost.

   Shape: a manual-merge append is held inside the cast lock after its read; the
   journal write is fired meanwhile. Locked, it queues behind the append and both
   entries survive; unlocked, it lands in the gap and the append's write drops it. */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { writeFoldJournal, writeDedupJournal } from './analysis.js';
import { withCastLock } from '../workspace/cast-lock.js';
import {
  appendManualEntry,
  loadCastMerges,
  saveCastMerges,
} from '../store/cast-merges.js';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function mkDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'audiobook-4031-journal-'));
  mkdirSync(join(d, '.audiobook'), { recursive: true });
  dirs.push(d);
  return d;
}

const SENTENCES = [{ id: 1, chapterId: 1, characterId: 'src' }];
const ROSTER = [{ id: 'src', name: 'Src' }];

/** A manual append held open inside the cast lock until `release()`. */
function heldManualAppend(bookDir: string) {
  let release!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  let signalRead!: () => void;
  const read = new Promise<void>((r) => {
    signalRead = r;
  });
  const done = withCastLock(bookDir, async () => {
    const journal = await loadCastMerges(bookDir);
    signalRead();
    await gate;
    await saveCastMerges(
      bookDir,
      appendManualEntry(journal, {
        ts: '2026-01-01T00:00:00.000Z',
        kind: 'manual',
        sourceId: 'manual-src',
        sourceName: 'Manual',
        targetId: 'tgt',
        affected: [],
      }),
    );
  });
  return { read, release, done };
}

describe('#4031 analysis journal writes hold the cast lock', () => {
  const cases: Array<[string, 'fold' | 'dedup', (d: string) => Promise<void>]> = [
    ['writeFoldJournal', 'fold', (d) => writeFoldJournal(d, { src: 'tgt' }, SENTENCES, ROSTER)],
    ['writeDedupJournal', 'dedup', (d) => writeDedupJournal(d, { src: 'tgt' }, SENTENCES, ROSTER)],
  ];

  for (const [name, kind, write] of cases) {
    it(`${name}: a racing manual-merge append and the ${kind} entry both survive`, async () => {
      const dir = mkDir();
      const manual = heldManualAppend(dir);
      await manual.read;

      const journalWrite = write(dir);
      journalWrite.catch(() => {});
      /* Locked, the write cannot start until the append ends, so there is no positive
         signal to wait on; give it a few macrotasks to land if nothing stops it. */
      await new Promise((r) => setTimeout(r, 100));
      manual.release();
      await manual.done;
      await journalWrite;

      const entries = (await loadCastMerges(dir)).entries;
      expect(entries.map((e) => e.kind).sort()).toEqual([kind, 'manual']);
    });
  }
});
