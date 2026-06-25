import { describe, it, expect, vi } from 'vitest';

// Force mock mode so `api` resolves to the mock object (not the real fetch-based one).
vi.stubEnv('VITE_USE_MOCKS', 'true');

// Must be a dynamic import AFTER stubEnv so the module sees the stubbed env.
const { api } = await import('./api');

describe('mock single design', () => {
  it('emits phase events then designed for a first design', async () => {
    const phases: string[] = [];
    let designed: { characterId: string; voiceId: string } | null = null;
    await api.startSingleDesign(
      'book1',
      { characterId: 'c1', persona: 'warm', sampleVoiceId: 'char-c1', modelKey: 'qwen3-tts', preview: false },
      {
        onPhase: ({ phase }) => phases.push(phase),
        onCharacterDesigned: (e) => (designed = e),
        onIdle: () => {},
      },
    );
    expect(phases).toEqual(['loading-model', 'designing', 'distilling', 'rendering']);
    expect(designed).toMatchObject({ characterId: 'c1', voiceId: 'qwen-c1' });
  });

  it('emits preview_ready for a re-design', async () => {
    let ready: { previewVoiceId: string } | null = null;
    await api.startSingleDesign(
      'book1',
      { characterId: 'c1', persona: 'warm', sampleVoiceId: 'char-c1', modelKey: 'qwen3-tts', preview: true },
      { onPreviewReady: (e) => (ready = e), onPhase: () => {}, onIdle: () => {} },
    );
    expect(ready).toMatchObject({ previewVoiceId: 'qwen-c1-preview' });
  });
});
