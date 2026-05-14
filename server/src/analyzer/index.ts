/* Analyzer abstraction — swap the implementation of stage1 / stage2 between
   today's manual file-drop handoff and a free-tier Gemini API call. Selected
   by ANALYZER=manual|gemini (default manual). The route in routes/analysis.ts
   calls runStage1 / runStage2; both implementations preserve the SSE
   onWaiting callback so the progress bar animates in either mode. */

import type { Stage1Output, Stage1ChapterOutput, Stage2ChapterOutput } from '../handoff/schemas.js';
import { ManualAnalyzer } from './manual.js';
import { GeminiAnalyzer } from './gemini.js';
import { getResolvedAnalyzerMode } from '../workspace/user-settings.js';

export interface StageChunkInfo {
  /** Total bytes of model output received so far. */
  receivedBytes: number;
  /** Full assembled buffer so far — callers may peek (e.g. count
      `"name":` occurrences during stage 1) but should not mutate. */
  receivedText: string;
  /** ms since the previous chunk arrived (or since the request started
      for the first chunk). Big values warn that the model went quiet. */
  sinceLastChunkMs: number;
  /** ms since the request was sent. */
  elapsedMs: number;
}

export interface StageCall {
  onWaiting?: (elapsedMs: number) => void;
  /** Fired per streamed chunk from the model (Gemini analyzer only).
      Manual analyzer never invokes this — it polls a file drop. */
  onChunk?: (info: StageChunkInfo) => void;
}

export interface Analyzer {
  /* Legacy whole-book stage 1 — kept for back-compat with any caller still
     wiring it. The current route uses runStage1Chapter (Phase 0a) instead. */
  runStage1(manuscriptId: string, promptMd: string, call: StageCall): Promise<Stage1Output>;
  /* Phase 0a — per-chapter cast detection. Each call returns the speaking
     characters that appear in ONE chapter (new + recurring). The route
     merges these into a running roster across the book. Same StageCall
     plumbing as runStage2Chapter — onChunk fires per stream chunk for
     the live "Receiving response" indicator. */
  runStage1Chapter(manuscriptId: string, chapterId: number, promptMd: string, call: StageCall): Promise<Stage1ChapterOutput>;
  /* Stage 2 runs per chapter so we stay under model context windows and the
     free-tier rate limit can recover between calls on transient 429/5xx.
     The route iterates chapters and concatenates the per-chapter sentence
     arrays. */
  runStage2Chapter(manuscriptId: string, chapterId: number, promptMd: string, call: StageCall): Promise<Stage2ChapterOutput>;
}

export interface SelectAnalyzerOptions {
  /** Per-request override for the Gemini model id. Falls back to
      process.env.GEMINI_MODEL, then to 'gemini-2.5-flash'. Ignored in
      manual mode. */
  model?: string;
}

export function selectAnalyzer(opts: SelectAnalyzerOptions = {}): Analyzer {
  /* Precedence: user-settings.json `analyzerMode` (live-reloaded) →
     ANALYZER env var → 'manual'. Switching modes in the Account view
     takes effect on the next request — no server restart needed. */
  const mode = getResolvedAnalyzerMode();
  if (mode === 'gemini') {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      throw new Error('ANALYZER=gemini requires GEMINI_API_KEY to be set (see server/.env.example).');
    }
    const model = opts.model ?? process.env.GEMINI_MODEL ?? 'gemma-4-31b-it';
    return new GeminiAnalyzer({ apiKey, model });
  }
  return new ManualAnalyzer();
}
