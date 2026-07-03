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

describe('buildSetupReadiness', () => {
  it('is ready when all four blockers pass', () => {
    const r = buildSetupReadiness({
      sidecar: pass(), ffmpeg: pass(), tts: pass(), analyzer: pass(), gpu: 'cuda',
    });
    expect(r.ready).toBe(true);
    expect(r.blockers).toEqual({ sidecar: pass(), ffmpeg: pass(), tts: pass(), analyzer: pass() });
  });

  it('is not ready when the sidecar blocker fails', () => {
    const r = buildSetupReadiness({
      sidecar: fail('venv-missing'), ffmpeg: pass(), tts: pass(), analyzer: pass(), gpu: 'cuda',
    });
    expect(r.ready).toBe(false);
    expect(r.blockers.sidecar.cause).toBe('venv-missing');
  });

  it('is not ready when the tts blocker fails', () => {
    const r = buildSetupReadiness({
      sidecar: pass(), ffmpeg: pass(), tts: fail('no-engine-installed'), analyzer: pass(), gpu: 'cuda',
    });
    expect(r.ready).toBe(false);
  });

  it('is not ready when the ffmpeg blocker fails', () => {
    const r = buildSetupReadiness({
      sidecar: pass(), ffmpeg: fail('both-missing'), tts: pass(), analyzer: pass(), gpu: 'cuda',
    });
    expect(r.ready).toBe(false);
  });

  it('is not ready when the analyzer blocker fails', () => {
    const r = buildSetupReadiness({
      sidecar: pass(), ffmpeg: pass(), tts: pass(), analyzer: fail('no-gemini-key'), gpu: 'cuda',
    });
    expect(r.ready).toBe(false);
  });

  it('surfaces the gpu info string and passes through completedAt', () => {
    const r = buildSetupReadiness({
      sidecar: pass(), ffmpeg: pass(), tts: pass(), analyzer: pass(), gpu: 'cuda · 1.2/8.0 GB',
      completedAt: '2026-01-01T00:00:00.000Z',
    });
    expect(r.info.gpu).toBe('cuda · 1.2/8.0 GB');
    expect(r.completedAt).toBe('2026-01-01T00:00:00.000Z');
  });

  it('defaults completedAt to null when omitted', () => {
    const r = buildSetupReadiness({ sidecar: pass(), ffmpeg: pass(), tts: pass(), analyzer: pass(), gpu: '' });
    expect(r.completedAt).toBeNull();
  });
});
