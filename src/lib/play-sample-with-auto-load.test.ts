/* Pairs with docs/features/archive/10-profile-drawer.md — the JIT TTS load path
   triggered by the profile-drawer / cast-row Play button. */

import { describe, expect, it, vi, beforeEach } from 'vitest';
import {
  playSampleWithAutoLoad,
  __resetPrepInFlightForTests,
  type SampleStatus,
} from './play-sample-with-auto-load';
import type { VoiceSampleArgs } from './api';

const sampleArgs: VoiceSampleArgs = {
  voiceId: 'char-brann',
  /* Voice is opaque to the helper — it forwards as-is to the server. The
     fixture only needs the fields the type system requires. */
  voice: {
    id: 'char-brann',
    character: 'Brann',
    bookTitle: '',
    bookId: '',
    attributes: [],
    gradient: ['#000', '#fff'],
    usedIn: 0,
    source: 'current',
    ttsVoice: { provider: 'coqui', name: 'Andrew Chipper', description: 'light male' },
  },
  modelKey: 'coqui-xtts-v2',
};

vi.mock('./api', () => ({
  api: {
    getSidecarHealth: vi.fn(),
    getOllamaHealth: vi.fn(),
    loadSidecar: vi.fn(),
    unloadAnalyzer: vi.fn(),
    getVoiceSample: vi.fn(),
  },
}));

import { api } from './api';

beforeEach(() => {
  vi.clearAllMocks();
  __resetPrepInFlightForTests();
});

