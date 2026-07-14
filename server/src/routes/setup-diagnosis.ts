/* fs-21 wave 4 — pure decision functions for the Setup checker / Status
   popover's layered blocker diagnosis. Mirrors buildSetupReadiness's own
   pure, mock-free style (setup-readiness.test.ts): every diagnose* function
   here takes already-probed plain data and returns a BlockerDiagnosis — all
   I/O (fs, spawnSync, network) happens once in the setup-readiness.ts route
   handler and is threaded in. diagnoseSidecar() must run before
   diagnoseTts(), whose result it feeds (spec Design §1). */
import { findPython312 } from '../tts/python-discovery.js';
import type { BlockerDiagnosis, BlockerCause } from './setup-readiness.js';

const PYTHON_PROBE_TTL_MS = 10_000;
let pythonProbeCache: { found: boolean; expiresAt: number } | null = null;

/** True if a Python 3.12 interpreter is found — TTL-cached (10s) so a
    stuck-venv incident's repeated polls don't repeatedly spawn interpreter
    probes. Only call this when `!sidecarVenvPresent()` — a healthy system
    should never pay this subprocess cost. */
export function probePython312Cached(nowFn: () => number = Date.now): boolean {
  const now = nowFn();
  if (pythonProbeCache && pythonProbeCache.expiresAt > now) return pythonProbeCache.found;
  const found = findPython312() !== null;
  pythonProbeCache = { found, expiresAt: now + PYTHON_PROBE_TTL_MS };
  return found;
}

export function _resetPythonProbeCacheForTests(): void {
  pythonProbeCache = null;
}

export interface SidecarDiagnosisInput {
  venvPresent: boolean;
  /** Only meaningful when !venvPresent — pass probePython312Cached()'s result. */
  pythonFound: boolean;
  corePackageInstalled: boolean;
  /** getActiveSupervisor() !== null */
  supervisorActive: boolean;
  supervisorTripped: boolean;
  supervisorExhausted: boolean;
  /** The existing diagnostics 'sidecar' check reporting reachable. */
  sidecarReachable: boolean;
}

function diagnosis(
  status: 'pass' | 'warn' | 'fail',
  cause: BlockerCause,
  message: string,
  remediation: string,
  action?: BlockerDiagnosis['action'],
): BlockerDiagnosis {
  return { status, cause, message, remediation, action };
}

export function diagnoseSidecar(input: SidecarDiagnosisInput): BlockerDiagnosis {
  if (!input.venvPresent) {
    if (!input.pythonFound) {
      return diagnosis(
        'fail',
        'python-missing',
        'No Python 3.12 interpreter was found — the voice engine runtime cannot be built.',
        'Run node server/tts-sidecar/scripts/ensure-python312.mjs, or install Python 3.12 from python.org.',
      );
    }
    return diagnosis(
      'fail',
      'venv-missing',
      'Voice engine runtime not set up.',
      'Set up the voice engine runtime — this is a one-time, ~2 GB download.',
      { kind: 'venv-bootstrap', label: 'Set up the voice engine runtime' },
    );
  }
  if (!input.corePackageInstalled) {
    return diagnosis(
      'fail',
      'venv-broken',
      'The voice engine runtime looks incomplete — a previous setup may have been interrupted.',
      'Re-run the voice engine runtime setup. If it reports the runtime was built for a different profile, delete server/tts-sidecar/.venv and re-run setup.',
      { kind: 'venv-bootstrap', label: 'Rebuild the voice engine runtime' },
    );
  }
  if (input.supervisorExhausted) {
    return diagnosis(
      'fail',
      'supervisor-exhausted',
      'The voice engine crashed repeatedly and stopped trying to restart.',
      'Reset and restart the voice engine.',
      { kind: 'sidecar-restart', label: 'Reset & restart voice engine' },
    );
  }
  if (input.supervisorTripped) {
    return diagnosis(
      'fail',
      'supervisor-tripped',
      'The voice engine is held down after repeated crash-loop exits (code-43 streak).',
      'Restarting the voice engine alone cannot recover this — the device assignment ' +
        'needs fixing, then the server itself needs restarting.',
    );
  }
  if (!input.sidecarReachable) {
    if (!input.supervisorActive) {
      return diagnosis(
        'fail',
        'unreachable-no-supervisor',
        'The voice engine is not running, and auto-start is off, so nothing will start it.',
        'Enable auto-start for the voice engine in Model Manager, or start it manually.',
        { kind: 'navigate', label: 'Open Model Manager', href: '#/models' },
      );
    }
    return diagnosis(
      'fail',
      'unreachable-transient',
      'The voice engine is starting up.',
      'This usually resolves within a few seconds.',
    );
  }
  return diagnosis('pass', 'pass', 'Voice engine ready.', '');
}

