/* #1682 REGRESSION LOCK — the OUTPUT-HEAVY cloud passes (script review, emotion
   annotation, instruct annotation) must clear the finite Gemma TPM guard
   (RequestExceedsTpmError fires when the ESTIMATED input tokens exceed the model
   TPM, 16000/min). Unlike stage-1, which force-splits on truncation, a
   RequestExceedsTpm on these passes is NOT caught by any recovery → the chapter
   fails permanently. On the free-tier Gemma path the PR advertises (script review
   runs on defaultAnalysisModel), a dense Cyrillic chapter tripped it.

   This reconstructs the REAL request each pass makes — the actual skill
   (`buildSystemInstruction` over `loadSkill(...)`) + the actual inbox builder,
   over a worst-case chunk sized by the REAL `chapterChunkBudget(...)` +
   `chunkSentencesByBudget(...)` path — and asserts the same `estimateInputTokens`
   the limiter uses stays under the guard with margin.

   Two root causes were fixed and are both locked here:
   1. No token-space system reservation — `chapterChunkBudget` passed
      reservedTokens=0, so the body filled the full ~12k-token cap and left no
      room for the (large) system prompt. Now OUTPUT_HEAVY_CLOUD_RESERVED_TOKENS
      is reserved in token space.
   2. Uncounted per-sentence fields (script-review only) — the chunk sizer
      serialized only {id,characterId,text} while the REAL request appends
      `structureEvidence` (folded into text) + `instruct`. Now the sizer packs by
      the real `buildReviewSentencesInput` payload.

   Using the REAL prompt (not a hand-faked string) is the point: if a skill or
   inbox scaffold grows, this re-trips and forces the reservation to be re-tuned
   instead of silently dropping chapters again. */

import { describe, it, expect } from 'vitest';
import {
  chunkSentencesByBudget,
  chunkWithContext,
  chapterChunkBudget,
  OUTPUT_HEAVY_CLOUD_RESERVED_TOKENS,
  type SentenceChunk,
} from './chapter-chunker.js';
import { loadSkill, buildSystemInstruction, estimateInputTokens } from './gemini.js';
import { cloudBodyCharBudget } from './token-budget.js';
import {
  buildScriptReviewChapterInbox,
  buildReviewSentencesInput,
} from '../routes/script-review.js';
import { buildEmotionChapterInbox } from '../routes/annotate-emotion.js';
import { buildInstructChapterInbox } from '../routes/instruct-annotation.js';
import type { SentenceOutput } from '../handoff/schemas.js';

const GEMMA_TPM = 16000;
const MARGIN_CEILING = 14500; // 16000 − 1500 safety margin

/* Dense Cyrillic prose (~2.5 chars/token). Includes a space every ~33 chars so
   the token estimate isn't distorted by an unbroken run. */
const CYR = 'абвгдеёжзийклмнопрстуфхцчшщъыьэюя ';
const cyr = (n: number): string =>
  Array.from({ length: n }, (_, i) => CYR[i % CYR.length]).join('');

/* A conservative single-book roster: 40 Cyrillic characters in the
   {id,name,role} shape the inbox renders. */
const roster = Array.from({ length: 40 }, (_, i) => ({
  id: `personazh-familiya-${i}`,
  name: `Антон Сергеевич Городецкий ${i}`,
  role: 'второстепенный персонаж истории',
}));

/* A Night-Watch-sized chapter: 600 attributed Cyrillic sentences, each with an
   `instruct` direction (the real script-review input carries these). */
const sentences: SentenceOutput[] = Array.from({ length: 600 }, (_, i) => ({
  id: i + 1,
  characterId: roster[i % roster.length].id,
  text: cyr(130),
  emotion: 'neutral',
  instruct: 'speaks in a low, measured voice',
})) as unknown as SentenceOutput[];

/* Worst case: a structure-evidence note on EVERY sentence (structure engine on,
   the default) — buildReviewSentencesInput folds each note into `text`. */
const evidence = new Map<number, string>(
  sentences.map((s) => [s.id, '(эвиденция: реплика с тегом называет говорящего Антон)']),
);

const est = (systemInstruction: string, inbox: string): number =>
  estimateInputTokens(systemInstruction, [{ role: 'user', parts: [{ text: inbox }] }]);

/* Pick the chunk with the largest core — the worst case for the guard. */
const largestChunk = <S extends { id: number; text: string }>(
  chunks: SentenceChunk<S>[],
): SentenceChunk<S> => chunks.reduce((a, b) => (b.core.length > a.core.length ? b : a));