describe('playSampleWithAutoLoad', () => {
  it('goes straight to synth when the sidecar reports the model already loaded', async () => {
    vi.mocked(api.getSidecarHealth).mockResolvedValueOnce({
      status: 'reachable',
      url: '',
      modelLoaded: true,
      loading: false,
    });
    vi.mocked(api.getVoiceSample).mockResolvedValueOnce({ url: '/audio/voices/x.mp3' } as never);
    const playback = { play: vi.fn().mockResolvedValue(undefined) };
    const statuses: SampleStatus[] = [];

    const result = await playSampleWithAutoLoad({
      args: sampleArgs,
      playback,
      onStatus: (s) => statuses.push(s),
    });

    expect(api.getOllamaHealth).not.toHaveBeenCalled();
    expect(api.unloadAnalyzer).not.toHaveBeenCalled();
    expect(api.loadSidecar).not.toHaveBeenCalled();
    expect(statuses).toEqual(['synthesizing']);
    expect(result.analyzerEvicted).toBe(false);
    expect(playback.play).toHaveBeenCalledWith('/audio/voices/x.mp3');
  });

  it('evicts the analyzer and loads the sidecar when the model is not resident', async () => {
    vi.mocked(api.getSidecarHealth).mockResolvedValueOnce({
      status: 'reachable',
      url: '',
      modelLoaded: false,
      loading: false,
    });
    vi.mocked(api.getOllamaHealth).mockResolvedValueOnce({
      status: 'reachable',
      url: '',
      modelResident: true,
    });
    vi.mocked(api.unloadAnalyzer).mockResolvedValueOnce({ status: 'unloaded' });
    vi.mocked(api.loadSidecar).mockResolvedValueOnce({ status: 'ready' });
    vi.mocked(api.getVoiceSample).mockResolvedValueOnce({ url: '/audio/voices/y.mp3' } as never);
    const playback = { play: vi.fn().mockResolvedValue(undefined) };
    const statusEvents: Array<[SampleStatus, boolean]> = [];

    const result = await playSampleWithAutoLoad({
      args: sampleArgs,
      playback,
      onStatus: (s, { analyzerEvicted }) => statusEvents.push([s, analyzerEvicted]),
    });

    expect(api.unloadAnalyzer).toHaveBeenCalledTimes(1);
    expect(api.loadSidecar).toHaveBeenCalledTimes(1);
    /* The status pipeline is evict→load→synth, with `analyzerEvicted`
       flipping true the moment we trigger unloadAnalyzer. */
    expect(statusEvents).toEqual([
      ['evicting', false],
      ['loading-tts', true],
      ['synthesizing', true],
    ]);
    expect(result.analyzerEvicted).toBe(true);
  });

  it('skips the analyzer eviction when Ollama reports the model is not resident', async () => {
    vi.mocked(api.getSidecarHealth).mockResolvedValueOnce({
      status: 'reachable',
      url: '',
      modelLoaded: false,
      loading: false,
    });
    vi.mocked(api.getOllamaHealth).mockResolvedValueOnce({
      status: 'reachable',
      url: '',
      modelResident: false,
    });
    vi.mocked(api.loadSidecar).mockResolvedValueOnce({ status: 'ready' });
    vi.mocked(api.getVoiceSample).mockResolvedValueOnce({ url: '/audio/voices/z.mp3' } as never);
    const playback = { play: vi.fn().mockResolvedValue(undefined) };
    const statuses: SampleStatus[] = [];

    const result = await playSampleWithAutoLoad({
      args: sampleArgs,
      playback,
      onStatus: (s) => statuses.push(s),
    });

    expect(api.unloadAnalyzer).not.toHaveBeenCalled();
    expect(result.analyzerEvicted).toBe(false);
    expect(statuses).toEqual(['loading-tts', 'synthesizing']);
  });

  it('throws a sidecar-specific recovery hint when the daemon is unreachable', async () => {
    vi.mocked(api.getSidecarHealth).mockResolvedValueOnce({
      status: 'unreachable',
      url: 'http://localhost:9000',
      proxy: 'sidecar',
      error: 'fetch failed: ECONNREFUSED',
    });
    const playback = { play: vi.fn() };

    /* Inspect the thrown message once — both the recovery hint and the
       appended underlying-error tag have to be present so power users
       can copy the reason into a bug report. */
    const message = await playSampleWithAutoLoad({ args: sampleArgs, playback }).catch(
      (e) => (e as Error).message,
    );
    expect(message).toMatch(/Voice engine.*:9000.*unreachable/);
    expect(message).toMatch(/ECONNREFUSED/);
    expect(api.loadSidecar).not.toHaveBeenCalled();
    expect(api.getVoiceSample).not.toHaveBeenCalled();
    expect(playback.play).not.toHaveBeenCalled();
  });

  it('throws a Node-specific recovery hint when the Express server (:8080) is unreachable', async () => {
    vi.mocked(api.getSidecarHealth).mockResolvedValueOnce({
      status: 'unreachable',
      url: '',
      proxy: 'node',
      error: 'Node server (:8080) returned HTTP 502',
    });
    const playback = { play: vi.fn() };

    /* The hint must point at the Node server, not the sidecar — the
       failure preceded the Node → sidecar hop entirely. The old generic
       message led the user to restart the (perfectly healthy) sidecar
       and ignore the actual Node-side crash. */
    await expect(playSampleWithAutoLoad({ args: sampleArgs, playback })).rejects.toThrow(
      /Node server.*:8080.*unreachable/,
    );
    expect(api.loadSidecar).not.toHaveBeenCalled();
  });

  it('falls back to sidecar wording when proxy field is absent (older Node server)', async () => {
    /* Backwards-compat: a Node server built before the `proxy` tag exists
       still answers /api/sidecar/health. The helper defaults to sidecar
       wording since that's the historically more common failure mode. */
    vi.mocked(api.getSidecarHealth).mockResolvedValueOnce({
      status: 'unreachable',
      url: '',
      error: 'Sidecar fetch failed.',
    });
    const playback = { play: vi.fn() };
    await expect(playSampleWithAutoLoad({ args: sampleArgs, playback })).rejects.toThrow(
      /Voice engine.*:9000.*unreachable/,
    );
  });

  it('propagates loadSidecar errors as a thrown Error so callers can render them', async () => {
    vi.mocked(api.getSidecarHealth).mockResolvedValueOnce({
      status: 'reachable',
      url: '',
      modelLoaded: false,
      loading: false,
    });
    vi.mocked(api.getOllamaHealth).mockResolvedValueOnce({
      status: 'reachable',
      url: '',
      modelResident: false,
    });
    vi.mocked(api.loadSidecar).mockResolvedValueOnce({ status: 'error', error: 'CUDA OOM' });
    const playback = { play: vi.fn() };

    await expect(playSampleWithAutoLoad({ args: sampleArgs, playback })).rejects.toThrow(
      /CUDA OOM/,
    );
    expect(api.getVoiceSample).not.toHaveBeenCalled();
  });

  it('coalesces concurrent prep calls so a second click awaits the same evict+load', async () => {
    /* Cold start — both callers see modelLoaded=false. The helper's
       single-flight gate must funnel them through one prepareSidecar
       invocation so we don't double-evict the analyzer or fire two
       parallel /load requests. The synth step is NOT coalesced — each
       caller still gets its own sample. */
    vi.mocked(api.getSidecarHealth).mockResolvedValue({
      status: 'reachable',
      url: '',
      modelLoaded: false,
      loading: false,
    });
    vi.mocked(api.getOllamaHealth).mockResolvedValue({
      status: 'reachable',
      url: '',
      modelResident: true,
    });
    vi.mocked(api.unloadAnalyzer).mockResolvedValue({ status: 'unloaded' });
    vi.mocked(api.loadSidecar).mockResolvedValue({ status: 'ready' });
    vi.mocked(api.getVoiceSample)
      .mockResolvedValueOnce({ url: '/audio/voices/a.mp3' } as never)
      .mockResolvedValueOnce({ url: '/audio/voices/b.mp3' } as never);
    const playback = { play: vi.fn().mockResolvedValue(undefined) };

    const [resA, resB] = await Promise.all([
      playSampleWithAutoLoad({ args: { ...sampleArgs, voiceId: 'a' }, playback }),
      playSampleWithAutoLoad({ args: { ...sampleArgs, voiceId: 'b' }, playback }),
    ]);

    /* Prep ran exactly once. Synth ran twice — once per caller. */
    expect(api.getSidecarHealth).toHaveBeenCalledTimes(1);
    expect(api.unloadAnalyzer).toHaveBeenCalledTimes(1);
    expect(api.loadSidecar).toHaveBeenCalledTimes(1);
    expect(api.getVoiceSample).toHaveBeenCalledTimes(2);
    expect(resA.analyzerEvicted).toBe(true);
    expect(resB.analyzerEvicted).toBe(true);
  });

  it('rejects when the server returns a sample with no URL (mock backend hint)', async () => {
    vi.mocked(api.getSidecarHealth).mockResolvedValueOnce({
      status: 'reachable',
      url: '',
      modelLoaded: true,
      loading: false,
    });
    vi.mocked(api.getVoiceSample).mockResolvedValueOnce({ url: '' } as never);
    const playback = { play: vi.fn() };
    await expect(playSampleWithAutoLoad({ args: sampleArgs, playback })).rejects.toThrow(
      /VITE_USE_MOCKS=false/,
    );
    expect(playback.play).not.toHaveBeenCalled();
  });

  /* Engine threading. Regression for the 2026-05-27 OOM: previewing a Qwen
     voice fired loadSidecar() with no engine, which the server defaults to
     Coqui — warming the ~2 GB XTTS model on top of the resident Qwen models
     and exhausting the 8 GB GPU. The sidecar must warm the engine the VOICE
     actually uses. */
  it.each(['coqui', 'kokoro', 'qwen'] as const)(
    'warms the %s engine (not the Coqui default) when the voice uses it',
    async (engine) => {
      vi.mocked(api.getSidecarHealth).mockResolvedValueOnce({
        status: 'reachable',
        url: '',
        modelLoaded: false,
        loading: false,
      });
      vi.mocked(api.getOllamaHealth).mockResolvedValueOnce({
        status: 'reachable',
        url: '',
        modelResident: false,
      });
      vi.mocked(api.loadSidecar).mockResolvedValueOnce({ status: 'ready' });
      vi.mocked(api.getVoiceSample).mockResolvedValueOnce({
        url: '/audio/voices/x.mp3',
      } as never);
      const playback = { play: vi.fn().mockResolvedValue(undefined) };

      await playSampleWithAutoLoad({
        args: {
          ...sampleArgs,
          voice: {
            ...sampleArgs.voice,
            ttsVoice: { provider: engine, name: 'V', description: '' },
          },
        },
        playback,
      });

      expect(api.loadSidecar).toHaveBeenCalledWith({ engine });
    },
  );

  it('skips sidecar prep entirely for a Gemini voice (cloud engine, no local model)', async () => {
    vi.mocked(api.getVoiceSample).mockResolvedValueOnce({ url: '/audio/voices/g.mp3' } as never);
    const playback = { play: vi.fn().mockResolvedValue(undefined) };
    const statuses: SampleStatus[] = [];

    await playSampleWithAutoLoad({
      args: {
        ...sampleArgs,
        voice: {
          ...sampleArgs.voice,
          ttsVoice: { provider: 'gemini', name: 'Kore', description: '' },
        },
      },
      playback,
      onStatus: (s) => statuses.push(s),
    });

    /* No sidecar hop at all — not even the health probe. */
    expect(api.getSidecarHealth).not.toHaveBeenCalled();
    expect(api.loadSidecar).not.toHaveBeenCalled();
    expect(api.unloadAnalyzer).not.toHaveBeenCalled();
    expect(statuses).toEqual(['synthesizing']);
    expect(playback.play).toHaveBeenCalledWith('/audio/voices/g.mp3');
  });
});
