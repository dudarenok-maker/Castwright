/* fs-38 Wave 3b1 — Node → sidecar clone-artifact primitive.

   Mirrors design-voice-core's postDesignAndCacheAudition transport (capacity
   retry + SidecarDesignError propagation) but for the clip-distil endpoint:
   POSTs the caller's normalized master PCM + the X-* headers to
   /<slot>/clone-voice and returns the audition preview PCM. Unlike the design
   core, it does NOT write the audition cache — the /clone route owns preview
   persistence. The `engine` param was 'qwen' only in 3b1; 3c (this file) adds
   the coqui/xtts branch on the same seam.

   Qwen and Coqui diverge on the wire: Qwen's clone prompt needs a transcript
   (`X-Ref-Text`, required — validated below) and returns `X-Base-Model`;
   Coqui's `get_conditioning_latents` is purely acoustic (no transcript sent
   at all) and returns `X-Coqui-Version` + `X-Model-Id` instead. `refText` is
   therefore optional on the shared input, and `baseModel`/`coquiVersion`/
   `modelId` are all optional on the shared result — each populated only by
   the branch that produces it. */

import { withCapacityRetry } from '../gpu/capacity-retry.js';
import { NoCapacityError } from './tts-errors.js';
import { SidecarDesignError } from './design-voice-core.js';
import { getResolvedSidecarUrl } from '../workspace/user-settings.js';
import { CLONE_CAPABLE_ENGINES, cloneStorageKey, manifestSlotFor, type CloneEngine } from './clone-engines.js';
import { fetch as undiciFetch, Agent } from 'undici';

export interface DeriveArtifactInput {
  masterPcm: Buffer;
  sampleRate: number;
  /** Required for a qwen derive (its clone prompt needs a transcript);
      unused for a coqui derive (XTTS's conditioning-latents extraction is
      purely acoustic). Validated inside the qwen branch only, at call time —
      see below. */
  refText?: string;
  auditionText?: string;
  /** #1951 — the sidecar language WORD ("German") for the reference clip,
      sent as `X-Language`. The sidecar bakes it into the voice manifest
      (`main.py:8578` qwen, `:8868` xtts); omitted, it computes
      `lang = DEFAULT_LANGUAGE`, which is why every cloned voice's manifest has
      always read "English".

      This governs the clone's OWN language — the wizard's completion audition
      and the label the Voice Library displays (`routes/voices.ts:412-421` reads
      the manifest word back through `codeForSidecarName`). It does NOT govern
      book synth: for that the BOOK's language wins and overrides this at the
      synth call (see tts/sidecar.ts `resolveWireLanguage`). The two are
      coherent, not contradictory — manifest language = the reference clip's,
      request language = the book's. */
  language?: string;
  /** #3058 — a per-REQUEST device override for this one derive call, sent as
      `X-Device-Hint`. Distinct from the engine's process-lifetime
      `COQUI_DEVICE`/`QWEN_DEVICE` pin: this lets a single derive land on a
      specific GPU (e.g. the lazy Coqui self-heal derive, which must avoid
      contending with a co-resident Qwen for the same card) without touching
      the engine's own device for its whole lifetime. Omitted for every
      caller except `clone-voice-resolver.ts`'s lazy Coqui derive — leave
      unset here to get today's behaviour unchanged. */
  deviceHint?: string;
}

export interface DeriveArtifactResult {
  previewPcm: Buffer;
  sampleRate: number;
  /** qwen only. */
  baseModel?: string;
  /** coqui only. */
  coquiVersion?: string;
  /** coqui only — the FULL resolved model string (e.g.
      "tts_models/multilingual/multi-dataset/xtts_v2"), not a short alias. */
  modelId?: string;
}

