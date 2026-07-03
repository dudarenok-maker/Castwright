/* fs-21 — GET /api/setup/readiness. A THIN MAPPER over diagnostics.ts (it
   must not re-implement the aggregator), adding the two probes diagnostics
   lacks: venv-on-disk and per-engine TTS weights. Drives the adaptive gate. */
import { Router } from 'express';
import type { Request, Response } from '../http.js';
import { buildDiagnostics, type CheckId, type DiagnosticsResponse } from './diagnostics.js';
import {
  getResolvedAnalysisEngine,
  getResolvedGeminiApiKey,
  getResolvedSetupCompletedAt,
  getResolvedOllamaModel,
  writeSetupCompletedAt,
} from '../workspace/user-settings.js';
import { sidecarVenvPresent } from '../diagnostics/venv.js';
import { selectTtsProvider } from '../tts/index.js';
import { encodePcmToAudio } from '../tts/mp3.js';
import {
  voiceSampleAudioDir,
  voiceSampleFilePath,
  voiceSamplePublicUrl,
} from '../tts/voice-sample-cache.js';
import { probeOllamaHealth } from './ollama-health.js';
import { probeSidecarHealth } from './sidecar-health.js';
import { getActiveSupervisor } from '../tts/sidecar-supervisor.js';
import { venvCorePackageInstalled } from '../tts/venv-core-package.js';
import { detectKokoroInstallStateOnDisk } from '../tts/kokoro-install-detect.js';
import { detectQwenInstallStateOnDisk } from '../tts/qwen-install-detect.js';
import { detectCoquiInstallStateOnDisk } from '../tts/coqui-install-detect.js';
import { probeFfmpeg } from '../diagnostics/ffmpeg.js';
import {
  diagnoseSidecar, diagnoseTts, diagnoseFfmpeg, diagnoseAnalyzer, probePython312Cached,
} from './setup-diagnosis.js';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

/* Repo root computed locally, exactly as models-inventory.ts does (this file
   is also under server/src/routes/, so '..','..','..' lands on the repo root).
   workspace/paths.ts exports WORKSPACE_ROOT, NOT a repo root — don't import. */
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

export type BlockerCause =
  // sidecar
  | 'python-missing' | 'venv-missing' | 'venv-broken' | 'supervisor-exhausted'
  | 'supervisor-tripped' | 'unreachable-transient' | 'unreachable-no-supervisor'
  // tts
  | 'sidecar-blocked' | 'no-engine-installed' | 'weights-missing'
  | 'cannot-confirm-engine' | 'package-broken'
  // ffmpeg
  | 'ffmpeg-missing' | 'ffprobe-missing' | 'both-missing'
  // analyzer
  | 'ollama-unreachable' | 'model-not-pulled' | 'no-gemini-key'
  // shared terminal
  | 'pass';

export type BlockerActionKind =
  | 'venv-bootstrap' | 'qwen-install' | 'kokoro-install' | 'coqui-install'
  | 'sidecar-restart' | 'ollama-install' | 'ollama-pull' | 'navigate';

export interface BlockerAction {
  kind: BlockerActionKind;
  label: string;
  /** Extra data an action needs beyond its kind, e.g. { model: 'qwen3.5:9b' } for ollama-pull. */
  params?: Record<string, string>;
  /** For 'navigate' only — an in-app hash route (e.g. '#/models'). */
  href?: string;
}

export interface BlockerDiagnosis {
  status: 'pass' | 'fail';
  cause: BlockerCause;
  message: string;
  remediation: string;
  /** Present when a safe automated fix exists; absent for text-only guidance. */
  action?: BlockerAction;
}

export interface SetupReadiness {
  ready: boolean;
  completedAt: string | null;
  blockers: { sidecar: BlockerDiagnosis; ffmpeg: BlockerDiagnosis; tts: BlockerDiagnosis; analyzer: BlockerDiagnosis };
  info: { gpu: string };
}

