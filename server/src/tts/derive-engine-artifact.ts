/* fs-38 Wave 3b1 — Node → sidecar clone-artifact primitive.

   Mirrors design-voice-core's postDesignAndCacheAudition transport (capacity
   retry + SidecarDesignError propagation) but for the clip-distil endpoint:
   POSTs the caller's normalized master PCM + the X-* headers to
   /qwen/clone-voice and returns the audition preview PCM. Unlike the design
   core, it does NOT write the audition cache — the /clone route owns preview
   persistence. The `engine` param is 'qwen' only in 3b1; 3c adds the xtts
   branch here (a clean seam). */

import { withCapacityRetry } from '../gpu/capacity-retry.js';
import { NoCapacityError } from './tts-errors.js';
import { SidecarDesignError } from './design-voice-core.js';
import { getResolvedSidecarUrl } from '../workspace/user-settings.js';

export interface DeriveArtifactInput {
  masterPcm: Buffer;
  sampleRate: number;
  refText: string;
  auditionText?: string;
}

export interface DeriveArtifactResult {
  previewPcm: Buffer;
  sampleRate: number;
  baseModel: string;
}

export async function deriveEngineArtifact(
  voiceUuid: string,
  engine: 'qwen',
  input: DeriveArtifactInput,
  opts: { signal?: AbortSignal; sidecarUrl?: string } = {},
): Promise<DeriveArtifactResult> {
  if (engine !== 'qwen') {
    // 3c wires the xtts/coqui branch here; 3b1 is Qwen-only.
    throw new SidecarDesignError(`Unsupported clone engine "${engine}".`, 400);
  }
  const sidecarUrl = (opts.sidecarUrl ?? getResolvedSidecarUrl()).replace(/\/+$/, '');
  const target = `${sidecarUrl}/qwen/clone-voice`;
  const headers: Record<string, string> = {
    'Content-Type': 'audio/L16',
    'X-Sample-Rate': String(input.sampleRate),
    'X-Voice-Id': `qwen-${voiceUuid}`,
    'X-Ref-Text': Buffer.from(input.refText, 'utf8').toString('base64'),
  };
  if (input.auditionText) {
    headers['X-Audition-Text'] = Buffer.from(input.auditionText, 'utf8').toString('base64');
  }

  let upstream: Awaited<ReturnType<typeof fetch>>;
  try {
    upstream = await withCapacityRetry(
      (s) => fetch(target, { method: 'POST', signal: s ?? opts.signal, headers, body: input.masterPcm }),
      { engine: 'qwen', signal: opts.signal },
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
  const baseModel = upstream.headers.get('X-Base-Model') ?? '';
  const previewPcm = Buffer.from(await upstream.arrayBuffer());
  return { previewPcm, sampleRate, baseModel };
}
