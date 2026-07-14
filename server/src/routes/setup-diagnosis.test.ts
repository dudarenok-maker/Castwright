import { describe, it, expect, vi, afterEach } from 'vitest';
import { diagnoseSidecar, diagnoseTts, probePython312Cached, _resetPythonProbeCacheForTests } from './setup-diagnosis.js';
import type { SidecarDiagnosisInput, TtsDiagnosisInput } from './setup-diagnosis.js';

const READY: SidecarDiagnosisInput = {
  venvPresent: true,
  pythonFound: true,
  corePackageInstalled: true,
  supervisorActive: true,
  supervisorTripped: false,
  supervisorExhausted: false,
  sidecarReachable: true,
};

describe('diagnoseSidecar', () => {
  it('passes when everything is healthy', () => {
    expect(diagnoseSidecar(READY)).toMatchObject({ status: 'pass', cause: 'pass' });
  });

  it('reports python-missing when the venv is absent and no 3.12 interpreter is found', () => {
    const r = diagnoseSidecar({ ...READY, venvPresent: false, pythonFound: false });
    expect(r).toMatchObject({ status: 'fail', cause: 'python-missing' });
    expect(r.action).toBeUndefined();
  });

  it('reports venv-missing (not python-missing) when the venv is absent but python is found', () => {
    const r = diagnoseSidecar({ ...READY, venvPresent: false, pythonFound: true });
    expect(r).toMatchObject({ status: 'fail', cause: 'venv-missing' });
    expect(r.action).toMatchObject({ kind: 'venv-bootstrap' });
  });

  it('reports venv-broken when the venv exists but the core package is not installed', () => {
    const r = diagnoseSidecar({ ...READY, venvPresent: true, corePackageInstalled: false });
    expect(r).toMatchObject({ status: 'fail', cause: 'venv-broken' });
    expect(r.action).toMatchObject({ kind: 'venv-bootstrap' });
  });

  it('venv-missing/python-missing take priority over venv-broken and supervisor state (first-match-wins)', () => {
    const r = diagnoseSidecar({
      ...READY,
      venvPresent: false,
      pythonFound: false,
      corePackageInstalled: false,
      supervisorExhausted: true,
    });
    expect(r.cause).toBe('python-missing');
  });

  it('reports supervisor-exhausted with a sidecar-restart action', () => {
    const r = diagnoseSidecar({ ...READY, supervisorExhausted: true });
    expect(r).toMatchObject({ status: 'fail', cause: 'supervisor-exhausted' });
    expect(r.action).toMatchObject({ kind: 'sidecar-restart' });
  });

  it('reports supervisor-tripped with no action — POST /api/sidecar/restart cannot recover a trip', () => {
    // A code-43 trip means the device assignment itself is broken; resetAndRespawn()
    // would just crash-loop back into the same trip, so the route intentionally
    // returns 409 for this cause (sidecar-health.ts's tripEvent() branch) rather
    // than spawning a fresh child. Attaching a `sidecar-restart` action here would
    // show a working-looking button that always fails — this is text-only guidance.
    const r = diagnoseSidecar({ ...READY, supervisorTripped: true });
    expect(r).toMatchObject({ status: 'fail', cause: 'supervisor-tripped' });
    expect(r.action).toBeUndefined();
  });

  it('supervisor-exhausted takes priority over supervisor-tripped when both are somehow true', () => {
    const r = diagnoseSidecar({ ...READY, supervisorExhausted: true, supervisorTripped: true });
    expect(r.cause).toBe('supervisor-exhausted');
  });

  it('reports unreachable-transient when a supervisor is active but not yet reachable', () => {
    const r = diagnoseSidecar({ ...READY, sidecarReachable: false });
    expect(r).toMatchObject({ status: 'fail', cause: 'unreachable-transient' });
    expect(r.action).toBeUndefined();
  });

  it('reports unreachable-no-supervisor with a navigate action when autoStart is off', () => {
    const r = diagnoseSidecar({ ...READY, supervisorActive: false, sidecarReachable: false });
    expect(r).toMatchObject({ status: 'fail', cause: 'unreachable-no-supervisor' });
    expect(r.action).toMatchObject({ kind: 'navigate', href: '#/models' });
  });
});

