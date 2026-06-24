/* ASR content-QA pass wiring inside synthesiseChapter (srv-31).
   Uses a fake provider (constant PCM) and an INJECTED transcribeFn (so no
   sidecar) whose verdict is driven by a per-call queue of transcripts. Pins:
     - a `drift` verdict re-records and keeps the better take,
     - persistent drift after the retry budget → asrSuspect, ship best take,
     - a clean transcript → no re-record, asr verdict ok,
     - `inconclusive` (untrusted transcript) → no re-record,
     - sampleEvery strides the pass. */

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
import type { TranscribeResult } from './transcribe-client.js';

const TEXT = 'The quick brown fox jumped over the lazy dog in the moonlit yard.';
const CLEAN = { language: 'en', avgLogprob: -0.2, noSpeechProb: 0.02, compressionRatio: 1.3 };

function makeProvider(): TtsProvider & { calls: SynthesizeInput[] } {
  const calls: SynthesizeInput[] = [];
  return {
    calls,
    async synthesize(input: SynthesizeInput): Promise<SynthesizeOutput> {
      calls.push(input);
      return { pcm: Buffer.alloc(2), sampleRate: 24000, mimeType: 'audio/pcm' };
    },
  };
}

/* transcribeFn that returns the next transcript from a queue, repeating the
   last entry once drained. Records how many times it was called. */
function makeTranscriber(transcripts: string[]) {
  const state = { calls: 0 };
  const fn = async (): Promise<TranscribeResult> => {
    const text = transcripts[Math.min(state.calls, transcripts.length - 1)];
    state.calls += 1;
    return { text, ...CLEAN };
  };
  return { fn, state };
}

const cast: CastCharacter[] = [{ id: 'narrator', name: 'Narrator' }];
function sentence(id: number, text = TEXT): SentenceOutput {
  return { id, chapterId: 1, characterId: 'narrator', text };
}

