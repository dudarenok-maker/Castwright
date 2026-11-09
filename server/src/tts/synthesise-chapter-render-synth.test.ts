/* #4066 — synthesiseChapter marks its provider calls as a chapter render's own
   synth (`renderSynth`), so the capacity give-up message can tell a render from
   a voice sample. Same three call sites as the #1951 cloned-language wiring:
   the batch call, the single-synth path, and the title beat. Missing one means
   that call's refusal is worded as if a sample had been blocked by the render. */
import { describe, it, expect } from 'vitest';
import { synthesiseChapter, type CastCharacter } from './synthesise-chapter.js';
import type { SentenceOutput } from '../handoff/schemas.js';
import type {
  SynthesizeInput,
  SynthesizeOutput,
  SynthesizeBatchInput,
  SynthesizeBatchOutput,
  TtsProvider,
} from './index.js';

function makeProvider() {
  const singleCalls: SynthesizeInput[] = [];
  const batchCalls: SynthesizeBatchInput[] = [];
  const provider: TtsProvider = {
    async synthesize(input: SynthesizeInput): Promise<SynthesizeOutput> {
      singleCalls.push(input);
      return { pcm: Buffer.alloc(4800, 0), sampleRate: 24000, mimeType: 'audio/pcm' };
    },
    async synthesizeBatch(input: SynthesizeBatchInput): Promise<SynthesizeBatchOutput> {
      batchCalls.push(input);
      return { pcms: input.items.map(() => Buffer.alloc(4800, 0)), sampleRate: 24000 };
    },
  };
  return { provider, singleCalls, batchCalls };
}

const SENTENCES: SentenceOutput[] = [1, 2, 3, 4].map((id) => ({
  id,
  chapterId: 1,
  characterId: 'narrator',
  text: `The old lighthouse stood alone number ${id}.`,
}));

const CAST: CastCharacter[] = [
  { id: 'narrator', name: 'Narrator', ttsEngine: 'qwen', overrideTtsVoices: { qwen: { name: 'qwen-narrator' } } },
];

const BASE = {
  sentences: SENTENCES,
  cast: CAST,
  modelKey: 'qwen3-tts-0.6b' as const,
  engine: 'qwen' as const,
  chapterTitleNarration: 'Chapter One',
};

describe('#4066 — synthesiseChapter flags its provider calls as render synths', () => {
  it('flags the batch call and the title beat', async () => {
    const { provider, singleCalls, batchCalls } = makeProvider();
    await synthesiseChapter({ ...BASE, provider, qwenBatchSize: 8 });

    expect(batchCalls.length).toBeGreaterThan(0);
    for (const c of batchCalls) expect(c.renderSynth).toBe(true);
    const title = singleCalls.find((c) => c.text.includes('Chapter One'));
    expect(title).toBeDefined();
    expect(title!.renderSynth).toBe(true);
  });

  it('flags the single-synth path (batching off)', async () => {
    const { provider, singleCalls, batchCalls } = makeProvider();
    await synthesiseChapter({ ...BASE, provider, qwenBatchSize: 1 });

    expect(batchCalls).toHaveLength(0);
    expect(singleCalls.length).toBeGreaterThan(1);
    for (const c of singleCalls) expect(c.renderSynth).toBe(true);
  });
});