function checkOk(d: DiagnosticsResponse, id: CheckId): boolean {
  return d.checks.find((c) => c.id === id)?.status === 'ok';
}
function detail(d: DiagnosticsResponse, id: CheckId): string {
  return d.checks.find((c) => c.id === id)?.detail ?? '';
}

export function buildSetupReadiness(input: {
  sidecar: BlockerDiagnosis;
  ffmpeg: BlockerDiagnosis;
  tts: BlockerDiagnosis;
  analyzer: BlockerDiagnosis;
  gpu: string;
  completedAt?: string | null;
}): SetupReadiness {
  const blockers = {
    sidecar: input.sidecar, ffmpeg: input.ffmpeg, tts: input.tts, analyzer: input.analyzer,
  };
  return {
    ready: Object.values(blockers).every((b) => b.status === 'pass'),
    completedAt: input.completedAt ?? null,
    blockers,
    info: { gpu: input.gpu },
  };
}

export const setupReadinessRouter = Router();

setupReadinessRouter.post('/complete', async (_req: Request, res: Response) => {
  const ts = new Date().toISOString();
  await writeSetupCompletedAt(ts);
  res.json({ completedAt: ts });
});

/* DiagnosticsResponse only exposes each check's `detail` string, not the raw
   kokoroPackageInstalled/qwenPackageInstalled booleans diagnostics.ts's own
   'sidecar' check reads internally. This makes exactly one additional
   probeSidecarHealth() call (on top of the one already inside
   buildDiagnostics(), which computes info.gpu and the sidecar/ffmpeg
   DiagnosticsCheck rows — two total network calls per /readiness request,
   not three; the spec's Design §4 polling-cost note scopes "the one /health
   fetch" as the accepted cost, so don't call this a second time anywhere
   else). */
async function packageBrokenFlags(
  d: DiagnosticsResponse,
): Promise<{ kokoroPackageConfirmedBroken: boolean; qwenPackageConfirmedBroken: boolean }> {
  if (!checkOk(d, 'sidecar')) return { kokoroPackageConfirmedBroken: false, qwenPackageConfirmedBroken: false };
  const h = await probeSidecarHealth();
  if (h.status !== 'reachable') return { kokoroPackageConfirmedBroken: false, qwenPackageConfirmedBroken: false };
  return {
    kokoroPackageConfirmedBroken: h.kokoroPackageInstalled === false,
    qwenPackageConfirmedBroken: h.qwenPackageInstalled === false,
  };
}

