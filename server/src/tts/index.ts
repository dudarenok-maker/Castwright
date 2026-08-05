/* TTS provider abstraction. The interface is engine-agnostic — every provider
   takes `{ text, voiceName, modelKey }` and returns raw 16-bit PCM. The
   factory routes per-call by inspecting the modelKey prefix, so a single
   server can serve a mix of local and cloud requests without restart.

   Local engines speak to a sidecar HTTP service (server/tts-sidecar/) started
   separately by the user (`npm run tts:sidecar`). Gemini stays available as a
   manually-selected fallback when the user wants to bypass the local engine. */

import { GeminiTtsProvider } from './gemini.js';
import { SidecarTtsProvider } from './sidecar.js';
import { getResolvedSidecarUrl, getResolvedGeminiApiKey } from '../workspace/user-settings.js';
import { engineForModelKey } from './model-keys.js';
import type { TtsModelKey } from './model-keys.js';

/* The model-key types + pure helpers (TtsEngine, TtsModelKey, TTS_MODEL_LABELS,
   resolveGeminiModelId, isTtsModelKey, engineForModelKey, sidecarModelId) live
   in the leaf module ./model-keys.js so the GeminiTtsProvider / SidecarTtsProvider
   classes can import them without forming an index ↔ provider cycle (that cycle
   was the source of the intermittent partial-`importOriginal` mock flake). The
   public `tts/index.js` surface is unchanged — re-export them here. */
export * from './model-keys.js';

export interface SynthesizeInput {
  text: string;
  voiceName: string;
  modelKey: TtsModelKey;
  /** fs-60 — BCP-47 primary subtag for this synth call. Coqui always honors it
      (threaded to the sidecar's per-request `language` field). Since #1951 Qwen
      honors it too, but ONLY for a cloned voice — see `cloned` below. Every
      other engine/provider ignores it. Optional — omitted means "use the
      sidecar's boot-time COQUI_LANGUAGE default" (backward-compatible for
      English). */
  language?: string;
  /** #1951 — true when this synth is backed by a CLONED voice
      (`hasClonedProvenance`). Qwen-only in effect. A cloned voice's sidecar
      manifest permanently says "English" (its derive never sent `X-Language`),
      and cloned voices are deliberately exempt from
      `clearMismatchedDesignedVoices` so they can be reused across books — so
      nothing else supplies a language and the clone renders every book in
      English. This flag is what tells `sidecar.ts` to put the book's language
      on the wire, where it OVERRIDES the manifest word.

      Decided in Node and never re-derived in the sidecar: the wire signal is
      simply whether a `language` is present on the request, so the sidecar
      never learns what a clone is. Absent/false → no language is sent for Qwen
      → the manifest language stands → byte-identical to pre-#1951 behaviour,
      which is what keeps designed voices unchanged. Callers that pass an
      unvalidated, client-supplied `language` (routes/voice-sample.ts) must NOT
      set this — see `resolveWireLanguage`. */
  cloned?: boolean;
  /** Optional abort signal — providers that can honour it should pass it
      through to their underlying HTTP/SDK call so a mid-call cancellation
      (e.g. server-side per-book mutex aborting a stale generation handler)
      doesn't leave a slow synth call running to completion. */
  signal?: AbortSignal;
}

export interface SynthesizeOutput {
  pcm: Buffer;
  sampleRate: number;
  mimeType: string;
  /** The voice name the caller REQUESTED, set only when the sidecar couldn't
      honour it and substituted a safe fallback (its `X-Voice-Substituted-From`
      header). Absent on a clean render. Lets the chapter assembler stamp the
      segment and the golden-audio gate fail on a silent voice fallback —
      previously the substitution was only `console.warn`'d, so it was
      unassertable. */
  voiceSubstitutedFrom?: string;
}

/** One sentence in a batched synth request (plan 112). Mirrors the per-call
    `{ text, voiceName }` pair; a batch may mix voices because the underlying
    Qwen `generate_voice_clone` takes a per-element prompt.

    fs-57 — on the 1.7B liveInstruct path each item optionally carries a
    delivery direction (`instruct`). Absent items carry no key; the sidecar
    substitutes NEUTRAL_INSTRUCT for those slots (PR2-Mi1). */
export interface SynthesizeBatchItem {
  text: string;
  voiceName: string;
  /** fs-57 — delivery direction for the 1.7B liveInstruct path. Absent
      when the gate is off or no instruct/emotion phrase applies. */
  instruct?: string;
  /** fs-57 — delivery emotion for the liveInstruct gain path. The sidecar
      uses this (not the voice name suffix) to look up the output gain on the
      liveInstruct path. Absent → unity gain (1.0). */
  emotion?: string;
  /** #1951 — true when THIS item's voice is cloned (`hasClonedProvenance`).
      Per-item, not per-batch, and that is forced rather than stylistic: a
      batch may MIX voices (a cloned character's line beside a designed
      narrator's), and those need different languages in the same forward. See
      `SynthesizeInput.cloned` for the full rationale; the batch's language
      itself is `SynthesizeBatchInput.language`. */
  cloned?: boolean;
}

