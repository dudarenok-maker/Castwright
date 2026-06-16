/* VoiceCompareModal (plan 161) — the drawer's "current vs proposed" bespoke
   voice audition. Asserts the staging contract:
     - Approve PROMOTES the preview (api.promoteQwenVoice) then hands the REAL
       voiceId + persona back via onApprove (drawer Save persists it).
     - Cancel DISCARDS the preview (api.discardQwenPreview) and never approves.
     - Re-design calls api.designQwenVoice with the edited persona + preview:true.
     - Regenerate calls api.generateVoiceStyle and updates the textarea.
   api, the sample player, and the playback singleton are mocked — no network,
   no audio. */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { VoiceCompareModal } from './voice-compare-modal';
import { playSampleWithAutoLoad } from '../lib/play-sample-with-auto-load';
import type { Character, Voice } from '../lib/types';

vi.mock('../lib/use-sample-playback', () => {
  const playback = {
    currentUrl: null as string | null,
    isPlaying: false,
    play: vi.fn(async () => {}),
    stop: vi.fn(() => {}),
    playUntilEnded: vi.fn(async () => ({ cancelled: false })),
  };
  return { useSamplePlayback: () => playback };
});

vi.mock('../lib/play-sample-with-auto-load', () => ({
  playSampleWithAutoLoad: vi.fn(async () => ({ analyzerEvicted: false })),
}));

const api = {
  designQwenVoice: vi.fn(async () => ({ voiceId: 'qwen-x-preview', previewUrl: '/audio/redesigned.mp3' })),
  generateVoiceStyle: vi.fn(async () => ({ voiceStyle: 'a fresh regenerated persona' })),
  promoteQwenVoice: vi.fn(async () => ({ voiceId: 'qwen-x', url: '/audio/promoted.mp3' })),
  discardQwenPreview: vi.fn(async () => {}),
};
vi.mock('../lib/api', () => ({ api: new Proxy({}, { get: (_t, k) => api[k as keyof typeof api] }) }));

const character = { id: 'x', name: 'Wren', color: 'lilac', role: 'protagonist' } as unknown as Character;
const currentSubject = {
  id: 'v_x',
  character: 'Wren',
  ttsVoice: { provider: 'kokoro', name: 'af_heart', description: 'warm' },
} as unknown as Voice;

function renderModal(overrides?: {
  onApprove?: () => void;
  onClose?: () => void;
  character?: Character;
  currentSubject?: Voice;
  currentModelKey?: string;
}) {
  const onApprove = vi.fn(overrides?.onApprove);
  const onClose = vi.fn(overrides?.onClose);
  render(
    <VoiceCompareModal
      bookId="b1"
      character={overrides?.character ?? character}
      currentSubject={overrides?.currentSubject ?? currentSubject}
      currentSampleVoiceId="v_x"
      currentModelKey={(overrides?.currentModelKey ?? 'kokoro-v1') as never}
      designModelKey="qwen3-tts-0.6b"
      sampleVoiceId="v_x"
      initial={{ voiceId: 'qwen-x-preview', previewUrl: '/audio/initial.mp3', persona: 'initial persona' }}
      onApprove={onApprove}
      onClose={onClose}
    />,
  );
  return { onApprove, onClose };
}

/* A Qwen current voice whose id lives in `ttsVoice.name` only (the reused /
   designed shape) — NOT in `overrideTtsVoices.qwen`, which is what tripped the
   server pick. */
const qwenCurrentSubject = {
  id: 'v_q',
  character: 'Master Oduvan',
  ttsVoice: { provider: 'qwen', name: 'qwen-master-oduvan', description: 'Designed voice' },
} as unknown as Voice;
const qwenCharacter = {
  id: 'x',
  name: 'Master Oduvan',
  color: 'lilac',
  role: 'elder',
  voiceStyle: 'An elderly gravelly voice with a dry rasp.',
} as unknown as Character;

beforeEach(() => {
  Object.values(api).forEach((fn) => fn.mockClear());
  (playSampleWithAutoLoad as unknown as ReturnType<typeof vi.fn>).mockClear();
});

