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
  writeSetupCompletedAt,
} from '../workspace/user-settings.js';
import { sidecarVenvPresent } from '../diagnostics/venv.js';
import { anyTtsEnginePresent } from '../tts/engine-presence.js';
import { selectTtsProvider } from '../tts/index.js';
import { encodePcmToAudio } from '../tts/mp3.js';
import {
  voiceSampleAudioDir,
  voiceSampleFilePath,
  voiceSamplePublicUrl,
} from '../tts/voice-sample-cache.js';
import { probeOllamaHealth } from './ollama-health.js';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

/* Repo root computed locally, exactly as models-inventory.ts does (this file
   is also under server/src/routes/, so '..','..','..' lands on the repo root).
   workspace/paths.ts exports WORKSPACE_ROOT, NOT a repo root — don't import. */
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

export type BlockerStatus = 'pass' | 'fail';

export interface SetupReadiness {
  ready: boolean;
  completedAt: string | null;
  blockers: { sidecar: BlockerStatus; ffmpeg: BlockerStatus; tts: BlockerStatus; analyzer: BlockerStatus };
  info: { gpu: string };
}

function checkOk(d: DiagnosticsResponse, id: CheckId): boolean {
  return d.checks.find((c) => c.id === id)?.status === 'ok';
}
function detail(d: DiagnosticsResponse, id: CheckId): string {
  return d.checks.find((c) => c.id === id)?.detail ?? '';
}

export function buildSetupReadiness(input: {
  diagnostics: DiagnosticsResponse;
  engine: 'local' | 'gemini';
  venvPresent: boolean;
  ttsEnginePresent: boolean;
  completedAt?: string | null;
}): SetupReadiness {
  const { diagnostics: d, engine, venvPresent, ttsEnginePresent } = input;
  const blockers = {
    sidecar: (checkOk(d, 'sidecar') && venvPresent ? 'pass' : 'fail') as BlockerStatus,
    ffmpeg: (checkOk(d, 'ffmpeg') ? 'pass' : 'fail') as BlockerStatus,
    tts: (ttsEnginePresent ? 'pass' : 'fail') as BlockerStatus,
    analyzer: (checkOk(d, engine === 'gemini' ? 'gemini' : 'analyzer') ? 'pass' : 'fail') as BlockerStatus,
  };
  return {
    ready: Object.values(blockers).every((b) => b === 'pass'),
    completedAt: input.completedAt ?? null,
    blockers,
    info: { gpu: detail(d, 'gpu') },
  };
}

export const setupReadinessRouter = Router();

setupReadinessRouter.post('/complete', async (_req: Request, res: Response) => {
  const ts = new Date().toISOString();
  await writeSetupCompletedAt(ts);
  res.json({ completedAt: ts });
});

setupReadinessRouter.get('/readiness', async (_req: Request, res: Response) => {
  const diagnostics = await buildDiagnostics();
  res.json(
    buildSetupReadiness({
      diagnostics,
      engine: getResolvedAnalysisEngine(),
      venvPresent: sidecarVenvPresent(REPO_ROOT),
      ttsEnginePresent: anyTtsEnginePresent(REPO_ROOT),
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
