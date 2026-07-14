// server/src/routes/setup-readiness.test.ts
import { describe, it, expect } from 'vitest';
import { buildSetupReadiness } from './setup-readiness.js';
import type { BlockerDiagnosis } from './setup-readiness.js';

function pass(message = 'ok'): BlockerDiagnosis {
  return { status: 'pass', cause: 'pass', message, remediation: '' };
}
function fail(cause: BlockerDiagnosis['cause'], message = 'broken'): BlockerDiagnosis {
  return { status: 'fail', cause, message, remediation: 'fix it' };
}
function warn(message = 'no backup'): BlockerDiagnosis {
  return { status: 'warn', cause: 'pass', message, remediation: '' };
}

describe('buildSetupReadiness', () => {
  it('is ready when all four blockers pass', () => {
    const r = buildSetupReadiness({
      sidecar: pass(), ffmpeg: pass(), tts: pass(), analyzer: pass(), gpu: 'cuda', vramTotalMb: 8192,
    });
    expect(r.ready).toBe(true);
    expect(r.blockers).toEqual({ sidecar: pass(), ffmpeg: pass(), tts: pass(), analyzer: pass() });
  });

  it('is not ready when the sidecar blocker fails', () => {
    const r = buildSetupReadiness({
      sidecar: fail('venv-missing'), ffmpeg: pass(), tts: pass(), analyzer: pass(), gpu: 'cuda', vramTotalMb: 8192,
    });
    expect(r.ready).toBe(false);
    expect(r.blockers.sidecar.cause).toBe('venv-missing');
  });

  it('is not ready when the tts blocker fails', () => {
    const r = buildSetupReadiness({
      sidecar: pass(), ffmpeg: pass(), tts: fail('no-engine-installed'), analyzer: pass(), gpu: 'cuda', vramTotalMb: 8192,
    });
    expect(r.ready).toBe(false);
  });

  it('is not ready when the ffmpeg blocker fails', () => {
    const r = buildSetupReadiness({
      sidecar: pass(), ffmpeg: fail('both-missing'), tts: pass(), analyzer: pass(), gpu: 'cuda', vramTotalMb: 8192,
    });
    expect(r.ready).toBe(false);
  });

  it('is not ready when the analyzer blocker fails', () => {
    const r = buildSetupReadiness({
      sidecar: pass(), ffmpeg: pass(), tts: pass(), analyzer: fail('no-gemini-key'), gpu: 'cuda', vramTotalMb: 8192,
    });
    expect(r.ready).toBe(false);
  });

  it('surfaces the gpu info string and passes through completedAt', () => {
    const r = buildSetupReadiness({
      sidecar: pass(), ffmpeg: pass(), tts: pass(), analyzer: pass(), gpu: 'cuda · 1.2/8.0 GB',
      vramTotalMb: 8192,
      completedAt: '2026-01-01T00:00:00.000Z',
    });
    expect(r.info.gpu).toBe('cuda · 1.2/8.0 GB');
    expect(r.completedAt).toBe('2026-01-01T00:00:00.000Z');
  });

  it('defaults completedAt to null when omitted', () => {
    const r = buildSetupReadiness({
      sidecar: pass(), ffmpeg: pass(), tts: pass(), analyzer: pass(), gpu: '', vramTotalMb: null,
    });
    expect(r.completedAt).toBeNull();
  });

  it('ready=true when the only non-pass blocker is analyzer warn', () => {
    const r = buildSetupReadiness({
      sidecar: pass(), ffmpeg: pass(), tts: pass(), analyzer: warn(), gpu: '', vramTotalMb: null,
    });
    expect(r.ready).toBe(true);
  });

  it('ready=false on analyzer fail', () => {
    const r = buildSetupReadiness({
      sidecar: pass(), ffmpeg: pass(), tts: pass(), analyzer: fail('no-gemini-key'), gpu: '', vramTotalMb: null,
    });
    expect(r.ready).toBe(false);
  });

  it('buildSetupReadiness carries vramTotalMb through info', () => {
    const r = buildSetupReadiness({
      sidecar: pass(), ffmpeg: pass(), tts: pass(), analyzer: pass(),
      gpu: 'cuda', vramTotalMb: 8192, completedAt: null,
    });
    expect(r.info.vramTotalMb).toBe(8192);
  });

  it('carries a null vramTotalMb through when there is no GPU', () => {
    const r = buildSetupReadiness({
      sidecar: pass(), ffmpeg: pass(), tts: pass(), analyzer: pass(),
      gpu: 'CPU — no GPU detected', vramTotalMb: null,
    });
    expect(r.info.vramTotalMb).toBeNull();
  });
});
