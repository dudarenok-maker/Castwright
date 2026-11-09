/* The interim manuscript-edits.json roll shared by the main and subset analysis
   routes (#3427). `buildRunning` is called inside the verified-dir callback — see below. */

import { withVerifiedBookDir, type WithVerifiedBookDirOpts } from './book-dir-guard.js';
import { withBookLock } from './book-lock.js';
import { manuscriptEditsJsonPath } from './paths.js';
import { writeJsonAtomicOrdered } from './ordered-write.js';
import { readJson } from './state-io.js';

/** The two fields a roll reads off a sentence; the rest is passed through. */
export interface RollSentence {
  chapterId: number;
  characterId: string;
}

/** Puts the roll's own sentences on the ids that are current now. May read, never locks `cast`. */
export type ResolveRollIds = (sentences: RollSentence[]) => RollSentence[] | Promise<RollSentence[]>;

/* Without `resolveIds` the roll writes `buildRunning()` as the whole file, as
   before (the subset job). With it (#4031) `buildRunning` returns only the
   chapters this job produced; the roll re-reads the file under the `book` lock
   and replaces just those, so chapters it did not produce — and a merge's remap
   of them — stay as the file has them. */
export async function rollManuscriptEdits(
  opts: WithVerifiedBookDirOpts,
  buildRunning: () => unknown[],
  bookId?: string,
  resolveIds?: ResolveRollIds,
  /* Chapters this job did not produce but the file may lack (a cached take): used only
     where the file has no sentences for the chapter, never over what it has. */
  fallback?: () => unknown[],
): Promise<void> {
  await withVerifiedBookDir(opts, async (bookDir) => {
    /* `withVerifiedBookDir` awaits a state.json read (with a sleeping retry on a
       transient failure) before this callback runs, so rolls reach here in
       verification-completion order, not call order. Build the snapshot HERE,
       immediately before the ordered write, so the snapshot and the queue
       position are one synchronous step: whichever roll joins the queue last
       also holds the freshest snapshot. */
    const roll = async (): Promise<void> => {
      const path = manuscriptEditsJsonPath(bookDir);
      if (!resolveIds) {
        await writeJsonAtomicOrdered(path, { sentences: buildRunning() });
        return;
      }
      const own = await resolveIds(buildRunning() as RollSentence[]);
      /* Absent is empty; an unreadable or malformed file throws, so a transient
         read fault is never written over as "no other chapters". */
      const onDisk = await readJson<{ sentences?: unknown }>(path);
      if (onDisk && !Array.isArray(onDisk.sentences)) {
        throw new Error('manuscript-edits.json has no sentences array');
      }
      const have = (onDisk?.sentences as RollSentence[] | undefined) ?? [];
      const present = new Set([...have, ...own].map((x) => x.chapterId));
      const seed = fallback ? await resolveIds(fallback() as RollSentence[]) : [];
      await writeJsonAtomicOrdered(path, {
        sentences: replaceChapters(have, [...own, ...seed.filter((x) => !present.has(x.chapterId))]),
      });
    };
    /* #3784 — the write is `book`-locked, shared with the slice PUT's manuscript
       revision check + write, so a roll cannot land between them. The analysis
       job holds no lock here (order `cast` -> `book`); the lock is FIFO, so rolls
       still join the queue in the order they reach it. A record with no bookId
       (legacy) has no lock key; roll unlocked as before. */
    if (bookId) await withBookLock(bookId, roll);
    else await roll();
  });
}

/* `own` replaces the file's sentences of the same chapters, in the slot the chapter
   already had; a chapter the file lacks goes before the first chapter with a
   higher id (after the last one when none is). */
function replaceChapters(onDisk: RollSentence[], own: RollSentence[]): RollSentence[] {
  const byChapter = new Map<number, RollSentence[]>();
  for (const x of onDisk) byChapter.set(x.chapterId, [...(byChapter.get(x.chapterId) ?? []), x]);
  const ownByChapter = new Map<number, RollSentence[]>();
  for (const x of own) ownByChapter.set(x.chapterId, [...(ownByChapter.get(x.chapterId) ?? []), x]);
  const order = [...byChapter.keys()];
  for (const id of ownByChapter.keys()) {
    if (byChapter.has(id)) continue;
    const at = order.findIndex((o) => o > id);
    order.splice(at < 0 ? order.length : at, 0, id);
  }
  return order.flatMap((id) => ownByChapter.get(id) ?? byChapter.get(id) ?? []);
}
