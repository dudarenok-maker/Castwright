/* fs-21 — GET /api/setup/readiness. The sidecar/tts blocker badges are
   derived from computeModelsStatus (models-status.ts) — the SAME
   computation GET /api/setup/models-status exposes — so the two surfaces
   can never disagree (fs-75 Part A). The ffmpeg/analyzer legs are diagnosed
   independently below; they don't share a computation with another route. */
import { Router } from 'express';
import type { Request, Response } from '../http.js';
import {
  getResolvedAnalysisEngine,
  getResolvedGeminiApiKey,
  getResolvedSetupCompletedAt,
  getResolvedOllamaModel,
  writeSetupCompletedAt,
} from '../workspace/user-settings.js';
import { selectTtsProvider } from '../tts/index.js';
import { encodePcmToAudio } from '../tts/mp3.js';
import {
  voiceSampleAudioDir,
  voiceSampleFilePath,
  voiceSamplePublicUrl,
} from '../tts/voice-sample-cache.js';
import { probeOllamaHealth } from './ollama-health.js';
import { computeModelsStatus } from './models-status.js';
import { engineUsable } from '../tts/models-status.js';
import { getActiveSupervisor } from '../tts/sidecar-supervisor.js';
import { venvCorePackageInstalled } from '../tts/venv-core-package.js';
import { probeFfmpeg } from '../diagnostics/ffmpeg.js';
import {
  diagnoseSidecar, diagnoseTts, diagnoseFfmpeg, diagnoseAnalyzer, anyAnalyzerModelPulled,
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
  status: 'pass' | 'warn' | 'fail';
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
  info: { gpu: string; vramTotalMb: number | null };
}

export function buildSetupReadiness(input: {
  sidecar: BlockerDiagnosis;
  ffmpeg: BlockerDiagnosis;
  tts: BlockerDiagnosis;
  analyzer: BlockerDiagnosis;
  gpu: string;
  vramTotalMb: number | null;
  completedAt?: string | null;
}): SetupReadiness {
  const blockers = {
    sidecar: input.sidecar, ffmpeg: input.ffmpeg, tts: input.tts, analyzer: input.analyzer,
  };
  return {
    ready: Object.values(blockers).every((b) => b.status === 'pass' || b.status === 'warn'),
    completedAt: input.completedAt ?? null,
    blockers,
    info: { gpu: input.gpu, vramTotalMb: input.vramTotalMb },
  };
}

export const setupReadinessRouter = Router();

setupReadinessRouter.post('/complete', async (_req: Request, res: Response) => {
  const ts = new Date().toISOString();
  await writeSetupCompletedAt(ts);
  res.json({ completedAt: ts });
});

setupReadinessRouter.get('/readiness', async (_req: Request, res: Response) => {
  /* Single source of truth for the sidecar/tts badges: computeModelsStatus
     makes the one probeSidecarHealth() call this route needs (plus the disk
     probes and vram total) and GET /api/setup/models-status reuses the exact
     same computation, so the two surfaces can never disagree. */
  const models = await computeModelsStatus(REPO_ROOT);
  const supervisor = getActiveSupervisor();

  const sidecar = diagnoseSidecar({
    venvPresent: models.runtime.installedOnDisk,
    pythonFound: models.runtime.pythonFound,
    corePackageInstalled: venvCorePackageInstalled(REPO_ROOT),
    supervisorActive: supervisor !== null,
    supervisorTripped: supervisor?.tripEvent() != null,
    supervisorExhausted: supervisor?.exhaustedEvent() ?? false,
    sidecarReachable: models.runtime.process === 'ready',
  });

  const VOICE_ENGINE_IDS = ['kokoro', 'qwen', 'coqui'] as const;
  const noEngineAtAll = VOICE_ENGINE_IDS.every((id) => models.engines[id].state === 'not-installed');
  const anyEngineUsable = VOICE_ENGINE_IDS.some((id) => engineUsable(models.engines[id]));
  const weightsMissingEngine =
    models.engines.kokoro.state === 'weights-missing' ? 'kokoro' :
    models.engines.qwen.state === 'weights-missing' ? 'qwen' :
    models.engines.coqui.state === 'weights-missing' ? 'coqui' : null;

  const tts = diagnoseTts(sidecar, {
    noEngineAtAll,
    anyEngineUsable,
    weightsMissingEngine,
    kokoroPackageConfirmedBroken: models.engines.kokoro.packageBroken,
    qwenPackageConfirmedBroken: models.engines.qwen.packageBroken,
  });

  const { ffmpeg: ffmpegPresent, ffprobe: ffprobePresent } = probeFfmpeg();
  const ffmpeg = diagnoseFfmpeg({ ffmpegPresent, ffprobePresent });

  const engine = getResolvedAnalysisEngine();
  const geminiKeySet = getResolvedGeminiApiKey() != null;
  /* Probe Ollama even when engine==='gemini' — the backup label needs the
     local-availability facts regardless of the active engine. Bounded by the
     2s probe budget in probeOllamaHealth(). */
  const ollama = await probeOllamaHealth();
  const analyzer = diagnoseAnalyzer({
    engine,
    ollamaReachable: ollama.status === 'reachable',
    ollamaError: ollama.error ?? null,
    modelPulled: ollama.modelPulled ?? false,
    anyAnalyzerModelPulled: anyAnalyzerModelPulled(ollama.models ?? [], ollama.pullable ?? []),
    expectedModel: ollama.expectedModel ?? getResolvedOllamaModel(),
    pullable: ollama.pullable ?? [],
    geminiKeySet,
  });

  res.json(
    buildSetupReadiness({
      sidecar, tts, ffmpeg, analyzer,
      gpu: models.info.gpu,
      vramTotalMb: models.info.vramTotalMb,
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
