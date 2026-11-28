/* #1393 (plan 293 §2.2) — `computeRunQwenNeeds`: a pending queue entry is evaluated at its OWN
   stamp (engine and Qwen tier), and every pending entry of a chapter counts (each one renders). */
import { describe, expect, it } from 'vitest';
import type { QueueEntry } from '../workspace/queue-io.js';
import { computeRunQwenNeeds, type RunQwenNeedsInput } from './qwen-run-needs.js';
import { chr, NONE, sent, T06, T17 } from './qwen-tier-needs.fixtures.js';
import type { CastCharacter } from './synthesise-chapter.js';

const entry = (
  id: string,
  chapterId: number,
  status: QueueEntry['status'],
  modelKey?: QueueEntry['modelKey'],
): QueueEntry => ({
  id,
  bookId: 'b1',
  chapterId,
  scope: 'this',
  addedAt: '2026-11-22T00:00:00.000Z',
  status,
  order: chapterId,
  ...(modelKey ? { modelKey } : {}),
});

const run = (over: Partial<RunQwenNeedsInput>) =>
  computeRunQwenNeeds({
    bookId: 'b1',
    targetChapterIds: [],
    queueEntries: [],
    analysisChapters: {},
    cast: [],
    defaultEngine: 'qwen',
    requestQwenModelKey: T06,
    qwenUnavailable: false,
    ...over,
  });

/* `rider` has a Qwen voice but no engine pin: it follows whichever engine its chapter's
   POST renders on. */
const rider = chr('rider', { ttsEngine: undefined });

describe('computeRunQwenNeeds: a pending entry is evaluated at its own stamp (#1393)', () => {
  it('a Quality request does NOT keep the 0.6B for a pending chapter stamped kokoro-v1', () => {
    expect(
      run({
        targetChapterIds: [1],
        requestQwenModelKey: T17,
        queueEntries: [entry('e2', 2, 'queued', 'kokoro-v1')],
        analysisChapters: { 1: [sent('narrator')], 2: [sent('rider')] },
        cast: [chr('narrator', { ttsModelKey: T17 }), rider],
      }),
    ).toEqual({ keep06: false, keep17: true });
  });

  it('a Kokoro request keeps the 1.7B for a pending chapter stamped qwen3-tts-1.7b', () => {
    expect(
      run({
        targetChapterIds: [1],
        defaultEngine: 'kokoro',
        queueEntries: [entry('e2', 2, 'queued', T17)],
        analysisChapters: { 1: [sent('pinned')], 2: [sent('rider')] },
        cast: [chr('pinned'), rider],
      }),
    ).toEqual({ keep06: true, keep17: true });
  });
});

describe('computeRunQwenNeeds: every pending entry of a chapter counts (#1393)', () => {
  it('a 0.6B queued entry plus a 1.7B awaiting_confirm entry for one chapter keep both tiers', () => {
    expect(
      run({
        queueEntries: [entry('e2a', 2, 'queued', T06), entry('e2b', 2, 'awaiting_confirm', T17)],
        analysisChapters: { 2: [sent('narrator')] },
        cast: [chr('narrator', { ttsEngine: undefined })],
      }),
    ).toEqual({ keep06: true, keep17: true });
  });
});

describe("computeRunQwenNeeds: only a target chapter's own in_progress entry is skipped (#1393)", () => {
  const narrator = chr('narrator', { ttsEngine: undefined });

  it('a target chapter re-queued at another tier keeps both (the own in_progress entry is skipped)', () => {
    expect(
      run({
        targetChapterIds: [3],
        queueEntries: [entry('own', 3, 'in_progress', T06), entry('requeue', 3, 'queued', T17)],
        analysisChapters: { 3: [sent('narrator')] },
        cast: [narrator],
      }),
    ).toEqual({ keep06: true, keep17: true });
  });

  it("with the POST's own entry id, a claimed in_progress re-queue of the target counts at its stamp", () => {
    expect(
      run({
        targetChapterIds: [3],
        ownQueueEntryId: 'own',
        queueEntries: [entry('own', 3, 'queued', T06), entry('requeue', 3, 'in_progress', T17)],
        analysisChapters: { 3: [sent('narrator')] },
        cast: [narrator],
      }),
    ).toEqual({ keep06: true, keep17: true });
  });

  it("a target chapter's own in_progress entry alone adds nothing beyond the request key", () => {
    expect(
      run({
        targetChapterIds: [3],
        queueEntries: [entry('own', 3, 'in_progress', T17)],
        analysisChapters: { 3: [sent('narrator')] },
        cast: [narrator],
      }),
    ).toEqual({ keep06: true, keep17: false });
  });
});

