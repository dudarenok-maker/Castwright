/* fs-18 — GET /api/diagnostics. One aggregator that fans out to every health
   probe the operator runs by hand today (sidecar reachability + resident
   models + VRAM, analyzer connectivity, ffmpeg/ffprobe, free disk) and returns
   a single green/amber/red board. Powers the all-users Admin watch console
   (src/views/admin.tsx) + the top-bar status dot.

   Reuses the in-process probe helpers extracted from the dedicated health
   routes (no HTTP self-calls): probeSidecarHealth / probeOllamaHealth /
   readGpuQueueState, plus the two net-new probes (ffmpeg, disk). Each check
   runs under its own try/catch so one slow or throwing probe degrades to a
   single `fail` row rather than 500ing the whole board. */

import { Router } from 'express';
import type { Request, Response } from '../http.js';
import { probeSidecarHealth } from './sidecar-health.js';
import { probeOllamaHealth } from './ollama-health.js';
import { readGpuQueueState } from './gpu-queue.js';
import { probeFfmpeg } from '../diagnostics/ffmpeg.js';
import { probeDiskSpace, DISK_WARN_GB, DISK_FAIL_GB } from '../diagnostics/disk.js';
import {
  getResolvedAnalysisEngine,
  getResolvedGeminiApiKey,
} from '../workspace/user-settings.js';
import { WORKSPACE_ROOT } from '../workspace/paths.js';
import { readinessSeverity } from '../tts/engine-presence.js';
import type { EngineId } from '../tts/engine-health.js';

export type CheckStatus = 'ok' | 'warn' | 'fail';
export type CheckId = 'gpu' | 'sidecar' | 'asr' | 'analyzer' | 'gemini' | 'ffmpeg' | 'disk';

export interface DiagnosticsCheck {
  id: CheckId;
  label: string;
  status: CheckStatus;
  /* Human-readable technical line, e.g. "cuda · 1.2 / 8.0 GB reserved". */
  detail: string;
  /* Optional machine value the UI can render compactly (GB free, etc.). */
  value?: string | number | null;
}

export interface DiagnosticsResponse {
  ts: string;
  overall: CheckStatus;
  checks: DiagnosticsCheck[];
}

export const diagnosticsRouter = Router();

const RANK: Record<CheckStatus, number> = { ok: 0, warn: 1, fail: 2 };

function worst(checks: DiagnosticsCheck[]): CheckStatus {
  return checks.reduce<CheckStatus>(
    (acc, c) => (RANK[c.status] > RANK[acc] ? c.status : acc),
    'ok',
  );
}

/* Run a single check body, collapsing any throw to a fail row so the board
   always returns 200 with a complete check list. */
async function runCheck(
  id: CheckId,
  label: string,
  body: () => Promise<DiagnosticsCheck> | DiagnosticsCheck,
): Promise<DiagnosticsCheck> {
  try {
    return await body();
  } catch (e) {
    return { id, label, status: 'fail', detail: (e as Error).message || 'probe failed' };
  }
}

function fmtGb(mb: number | null | undefined): string {
  return mb == null ? '?' : (mb / 1024).toFixed(1);
}