describe('probePython312Cached', () => {
  afterEach(() => {
    _resetPythonProbeCacheForTests();
    vi.restoreAllMocks();
  });

  it('caches the result across calls within the TTL window', async () => {
    const findPython312 = await import('../tts/python-discovery.js');
    const spy = vi.spyOn(findPython312, 'findPython312').mockReturnValue({ cmd: 'py', args: ['-3.12'] });
    let now = 0;
    expect(probePython312Cached(() => now)).toBe(true);
    now += 1_000;
    expect(probePython312Cached(() => now)).toBe(true);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('re-probes after the TTL expires', async () => {
    const findPython312 = await import('../tts/python-discovery.js');
    const spy = vi.spyOn(findPython312, 'findPython312').mockReturnValue(null);
    let now = 0;
    probePython312Cached(() => now);
    now += 10_001;
    probePython312Cached(() => now);
    expect(spy).toHaveBeenCalledTimes(2);
  });
});

const SIDECAR_PASS = diagnoseSidecar(READY);
const SIDECAR_VENV_MISSING = diagnoseSidecar({ ...READY, venvPresent: false, pythonFound: true });
const SIDECAR_TRANSIENT = diagnoseSidecar({ ...READY, sidecarReachable: false });
const SIDECAR_NO_SUPERVISOR = diagnoseSidecar({ ...READY, supervisorActive: false, sidecarReachable: false });

const TTS_READY: TtsDiagnosisInput = {
  noEngineAtAll: false,
  anyEngineUsable: true,
  weightsMissingEngine: null,
  kokoroPackageConfirmedBroken: false,
  qwenPackageConfirmedBroken: false,
};

describe('diagnoseTts', () => {
  it('passes when the sidecar passes and an engine is present', () => {
    expect(diagnoseTts(SIDECAR_PASS, TTS_READY)).toMatchObject({ status: 'pass', cause: 'pass' });
  });

  it('reports sidecar-blocked (not no-engine-installed) when the sidecar has an actionable failure', () => {
    const r = diagnoseTts(SIDECAR_VENV_MISSING, { ...TTS_READY, noEngineAtAll: true });
    expect(r).toMatchObject({ status: 'fail', cause: 'sidecar-blocked' });
    expect(r.action).toBeUndefined();
  });

  it('does NOT gate on unreachable-transient — disk checks still run', () => {
    const r = diagnoseTts(SIDECAR_TRANSIENT, { ...TTS_READY, noEngineAtAll: true });
    expect(r).toMatchObject({ status: 'fail', cause: 'no-engine-installed' });
    expect(r.action).toMatchObject({ kind: 'kokoro-install' });
  });

  it('DOES gate on unreachable-no-supervisor — it is actionable, not transient', () => {
    const r = diagnoseTts(SIDECAR_NO_SUPERVISOR, { ...TTS_READY, noEngineAtAll: true });
    expect(r.cause).toBe('sidecar-blocked');
  });

  it('reports no-engine-installed when the sidecar passes but no engine has a package', () => {
    const r = diagnoseTts(SIDECAR_PASS, { ...TTS_READY, noEngineAtAll: true });
    expect(r).toMatchObject({ status: 'fail', cause: 'no-engine-installed' });
    expect(r.action).toMatchObject({ kind: 'kokoro-install' });
  });

  it('reports weights-missing for the reporting engine when no engine is ready yet', () => {
    const r = diagnoseTts(SIDECAR_PASS, { ...TTS_READY, anyEngineUsable: false, weightsMissingEngine: 'qwen' });
    expect(r).toMatchObject({ status: 'fail', cause: 'weights-missing' });
    expect(r.action).toMatchObject({ kind: 'qwen-install' });
  });

  it('passes when one engine is ready even though another engine reports weights-missing (mixed state, round-2 plan review finding A2)', () => {
    const r = diagnoseTts(SIDECAR_PASS, { ...TTS_READY, anyEngineUsable: true, weightsMissingEngine: 'qwen' });
    expect(r).toMatchObject({ status: 'pass', cause: 'pass' });
  });

  it('passes when one engine is live-confirmed-broken but another is usable (round-3 plan review finding 1)', () => {
    const r = diagnoseTts(SIDECAR_PASS, { ...TTS_READY, anyEngineUsable: true, kokoroPackageConfirmedBroken: true });
    expect(r).toMatchObject({ status: 'pass', cause: 'pass' });
  });

  it('reports package-broken when the only ready engine is the broken one', () => {
    const r = diagnoseTts(SIDECAR_PASS, { ...TTS_READY, anyEngineUsable: false, kokoroPackageConfirmedBroken: true });
    expect(r).toMatchObject({ status: 'fail', cause: 'package-broken' });
  });

  it('reports cannot-confirm-engine (not pass) when sidecar is transient and disk checks found nothing', () => {
    const r = diagnoseTts(SIDECAR_TRANSIENT, TTS_READY);
    expect(r).toMatchObject({ status: 'fail', cause: 'cannot-confirm-engine' });
    expect(r.action).toBeUndefined();
  });

  it('reports package-broken only once the sidecar is confirmed pass', () => {
    const r = diagnoseTts(SIDECAR_PASS, { ...TTS_READY, anyEngineUsable: false, kokoroPackageConfirmedBroken: true });
    expect(r).toMatchObject({ status: 'fail', cause: 'package-broken' });
    expect(r.action).toBeUndefined();
  });

  it('never returns package-broken while the sidecar is not pass, even if the flag is somehow set', () => {
    const r = diagnoseTts(SIDECAR_TRANSIENT, { ...TTS_READY, kokoroPackageConfirmedBroken: true });
    expect(r.cause).not.toBe('package-broken');
  });
});

import { diagnoseFfmpeg, diagnoseAnalyzer, anyAnalyzerModelPulled } from './setup-diagnosis.js';
import type { AnalyzerDiagnosisInput } from './setup-diagnosis.js';

describe('diagnoseFfmpeg', () => {
  it('passes when both are present', () => {
    const r = diagnoseFfmpeg({ ffmpegPresent: true, ffprobePresent: true });
    expect(r).toMatchObject({ status: 'pass', cause: 'pass' });
  });
  it('reports ffmpeg-missing', () => {
    const r = diagnoseFfmpeg({ ffmpegPresent: false, ffprobePresent: true });
    expect(r).toMatchObject({ status: 'fail', cause: 'ffmpeg-missing' });
    expect(r.action).toBeUndefined();
  });
  it('reports ffprobe-missing', () => {
    const r = diagnoseFfmpeg({ ffmpegPresent: true, ffprobePresent: false });
    expect(r.cause).toBe('ffprobe-missing');
  });
  it('reports both-missing', () => {
    const r = diagnoseFfmpeg({ ffmpegPresent: false, ffprobePresent: false });
    expect(r.cause).toBe('both-missing');
  });
});

const ANALYZER_LOCAL_READY: AnalyzerDiagnosisInput = {
  engine: 'local',
  ollamaReachable: true,
  ollamaError: null,
  modelPulled: true,
  anyAnalyzerModelPulled: true,
  expectedModel: 'qwen3.5:9b',
  pullable: ['qwen3.5:9b'],
  geminiKeySet: true,
};

describe('diagnoseAnalyzer', () => {
  it('passes for a reachable, pulled local model', () => {
    expect(diagnoseAnalyzer(ANALYZER_LOCAL_READY)).toMatchObject({ status: 'pass', cause: 'pass' });
  });
  it('reports ollama-unreachable with an install action', () => {
    const r = diagnoseAnalyzer({ ...ANALYZER_LOCAL_READY, ollamaReachable: false, ollamaError: 'ECONNREFUSED' });
    expect(r).toMatchObject({ status: 'fail', cause: 'ollama-unreachable' });
    expect(r.action).toMatchObject({ kind: 'ollama-install' });
  });
  it('reports model-not-pulled with a pull action when the model is in the allowlist', () => {
    const r = diagnoseAnalyzer({ ...ANALYZER_LOCAL_READY, modelPulled: false });
    expect(r).toMatchObject({ status: 'fail', cause: 'model-not-pulled' });
    expect(r.action).toMatchObject({ kind: 'ollama-pull', params: { model: 'qwen3.5:9b' } });
  });
  it('omits the pull action when the model is not in the allowlist', () => {
    const r = diagnoseAnalyzer({ ...ANALYZER_LOCAL_READY, modelPulled: false, pullable: ['other-model'] });
    expect(r).toMatchObject({ status: 'fail', cause: 'model-not-pulled' });
    expect(r.action).toBeUndefined();
  });
  it('reports no-gemini-key with a navigate action for the gemini engine', () => {
    const r = diagnoseAnalyzer({ ...ANALYZER_LOCAL_READY, engine: 'gemini', geminiKeySet: false });
    expect(r).toMatchObject({ status: 'fail', cause: 'no-gemini-key' });
    expect(r.action).toMatchObject({ kind: 'navigate' });
  });
  it('passes for the gemini engine when a key is set', () => {
    const r = diagnoseAnalyzer({ ...ANALYZER_LOCAL_READY, engine: 'gemini', geminiKeySet: true });
    expect(r).toMatchObject({ status: 'pass', cause: 'pass' });
  });
});

const base = { expectedModel: 'qwen3.5:4b', pullable: ['qwen3.5:4b', 'llama3.1:8b'], ollamaError: null };

describe('diagnoseAnalyzer tri-state', () => {
  // engine = gemini
  it('gemini, no key → fail', () => {
    expect(diagnoseAnalyzer({ ...base, engine: 'gemini', geminiKeySet: false, ollamaReachable: false, modelPulled: false, anyAnalyzerModelPulled: false }).status).toBe('fail');
  });
  it('gemini, key only (no local model) → warn', () => {
    expect(diagnoseAnalyzer({ ...base, engine: 'gemini', geminiKeySet: true, ollamaReachable: true, modelPulled: false, anyAnalyzerModelPulled: false }).status).toBe('warn');
  });
  it('gemini, key + local analyzer model → pass', () => {
    expect(diagnoseAnalyzer({ ...base, engine: 'gemini', geminiKeySet: true, ollamaReachable: true, modelPulled: true, anyAnalyzerModelPulled: true }).status).toBe('pass');
  });
  // engine = local
  it('local, resolved model not pulled → fail', () => {
    expect(diagnoseAnalyzer({ ...base, engine: 'local', geminiKeySet: false, ollamaReachable: true, modelPulled: false, anyAnalyzerModelPulled: false }).status).toBe('fail');
  });
  it('local, resolved model pulled, no key → warn', () => {
    expect(diagnoseAnalyzer({ ...base, engine: 'local', geminiKeySet: false, ollamaReachable: true, modelPulled: true, anyAnalyzerModelPulled: true }).status).toBe('warn');
  });
  it('local, resolved model pulled + key → pass', () => {
    expect(diagnoseAnalyzer({ ...base, engine: 'local', geminiKeySet: true, ollamaReachable: true, modelPulled: true, anyAnalyzerModelPulled: true }).status).toBe('pass');
  });

  // Regression guards — the gate is NEVER more lenient than today.
  it('gemini + no key + Ollama model pulled → still fail (no gemini→local fallback)', () => {
    expect(diagnoseAnalyzer({ ...base, engine: 'gemini', geminiKeySet: false, ollamaReachable: true, modelPulled: true, anyAnalyzerModelPulled: true }).status).toBe('fail');
  });
  it('local + resolved model NOT pulled + key set → still fail (fallback is unreachable-only)', () => {
    expect(diagnoseAnalyzer({ ...base, engine: 'local', geminiKeySet: true, ollamaReachable: true, modelPulled: false, anyAnalyzerModelPulled: false }).status).toBe('fail');
  });
  it('local + daemon unreachable → fail with ollama-install action', () => {
    const d = diagnoseAnalyzer({ ...base, engine: 'local', geminiKeySet: false, ollamaReachable: false, modelPulled: false, anyAnalyzerModelPulled: false });
    expect(d.status).toBe('fail');
    expect(d.action?.kind).toBe('ollama-install');
  });
  // Deviation-fix guard: local custom-model primary + key → green (a running local counts).
  it('local, resolved (custom) model pulled but not curated, key set → pass', () => {
    expect(diagnoseAnalyzer({ ...base, engine: 'local', geminiKeySet: true, ollamaReachable: true, modelPulled: true, anyAnalyzerModelPulled: false }).status).toBe('pass');
  });
});

describe('anyAnalyzerModelPulled', () => {
  const curated = ['qwen3.5:4b', 'llama3.1:8b'];
  it('true for a curated tag (canonicalised)', () => {
    expect(anyAnalyzerModelPulled(['qwen3.5:4b-instruct-q4_K_M'], curated)).toBe(true);
  });
  it('false for an embedding-only install', () => {
    expect(anyAnalyzerModelPulled(['nomic-embed-text:latest'], curated)).toBe(false);
  });
  it('false for an empty tag list', () => {
    expect(anyAnalyzerModelPulled([], curated)).toBe(false);
  });
});
