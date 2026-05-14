/* Analyzer abstraction. Today the only implementation is GeminiAnalyzer
   (free-tier Gemini API with streaming chunk feedback). The manual
   file-drop cowork analyzer is gone — it was a development-time
   convenience that's no longer useful now the API path is solid. */

import type { Stage1Output, Stage1ChapterOutput, Stage2ChapterOutput } from '../handoff/schemas.js';
import { GeminiAnalyzer } from './gemini.js';

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
  /** Fired per streamed chunk from the model. */
  onChunk?: (info: StageChunkInfo) => void;
}

export interface Analyzer {
  /* Legacy whole-book stage 1 — retained on the interface for any
     historical caller. The current route uses runStage1Chapter
     (Phase 0a) instead. */
  runStage1(manuscriptId: string, promptMd: string, call: StageCall): Promise<Stage1Output>;
  /* Phase 0a — per-chapter cast detection. Each call returns the
     speaking characters that appear in ONE chapter (new + recurring).
     The route merges these into a running roster across the book. */
  runStage1Chapter(manuscriptId: string, chapterId: number, promptMd: string, call: StageCall): Promise<Stage1ChapterOutput>;
  /* Per-chapter sentence attribution. Stays under model context windows
     and lets free-tier rate limits recover between calls. */
  runStage2Chapter(manuscriptId: string, chapterId: number, promptMd: string, call: StageCall): Promise<Stage2ChapterOutput>;
}

export interface SelectAnalyzerOptions {
  /** Per-request override for the Gemini model id. Falls back to
      process.env.GEMINI_MODEL, then to 'gemma-4-31b-it'. */
  model?: string;
}

export function selectAnalyzer(opts: SelectAnalyzerOptions = {}): Analyzer {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error('GEMINI_API_KEY is required (set it in server/.env — see server/.env.example).');
  }
  const model = opts.model ?? process.env.GEMINI_MODEL ?? 'gemma-4-31b-it';
  return new GeminiAnalyzer({ apiKey, model });
}
