/* Parity: `chapterQwenTierNeeds` vs the REAL `synthesiseChapter` (#1393, plan 293
   §2.1 step 5 / §5.1 "Parity").

   Each H1-H11 row from `qwen-tier-needs.fixtures.ts` is rendered through the real
   `synthesiseChapter` with recording fake providers. The Qwen tiers the render
   actually sends must be a SUBSET of what the helper predicts on every row, and
   EQUAL to it on H1-H9 and H11 ("may over-keep, never under-keep"). H10 is
   subset-only and runs twice (with and without an emotion-tagged sentence).

   OUT OF SCOPE BY CONSTRUCTION (plan §3.5): the cloned / designed voice
   pre-pass re-derives run BEFORE any synth call, and only for library-backed
   cloned or designed voices. Every fixture Qwen voice is a bare `name` slot, so
   that pre-pass never engages here; the fixture-precondition test and the
   throwing `fetch` / undici `fetch` below enforce this. Pre-pass re-derives
   are accepted over-keep/under-keep risk by the plan and are not pinned. */
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { synthesiseChapter, type CastCharacter } from './synthesise-chapter.js';
import { chapterQwenTierNeeds } from './qwen-tier-needs.js';
import { characterHasClonedSlot } from './clone-engines.js';
import { ROWS, row, T06, T17, type TierRow } from './qwen-tier-needs.fixtures.js';
import type { SynthesizeBatchInput, SynthesizeInput, TtsProvider } from './index.js';
import type { TtsModelKey } from './model-keys.js';

const { undiciFetch } = vi.hoisted(() => ({
  undiciFetch: vi.fn(() => {
    throw new Error('parity test: undici fetch must never be reached (sidecar call)');
  }),
}));
vi.mock('undici', async (importOriginal) => {
  const actual = await importOriginal<typeof import('undici')>();
  return { ...actual, fetch: undiciFetch };
});

const realFetch = globalThis.fetch;
const globalFetch = vi.fn(() => {
  throw new Error('parity test: global fetch must never be reached (sidecar call)');
});
beforeEach(() => {
  globalThis.fetch = globalFetch as unknown as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = realFetch;
  undiciFetch.mockClear();
  globalFetch.mockClear();
});

/* The three selectors that would engage the real-sidecar resolver deps. */
function engagesResolver(c: CastCharacter): string | null {
  if (characterHasClonedSlot(c)) return 'characterHasClonedSlot';
  const q = (c.overrideTtsVoices as { qwen?: { libraryUuid?: unknown; provenance?: unknown } } | undefined)?.qwen;
  if (q && typeof q.libraryUuid === 'string' && q.provenance === undefined) return 'legacy libraryUuid shape';
  if (q?.provenance === 'designed') return "qwen provenance 'designed'";
  return null;
}

function recorder() {
  const calls: TtsModelKey[] = [];
  const provider: TtsProvider = {
    async synthesize(input: SynthesizeInput) {
      calls.push(input.modelKey);
      return { pcm: Buffer.alloc(2), sampleRate: 24000, mimeType: 'audio/pcm' };
    },
    async synthesizeBatch(input: SynthesizeBatchInput) {
      for (let i = 0; i < input.items.length; i++) calls.push(input.modelKey);
      return { pcms: input.items.map(() => Buffer.alloc(2)), sampleRate: 24000 } as never;
    },
  };
  return { calls, provider };
}

/** Render the row through the real synthesiseChapter; return the Qwen tiers sent. */
async function renderedTiers(r: TierRow, sentences = r.input.sentences) {
  const qwen = recorder();
  const kokoro = recorder();
  const coqui = recorder();
  const runKey = r.input.runQwenModelKey;
  const resolveForEngine = (e: string) =>
    e === 'qwen'
      ? { provider: qwen.provider, modelKey: runKey }
      : e === 'coqui'
        ? { provider: coqui.provider, modelKey: 'coqui-xtts-v2' as const }
        : { provider: kokoro.provider, modelKey: 'kokoro-v1' as const };
  const engine = r.input.defaultEngine;
  const runProvider = engine === 'qwen' ? qwen.provider : kokoro.provider;
  const runModelKey: TtsModelKey = engine === 'qwen' ? runKey : 'kokoro-v1';
  await synthesiseChapter({
    sentences,
    cast: r.input.cast,
    castIdHistory: r.input.castIdHistory as never,
    provider: runProvider,
    modelKey: runModelKey,
    engine,
    resolveForEngine: resolveForEngine as never,
    qwenUnavailable: r.input.qwenUnavailable,
    ...(r.input.includesTitleBeat ? { chapterTitleNarration: 'Chapter One' } : {}),
  });
  const sent = new Set(qwen.calls);
  return { keep06: sent.has(T06), keep17: sent.has(T17), qwenCalls: qwen.calls };
}

describe('fixture precondition: no fixture character can reach the sidecar resolvers', () => {
  for (const r of ROWS) {
    it(`${r.id}`, () => {
      for (const c of r.input.cast) {
        expect(
          engagesResolver(c),
          `fixture character "${c.id}" of row ${r.id} would engage the real-sidecar resolver deps`,
        ).toBeNull();
      }
    });
  }
});

const assertParity = (
  predicted: { keep06: boolean; keep17: boolean },
  got: { keep06: boolean; keep17: boolean },
  equal: boolean,
) => {
  // subset: anything the render sent must have been predicted
  if (got.keep06) expect(predicted.keep06, 'render sent 0.6B but helper did not predict it').toBe(true);
  if (got.keep17) expect(predicted.keep17, 'render sent 1.7B but helper did not predict it').toBe(true);
  if (equal) expect({ keep06: got.keep06, keep17: got.keep17 }).toEqual(predicted);
};

describe('chapterQwenTierNeeds parity with the real synthesiseChapter', () => {
  for (const r of ROWS.filter((x) => x.id !== 'H10')) {
    it(`${r.id}: render tiers ⊆ prediction, and equal`, async () => {
      const predicted = chapterQwenTierNeeds(r.input);
      const got = await renderedTiers(r);
      assertParity(predicted, got, true);
    });
  }

  for (const tagged of [false, true]) {
    it(`H10 (${tagged ? 'with' : 'without'} an emotion-tagged sentence): subset only`, async () => {
      const r = row('H10');
      const sentences = tagged
        ? r.input.sentences.map((s) => ({ ...s, emotion: 'angry' as const }))
        : r.input.sentences;
      const predicted = chapterQwenTierNeeds({ ...r.input, sentences });
      expect(predicted).toEqual(r.expected); // helper keeps 0.6B either way
      const got = await renderedTiers(r, sentences);
      assertParity(predicted, got, false);
    });
  }

  it('controls: some row records a 0.6B Qwen call and some a 1.7B Qwen call', async () => {
    const h9 = await renderedTiers(row('H9'));
    const h1 = await renderedTiers(row('H1'));
    expect(h9.qwenCalls.length).toBeGreaterThan(0);
    expect(h9.keep06).toBe(true);
    expect(h1.qwenCalls.length).toBeGreaterThan(0);
    expect(h1.keep17).toBe(true);
  });
});