export interface TtsDiagnosisInput {
  /** True only when kokoro/coqui/qwen all report 'not-installed' on disk. */
  noEngineAtAll: boolean;
  /** True when at least one engine is BOTH 'ready' on disk AND not live-
      confirmed-broken — i.e. an engine a book could actually render with
      right now. Deliberately richer than a plain disk-readiness check
      (round-3 plan review finding 1): gating `weights-missing` alone on
      disk-readiness (an earlier draft) still let a *live-broken* engine's
      package-broken verdict fail the whole blocker even when a DIFFERENT
      engine was fully usable — the same "usable engine, reported not-ready"
      reversal the disk-only check was created to prevent (round-2 finding
      A2), reproduced one layer down. Both `weights-missing` and
      `package-broken` below gate on this single combined signal instead of
      two different ones, so there's one definition of "is anything actually
      usable," not two that can disagree. */
  anyEngineUsable: boolean;
  /** First engine reporting 'weights-missing' on disk, or null. Only acted
      on when anyEngineUsable is false — see above. */
  weightsMissingEngine: 'kokoro' | 'qwen' | 'coqui' | null;
  /** From the sidecar's live /health payload — only meaningful once sidecar is reachable. */
  kokoroPackageConfirmedBroken: boolean;
  qwenPackageConfirmedBroken: boolean;
}

const ENGINE_INSTALL_ACTION: Record<'kokoro' | 'qwen' | 'coqui', BlockerDiagnosis['action']> = {
  kokoro: { kind: 'kokoro-install', label: 'Install Kokoro' },
  qwen: { kind: 'qwen-install', label: 'Install Qwen3-TTS' },
  coqui: { kind: 'coqui-install', label: 'Install Coqui XTTS v2' },
};

export function diagnoseTts(sidecar: BlockerDiagnosis, input: TtsDiagnosisInput): BlockerDiagnosis {
  if (sidecar.status === 'fail' && sidecar.cause !== 'unreachable-transient') {
    return diagnosis(
      'fail',
      'sidecar-blocked',
      'The voice engine needs to be fixed before a voice can be confirmed.',
      'Fix the voice engine above first.',
    );
  }
  if (input.noEngineAtAll) {
    return diagnosis(
      'fail',
      'no-engine-installed',
      'No voice engine is installed.',
      'Install Kokoro — the always-available default voice engine.',
      ENGINE_INSTALL_ACTION.kokoro,
    );
  }
  if (!input.anyEngineUsable && input.weightsMissingEngine) {
    return diagnosis(
      'fail',
      'weights-missing',
      `${input.weightsMissingEngine} is installed but its voice weights have not been downloaded.`,
      `Download ${input.weightsMissingEngine}'s voice weights.`,
      ENGINE_INSTALL_ACTION[input.weightsMissingEngine],
    );
  }
  if (sidecar.status !== 'pass') {
    return diagnosis(
      'fail',
      'cannot-confirm-engine',
      'Waiting for the voice engine to respond to confirm this.',
      'Try again shortly.',
    );
  }
  if (!input.anyEngineUsable && (input.kokoroPackageConfirmedBroken || input.qwenPackageConfirmedBroken)) {
    return diagnosis(
      'fail',
      'package-broken',
      'A voice engine package is not importable in the voice engine runtime.',
      'Repair in Model Manager.',
    );
  }
  return diagnosis('pass', 'pass', 'A voice engine is ready.', '');
}

