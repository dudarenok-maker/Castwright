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

export interface DeriveArtifactInput {
  masterPcm: Buffer;
  sampleRate: number;
  /** Required for a qwen derive (its clone prompt needs a transcript);
      unused for a coqui derive (XTTS's conditioning-latents extraction is
      purely acoustic). Validated inside the qwen branch only, at call time —
      see below. */
  refText?: string;
  auditionText?: string;
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

  let upstream: Awaited<ReturnType<typeof fetch>>;
  try {
    upstream = await withCapacityRetry(
      (s) => fetch(target, { method: 'POST', signal: s ?? opts.signal, headers, body: input.masterPcm }),
      { engine, signal: opts.signal },
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