describe('#1682 — output-heavy cloud passes clear the Gemma TPM guard', () => {
  it('script-review: worst-case Cyrillic chunk (evidence + instruct + roster) estimates under the guard', async () => {
    const skill = await loadSkill('script_review');
    const systemInstruction = buildSystemInstruction(skill, 'ru', 'script_review');

    // Size + pack exactly the way the route does (chapter-chunker + the real
    // per-sentence serialize that counts evidence/instruct).
    const budget = chapterChunkBudget(
      'gemini',
      JSON.stringify(roster).length + 800,
      sentences.map((s) => s.text).join(' '),
      OUTPUT_HEAVY_CLOUD_RESERVED_TOKENS,
    );
    const chunks = chunkSentencesByBudget(sentences, {
      charBudget: budget,
      overlap: 3,
      serialize: (s) => JSON.stringify(buildReviewSentencesInput([s], evidence)[0]),
    });
    const big = largestChunk(chunks);
    const withCtx = [...big.contextBefore, ...big.core, ...big.contextAfter];
    const inbox = buildScriptReviewChapterInbox('m_1682', 12, withCtx, roster, null, evidence);

    const estimated = est(systemInstruction, inbox);
    expect(estimated).toBeLessThanOrEqual(GEMMA_TPM);
    expect(estimated).toBeLessThanOrEqual(MARGIN_CEILING);
  });

  it('script-review: proves the fix is load-bearing — the PRE-fix path (0 reservation + bare serialize) OVERRUNS the guard', async () => {
    const skill = await loadSkill('script_review');
    const systemInstruction = buildSystemInstruction(skill, 'ru', 'script_review');

    // Reconstruct the pre-#1682 sizing: reservedTokens=0 (3-arg chapterChunkBudget)
    // and the bare {id,characterId,text} serialize that ignored evidence/instruct.
    const budget = chapterChunkBudget(
      'gemini',
      JSON.stringify(roster).length + 800,
      sentences.map((s) => s.text).join(' '),
    );
    const chunks = chunkSentencesByBudget(sentences, {
      charBudget: budget,
      overlap: 3,
      serialize: (s) => JSON.stringify({ id: s.id, characterId: s.characterId, text: s.text }),
    });
    const big = largestChunk(chunks);
    const withCtx = [...big.contextBefore, ...big.core, ...big.contextAfter];
    const inbox = buildScriptReviewChapterInbox('m_1682', 12, withCtx, roster, null, evidence);

    // The real request the pre-fix code would have sent blows the guard —
    // exactly the RequestExceedsTpmError that dropped the chapter.
    expect(est(systemInstruction, inbox)).toBeGreaterThan(GEMMA_TPM);
  });

  it('emotion + instruct: worst-case Cyrillic chunk estimates under the guard', async () => {
    // These passes carry NO roster and NO evidence — only the skill differs
    // (emotion ≈ 2.9 KB, instruct ≈ 7.0 KB). Their input is {sentenceId,
    // characterId, text}. Emotion already cleared the guard at 0 reservation
    // (~13.3k) and instruct sat ~14.3k (thin — ~1.7k under); the shared
    // reservation gives both healthy margin and future-proofs against skill
    // growth.
    const emoSkill = buildSystemInstruction(await loadSkill('emotion_annotation'), 'ru', 'emotion_annotation');
    const insSkill = buildSystemInstruction(await loadSkill('instruct_annotation'), 'ru', 'instruct_annotation');
    const plain: SentenceOutput[] = sentences.map((s) => ({ ...s, instruct: undefined })) as SentenceOutput[];

    const budget = chapterChunkBudget(
      'gemini',
      0,
      plain.map((s) => s.text).join(' '),
      OUTPUT_HEAVY_CLOUD_RESERVED_TOKENS,
    );
    const chunks = chunkSentencesByBudget(plain, {
      charBudget: budget,
      overlap: 3,
      serialize: (s) => JSON.stringify({ sentenceId: s.id, characterId: s.characterId, text: s.text }),
    });
    const withCtx = chunkWithContext(largestChunk(chunks));

    expect(est(emoSkill, buildEmotionChapterInbox('m_1682', 12, withCtx))).toBeLessThanOrEqual(MARGIN_CEILING);
    expect(est(insSkill, buildInstructChapterInbox('m_1682', 12, withCtx))).toBeLessThanOrEqual(MARGIN_CEILING);
  });

  it('the token reservation genuinely shrinks the output-heavy body budget', () => {
    // With reservedTokens=0 the body fills the full cap; the reservation removes
    // OUTPUT_HEAVY_CLOUD_RESERVED_TOKENS tokens' worth of Cyrillic chars, which
    // is what buys back the TPM headroom for the system prompt.
    const sample = 'а'.repeat(200000);
    const zeroReserve = cloudBodyCharBudget(sample, 0, 0);
    const reserved = cloudBodyCharBudget(sample, 0, OUTPUT_HEAVY_CLOUD_RESERVED_TOKENS);
    expect(reserved).toBe(zeroReserve - OUTPUT_HEAVY_CLOUD_RESERVED_TOKENS * 2.5);
    // And chapterChunkBudget threads it through (below the 32000 output cap here).
    expect(chapterChunkBudget('gemini', 0, sample, OUTPUT_HEAVY_CLOUD_RESERVED_TOKENS)).toBeLessThan(
      chapterChunkBudget('gemini', 0, sample, 0),
    );
  });
});
