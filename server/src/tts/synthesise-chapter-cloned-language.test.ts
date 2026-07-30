/* #1951 / plan 275 — synthesiseChapter must tell the provider WHICH groups are
   backed by a cloned voice, so `sidecar.ts` can put the book's language on the
   wire for those and only those.

   Clone-ness is decided HERE, in Node, via the same `hasClonedProvenance`
   predicate `clearMismatchedDesignedVoices`'s cloned-voice exemption uses
   (`verify-designed-voice-language.ts:55`). The sidecar never re-derives it.

   Three call sites, all three covered below, because missing any one ships a
   chapter that is partly in the wrong language:
     - the BATCH items map — the primary surface: chapter SENTENCES batch
       (QWEN_BATCH_SIZE defaults to 32);
     - the single-synth path — reached when batching is off / size 1;
     - the TITLE beat — the only /synthesize call in a normally-batched
       chapter. Miss it and the body is German over an English title. */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { synthesiseChapter, type CastCharacter } from './synthesise-chapter.js';
import type { ResolveChapterDeps } from './clone-voice-resolver.js';
import type { VoiceLibraryEntry } from '../workspace/voice-library.js';
import type { SentenceOutput } from '../handoff/schemas.js';
import type {
  SynthesizeInput,
  SynthesizeOutput,
  SynthesizeBatchInput,
  SynthesizeBatchOutput,
  TtsProvider,
} from './index.js';

afterEach(() => vi.restoreAllMocks());

/** Healthy entry so the Wave 3b2 cloned-voice resolver pre-pass is a no-op and
    these tests exercise the synth wiring rather than the resolver. */
function healthyClonedEntry(uuid: string): VoiceLibraryEntry {
  return {
    voiceUuid: uuid,
    name: 'Wren clone',
    provenance: 'cloned',
    tags: [],
    pinned: false,
    engines: {},
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

const cloneResolverDepsOverride: Partial<ResolveChapterDeps> = {
  readEntry: async (u) => healthyClonedEntry(u),
  ptExists: async () => true,
};

function makeProvider(): TtsProvider & {
  singleCalls: SynthesizeInput[];
  batchCalls: SynthesizeBatchInput[];
} {
  const singleCalls: SynthesizeInput[] = [];
  const batchCalls: SynthesizeBatchInput[] = [];
  return {
    singleCalls,
    batchCalls,
    async synthesize(input: SynthesizeInput): Promise<SynthesizeOutput> {
      singleCalls.push(input);
      return { pcm: Buffer.alloc(4800, 0), sampleRate: 24000, mimeType: 'audio/pcm' };
    },
    async synthesizeBatch(input: SynthesizeBatchInput): Promise<SynthesizeBatchOutput> {
      batchCalls.push(input);
      return { pcms: input.items.map(() => Buffer.alloc(4800, 0)), sampleRate: 24000 };
    },
  };
}

function sentence(id: number, characterId: string): SentenceOutput {
  return { id, chapterId: 1, characterId, text: `Der alte Leuchtturm stand einsam Nummer ${id}.` };
}

/* Four sentences, alternating cloned/designed. Three is the practical floor for
   a batch here (the sample-rate anchor renders singly first, and a leftover
   slice of one is emitted as a `single`), and alternating guarantees the batch
   holds BOTH provenances — which is the whole point of a per-item flag. */
const MIXED_SENTENCES = [
  sentence(1, 'wren'),
  sentence(2, 'narrator'),
  sentence(3, 'wren'),
  sentence(4, 'narrator'),
];

/* One cloned character, one designed character — both on Qwen, so a single
   batch can hold both and the per-item nature of the flag is provable. */
const MIXED_CAST: CastCharacter[] = [
  {
    id: 'wren',
    name: 'Wren',
    ttsEngine: 'qwen',
    overrideTtsVoices: {
      qwen: { name: 'Wren (unused)', libraryUuid: 'lib-clone', provenance: 'cloned' },
    },
  },
  {
    id: 'narrator',
    name: 'Narrator',
    ttsEngine: 'qwen',
    overrideTtsVoices: { qwen: { name: 'qwen-narrator' } },
  },
];

describe('#1951 — synthesiseChapter marks cloned groups for the language override', () => {
  it('THE PRIMARY SURFACE: batch items carry per-item `cloned` and the batch carries the book language', async () => {
    const provider = makeProvider();
    await synthesiseChapter({
      sentences: MIXED_SENTENCES,
      cast: MIXED_CAST,
      provider,
      modelKey: 'qwen3-tts-0.6b',
      engine: 'qwen',
      bookLanguage: 'de',
      qwenBatchSize: 8,
      cloneResolverDepsOverride,
    });

    expect(provider.batchCalls).toHaveLength(1);
    const call = provider.batchCalls[0];
    /* Batch-level: one chapter = one book = one language. */
    expect(call.language).toBe('de');
    /* Per-item: the cloned character's line is flagged, the designed
       narrator's is not — they share one forward and need different
       languages. */
    const byVoice = new Map(call.items.map((it) => [it.voiceName, it.cloned]));
    expect(byVoice.get('qwen-lib-clone')).toBe(true);
    expect(byVoice.get('qwen-narrator')).toBeFalsy();
  });

  it('single-synth path (batching off) flags a cloned group and not a designed one', async () => {
    const provider = makeProvider();
    await synthesiseChapter({
      sentences: MIXED_SENTENCES,
      cast: MIXED_CAST,
      provider,
      modelKey: 'qwen3-tts-0.6b',
      engine: 'qwen',
      bookLanguage: 'de',
      qwenBatchSize: 1,
      cloneResolverDepsOverride,
    });

    expect(provider.batchCalls).toHaveLength(0);
    const byVoice = new Map(provider.singleCalls.map((c) => [c.voiceName, c.cloned]));
    expect(byVoice.get('qwen-lib-clone')).toBe(true);
    expect(byVoice.get('qwen-narrator')).toBeFalsy();
    /* The book language must still ride along — it is what `cloned` unlocks. */
    for (const c of provider.singleCalls) expect(c.language).toBe('de');
  });

  /* The title beat is a SEPARATE `provider.synthesize` call from the body's,
     and in a normally-batched chapter it is the only one. The plan's
     Implementation table (c) lists only the body's two call sites; missing this
     third one ships a German book under an English chapter title — the exact
     mirror of the batch trap the plan was written to avoid. */
  it('the TITLE beat flags a cloned narrator — otherwise the title alone stays English', async () => {
    const provider = makeProvider();
    await synthesiseChapter({
      /* The narrator is the cloned voice here: `resolveNarratorChar` picks the
         narrator-id character, and the title beat always speaks in its voice. */
      sentences: [sentence(1, 'narrator')],
      cast: [
        {
          id: 'narrator',
          name: 'Narrator',
          ttsEngine: 'qwen',
          overrideTtsVoices: {
            qwen: { name: 'Narrator (unused)', libraryUuid: 'lib-clone', provenance: 'cloned' },
          },
        },
      ],
      provider,
      modelKey: 'qwen3-tts-0.6b',
      engine: 'qwen',
      bookLanguage: 'de',
      chapterTitleNarration: 'Kapitel Eins',
      qwenBatchSize: 8,
      cloneResolverDepsOverride,
    });

    const title = provider.singleCalls.find((c) => c.text.includes('Kapitel Eins'));
    expect(title).toBeDefined();
    expect(title!.voiceName).toBe('qwen-lib-clone');
    expect(title!.cloned).toBe(true);
    expect(title!.language).toBe('de');
  });
});