describe('synthesiseChapter ASR content-QA pass', () => {
  it('re-records a drift segment and keeps the clean retake', async () => {
    const provider = makeProvider();
    // Take 1 transcribes wrong; the re-record transcribes correctly.
    const { fn, state } = makeTranscriber(['totally unrelated nonsense words appear here instead now', TEXT]);
    const res = await synthesiseChapter({
      sentences: [sentence(1)],
      cast,
      provider,
      modelKey: 'gemini-2.5-flash',
      engine: 'gemini',
      asr: { maxRerecords: 2, transcribeFn: fn },
    });
    // 1 pool synth + 1 re-record.
    expect(provider.calls).toHaveLength(2);
    // 1 initial verify + 1 verify of the retake.
    expect(state.calls).toBe(2);
    const seg = res.segments.find((s) => s.kind !== 'title');
    expect(seg?.asr?.verdict).toBe('ok');
    expect(seg?.asrSuspect).toBeUndefined();
  });

  it('flags asrSuspect and ships the best take when drift persists', async () => {
    const provider = makeProvider();
    const { fn } = makeTranscriber(['always the wrong words spoken aloud across this line']);
    const res = await synthesiseChapter({
      sentences: [sentence(1)],
      cast,
      provider,
      modelKey: 'gemini-2.5-flash',
      engine: 'gemini',
      asr: { maxRerecords: 1, transcribeFn: fn },
    });
    // 1 pool synth + 1 re-record (budget 1), still drift.
    expect(provider.calls).toHaveLength(2);
    const seg = res.segments.find((s) => s.kind !== 'title');
    expect(seg?.asr?.verdict).toBe('drift');
    expect(seg?.asrSuspect).toBe(true);
  });

  it('does not re-record a clean segment', async () => {
    const provider = makeProvider();
    const { fn } = makeTranscriber([TEXT]);
    const res = await synthesiseChapter({
      sentences: [sentence(1)],
      cast,
      provider,
      modelKey: 'gemini-2.5-flash',
      engine: 'gemini',
      asr: { maxRerecords: 2, transcribeFn: fn },
    });
    expect(provider.calls).toHaveLength(1);
    expect(res.segments.find((s) => s.kind !== 'title')?.asr?.verdict).toBe('ok');
  });

  it('does not re-record an inconclusive (untrusted transcript) segment', async () => {
    const provider = makeProvider();
    let calls = 0;
    const fn = async (): Promise<TranscribeResult> => {
      calls += 1;
      return { text: 'mumble', language: 'en', avgLogprob: -2.0, noSpeechProb: 0.02, compressionRatio: 1.3 };
    };
    const res = await synthesiseChapter({
      sentences: [sentence(1)],
      cast,
      provider,
      modelKey: 'gemini-2.5-flash',
      engine: 'gemini',
      asr: { maxRerecords: 2, transcribeFn: fn },
    });
    expect(provider.calls).toHaveLength(1); // no re-record
    expect(calls).toBe(1);
    expect(res.segments.find((s) => s.kind !== 'title')?.asr?.verdict).toBe('inconclusive');
  });

  it('strides the pass with sampleEvery', async () => {
    const provider = makeProvider();
    const { fn, state } = makeTranscriber([TEXT]);
    await synthesiseChapter({
      sentences: [sentence(1), sentence(2), sentence(3), sentence(4)],
      cast,
      provider,
      modelKey: 'gemini-2.5-flash',
      engine: 'gemini',
      asr: { maxRerecords: 0, sampleEvery: 2, transcribeFn: fn },
    });
    // 4 sentences, stride 2 → only sentences 0 and 2 transcribed.
    expect(state.calls).toBe(2);
  });

  it('fires onProgress once per sampled group, including ok verdicts', async () => {
    const provider = makeProvider();
    const { fn } = makeTranscriber([TEXT]); // always clean → all ok, no re-record
    const calls: Array<{ verified: number; total: number }> = [];
    const res = await synthesiseChapter({
      sentences: [sentence(1), sentence(2), sentence(3)],
      cast,
      provider,
      modelKey: 'gemini-2.5-flash',
      engine: 'gemini',
      asr: { maxRerecords: 0, transcribeFn: fn, onProgress: (e) => calls.push(e) },
    });
    expect(calls).toHaveLength(3);
    expect(calls[0]).toEqual({ verified: 0, total: 3 });
    expect(calls[2]).toEqual({ verified: 2, total: 3 });
    // All clean → no re-records → one pool synth per sentence.
    expect(provider.calls).toHaveLength(3);
    // Sanity: every body segment verified ok.
    for (const seg of res.segments.filter((s) => s.kind !== 'title')) {
      expect(seg.asr?.verdict).toBe('ok');
    }
  });

  it('strides onProgress with sampleEvery', async () => {
    const provider = makeProvider();
    const { fn } = makeTranscriber([TEXT]);
    const calls: Array<{ verified: number; total: number }> = [];
    await synthesiseChapter({
      sentences: [sentence(1), sentence(2), sentence(3), sentence(4)],
      cast,
      provider,
      modelKey: 'gemini-2.5-flash',
      engine: 'gemini',
      asr: { maxRerecords: 0, sampleEvery: 2, transcribeFn: fn, onProgress: (e) => calls.push(e) },
    });
    // 4 groups, stride 2 → groups 0 and 2 sampled → 2 onProgress calls.
    expect(calls).toHaveLength(2);
    expect(calls.map((c) => c.total)).toEqual([2, 2]);
    expect(calls.map((c) => c.verified)).toEqual([0, 1]);
  });

  it('quarantines a calibration-bleed segment instead of shipping the pangram (#1083)', async () => {
    const provider = makeProvider();
    // A runaway clone bled its ICL ref_text (the calibration pangram) into the
    // audio. The narration line is ordinary, but every take transcribes as the
    // pangram → drift that never recovers → must be quarantined, not shipped.
    const NARRATION = 'Sophie hurried down the long museum hallway toward the exit.';
    const PANGRAM =
      'The quick brown fox jumps over the lazy dog, and she wondered what tomorrow would bring.';
    const { fn } = makeTranscriber([PANGRAM]);
    const res = await synthesiseChapter({
      sentences: [sentence(1, NARRATION)],
      cast,
      provider,
      modelKey: 'gemini-2.5-flash',
      engine: 'gemini',
      asr: { maxRerecords: 1, transcribeFn: fn },
    });
    // Re-recorded up to budget (initial + 1) before quarantining.
    expect(provider.calls).toHaveLength(2);
    const seg = res.segments.find((s) => s.kind !== 'title');
    expect(seg?.quarantined).toBe(true);
    expect(seg?.suspect).toBe(true);
    // The bleeding take is NOT shipped — replaced with silence (a distinct,
    // non-trivial length vs the 2-byte stub the provider returns).
    expect(seg!.endSec - seg!.startSec).toBeGreaterThan(0.2);
    // Forensics retained for the QA report.
    expect(seg?.asr?.transcript).toContain('quick brown fox');
  });

  it('does not quarantine when the manuscript legitimately quotes the pangram', async () => {
    const provider = makeProvider();
    // Both the line AND the transcript are the pangram → faithful render, ship it.
    const PANGRAM =
      'The quick brown fox jumps over the lazy dog, and she wondered what tomorrow would bring.';
    const { fn } = makeTranscriber([PANGRAM]);
    const res = await synthesiseChapter({
      sentences: [sentence(1, PANGRAM)],
      cast,
      provider,
      modelKey: 'gemini-2.5-flash',
      engine: 'gemini',
      asr: { maxRerecords: 1, transcribeFn: fn },
    });
    const seg = res.segments.find((s) => s.kind !== 'title');
    expect(seg?.quarantined).toBeUndefined();
    expect(seg?.asr?.verdict).toBe('ok');
  });

  it('fs-53: a faithful render of an expanded number is ok, not drift (ASR-QA alignment)', async () => {
    /* The sentence carries "$1,200"; fs-53 synthesises it as "one thousand two
       hundred dollars", and Whisper transcribes that spoken form. Without the
       ASR-QA alignment (expected text normalised with the book langCode) the
       gate would WER the transcript against the raw "$1,200" and false-flag a
       perfect render as drift. With it, expected == spoken → verdict ok. */
    const provider = makeProvider();
    const SENTENCE = 'He paid $1,200 for the rare old book.';
    const SPOKEN = 'He paid one thousand two hundred dollars for the rare old book.';
    const { fn } = makeTranscriber([SPOKEN]);
    const res = await synthesiseChapter({
      sentences: [sentence(1, SENTENCE)],
      cast,
      provider,
      modelKey: 'gemini-2.5-flash',
      engine: 'gemini',
      bookLanguage: 'en',
      asr: { maxRerecords: 2, transcribeFn: fn },
    });
    // No re-record — the take is faithful once the expected text is aligned.
    expect(provider.calls).toHaveLength(1);
    const seg = res.segments.find((s) => s.kind !== 'title');
    expect(seg?.asr?.verdict).toBe('ok');
    expect(seg?.asrSuspect).toBeUndefined();
  });

  it('is a no-op when asr is absent (byte-identical to today)', async () => {
    const provider = makeProvider();
    const res = await synthesiseChapter({
      sentences: [sentence(1)],
      cast,
      provider,
      modelKey: 'gemini-2.5-flash',
      engine: 'gemini',
    });
    expect(res.segments.find((s) => s.kind !== 'title')?.asr).toBeUndefined();
  });
});

