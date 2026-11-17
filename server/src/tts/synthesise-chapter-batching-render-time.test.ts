/* #4238 — the five Qwen batching knobs (`tts.batch.size`, `.size17b`,
   `.bucket`, `.tokenBudget`, `.tokenBudget17b`) must be read when a render
   STARTS, not when `synthesise-chapter.ts` is first imported. At import the
   user-settings cache is still cold, so a module-level read pinned the shipped
   defaults and an Advanced Settings change was silently ignored.

   Every case imports the renderer FIRST and writes the override through the
   real settings store AFTER, then drives `synthesiseChapter` with no explicit
   `qwenBatch*` option so the knob is what decides the packing. */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SentenceOutput } from '../handoff/schemas.js';
import type { CastCharacter } from './synthesise-chapter.js';
import type {
  SynthesizeOutput,
  SynthesizeBatchInput,
  SynthesizeBatchOutput,
  TtsProvider,
} from './index.js';

const ENV_KEYS = [
  'QWEN_BATCH_SIZE',
  'QWEN_BATCH_SIZE_17B',
  'QWEN_BATCH_BUCKET',
  'QWEN_BATCH_TOKEN_BUDGET',
  'QWEN_BATCH_TOKEN_BUDGET_17B',
  'USER_SETTINGS_FILE',
];

function makeProvider() {
  const batchCalls: SynthesizeBatchInput[] = [];
  const provider: TtsProvider = {
    async synthesize(): Promise<SynthesizeOutput> {
      return { pcm: Buffer.alloc(4800, 0), sampleRate: 24000, mimeType: 'audio/pcm' };
    },
    async synthesizeBatch(input: SynthesizeBatchInput): Promise<SynthesizeBatchOutput> {
      batchCalls.push(input);
      return { pcms: input.items.map(() => Buffer.alloc(4800, 0)), sampleRate: 24000 };
    },
  };
  return { provider, batchCalls };
}

const CAST: CastCharacter[] = [
  { id: 'narrator', name: 'Narrator', ttsEngine: 'qwen', overrideTtsVoices: { qwen: { name: 'qwen-narrator' } } },
];

/** Four same-length sentences — the shipped 32 / 3600 defaults pack them into ONE batch. */
const EVEN: SentenceOutput[] = [1, 2, 3, 4].map((id) => ({
  id,
  chapterId: 1,
  characterId: 'narrator',
  text: `The old lighthouse stood alone number ${id}.`,
}));

/** Descending lengths, so length-bucketing visibly reorders the batch. */
const UNEVEN: SentenceOutput[] = [
  'The old lighthouse stood alone on the very edge of the northern cliffs.',
  'The old lighthouse stood alone on the cliffs.',
  'The lighthouse stood.',
].map((text, i) => ({ id: i + 1, chapterId: 1, characterId: 'narrator', text }));

const base = (sentences: SentenceOutput[], modelKey: 'qwen3-tts-0.6b' | 'qwen3-tts-1.7b') => ({
  sentences,
  cast: CAST,
  modelKey,
  engine: 'qwen' as const,
  // The title beat anchors the chapter's sample rate, so every body sentence
  // below is batchable (otherwise the first one is synthesised alone).
  chapterTitleNarration: 'Chapter One',
});

const widths = (calls: SynthesizeBatchInput[]) => calls.map((c) => c.items.length);

let dir: string;
beforeEach(() => {
  vi.resetModules();
  for (const k of ENV_KEYS) delete process.env[k];
  dir = mkdtempSync(join(tmpdir(), 'cw-batch-render-'));
  process.env.USER_SETTINGS_FILE = join(dir, 'user-settings.json');
  writeFileSync(process.env.USER_SETTINGS_FILE, '{}');
});
afterEach(() => {
  for (const k of ENV_KEYS) delete process.env[k];
  rmSync(dir, { recursive: true, force: true });
});

