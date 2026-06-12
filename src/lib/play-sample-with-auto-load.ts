/* Voice-sample request orchestrator — bridges the "model lifecycle is
   button-driven, not eager" rule (CLAUDE.md) with the user's expectation
   that clicking Play just plays.

   Without this, clicking Play in the profile drawer or a cast row hits
   /api/voices/:id/sample directly. If the TTS sidecar has no weights
   loaded (the default since we removed PRELOAD_COQUI), or if the
   analyzer is still resident from a recent analysis run, the synth
   fails with "Workspace can't be allocated, no enough memory" — the
   screenshot the user filed.

   Treat the Play click as the user's load consent (same shape as the
   Generation view's handleLoadTts, just inline): probe sidecar health,
   evict the analyzer when it's resident, load the sidecar, then synth.
   The caller drives per-row UI from the onStatus callback. */

import { api } from './api';
import type { VoiceSampleArgs, BaseVoiceSampleArgs } from './api';
import type { TtsEngine } from './types';

export type SampleStatus = 'evicting' | 'loading-tts' | 'synthesizing';

export interface PlaySampleOptions {
  args: VoiceSampleArgs;
  /* Minimal subset of useSamplePlayback's return — accepting a structural
     type keeps the helper testable without pulling the DOM Audio element
     into unit tests. */
  playback: { play: (url: string) => Promise<void> };
  /* Called each time the orchestrator advances a step so the caller can
     update its button label / inline banner. `analyzerEvicted` flips to
     true the moment we unload Ollama and stays true for the rest of the
     run, so callers can keep the eviction banner visible through the
     load + synth phases. */
  onStatus?: (status: SampleStatus, opts: { analyzerEvicted: boolean }) => void;
}

export interface PlaySampleResult {
  analyzerEvicted: boolean;
}

/* Single-flight gate so a second click while an evict+load is mid-flight
   awaits the same preparation instead of firing a duplicate one. The
   sidecar's /load is already locked server-side, but doubling up the
   client-side eviction probe is just noise. Resolves once the model is
   ready (or rejects when prep fails); the synth itself is not coalesced
   — each click still synthesizes its own (potentially different) sample. */
let prepInFlight: Promise<{ analyzerEvicted: boolean }> | null = null;

export async function playSampleWithAutoLoad(opts: PlaySampleOptions): Promise<PlaySampleResult> {
  const { args, playback, onStatus } = opts;

  /* Phase 1: ensure the sidecar model is resident. The engine the voice
     actually uses drives WHICH model warms — without it the load defaulted to
     Coqui, warming the wrong ~2 GB XTTS model when the voice is Kokoro/Qwen
     (and on an 8 GB GPU that stacked onto the Qwen models and OOM'd design).
     Gemini is cloud-only — no local sidecar — so skip prep entirely (mirrors
     playBaseVoiceSampleWithAutoLoad). Shared single-flight gate so a Drawer
     click + a Cast row click don't both fire evict+load. */
  const engine = args.voice.ttsVoice?.provider;
  let analyzerEvicted = false;
  if (engine !== 'gemini') {
    const prep =
      prepInFlight ?? (prepInFlight = prepareSidecar(onStatus, sidecarEngineFor(engine)));
    try {
      ({ analyzerEvicted } = await prep);
    } finally {
      /* Only the caller that started prepInFlight should clear it. Cheap to
         just clear unconditionally — the next click rebuilds it if needed. */
      if (prepInFlight === prep) prepInFlight = null;
    }
  }

  /* Phase 2: synth + play. Each call is independent — different voiceId /
     characterHint produces different audio, so coalescing here would be
     wrong. */
  onStatus?.('synthesizing', { analyzerEvicted });
  const res = await api.getVoiceSample(args);
  if (!res.url) {
    throw new Error('Voice samples need the live server (VITE_USE_MOCKS=false).');
  }
  await playback.play(res.url);
  return { analyzerEvicted };
}

/* Map a voice's engine to the engine the local sidecar can `/load`. Gemini
   is cloud-only (callers skip prep before reaching here); anything without a
   sidecar `/load` engine (e.g. piper, or a voice with no ttsVoice yet) returns
   undefined, falling back to the server's default — exact prior behaviour. */
function sidecarEngineFor(
  engine: TtsEngine | undefined,
): 'coqui' | 'kokoro' | 'qwen' | undefined {
  return engine === 'coqui' || engine === 'kokoro' || engine === 'qwen' ? engine : undefined;
}