/* ASR drift re-records must flow through the SAME batched path as the initial
   synth (one `synthesizeBatch` call for the whole round) instead of one
   single `synthesize` call per drift sentence — the unbatched per-group
   re-record was the ~2x RTF regression on Qwen chapters. */
describe('synthesiseChapter ASR re-records are batched (Qwen)', () => {
  function makeQwenBatchProvider(): TtsProvider & {
    singleCalls: SynthesizeInput[];
    batchCalls: { items: SynthesizeBatchInput['items'] }[];
  } {
    const singleCalls: SynthesizeInput[] = [];
    const batchCalls: { items: SynthesizeBatchInput['items'] }[] = [];
    return {
      singleCalls,
      batchCalls,
      async synthesize(input: SynthesizeInput): Promise<SynthesizeOutput> {
        singleCalls.push(input);
        return { pcm: Buffer.alloc(2), sampleRate: 24000, mimeType: 'audio/pcm' };
      },
      async synthesizeBatch({ items }: SynthesizeBatchInput): Promise<SynthesizeBatchOutput> {
        batchCalls.push({ items });
        return { pcms: items.map(() => Buffer.alloc(2)), sampleRate: 24000 };
      },
    };
  }

  const qwenCast: CastCharacter[] = [
    { id: 'narrator', name: 'Narrator', ttsEngine: 'qwen', overrideTtsVoices: { qwen: { name: 'qwen-narrator' } } },
  ];

  it('re-records all drift sentences in one batch, not one single call each', async () => {
    const provider = makeQwenBatchProvider();
    // Every sentence transcribes wrong → every sentence drifts → every sentence
    // is re-recorded once (maxRerecords: 1).
    const { fn } = makeTranscriber(['totally wrong unrelated words across this whole line now']);
    await synthesiseChapter({
      sentences: [sentence(1), sentence(2), sentence(3)],
      cast: qwenCast,
      provider,
      modelKey: 'qwen3-tts-0.6b',
      engine: 'qwen',
      qwenBatchSize: 8,
      asr: { maxRerecords: 1, transcribeFn: fn },
    });

    // Initial dispatch: groups[0] is the up-front anchor (1 single call);
    // groups[1..2] synth in one batch. The 3 drift re-records must then go
    // through ONE more batched call — NOT three single `synthesize` calls.
    expect(provider.singleCalls).toHaveLength(1); // anchor only; zero single re-records
    expect(provider.batchCalls).toHaveLength(2); // initial body batch + one re-record batch
  });

  it('stops re-recording groups that recover — no wasted second round', async () => {
    const provider = makeQwenBatchProvider();
    // All three drift on the first verify, then transcribe clean on the retake.
    const { fn } = makeTranscriber(['wrong words one', 'wrong words two', 'wrong words three', TEXT]);
    const res = await synthesiseChapter({
      sentences: [sentence(1), sentence(2), sentence(3)],
      cast: qwenCast,
      provider,
      modelKey: 'qwen3-tts-0.6b',
      engine: 'qwen',
      qwenBatchSize: 8,
      asr: { maxRerecords: 2, transcribeFn: fn },
    });

    // Round 1 re-records all three (one batch) and they recover, so round 2
    // finds nothing pending and never dispatches: exactly ONE re-record batch
    // despite a budget of 2.
    expect(provider.batchCalls).toHaveLength(2); // initial body batch + one re-record round
    for (const seg of res.segments.filter((s) => s.kind !== 'title')) {
      expect(seg.asr?.verdict).toBe('ok');
      expect(seg.asrSuspect).toBeUndefined();
    }
  });
});