export interface FfmpegDiagnosisInput {
  ffmpegPresent: boolean;
  ffprobePresent: boolean;
}

export function diagnoseFfmpeg(input: FfmpegDiagnosisInput): BlockerDiagnosis {
  if (!input.ffmpegPresent && !input.ffprobePresent) {
    return diagnosis(
      'fail', 'both-missing',
      'ffmpeg and ffprobe are not on PATH.',
      'Install ffmpeg (which bundles ffprobe) for your OS, then click Recheck.',
    );
  }
  if (!input.ffmpegPresent) {
    return diagnosis('fail', 'ffmpeg-missing', 'ffmpeg is not on PATH.', 'Install ffmpeg for your OS, then click Recheck.');
  }
  if (!input.ffprobePresent) {
    return diagnosis('fail', 'ffprobe-missing', 'ffprobe is not on PATH.', 'Install ffmpeg (which bundles ffprobe) for your OS, then click Recheck.');
  }
  return diagnosis('pass', 'pass', 'ffmpeg and ffprobe are both installed.', '');
}

/** True when at least one pulled tag prefix-matches a curated analyzer model
    from the pull allowlist — mirrors ollama-health.ts's tag-canonicalisation
    (bare ⇄ family-root / `-suffix`). Excludes non-analyzer installs (e.g. an
    embedding-only `nomic-embed-text`, absent from the allowlist). Backup label
    ONLY — never the gate. */
export function anyAnalyzerModelPulled(pulledTags: string[], curated: string[]): boolean {
  return pulledTags.some((tag) => {
    const tagRoot = tag.split(':')[0];
    return curated.some((m) => {
      const root = m.split(':')[0];
      return tag === m || tag.startsWith(`${m}-`) || (tagRoot === root && tag.startsWith(`${root}:`));
    });
  });
}

export interface AnalyzerDiagnosisInput {
  engine: 'local' | 'gemini';
  ollamaReachable: boolean;
  ollamaError: string | null;
  /** Resolved analyzer model pulled — today's gate signal (model-specific). */
  modelPulled: boolean;
  /** Any analyzer-capable model pulled — backup label only. */
  anyAnalyzerModelPulled: boolean;
  expectedModel: string;
  pullable: string[];
  geminiKeySet: boolean;
}

export function diagnoseAnalyzer(input: AnalyzerDiagnosisInput): BlockerDiagnosis {
  // ── Gate: byte-identical to today's pass/fail (fallback NOT modeled) ──
  if (input.engine === 'gemini') {
    if (!input.geminiKeySet) {
      return diagnosis(
        'fail', 'no-gemini-key',
        'No Gemini API key is configured.',
        'Enter a Gemini API key in Advanced Settings.',
        { kind: 'navigate', label: 'Open Advanced Settings', href: '#/advanced' },
      );
    }
  } else {
    if (!input.ollamaReachable) {
      return diagnosis(
        'fail', 'ollama-unreachable',
        input.ollamaError ?? 'The local Ollama analyzer is not reachable.',
        'Install and start Ollama.',
        { kind: 'ollama-install', label: 'Install Ollama' },
      );
    }
    if (!input.modelPulled) {
      const action = input.pullable.includes(input.expectedModel)
        ? { kind: 'ollama-pull' as const, label: `Pull ${input.expectedModel}`, params: { model: input.expectedModel } }
        : undefined;
      return diagnosis(
        'fail', 'model-not-pulled',
        `The analyzer model "${input.expectedModel}" has not been pulled.`,
        action ? `Pull ${input.expectedModel}.` : `Pull it via the terminal: ollama pull ${input.expectedModel}`,
        action,
      );
    }
  }

  // ── activeUsable === true. Backup label splits green vs yellow (never gates). ──
  const geminiBackup = input.geminiKeySet;
  const localBackup = input.ollamaReachable && (input.anyAnalyzerModelPulled || input.modelPulled);
  if (geminiBackup && localBackup) {
    return diagnosis('pass', 'pass', 'Analyzer ready.', '');
  }
  return diagnosis('warn', 'pass', 'Analyzer ready — no backup analyzer configured.', '');
}