setupReadinessRouter.get('/readiness', async (_req: Request, res: Response) => {
  const diagnostics = await buildDiagnostics();
  const venvPresent = sidecarVenvPresent(REPO_ROOT);
  const pythonFound = venvPresent ? true : probePython312Cached();
  const corePackageInstalled = venvPresent ? venvCorePackageInstalled(REPO_ROOT) : false;
  const supervisor = getActiveSupervisor();

  const sidecar = diagnoseSidecar({
    venvPresent,
    pythonFound,
    corePackageInstalled,
    supervisorActive: supervisor !== null,
    supervisorTripped: supervisor?.tripEvent() != null,
    supervisorExhausted: supervisor?.exhaustedEvent() ?? false,
    sidecarReachable: checkOk(diagnostics, 'sidecar'),
  });

  const kokoroState = detectKokoroInstallStateOnDisk(REPO_ROOT);
  const qwenState = detectQwenInstallStateOnDisk(REPO_ROOT);
  const coquiState = detectCoquiInstallStateOnDisk(REPO_ROOT);
  const noEngineAtAll = [kokoroState, qwenState, coquiState].every((s) => s === 'not-installed');
  const weightsMissingEngine =
    kokoroState === 'weights-missing' ? 'kokoro' :
    qwenState === 'weights-missing' ? 'qwen' :
    coquiState === 'weights-missing' ? 'coqui' : null;
  const packageFlags = await packageBrokenFlags(diagnostics);
  /* "Usable" = ready on disk AND not live-confirmed-broken. Coqui has no
     live package-broken signal (coqui-tts is a BASE sidecar requirement
     present whenever the venv is bootstrapped — see coqui-install-detect.ts
     — so its readiness on disk is the whole story). Computed AFTER
     packageFlags, not alongside the plain disk-readiness check, precisely
     because a disk-only "any engine ready" signal is what let a live-broken
     engine still fail the whole blocker in round-3 plan review finding 1. */
  const anyEngineUsable =
    (kokoroState === 'ready' && !packageFlags.kokoroPackageConfirmedBroken) ||
    (qwenState === 'ready' && !packageFlags.qwenPackageConfirmedBroken) ||
    coquiState === 'ready';

  const tts = diagnoseTts(sidecar, {
    noEngineAtAll,
    anyEngineUsable,
    weightsMissingEngine,
    ...packageFlags,
  });

  const { ffmpeg: ffmpegPresent, ffprobe: ffprobePresent } = probeFfmpeg();
  const ffmpeg = diagnoseFfmpeg({ ffmpegPresent, ffprobePresent });

  const engine = getResolvedAnalysisEngine();
  let analyzer: BlockerDiagnosis;
  if (engine === 'gemini') {
    analyzer = diagnoseAnalyzer({
      engine: 'gemini', ollamaReachable: true, ollamaError: null, modelPulled: true,
      expectedModel: '', pullable: [], geminiKeySet: getResolvedGeminiApiKey() != null,
    });
  } else {
    const ollama = await probeOllamaHealth();
    analyzer = diagnoseAnalyzer({
      engine: 'local',
      ollamaReachable: ollama.status === 'reachable',
      ollamaError: ollama.error ?? null,
      modelPulled: ollama.modelPulled ?? false,
      expectedModel: getResolvedOllamaModel(),
      pullable: ollama.pullable ?? [],
      geminiKeySet: false,
    });
  }

  res.json(
    buildSetupReadiness({
      sidecar, tts, ffmpeg, analyzer,
      gpu: detail(diagnostics, 'gpu'),
      completedAt: getResolvedSetupCompletedAt(),
    }),
  );
});

/* POST /api/setup/smoke — Tier-1 light smoke test (fs-21 wave 3).
   Synthesises a fixed sentence via Kokoro (the always-present fallback),
   encodes to MP3, writes to the voice-sample cache dir, and pings the
   analyzer. Returns ok:false (never 500) on sidecar/ffmpeg failure so the
   setup UI can surface a user-readable diagnosis rather than an error page. */
setupReadinessRouter.post('/smoke', async (_req: Request, res: Response) => {
  const modelKey = 'kokoro-v1';
  const voiceName = 'af_heart';
  const text = 'The lighthouse keeper watched the grey sea roll in.';

  let url: string | undefined;
  let durationSec: number | undefined;
  try {
    const provider = selectTtsProvider(modelKey);
    const { pcm, sampleRate } = await provider.synthesize({ text, voiceName, modelKey });
    const mp3 = await encodePcmToAudio(pcm, sampleRate);
    await mkdir(voiceSampleAudioDir(), { recursive: true });
    await writeFile(voiceSampleFilePath('setup-smoke.mp3'), mp3);
    url = voiceSamplePublicUrl('setup-smoke.mp3');
    durationSec = pcm.length / 2 / sampleRate; // 16-bit mono
  } catch (e) {
    return res.json({ ok: false, stage: 'synth', error: (e as Error).message });
  }

  let analyzerOk = false;
  let analyzerDetail = '';
  try {
    if (getResolvedAnalysisEngine() === 'gemini') {
      analyzerOk = getResolvedGeminiApiKey() != null;
      analyzerDetail = analyzerOk ? 'API key set' : 'no key';
    } else {
      const o = await probeOllamaHealth();
      analyzerOk = o.status === 'reachable';
      analyzerDetail = o.error ?? (o.modelPulled ? 'model pulled' : 'reachable');
    }
  } catch (e) {
    analyzerDetail = (e as Error).message;
  }

  res.json({ ok: true, url, durationSec, analyzerOk, analyzerDetail });
});
