/* Maps a completed TransportResult to answer text or the classified error the
   stage-2 chunker / failure taxonomy key off. Wave 1 reproduces each engine's
   pre-extraction order exactly (ollama.ts chat() :830-844, gemini.ts
   generate() :783-818 on 80be2f1d). Wave 2 adds the reasoning-overflow rule. */
import { AnalyzerTruncatedError, GeminiContentBlockedError, type TransportKind } from '../errors.js';
import type { TransportResult } from './transport.js';

export function mapFinish(r: TransportResult, ctx: { kind: TransportKind; model: string }): string {
  if (ctx.kind === 'ollama') {
    /* Emptiness first: an empty stream that also reports done_reason 'length'
       has always been the empty-response error, never a split. */
    if (!r.text) throw new Error(`Ollama ${ctx.model} returned an empty response.`);
    if (r.finish === 'length') {
      throw new AnalyzerTruncatedError('ollama', r.finishReason ?? 'length', r.receivedBytes);
    }
    return r.text;
  }
  if (r.finish === 'blocked') throw new GeminiContentBlockedError(ctx.model, r.blockReason);
  if (r.finish === 'length') {
    throw new AnalyzerTruncatedError(ctx.kind, r.finishReason ?? 'length', r.receivedBytes, r.usage?.outputTokens);
  }
  return r.text;
}
