/* fs-38 Wave 1, Task 9 — scope-agnostic Qwen voice-design core.

   The sidecar `/qwen/design-voice` POST + audition-cache write, lifted out of
   the nested `postDesignAndCache` closure in `routes/qwen-voice.ts` (which was
   coupled to a book/character) and parameterised so BOTH the character-scoped
   design route AND the voice-library design/redesign routes run the exact same
   sidecar path. The character route wraps this in its own book design-lock +
   GPU-load + emotion-variant/fallback logic; the library routes wrap it in the
   library single-flight lock. This module knows nothing about either scope — it
   takes a `storageKey`/`displayName`/`persona`, shapes the request, warms the
   sample cache, and returns the audition URL.

   `SidecarDesignError`, the liveness watchdog constants, and
   `evaluateDesignLiveness` live here (rather than in the route) because both the
   route and this core throw/consult them; qwen-voice.ts re-exports them so its
   existing importers (and its whole test file) are unaffected. */

import { mkdir, writeFile } from 'node:fs/promises';
import { withCapacityRetry } from '../gpu/capacity-retry.js';
import { NoCapacityError } from './tts-errors.js';
import { encodePcmToAudio } from './mp3.js';
import {
  buildSampleText,
  voiceSampleAudioDir,
  voiceSampleFileName,
  voiceSampleFilePath,
  voiceSamplePublicUrl,
} from './voice-sample-cache.js';
import type { TtsModelKey } from './model-keys.js';
import { sidecarLanguageName } from './language.js';
import { getResolvedSidecarUrl } from '../workspace/user-settings.js';

export class SidecarDesignError extends Error {
  status: number;
  code?: string;
  reason?: string;
  constructor(message: string, status: number, code?: string, reason?: string) {
    super(message);
    this.name = 'SidecarDesignError';
    this.status = status;
    this.code = code;
    this.reason = reason;
  }
}

/* The base liveness-check interval. A design that exceeds this AND whose sidecar
   /health is still reachable is slow-but-alive — keep waiting (almost always a
   contended GPU). Only an unreachable sidecar or the absolute ceiling aborts. */
const DESIGN_LIVENESS_INTERVAL_MS = 180_000;
/* Hard ceiling so a genuinely hung-but-pingable sidecar still fails eventually. */
const DESIGN_ABSOLUTE_MAX_MS = 600_000;

export type DesignLivenessResult =
  | { action: 'continue' }
  | { action: 'abort'; reason: 'unreachable' | 'absolute' };

/** Pure decision for the design liveness watchdog — easy to unit-test. */
export function evaluateDesignLiveness(p: {
  startedAt: number;
  now: number;
  health: 'reachable' | 'unreachable';
  absoluteMaxMs: number;
}): DesignLivenessResult {
  if (p.health === 'unreachable') return { action: 'abort', reason: 'unreachable' };
  if (p.now - p.startedAt >= p.absoluteMaxMs) return { action: 'abort', reason: 'absolute' };
  return { action: 'continue' };
}

export interface PostDesignAndCacheParams {
  /** Sidecar endpoint, e.g. `${sidecarUrl}/qwen/design-voice`. */
  target: string;
  /** Serialized JSON request body. */
  fetchBody: string;
  /** The voice id the sidecar persists AND the cached audition is keyed on. */
  outVoiceId: string;
  /** Sample-cache scope (character `sampleVoiceId` OR library `storageKey`). */
  cacheScope: string;
  /** Model key folded into the cached audition filename. */
  modelKey: TtsModelKey;
  /** The audition line — also the cache-key text. */
  calibrationText: string;
  /** Resolved sidecar base URL (for error messages). */
  sidecarUrl: string;
  /** External cancel — aborts the in-flight sidecar call (e.g. a bulk job). */
  signal?: AbortSignal;
  /** Free-text logging prefix (`book=… character=…` OR `library storageKey=…`). */
  logContext: string;
}

/* The lifted `postDesignAndCache`: POST the sidecar with a liveness watchdog +
   capacity-retry, encode the returned PCM into the audition cache under the
   caller's scope, and return the public URL. Throws SidecarDesignError (or a
   plain Error on an encode failure) with a user-facing message; the caller maps
   it. Behaviour is preserved byte-for-byte from the character route's closure —
   the only change is that book/character-coupled captures are now params. */