/* #4587 — on a non-English book each pending entry's POST re-forces the cast at ITS engine, so the
   request-forced `cast` cannot answer for it. */
describe('computeRunQwenNeeds: a non-English pending entry is evaluated at its stamp engine (#4587)', () => {
  /* Cloned on both clone-capable engines and not pinned, so the forcing follows the run's engine. */
  const dual = chr('narrator', {
    ttsEngine: undefined,
    overrideTtsVoices: {
      qwen: { name: 'qwen-voice', provenance: 'cloned', libraryUuid: 'u-qwen' },
      coqui: { name: 'xtts-voice', provenance: 'cloned', libraryUuid: 'u-coqui' },
    },
  });
  const nonEnglish = (
    unforcedCast: CastCharacter[],
    fullCastKeep = NONE,
  ): NonNullable<RunQwenNeedsInput['nonEnglish']> => ({
    eligibleEngines: ['qwen', 'coqui'],
    unforcedCast,
    fullCastKeep,
  });

  it('a Coqui request keeps the tier of a Qwen-stamped pending chapter voiced by a dual clone', () => {
    const coquiRequest: Partial<RunQwenNeedsInput> = {
      targetChapterIds: [1],
      defaultEngine: 'coqui',
      queueEntries: [entry('e2', 2, 'queued', T17)],
      analysisChapters: { 1: [sent('narrator')], 2: [sent('narrator')] },
      cast: [{ ...dual, ttsEngine: 'coqui' }],
    };
    expect(run({ ...coquiRequest, nonEnglish: nonEnglish([dual]) })).toEqual({
      keep06: false,
      keep17: true,
    });
    expect(run(coquiRequest)).toEqual(NONE);
  });

  /* Chapter 2's speaker is pinned to Qwen 1.7B, so evaluating the entry as a run would keep 1.7B:
     only the full-cast keep may come out of an unknown entry. */
  describe.each([
    ['kokoro-stamped', 'kokoro-v1'],
    ['gemini-stamped', 'gemini-2.5-flash'],
    ['unstamped', undefined],
  ] as const)('a %s pending entry is unknown', (_label, stamp) => {
    const cast = [chr('narrator', { ttsEngine: 'coqui' }), chr('wren', { ttsModelKey: T17 })];
    const unknown: Partial<RunQwenNeedsInput> = {
      queueEntries: [entry('e2', 2, 'queued', stamp)],
      analysisChapters: { 1: [sent('narrator')], 2: [sent('wren')] },
      cast,
      nonEnglish: nonEnglish(cast, { keep06: true, keep17: false }),
    };

    it('takes the full-cast keep instead of being evaluated as a run', () => {
      expect(run(unknown)).toEqual({ keep06: true, keep17: false });
    });

    it('ORs the full-cast keep into what the target chapters need', () => {
      expect(
        run({
          ...unknown,
          targetChapterIds: [1],
          defaultEngine: 'qwen',
          requestQwenModelKey: T17,
          cast: [chr('narrator', { ttsModelKey: T17 }), chr('wren', { ttsModelKey: T17 })],
        }),
      ).toEqual({ keep06: true, keep17: true });
    });
  });

  it('an eligible-stamped entry whose retargeted cast has no Qwen speaker contributes nothing', () => {
    expect(
      run({
        queueEntries: [entry('e2', 2, 'queued', 'coqui-xtts-v2')],
        analysisChapters: { 2: [sent('narrator')] },
        cast: [{ ...dual, ttsEngine: 'qwen' }],
        nonEnglish: nonEnglish([dual], { keep06: true, keep17: true }),
      }),
    ).toEqual(NONE);
  });

  it("a pending entry at the target's own engine and key does not replace the target's cast", () => {
    expect(
      run({
        targetChapterIds: [1],
        queueEntries: [entry('requeue', 1, 'queued', T06)],
        analysisChapters: { 1: [sent('narrator')] },
        cast: [chr('narrator')],
        nonEnglish: nonEnglish([chr('narrator', { ttsEngine: 'coqui' })]),
      }),
    ).toEqual({ keep06: true, keep17: false });
  });
});
