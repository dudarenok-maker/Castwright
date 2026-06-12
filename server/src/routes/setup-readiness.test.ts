import { describe, it, expect } from 'vitest';
import { buildSetupReadiness } from './setup-readiness.js';
import type { CheckId, DiagnosticsResponse } from './diagnostics.js';

function diag(over: Partial<Record<string, 'ok' | 'warn' | 'fail'>>): DiagnosticsResponse {
  const def: Record<string, 'ok' | 'warn' | 'fail'> = {
    gpu: 'ok', sidecar: 'ok', asr: 'ok', analyzer: 'ok', gemini: 'ok', ffmpeg: 'ok', disk: 'ok',
  };
  const merged = { ...def, ...over };
  return {
    ts: 'T',
    overall: 'ok',
    checks: Object.entries(merged).map(([id, status]) => ({
      id: id as CheckId, label: id, status: status as 'ok' | 'warn' | 'fail', detail: `${id}:${status}`,
    })),
  };
}

describe('buildSetupReadiness', () => {
  it('is ready when all hard-blockers pass', () => {
    const r = buildSetupReadiness({ diagnostics: diag({}), engine: 'local', venvPresent: true, ttsEnginePresent: true });
    expect(r.ready).toBe(true);
    expect(r.blockers).toEqual({ sidecar: 'pass', ffmpeg: 'pass', tts: 'pass', analyzer: 'pass' });
  });
  it('fails sidecar when venv is missing even if the sidecar pings', () => {
    const r = buildSetupReadiness({ diagnostics: diag({}), engine: 'local', venvPresent: false, ttsEnginePresent: true });
    expect(r.blockers.sidecar).toBe('fail');
    expect(r.ready).toBe(false);
  });
  it('fails tts when no engine weights are present', () => {
    const r = buildSetupReadiness({ diagnostics: diag({}), engine: 'local', venvPresent: true, ttsEnginePresent: false });
    expect(r.blockers.tts).toBe('fail');
    expect(r.ready).toBe(false);
  });
  it('uses the gemini check when engine is gemini', () => {
    const r = buildSetupReadiness({ diagnostics: diag({ analyzer: 'fail', gemini: 'ok' }), engine: 'gemini', venvPresent: true, ttsEnginePresent: true });
    expect(r.blockers.analyzer).toBe('pass');
  });
  it('surfaces gpu detail as info, never a blocker', () => {
    const r = buildSetupReadiness({ diagnostics: diag({ gpu: 'fail' }), engine: 'local', venvPresent: true, ttsEnginePresent: true });
    expect(r.ready).toBe(true);
    expect(r.info.gpu).toBe('gpu:fail');
  });
  it('fails ffmpeg when the ffmpeg check is not ok', () => {
    const r = buildSetupReadiness({ diagnostics: diag({ ffmpeg: 'fail' }), engine: 'local', venvPresent: true, ttsEnginePresent: true });
    expect(r.blockers.ffmpeg).toBe('fail');
    expect(r.ready).toBe(false);
  });
});