export interface SynthesizeBatchInput {
  items: SynthesizeBatchItem[];
  modelKey: TtsModelKey;
  /** #1951 — BCP-47 primary subtag of the BOOK, for the whole batch. Batch-level
      because a batch is always one chapter of one book, so there is exactly one
      book language; what varies per item is `cloned`, which decides whether this
      language reaches the wire for that item (Qwen), and the wire field is
      therefore per-item. Absent → no item carries a language, i.e. every voice
      keeps its manifest language (pre-#1951 behaviour). */
  language?: string;
  /** fs-57 — when true the sidecar activates the liveInstruct path for the
      whole batch (1.7B-only). Per-item `instruct` carries the phrase; absent
      items get the sidecar's NEUTRAL_INSTRUCT fill (PR2-Mi1). Default false
      (absent = off, back-compat). */
  liveInstruct?: boolean;
  signal?: AbortSignal;
}

/** No `voiceSubstitutedFrom` here, unlike `SynthesizeOutput` — deliberate,
    not an oversight (#2033, rescoped after premise check found no live
    defect). Only `CoquiEngine._synthesize_claimed` and `KokoroEngine.synthesize`
    (`server/tts-sidecar/main.py`) ever set `substituted_from`; batching is
    Qwen-only, and `QwenEngine` never substitutes. A per-item field here would
    carry a value that's structurally always null.

    What actually enforces "Qwen-only" on the Node side is the
    `route.engine === 'qwen'` arm of `isBatchable` (`synthesise-chapter.ts:2687`)
    — NOT a feature-detect on this method. `synthesizeBatch` is an
    UNCONDITIONAL method on `SidecarTtsProvider` (`server/src/tts/sidecar.ts:322`);
    every route, Coqui/Kokoro/Qwen alike, gets one, so
    `typeof route.provider.synthesizeBatch === 'function'` is true for all
    three today and detects nothing. Covered by
    `synthesise-chapter.test.ts:1597` ("keeps non-Qwen sentences one-per-call
    while batching the Qwen ones").

    On the Python side, `test_substituting_engines_cannot_batch`
    (`server/tts-sidecar/tests/test_batch_synthesis.py`) pins that neither
    `CoquiEngine` nor `KokoroEngine` exposes a usable `synthesize_batch`
    (note the Python name — a different symbol on a different object from
    the Node method above). `test_qwen_engine_never_constructs_a_substituted_synth_result`
    covers the other arm: that `QwenEngine` never sets `substituted_from` in
    the first place, since `SynthBatchResult` (unlike `SynthResult`) has
    nowhere to carry that signal if it ever did. */
export interface SynthesizeBatchOutput {
  /** One PCM blob per input item, SAME order. */
  pcms: Buffer[];
  /** Single sample rate shared by the whole batch (one batched forward). */
  sampleRate: number;
  /** Sidecar's forward-compute wall for this batch, ms. Drives live per-batch
      RTF telemetry (plan 127). Undefined if the sidecar didn't report it. */
  genMs?: number;
  /** Total audio the batch produced, ms (the RTF denominator). */
  audioMs?: number;
}

export interface TtsProvider {
  synthesize(input: SynthesizeInput): Promise<SynthesizeOutput>;
  /** TRUE batching (plan 112) — OPTIONAL. Synthesises N sentences in one
      batched model forward and returns one PCM blob per item, in order. Only
      providers backed by a list-capable engine (Qwen via the sidecar)
      implement it; callers MUST feature-detect (`provider.synthesizeBatch`)
      and fall back to per-call `synthesize` when it's absent (Gemini, or
      batching disabled). Keeping it optional preserves the engine-agnostic
      single-call contract every other consumer relies on. */
  synthesizeBatch?(input: SynthesizeBatchInput): Promise<SynthesizeBatchOutput>;
}

/* Picks the right provider for a single synthesise call. Gemini key →
   GeminiTtsProvider (resolves the API key at call-time via the env →
   user-settings → null chain); local key → SidecarTtsProvider pointed at
   LOCAL_TTS_URL. */
export function selectTtsProvider(modelKey: TtsModelKey): TtsProvider {
  const engine = engineForModelKey(modelKey);
  if (engine === 'gemini') {
    const apiKey = getResolvedGeminiApiKey();
    if (!apiKey) {
      throw new Error(
        'Gemini TTS selected but no API key is configured. ' +
          'Set it from Account → Server configuration → Gemini API key, ' +
          'or add it to server/.env for CI / power users.',
      );
    }
    return new GeminiTtsProvider({ apiKey });
  }
  /* Live-resolved from user-settings.json → LOCAL_TTS_URL env → localhost. */
  const url = getResolvedSidecarUrl();
  return new SidecarTtsProvider({ url, engine });
}