export async function postDesignAndCacheAudition(
  params: PostDesignAndCacheParams,
): Promise<{ voiceId: string; url: string }> {
  const {
    target,
    fetchBody,
    outVoiceId,
    cacheScope,
    modelKey,
    calibrationText,
    sidecarUrl,
    signal,
    logContext,
  } = params;

  const controller = new AbortController();
  const startedAt = Date.now();
  let abortReason: 'unreachable' | 'absolute' | null = null;
  const livenessTimer = setInterval(() => {
    void (async () => {
      const { probeSidecarHealth } = await import('../routes/sidecar-health.js');
      const health = (await probeSidecarHealth()).status;
      const decision = evaluateDesignLiveness({
        startedAt,
        now: Date.now(),
        health,
        absoluteMaxMs: DESIGN_ABSOLUTE_MAX_MS,
      });
      if (decision.action === 'abort') {
        abortReason = decision.reason;
        controller.abort();
      } else {
        console.warn(
          `[qwen-voice] design slow (${Math.round((Date.now() - startedAt) / 1000)}s) ` +
            `— sidecar /health reachable, extending (ceiling ${DESIGN_ABSOLUTE_MAX_MS / 1000}s).`,
        );
      }
    })();
  }, DESIGN_LIVENESS_INTERVAL_MS);
  const onExternalAbort = () => controller.abort();
  if (signal) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener('abort', onExternalAbort, { once: true });
  }
  try {
    let upstream: Awaited<ReturnType<typeof fetch>>;
    try {
      upstream = await withCapacityRetry(
        (s) =>
          fetch(target, {
            method: 'POST',
            signal: s,
            headers: { 'Content-Type': 'application/json' },
            body: fetchBody,
          }),
        { engine: 'qwen', signal: controller.signal },
      );
    } catch (e) {
      if (e instanceof NoCapacityError) {
        throw new SidecarDesignError(
          'GPU has no capacity for voice design right now — free VRAM and retry.',
          503,
        );
      }
      const err = e as { name?: string; message?: string };
      if (err.name === 'AbortError') {
        if (signal?.aborted) throw new SidecarDesignError('Voice design was cancelled.', 0);
        if (abortReason === 'unreachable')
          throw new SidecarDesignError(
            `TTS sidecar (${sidecarUrl}) stopped responding to /health during voice design.`,
            0,
          );
        throw new SidecarDesignError(
          `Sidecar ${target} did not complete within ${DESIGN_ABSOLUTE_MAX_MS}ms.`,
          0,
        );
      }
      throw new SidecarDesignError(
        `TTS sidecar (${sidecarUrl}) is unreachable — ${err.message || 'request failed'}.`,
        0,
      );
    }
    if (!upstream.ok) {
      let detail = '',
        code: string | undefined,
        reason: string | undefined;
      try {
        const b = (await upstream.json()) as {
          detail?: string;
          error?: string;
          code?: string;
          reason?: string;
        };
        detail = b.detail ?? b.error ?? '';
        code = b.code;
        reason = b.reason;
      } catch {
        /* not json */
      }
      throw new SidecarDesignError(
        detail || `Sidecar ${target} returned ${upstream.status} ${upstream.statusText}.`,
        upstream.status,
        code,
        reason,
      );
    }
    const sampleRate = Number(upstream.headers.get('X-Sample-Rate') ?? '24000') || 24000;
    const pcm = Buffer.from(await upstream.arrayBuffer());
    const fileName = voiceSampleFileName({
      cacheScope,
      modelKey,
      text: calibrationText,
      voiceName: outVoiceId,
    });
    const filePath = voiceSampleFilePath(fileName);
    const url = voiceSamplePublicUrl(fileName);
    try {
      await mkdir(voiceSampleAudioDir(), { recursive: true });
      const mp3 = await encodePcmToAudio(pcm, sampleRate);
      await writeFile(filePath, mp3);
    } catch (encErr) {
      throw new Error(`Designed the voice but failed to cache its preview: ${(encErr as Error).message}`);
    }
    console.log(
      `[qwen-voice] ${logContext} voiceId=${outVoiceId} → cached ${fileName} (${pcm.length} bytes @ ${sampleRate}Hz)`,
    );
    // fs-45 v1: record the design peak (Base + VoiceDesign resident here).
    const { maybeSampleSidecarEngine } = await import('../gpu/sidecar-vram-sample.js');
    await maybeSampleSidecarEngine('qwen:design');
    return { voiceId: outVoiceId, url };
  } finally {
    clearInterval(livenessTimer);
    if (signal) signal.removeEventListener('abort', onExternalAbort);
  }
}

export interface RunVoiceDesignOpts {
  /** The Qwen storage key the sidecar persists the `.pt` under (`qwen-<uuid>`). */
  storageKey: string;
  /** Human name — seeds the fallback audition line when there's no evidence. */
  displayName: string;
  /** Non-empty persona/instruct text. */
  persona: string;
  /** BCP-47 language for the designed voice (defaults to English). */
  languageCode?: string;
  /** Stage under `<storageKey>-preview` (A/B compare) instead of in place. */
  preview?: boolean;
}

/* The scope-agnostic entry point the voice-library routes call. Designs a Qwen
   voice from a bare `{ storageKey, displayName, persona }` — no book, cast, or
   character. `preview: true` stages under `<storageKey>-preview` (the plan-161
   pattern generalised) so an A/B redesign never overwrites the live `.pt` until
   the user promotes. ALWAYS warms the sample cache and returns the audition URL
   as `previewUrl` (what the create modal auditions and the A/B modal plays). */
export async function runVoiceDesign(
  opts: RunVoiceDesignOpts,
): Promise<{ storageKey: string; previewUrl?: string }> {
  const outVoiceId = opts.preview ? `${opts.storageKey}-preview` : opts.storageKey;
  /* A character-less audition line: buildSampleText tolerates no evidence and
     falls back to a name-seeded canned script (see voice-sample-cache.ts). */
  const calibrationText = buildSampleText({
    id: opts.storageKey,
    character: opts.displayName,
    overrideTtsVoices: {},
  });
  const language = sidecarLanguageName(opts.languageCode ?? 'en');
  const sidecarUrl = getResolvedSidecarUrl();

  const { url } = await postDesignAndCacheAudition({
    target: `${sidecarUrl}/qwen/design-voice`,
    fetchBody: JSON.stringify({
      voiceId: outVoiceId,
      voiceUuid: null,
      instruct: opts.persona,
      language,
      calibrationText,
    }),
    outVoiceId,
    /* Cache-scope is the STABLE storageKey for both the live and preview
       designs — the preview file stays distinct because `outVoiceId` (with its
       `-preview` suffix) folds into the filename hash. Keeping one scope means a
       single `purgeVoiceSamples(storageKey)` clears both live + preview
       auditions on promote/delete. */
    cacheScope: opts.storageKey,
    modelKey: 'qwen3-tts-0.6b',
    calibrationText,
    sidecarUrl,
    logContext: `library storageKey=${opts.storageKey}${opts.preview ? ' (preview)' : ''}`,
  });

  return { storageKey: opts.storageKey, previewUrl: url };
}
