/* Analyzer abstraction — swap the implementation of stage1 / stage2 between
   today's manual file-drop handoff and a free-tier Gemini API call. Selected
   by ANALYZER=manual|gemini (default manual). The route in routes/analysis.ts
   calls runStage1 / runStage2; both implementations preserve the SSE
   onWaiting callback so the progress bar animates in either mode. */

import type { Stage1Output, Stage2ChapterOutput } from '../handoff/schemas.js';
import { ManualAnalyzer } from './manual.js';
import { GeminiAnalyzer } from './gemini.js';

export interface StageCall {
  onWaiting?: (elapsedMs: number) => void;
}

export interface Analyzer {
  runStage1(manuscriptId: string, promptMd: string, call: StageCall): Promise<Stage1Output>;
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
  const mode = (process.env.ANALYZER ?? 'manual').toLowerCase();
  if (mode === 'gemini') {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      throw new Error('ANALYZER=gemini requires GEMINI_API_KEY to be set (see server/.env.example).');
    }
    const model = opts.model ?? process.env.GEMINI_MODEL ?? 'gemma-4-31b-it';
    return new GeminiAnalyzer({ apiKey, model });
  }
  if (mode !== 'manual') {
    throw new Error(`Unknown ANALYZER mode: ${mode}. Expected 'manual' or 'gemini'.`);
  }
  return new ManualAnalyzer();
}