/** Import the renderer FIRST (the bug's precondition), then the settings store. */
async function load() {
  const chapter = await import('./synthesise-chapter.js');
  const settings = await import('../workspace/user-settings.js');
  return { synthesiseChapter: chapter.synthesiseChapter, settings };
}

describe('#4238 — Qwen batching knobs are read at render time', () => {
  it('control: with no override the shipped defaults pack all four into one batch', async () => {
    const { synthesiseChapter } = await load();
    const { provider, batchCalls } = makeProvider();
    await synthesiseChapter({ ...base(EVEN, 'qwen3-tts-0.6b'), provider });
    expect(widths(batchCalls)).toEqual([4]);
  });

  it('tts.batch.size set after import caps the 0.6B batch width', async () => {
    const { synthesiseChapter, settings } = await load();
    await settings.writeConfigOverride('tts.batch.size', 2);
    const { provider, batchCalls } = makeProvider();
    await synthesiseChapter({ ...base(EVEN, 'qwen3-tts-0.6b'), provider });
    expect(widths(batchCalls)).toEqual([2, 2]);
  });

  it('tts.batch.size17b set after import caps the 1.7B batch width', async () => {
    const { synthesiseChapter, settings } = await load();
    await settings.writeConfigOverride('tts.batch.size17b', 2);
    const { provider, batchCalls } = makeProvider();
    await synthesiseChapter({ ...base(EVEN, 'qwen3-tts-1.7b'), provider });
    expect(widths(batchCalls)).toEqual([2, 2]);
  });

  it('tts.batch.tokenBudget set after import narrows 0.6B batches', async () => {
    const { synthesiseChapter, settings } = await load();
    // ~42 chars per sentence: (count+1) x maxLen <= 100 admits two, not three.
    await settings.writeConfigOverride('tts.batch.tokenBudget', 100);
    const { provider, batchCalls } = makeProvider();
    await synthesiseChapter({ ...base(EVEN, 'qwen3-tts-0.6b'), provider });
    expect(widths(batchCalls)).toEqual([2, 2]);
  });

  it('tts.batch.tokenBudget17b set after import narrows 1.7B batches', async () => {
    const { synthesiseChapter, settings } = await load();
    await settings.writeConfigOverride('tts.batch.tokenBudget17b', 100);
    const { provider, batchCalls } = makeProvider();
    await synthesiseChapter({ ...base(EVEN, 'qwen3-tts-1.7b'), provider });
    expect(widths(batchCalls)).toEqual([2, 2]);
  });

  it('tts.batch.bucket set false after import restores index order', async () => {
    const { synthesiseChapter, settings } = await load();
    const bucketed = makeProvider();
    await synthesiseChapter({ ...base(UNEVEN, 'qwen3-tts-0.6b'), provider: bucketed.provider });
    const order = (calls: SynthesizeBatchInput[]) => calls.flatMap((c) => c.items.map((i) => i.text.length));
    const onOrder = order(bucketed.batchCalls);
    // Sanity: the default (bucket ON) sorts ascending, so it is NOT index order.
    expect(onOrder).toEqual([...onOrder].sort((a, b) => a - b));

    await settings.writeConfigOverride('tts.batch.bucket', false);
    const unbucketed = makeProvider();
    await synthesiseChapter({ ...base(UNEVEN, 'qwen3-tts-0.6b'), provider: unbucketed.provider });
    const offOrder = order(unbucketed.batchCalls);
    expect(offOrder).toEqual(UNEVEN.map((s) => s.text.length));
  });

  it('env var still wins over the shipped default when no override is saved', async () => {
    process.env.QWEN_BATCH_SIZE = '1';
    const { synthesiseChapter } = await load();
    const { provider, batchCalls } = makeProvider();
    await synthesiseChapter({ ...base(EVEN, 'qwen3-tts-0.6b'), provider });
    expect(batchCalls).toHaveLength(0); // =1 is the kill-switch: single synths
  });
});