/* The sidecar's clone_voice takes `_synth_lock` and holds it across distil +
   persist + audition (tts-sidecar/main.py), so this POST can legitimately queue
   behind ANOTHER book's in-flight synth — the same property that justifies
   EVICT_DISPATCHER in synthesise-chapter.ts, and a wide Qwen batch under that
   lock can exceed 5 minutes of GPU decode. On the global fetch, undici's hidden
   300s headersTimeout killed it first, and the bare TypeError is not a
   NoCapacityError, so the catch below rethrows SidecarDesignError("… is
   unreachable — fetch failed.") and a cloned-voice self-heal aborts the
   chapter LOUDLY while both sidecar and GPU are fine.

   `opts.signal` is optional here, so simply disabling the cap would trade a
   wrong diagnosis for an unbounded hang. DERIVE_ABSOLUTE_MAX_MS is therefore
   the replacement ceiling — the caller's signal still wins when supplied.
   600_000 matches SYNTH_CALL_TIMEOUT_MS, DESIGN_ABSOLUTE_MAX_MS and
   PERSONA_ABSOLUTE_MAX_MS: the same "slow but not infinite" judgement. */
const DERIVE_DISPATCHER = new Agent({
  headersTimeout: 0,
  bodyTimeout: 0,
  connectTimeout: 10_000,
});
const DERIVE_ABSOLUTE_MAX_MS = 600_000;

export async function deriveEngineArtifact(
  voiceUuid: string,
  engine: CloneEngine,
  input: DeriveArtifactInput,
  opts: { signal?: AbortSignal; sidecarUrl?: string } = {},
): Promise<DeriveArtifactResult> {
  if (!CLONE_CAPABLE_ENGINES.has(engine)) {
    throw new SidecarDesignError(`Unsupported clone engine "${engine}".`, 400);
  }
  if (engine === 'qwen' && !input.refText) {
    throw new SidecarDesignError('`refText` is required for a Qwen clone derive.', 400);
  }

  const sidecarUrl = (opts.sidecarUrl ?? getResolvedSidecarUrl()).replace(/\/+$/, '');
  const target = `${sidecarUrl}/${manifestSlotFor(engine)}/clone-voice`;
  const headers: Record<string, string> = {
    'Content-Type': 'audio/L16',
    'X-Sample-Rate': String(input.sampleRate),
    'X-Voice-Id': cloneStorageKey(engine, voiceUuid),
  };
  if (engine === 'qwen') {
    headers['X-Ref-Text'] = Buffer.from(input.refText as string, 'utf8').toString('base64');
  }
  if (input.auditionText) {
    headers['X-Audition-Text'] = Buffer.from(input.auditionText, 'utf8').toString('base64');
  }
  /* #1951 — both engine branches: qwen reads it at main.py:8578, xtts at
     :8868. Plain ASCII language words, so no base64 wrapper (unlike the
     free-text headers above). */
  if (input.language) {
    headers['X-Language'] = input.language;
  }
  if (input.deviceHint) {
    headers['X-Device-Hint'] = input.deviceHint;
  }

  /* Bound the call even when the caller supplied no signal — see the note on
     DERIVE_DISPATCHER. */
  const budget = AbortSignal.timeout(DERIVE_ABSOLUTE_MAX_MS);
  const bounded = opts.signal ? AbortSignal.any([budget, opts.signal]) : budget;

  let upstream: Response;
  try {
    upstream = await withCapacityRetry(
      /* undici's Response is structurally identical for everything
         withCapacityRetry and the code below use; the cast keeps that shared
         helper, which other callers hand a global Response, untouched. */
      (s) =>
        undiciFetch(target, {
          method: 'POST',
          signal: s,
          headers,
          body: input.masterPcm,
          dispatcher: DERIVE_DISPATCHER,
        }) as unknown as Promise<Response>,
      { engine, signal: bounded },
    );
  } catch (e) {
    if (e instanceof NoCapacityError) {
      throw new SidecarDesignError(
        'GPU has no capacity for voice cloning right now — free VRAM and retry.',
        503,
      );
    }
    const err = e as { message?: string };
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
      const b = (await upstream.json()) as { detail?: string; error?: string; code?: string; reason?: string };
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
  const sampleRate = Number(upstream.headers.get('X-Sample-Rate') ?? String(input.sampleRate)) || input.sampleRate;
  const previewPcm = Buffer.from(await upstream.arrayBuffer());
  if (engine === 'qwen') {
    const baseModel = upstream.headers.get('X-Base-Model') ?? '';
    return { previewPcm, sampleRate, baseModel };
  }
  const coquiVersion = upstream.headers.get('X-Coqui-Version') ?? '';
  const modelId = upstream.headers.get('X-Model-Id') ?? '';
  return { previewPcm, sampleRate, coquiVersion, modelId };
}