describe('VoiceCompareModal', () => {
  it('Approve promotes the preview and hands the real voiceId + persona to onApprove', async () => {
    const { onApprove } = renderModal();
    fireEvent.click(screen.getByTestId('voice-compare-approve'));

    await waitFor(() => expect(api.promoteQwenVoice).toHaveBeenCalledTimes(1));
    expect(api.promoteQwenVoice).toHaveBeenCalledWith('b1', 'x', {
      previewVoiceId: 'qwen-x-preview',
      sampleVoiceId: 'v_x',
      modelKey: 'qwen3-tts-0.6b',
    });
    await waitFor(() =>
      expect(onApprove).toHaveBeenCalledWith({
        voiceId: 'qwen-x',
        persona: 'initial persona',
        previewUrl: '/audio/promoted.mp3',
      }),
    );
  });

  it('Cancel discards the preview and never approves', async () => {
    const { onApprove, onClose } = renderModal();
    fireEvent.click(screen.getByTestId('voice-compare-cancel'));

    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(api.discardQwenPreview).toHaveBeenCalledWith('b1', 'x', {
      previewVoiceId: 'qwen-x-preview',
      sampleVoiceId: 'v_x',
      modelKey: 'qwen3-tts-0.6b',
    });
    expect(onApprove).not.toHaveBeenCalled();
  });

  it('Re-design designs a fresh preview from the edited persona', async () => {
    renderModal();
    fireEvent.change(screen.getByTestId('voice-compare-persona'), {
      target: { value: 'an edited persona' },
    });
    fireEvent.click(screen.getByTestId('voice-compare-redesign'));

    await waitFor(() => expect(api.designQwenVoice).toHaveBeenCalledTimes(1));
    expect(api.designQwenVoice).toHaveBeenCalledWith('b1', 'x', {
      persona: 'an edited persona',
      sampleVoiceId: 'v_x',
      modelKey: 'qwen3-tts-0.6b',
      preview: true,
    });
  });

  it('Regenerate fills the persona textarea from the generator', async () => {
    renderModal();
    fireEvent.click(screen.getByTestId('voice-compare-regenerate'));
    await waitFor(() =>
      expect((screen.getByTestId('voice-compare-persona') as HTMLTextAreaElement).value).toBe(
        'a fresh regenerated persona',
      ),
    );
    expect(api.generateVoiceStyle).toHaveBeenCalledWith('b1', 'x');
  });

  it('Play current injects the Qwen voiceId into overrideTtsVoices so the server can resolve it (regression: Play current did nothing)', async () => {
    renderModal({
      character: qwenCharacter,
      currentSubject: qwenCurrentSubject,
      currentModelKey: 'qwen3-tts-0.6b',
    });
    fireEvent.click(screen.getByTestId('voice-compare-current-play'));
    await waitFor(() => expect(playSampleWithAutoLoad).toHaveBeenCalledTimes(1));
    const arg = (playSampleWithAutoLoad as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(arg.args.voice.overrideTtsVoices.qwen.name).toBe('qwen-master-oduvan');
    expect(arg.args.modelKey).toBe('qwen3-tts-0.6b');
  });

  it('Side A shows the current voice descriptor line AND its persona', () => {
    renderModal({
      character: qwenCharacter,
      currentSubject: qwenCurrentSubject,
      currentModelKey: 'qwen3-tts-0.6b',
    });
    const descriptor = screen.getByTestId('voice-compare-current-name');
    expect(descriptor.textContent).toMatch(/Qwen/);
    expect(descriptor.textContent).toMatch(/Designed voice/);
    expect(screen.getByTestId('voice-compare-current-persona').textContent).toBe(
      'An elderly gravelly voice with a dry rasp.',
    );
  });

  it('a failing Play current surfaces an error instead of silently doing nothing', async () => {
    (playSampleWithAutoLoad as unknown as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error('Voice engine (:9000) is unreachable'),
    );
    renderModal({
      character: qwenCharacter,
      currentSubject: qwenCurrentSubject,
      currentModelKey: 'qwen3-tts-0.6b',
    });
    fireEvent.click(screen.getByTestId('voice-compare-current-play'));
    await waitFor(() =>
      expect(screen.getByTestId('voice-compare-current-error').textContent).toMatch(
        /unreachable/,
      ),
    );
  });
});