export async function buildDiagnostics(): Promise<DiagnosticsResponse> {
  /* Probe the sidecar once and reuse it for both the sidecar row AND the GPU
     row — the sidecar /health is where VRAM figures come from. */
  const sidecar = await probeSidecarHealth().catch(
    (e: Error) => ({ status: 'unreachable' as const, url: '', proxy: 'sidecar' as const, error: e.message }),
  );
  const engine = getResolvedAnalysisEngine();

  const checks = await Promise.all([
    // GPU / VRAM headroom — derived from the sidecar's torch CUDA figures.
    runCheck('gpu', 'GPU / VRAM', () => {
      if (sidecar.status !== 'reachable') {
        return {
          id: 'gpu',
          label: 'GPU / VRAM',
          status: 'fail',
          detail: 'sidecar unreachable — cannot read VRAM',
        };
      }
      const device = sidecar.device ?? null;
      const reserved = sidecar.vramReservedMb;
      const total = sidecar.vramTotalMb;
      /* CUDA presence is engine-independent: the sidecar reports vramTotalMb iff
         torch.cuda.is_available() (see _cuda_vram_mb). Don't key off the `device`
         field alone — it only reflects the Coqui engine and only when Coqui is
         loaded, so a Qwen-only run (Coqui idle) reports device=null while the GPU
         is plainly in use. */
      const cudaPresent = device === 'cuda' || total != null;
      if (!cudaPresent) {
        return {
          id: 'gpu',
          label: 'GPU / VRAM',
          status: 'ok',
          detail: device ? `device: ${device}` : 'CPU — no GPU detected',
        };
      }
      const queue = readGpuQueueState();
      const ratio = reserved != null && total != null && total > 0 ? reserved / total : null;
      const status: CheckStatus = ratio != null && ratio > 0.85 ? 'warn' : 'ok';
      const detail =
        `cuda · ${fmtGb(reserved)} / ${fmtGb(total)} GB reserved` +
        (queue.inFlight > 0 ? ` · ${queue.inFlight} in-flight` : '');
      return {
        id: 'gpu',
        label: 'GPU / VRAM',
        status,
        detail,
        value: total != null ? `${fmtGb(reserved)}/${fmtGb(total)} GB` : null,
      };
    }),

    // Voice engine (TTS sidecar) reachability + resident models.
    runCheck('sidecar', 'Voice engine', () => {
      if (sidecar.status !== 'reachable') {
        return {
          id: 'sidecar',
          label: 'Voice engine',
          status: 'fail',
          detail: sidecar.error || 'unreachable',
        };
      }
      const resident: string[] = [];
      if (sidecar.modelLoaded) resident.push('coqui');
      if (sidecar.kokoroLoaded) resident.push('kokoro');
      if (sidecar.qwenLoaded) resident.push('qwen');

      // Check standard TTS engines for sidecar-confirmed package-missing state.
      const STANDARD_TTS: { engine: EngineId; pkg: boolean | undefined; name: string }[] = [
        { engine: 'kokoro', pkg: sidecar.kokoroPackageInstalled, name: 'Kokoro' },
        { engine: 'qwen', pkg: sidecar.qwenPackageInstalled, name: 'Qwen' },
      ];
      const broken = STANDARD_TTS.filter((e) => e.pkg === false);
      if (broken.length > 0) {
        const sev: CheckStatus = broken
          .map((e) =>
            readinessSeverity({ engine: e.engine, state: 'package-missing', sidecarConfirmed: true }),
          )
          .includes('block')
          ? 'fail'
          : 'warn';
        return {
          id: 'sidecar',
          label: 'Voice engine',
          status: sev,
          detail: `reachable · ${broken.map((e) => e.name).join(', ')} package not importable — repair in Model Manager`,
          value: resident.join(', ') || null,
        };
      }

      return {
        id: 'sidecar',
        label: 'Voice engine',
        status: 'ok',
        detail: resident.length ? `reachable · ${resident.join(', ')}` : 'reachable · no model resident',
        value: resident.join(', ') || null,
      };
    }),

    // ASR (Whisper) content-QA engine (srv-31). Display-only — it loads lazily
    // on /transcribe and idle-evicts, so there's no Load/Stop here. OFF unless
    // SEG_ASR_ENABLED, in which case we surface whether it's resident + device.
    // Never a `fail` row: an idle (not-yet-loaded) ASR is the normal state.
    runCheck('asr', 'ASR (Whisper)', () => {
      if (sidecar.status !== 'reachable') {
        return {
          id: 'asr',
          label: 'ASR (Whisper)',
          status: 'fail',
          detail: 'voice engine unreachable — cannot read ASR state',
        };
      }
      if (!sidecar.asrEnabled) {
        return {
          id: 'asr',
          label: 'ASR (Whisper)',
          status: 'ok',
          detail: 'off — content-QA disabled',
        };
      }
      const device = sidecar.asrDevice ?? 'cpu';
      return {
        id: 'asr',
        label: 'ASR (Whisper)',
        status: 'ok',
        detail: sidecar.asrLoaded
          ? `enabled · resident · ${device}`
          : `enabled · idle · ${device}`,
        value: sidecar.asrLoaded ? device : null,
      };
    }),

    // Analyzer (Ollama) connectivity — only meaningful when the local engine
    // is selected; with Gemini it's not in use and never a failure.
    runCheck('analyzer', 'Analyzer (Ollama)', async () => {
      if (engine !== 'local') {
        return {
          id: 'analyzer',
          label: 'Analyzer (Ollama)',
          status: 'ok',
          detail: `not in use (engine: ${engine})`,
        };
      }
      const ollama = await probeOllamaHealth();
      if (ollama.status !== 'reachable') {
        return {
          id: 'analyzer',
          label: 'Analyzer (Ollama)',
          status: 'fail',
          detail: ollama.error || 'unreachable',
        };
      }
      if (!ollama.modelPulled) {
        return {
          id: 'analyzer',
          label: 'Analyzer (Ollama)',
          status: 'warn',
          detail: `reachable · model "${ollama.expectedModel}" not pulled`,
        };
      }
      return {
        id: 'analyzer',
        label: 'Analyzer (Ollama)',
        status: 'ok',
        detail: ollama.modelResident
          ? `reachable · ${ollama.expectedModel} resident`
          : `reachable · ${ollama.expectedModel} pulled`,
        value: ollama.expectedModel ?? null,
      };
    }),

    // Gemini config presence (no live call) — only fails when Gemini is the
    // selected engine but no key is configured.
    runCheck('gemini', 'Analyzer (Gemini)', () => {
      const hasKey = getResolvedGeminiApiKey() != null;
      if (engine !== 'gemini') {
        return {
          id: 'gemini',
          label: 'Analyzer (Gemini)',
          status: 'ok',
          detail: hasKey ? 'not in use · API key configured' : 'not in use',
        };
      }
      return hasKey
        ? { id: 'gemini', label: 'Analyzer (Gemini)', status: 'ok', detail: 'API key configured' }
        : {
            id: 'gemini',
            label: 'Analyzer (Gemini)',
            status: 'fail',
            detail: 'GEMINI_API_KEY not set',
          };
    }),

    // ffmpeg + ffprobe presence on PATH.
    runCheck('ffmpeg', 'ffmpeg / ffprobe', () => {
      const { ffmpeg, ffprobe } = probeFfmpeg();
      if (ffmpeg && ffprobe) {
        return { id: 'ffmpeg', label: 'ffmpeg / ffprobe', status: 'ok', detail: 'both present' };
      }
      const missing = [!ffmpeg && 'ffmpeg', !ffprobe && 'ffprobe'].filter(Boolean).join(' + ');
      return {
        id: 'ffmpeg',
        label: 'ffmpeg / ffprobe',
        status: 'fail',
        detail: `${missing} not found on PATH`,
      };
    }),

    // Free disk on the workspace volume.
    runCheck('disk', 'Free disk', async () => {
      const probe = await probeDiskSpace(WORKSPACE_ROOT);
      const detail =
        probe.status === 'fail'
          ? `${probe.freeGb} GB free — below ${DISK_FAIL_GB} GB`
          : probe.status === 'warn'
            ? `${probe.freeGb} GB free — below ${DISK_WARN_GB} GB`
            : `${probe.freeGb} GB free`;
      return { id: 'disk', label: 'Free disk', status: probe.status, detail, value: probe.freeGb };
    }),
  ]);

  return {
    ts: new Date().toISOString(),
    overall: worst(checks),
    checks,
  };
}

diagnosticsRouter.get('/', async (_req: Request, res: Response) => {
  res.json(await buildDiagnostics());
});
