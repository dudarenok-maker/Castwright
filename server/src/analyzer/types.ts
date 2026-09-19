/* Analyzer interface types. A leaf module (type-only imports) so runner/transport files can reference StageCall/Analyzer without an edge back to index.ts — madge counts type-only imports as cycle edges. */
import type {
  Stage1Output,
  Stage1ChapterOutput,
  Stage2ChapterOutput,
  EmotionAnnotationOutput,
  ScriptReviewOutput,
  Stage3ChapterOutput,
  EscalationOutput,
  NonStoryClassificationOutput,
} from '../handoff/schemas.js';

import type { RawEvalTiming } from './analyzer-eval-stats.js';

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
  /** Fired once per Ollama chat() call with that call's decode timing. The
      analysis route accumulates these per pass (see withPassEval). Only the
      local Ollama analyzer fires it; Gemini never does. */
  onEvalTiming?: (t: RawEvalTiming) => void;
  /** Optional abort signal — when the caller (the analysis route) sees its
      SSE client disconnect, it aborts the controller so the analyzer can
      tear down the in-flight Ollama/Gemini request instead of running on
      as a zombie that holds the model busy for the next session. */
  signal?: AbortSignal;
  /** #2324 — 1-based sequence of this stage-2 call WITHIN its chapter, set by
      runStage2ChapterChunked and used only to key the handoff forensics so a
      chunked chapter doesn't overwrite its own prompts/responses. Carried on
      StageCall rather than as a method parameter so the `Analyzer` interface
      (and every implementation and test double) is untouched. Absent for the
      single-call path, which therefore keeps its existing filenames exactly.
      Counts CALLS, not sections: a coverage retry gets its own number, so the
      failing attempt survives alongside the one that replaced it. */
  stage2CallSeq?: number;
  /** Fired when the limiter has to delay this request — RPM/TPM cap hit
      locally, or `retry-delay` honored after a 429. Only emitted when
      the wait exceeds ~1s so sub-second jitter doesn't spam the UI.
      The route layer converts these to SSE `throttle` events. */
  onThrottle?: (waitMs: number, reason: 'rpm' | 'tpm' | 'rpd' | 'retry-after') => void;
  /** fs-2 — the book's BCP-47 language. When non-English, the analyzer
      prepends a language preamble to the system instruction so attribution
      handles the script's conventions (Cyrillic names, «…»/— dash dialogue,
      patronymics). Absent/`'en'` → no preamble (byte-identical to pre-fs-2).
      Flows verbatim through every `runStage*` of every analyzer
      implementation, so it never touches a method signature. */
  language?: string;
  /** Fired by FallbackAnalyzer when it switches from a primary that threw
      AnalyzerUnreachableError to the fallback for this call. Route uses it to
      announce the switch. */
  onFallback?: (info: { reason: string }) => void;
}

export interface Analyzer {
  /* Legacy whole-book stage 1 — retained on the interface for any
     historical caller. The current route uses runStage1Chapter
     (Phase 0a) instead. */
  runStage1(manuscriptId: string, promptMd: string, call: StageCall): Promise<Stage1Output>;
  /* Phase 0a — per-chapter cast detection. Each call returns the
     speaking characters that appear in ONE chapter (new + recurring).
     The route merges these into a running roster across the book. */
  runStage1Chapter(
    manuscriptId: string,
    chapterId: number,
    promptMd: string,
    call: StageCall,
  ): Promise<Stage1ChapterOutput>;
  /* Per-chapter sentence attribution. Stays under model context windows
     and lets free-tier rate limits recover between calls. */
  runStage2Chapter(
    manuscriptId: string,
    chapterId: number,
    promptMd: string,
    call: StageCall,
  ): Promise<Stage2ChapterOutput>;
  /* fs-33 — emotion-only backfill. Reads a chapter's already-attributed
     sentences and returns ONLY {sentenceId, emotion} for the sentences it
     assigns a delivery emotion. Never re-attributes (no characterId/text in
     the output schema), so existing cast/manual reassignments are untouched. */
  runEmotionChapter(
    manuscriptId: string,
    chapterId: number,
    promptMd: string,
    call: StageCall,
  ): Promise<EmotionAnnotationOutput>;
  /* fs-58 — LLM script review pass. Reads a chapter's attributed sentences
     and returns a flat list of editing ops (strip_tag, split, extract_dialogue,
     merge, fix_emotion) with anchors and rationale. Client-side apply dispatches
     the ops through existing Redux manual-edit reducers. */
  runScriptReviewChapter(
    manuscriptId: string,
    chapterId: number,
    promptMd: string,
    call: StageCall,
  ): Promise<ScriptReviewOutput>;
  /* fs-57 — instruct-annotation pass. Reads a chapter's already-attributed
     sentences and returns {sentenceId, text?, instruct?, vocalization?} for
     sentences that need a delivery direction or vocalization flag. Never
     re-attributes (no characterId in the output schema). */
  runStage3Chapter(
    manuscriptId: string,
    chapterId: number,
    promptMd: string,
    call: StageCall,
  ): Promise<Stage3ChapterOutput>;
  /* srv-59 Task 9 — flagged-window attribution escalation. Unlike every
     other analyzer call, this is NOT schema-constrained decoding: the
     reply shape `{assignments:[…]}` doesn't fit the stage2 grammar, and an
     empty/RECITATION-blocked reply must be observable rather than thrown.
     Returns `null` for an empty/blocked/unparseable response — NEVER a
     throw for those cases; the caller (escalateFlaggedWindows, Task 9b)
     just skips the window. A genuinely unreachable local daemon (or a
     client abort) still throws, same as every other method here, so
     FallbackAnalyzer/the route's abort handling keep working unchanged. */
  runAttributionEscalation(
    manuscriptId: string,
    chapterId: number,
    windowIndex: number,
    prompt: string,
    call: StageCall,
  ): Promise<EscalationOutput | null>;
  /* #1447 — chapter-level non-story classification (Signal 2). OPTIONAL so
     analyzers that don't implement it degrade to Signal-1-only. Returns
     { nonStory: true } when the chapter is a non-story foreword / critical
     essay about the book or its author rather than narrative fiction. */
  runNonStoryClassification?(
    manuscriptId: string,
    chapterId: number,
    promptMd: string,
    call: StageCall,
  ): Promise<NonStoryClassificationOutput>;
}