async function prepareSidecar(
  onStatus: PlaySampleOptions['onStatus'],
  engine?: 'coqui' | 'kokoro' | 'qwen',
): Promise<{ analyzerEvicted: boolean }> {
  const health = await api.getSidecarHealth();
  if (health.status === 'unreachable') {
    /* Two distinct failure modes share `unreachable` status — the
       `proxy` field tells us which hop died. Surface different copy so
       the user runs the right recovery. The underlying error message
       (Vite 502, ECONNREFUSED, sidecar timeout) is appended so power
       users can copy-paste it into a bug report. */
    const reason = health.error ?? 'no further detail';
    if (health.proxy === 'node') {
      throw new Error(
        `Node server (:8080) is unreachable — restart it via \`npm --prefix server run dev\` (or scripts\\start-app.ps1). [${reason}]`,
      );
    }
    /* Default to sidecar wording (covers older Node servers that don't
       emit `proxy`) — they're the more common failure mode now that
       :8080 is more stable than the Python sidecar's CUDA path. */
    throw new Error(
      `Voice engine (:9000) is unreachable — restart it via scripts\\start-app.ps1 (or kill any stale process holding :9000). [${reason}]`,
    );
  }
  if (health.modelLoaded) {
    /* Fast path: model already warm. Nothing to evict or load. */
    return { analyzerEvicted: false };
  }

  /* Mirror generation.tsx handleLoadTts: only claim "evicted" when the
     analyzer was actually resident. unloadAnalyzer on an idle Ollama is
     a no-op; lying about the eviction confuses the banner copy. */
  let analyzerResident = false;
  try {
    const ollama = await api.getOllamaHealth();
    analyzerResident = ollama.status === 'reachable' && ollama.modelResident === true;
  } catch {
    /* /api/ps flaky — still attempt the unload so a stuck analyzer
       doesn't poison the load. analyzerEvicted stays false because we
       can't confirm anything was actually freed. */
  }

  if (analyzerResident) {
    onStatus?.('evicting', { analyzerEvicted: false });
    try {
      await api.unloadAnalyzer();
    } catch {
      /* Server-side unload failures fall through — the subsequent
         loadSidecar will surface the real allocation error if VRAM is
         still held. */
    }
  }

  onStatus?.('loading-tts', { analyzerEvicted: analyzerResident });
  const result = await api.loadSidecar(engine ? { engine } : {});
  if (result.status === 'error') {
    throw new Error(result.error ?? 'Voice engine failed to load.');
  }
  return { analyzerEvicted: analyzerResident };
}

/* Auto-load variant for the "Base voices" tab + family-header Play. Same
   orchestration as the cast-row variant for Coqui/Piper/Kokoro (sidecar
   prep, then synth), but the prep step is skipped entirely for Gemini
   raw samples — Gemini doesn't run through the local sidecar. The caller
   doesn't have a Voice/Character context for an unassigned base voice,
   so we accept a flatter args shape. */
export interface PlayBaseSampleOptions {
  args: BaseVoiceSampleArgs;
  playback: { play: (url: string) => Promise<void> };
  onStatus?: (status: SampleStatus, opts: { analyzerEvicted: boolean }) => void;
}

export async function playBaseVoiceSampleWithAutoLoad(
  opts: PlayBaseSampleOptions,
): Promise<PlaySampleResult> {
  const { args, playback, onStatus } = opts;
  const needsSidecar: TtsEngine = args.engine;
  let analyzerEvicted = false;
  if (needsSidecar !== 'gemini') {
    const prep =
      prepInFlight ?? (prepInFlight = prepareSidecar(onStatus, sidecarEngineFor(needsSidecar)));
    try {
      ({ analyzerEvicted } = await prep);
    } finally {
      if (prepInFlight === prep) prepInFlight = null;
    }
  }
  onStatus?.('synthesizing', { analyzerEvicted });
  const res = await api.getBaseVoiceSample(args);
  if (!res.url) {
    throw new Error('Voice samples need the live server (VITE_USE_MOCKS=false).');
  }
  await playback.play(res.url);
  return { analyzerEvicted };
}

/* Test-only escape hatch — exported so the unit tests can reset the
   single-flight gate between cases. Not part of the public surface. */
export function __resetPrepInFlightForTests(): void {
  prepInFlight = null;
}
