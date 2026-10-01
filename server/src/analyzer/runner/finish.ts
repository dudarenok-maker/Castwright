/* Maps a completed TransportResult to answer text or the classified error the
   stage-2 chunker / failure taxonomy key off. Wave 1 reproduces each engine's
   pre-extraction order exactly (ollama.ts chat() :830-844, gemini.ts
   generate() :783-818 on 80be2f1d). Wave 2 adds the reasoning-overflow rule. */
import { AnalyzerReasoningOverflowError, AnalyzerTruncatedError, GeminiContentBlockedError, type TransportKind } from '../errors.js';
import { stripThink } from './parse.js';
import type { TransportResult } from './transport.js';

/** Reasoning evidence for a completed response (spec §7): reported reasoning
    tokens, or reasoning the transport saw on the wire (Gemini thought parts,
    OpenAI reasoning deltas). The unterminated-<think> signal is read from the
    text in mapFinish. */
export function hasReasoningEvidence(r: TransportResult): boolean {
  return (r.usage?.reasoningTokens ?? 0) > 0 || r.reasoningSeen;
}

export function mapFinish(r: TransportResult, ctx: { kind: TransportKind; model: string }): string {
  if (r.finish === 'blocked') throw new GeminiContentBlockedError(ctx.model, r.blockReason);
  /* #3084 wave 2 — the 'length' rule runs FIRST for every transport (spec §7).
     Wave 1 kept Ollama's pre-extraction order (empty check first; ollama.ts:830
     vs :839 at `80be2f1d`), which made an empty `length` stream the generic
     empty-response error instead of a split or a reasoning overflow. */
  if (r.finish === 'length') {
    const answer = stripThink(r.text);
    if (answer.text.trim() === '' && (hasReasoningEvidence(r) || answer.unterminated)) {
      throw new AnalyzerReasoningOverflowError(ctx.kind, ctx.model, r.usage?.reasoningTokens);
    }
    throw new AnalyzerTruncatedError(ctx.kind, r.finishReason ?? 'length', r.receivedBytes, r.usage?.outputTokens);
  }
  if (ctx.kind === 'ollama' && !r.text) throw new Error(`Ollama ${ctx.model} returned an empty response.`);
  return r.text;
}

/** An unterminated leading <think> is reasoning evidence even when the
    transport saw no reasoning deltas (wave 2's reasoning-overflow rule reads
    reasoningSeen). Returns the same object when nothing changes. */
export function withThinkEvidence(r: TransportResult): TransportResult {
  if (r.reasoningSeen || !stripThink(r.text).unterminated) return r;
  return { ...r, reasoningSeen: true };
}
