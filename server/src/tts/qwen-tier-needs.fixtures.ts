/* Shared H1-H11 rows of plan 293 §5.1 (#1393). Consumed by the helper's own
   unit test (`qwen-tier-needs.test.ts`) and by the parity test against the real
   `synthesiseChapter` (`qwen-tier-needs.parity.test.ts`), so the two can never
   drift on what a row means.

   Every fixture character's Qwen voice is a slot with a `name` only (no
   `provenance`, no `libraryUuid`, no cloned slot): that keeps the render's
   cloned/designed resolver pre-passes, which would make real sidecar calls,
   from ever engaging. */
import type { SentenceOutput } from '../handoff/schemas.js';
import type { ChapterQwenTierNeedsInput } from './qwen-tier-needs.js';
import type { CastCharacter } from './synthesise-chapter.js';

export const T06 = 'qwen3-tts-0.6b' as const;
export const T17 = 'qwen3-tts-1.7b' as const;
export const NONE = { keep06: false, keep17: false };

const designed = { qwen: { name: 'qwen-voice' } };
export const chr = (id: string, over: Partial<CastCharacter> = {}): CastCharacter => ({
  id,
  name: id,
  ttsEngine: 'qwen',
  overrideTtsVoices: designed,
  ...over,
});
let nextId = 1;
export const sent = (characterId: string, over: Partial<SentenceOutput> = {}): SentenceOutput => ({
  id: nextId++,
  chapterId: 1,
  characterId,
  text: 'Hello there, said the voice.',
  ...over,
});
export const needsInput = (over: Partial<ChapterQwenTierNeedsInput>): ChapterQwenTierNeedsInput => ({
  sentences: [],
  cast: [],
  defaultEngine: 'qwen',
  runQwenModelKey: T17,
  qwenUnavailable: false,
  includesTitleBeat: false,
  ...over,
});

export const variantOnly = (id: string, over: Partial<CastCharacter> = {}): CastCharacter =>
  chr(id, {
    overrideTtsVoices: { qwen: { name: '', variants: { angry: { name: 'qwen-v-angry' } } } },
    ...over,
  });

export interface TierRow {
  id: string;
  input: ChapterQwenTierNeedsInput;
  expected: { keep06: boolean; keep17: boolean };
  /** H10 only: the render may send less than the helper keeps. */
  subsetOnly?: boolean;
}

export const ROWS: TierRow[] = [
  {
    id: 'H1',
    input: needsInput({
      cast: [chr('narrator', { ttsModelKey: T17 }), chr('ghost')],
      runQwenModelKey: T06,
      sentences: [sent('narrator')],
    }),
    expected: { keep06: false, keep17: true },
  },
  {
    id: 'H2',
    input: needsInput({
      cast: [chr('narrator', { overrideTtsVoices: undefined })],
      sentences: [sent('narrator')],
    }),
    expected: NONE,
  },
  {
    id: 'H3',
    input: needsInput({
      cast: [chr('narrator')],
      sentences: [sent('narrator')],
      qwenUnavailable: true,
    }),
    expected: NONE,
  },
  {
    id: 'H4 (title beat)',
    input: needsInput({ cast: [chr('narrator')], runQwenModelKey: T06, includesTitleBeat: true }),
    expected: { keep06: true, keep17: false },
  },
  {
    id: 'H4 (no title beat)',
    input: needsInput({ cast: [chr('narrator')], runQwenModelKey: T06, includesTitleBeat: false }),
    expected: NONE,
  },
  {
    id: 'H5',
    input: needsInput({
      cast: [chr('narrator', { ttsModelKey: T17 })],
      runQwenModelKey: T06,
      sentences: [sent('stranger')],
    }),
    expected: { keep06: false, keep17: true },
  },
  {
    id: 'H6',
    input: needsInput({
      cast: [chr('narrator', { ttsEngine: 'kokoro' }), chr('wren', { ttsModelKey: T17 })],
      runQwenModelKey: T06,
      castIdHistory: { supersededBy: { 'old-wren': 'wren' } },
      sentences: [sent('old-wren')],
    }),
    expected: { keep06: false, keep17: true },
  },
  {
    id: 'H7',
    input: needsInput({
      cast: [chr('narrator', { ttsModelKey: T06 })],
      runQwenModelKey: T17,
      sentences: [sent('narrator')],
    }),
    expected: { keep06: false, keep17: true },
  },
  {
    id: 'H8',
    input: needsInput({
      cast: [chr('narrator', { ttsEngine: 'kokoro' }), chr('wren', { ttsModelKey: T17 })],
      runQwenModelKey: T06,
      sentences: [sent('wren', { excludeFromSynthesis: true })],
    }),
    expected: NONE,
  },
  {
    id: 'H9',
    input: needsInput({
      cast: [chr('narrator', { ttsEngine: undefined }), chr('wren')],
      defaultEngine: 'kokoro',
      runQwenModelKey: T06,
      sentences: [sent('wren')],
    }),
    expected: { keep06: true, keep17: false },
  },
  {
    id: 'H10',
    input: needsInput({
      cast: [variantOnly('narrator')],
      runQwenModelKey: T06,
      sentences: [sent('narrator')],
    }),
    expected: { keep06: true, keep17: false },
    subsetOnly: true,
  },
  {
    id: 'H11',
    input: needsInput({
      cast: [variantOnly('narrator')],
      runQwenModelKey: T17,
      sentences: [sent('narrator')],
    }),
    expected: NONE,
  },
];

export const row = (id: string): TierRow => {
  const r = ROWS.find((x) => x.id === id);
  if (!r) throw new Error(`no fixture row ${id}`);
  return r;
};
