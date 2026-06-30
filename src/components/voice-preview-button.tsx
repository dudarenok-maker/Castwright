/* Per-candidate "Play sample" affordance for the profile drawer.
   Pairs with docs/features/archive/64-voice-preview-while-editing.md.

   Synthesizes a short user-editable preview line through the same
   sidecar lifecycle as the rest of the app — `playBaseVoiceSampleWithAutoLoad`
   handles evict-analyzer / load-sidecar / synth in one shot, so a fresh
   click from an idle box still plays. The candidate voice is a
   `BaseVoice` (engine + speakerName) because the preview is by definition
   read-only: no cast assignment is committed.

   The previous preview is implicitly stopped by the shared
   `useSamplePlayback` singleton — swapping the audio element's src
   counts as cancelling the current track (see use-sample-playback.ts:96).
   Each click therefore renders fresh audio without the component having
   to coordinate stop() calls between candidates. */

import { useState } from 'react';
import { IconWaveform, IconPause, IconSpinner } from '../lib/icons';
import { useSamplePlayback } from '../lib/use-sample-playback';
import {
  playBaseVoiceSampleWithAutoLoad,
  type SampleStatus,
} from '../lib/play-sample-with-auto-load';
import type { BaseVoice, TtsModelKey } from '../lib/types';

interface Props {
  /** Candidate voice to audition. Engine + name uniquely identifies the
      raw model voice; the server caches the synthesised audio by
      (engine, name, text) so re-clicking the same candidate with the
      same text replays instantly. */
  voice: BaseVoice;
  /** Project-active TTS model key. Forwarded so the sidecar route picks
      the right model when the candidate's engine != current engine
      (server re-maps to a compatible model — see
      `server/src/routes/voice-sample.ts`). */
  modelKey: TtsModelKey;
  /** Sample line to speak. Hoisted into the parent (profile drawer) so
      one input drives every candidate row's preview. */
  text: string;
  /** Optional aria-label override; defaults to "Play sample for <name>".
      Useful when the parent already labels the row with the voice name. */
  ariaLabel?: string;
  /** Per-row test id so e2e specs can target a specific candidate. */
  testId?: string;
}

/* Stable preview-url prefix used to detect "this candidate's preview is
   currently playing". Server names preview cache files
   /audio/voices/raw-<engine>-<name>-<modelKey>-<paramHash>.mp3
   (see server/src/routes/voice-sample.ts buildCacheFilename). The hash
   depends on (text, voiceName) so we match by prefix — text edits don't
   need to invalidate the "is-playing-this" check. */
function previewUrlPrefixFor(voice: BaseVoice, modelKey: TtsModelKey): string {
  const carrier = `raw-${voice.engine}-${voice.name}`;
  return `/audio/voices/${encodeURIComponent(carrier)}-${modelKey}`;
}

export function VoicePreviewButton({ voice, modelKey, text, ariaLabel, testId }: Props) {
  const playback = useSamplePlayback();
  const [status, setStatus] = useState<SampleStatus | 'idle'>('idle');
  const [error, setError] = useState<string | null>(null);
  const isLoading = status !== 'idle';
  const isPlayingThis =
    playback.isPlaying && !!playback.currentUrl?.startsWith(previewUrlPrefixFor(voice, modelKey));

  async function onClick() {
    if (isPlayingThis) {
      playback.stop();
      return;
    }
    setError(null);
    setStatus('synthesizing');
    try {
      await playBaseVoiceSampleWithAutoLoad({
        args: { engine: voice.engine, speakerName: voice.name, modelKey, text },
        playback,
        onStatus: (next) => setStatus(next),
      });
    } catch (err) {
      setError((err as Error).message || 'Preview failed.');
    } finally {
      setStatus('idle');
    }
  }

  const label = ariaLabel ?? `Play sample for ${voice.name}`;

  return (
    <div className="inline-flex flex-col items-start gap-1">
      <button
        type="button"
        onClick={onClick}
        disabled={isLoading}
        aria-label={label}
        data-testid={testId}
        className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-semibold transition-colors ${
          isLoading
            ? 'bg-magenta/10 text-magenta cursor-wait'
            : isPlayingThis
              ? 'bg-magenta text-white hover:bg-magenta/90'
              : 'bg-magenta/10 text-magenta hover:bg-magenta/20'
        }`}
      >
        {isLoading ? (
          <>
            <IconSpinner className="w-3 h-3" />
            <span>{previewLoadingLabel(status)}</span>
          </>
        ) : isPlayingThis ? (
          <>
            <IconPause className="w-3 h-3" />
            <span>Stop</span>
          </>
        ) : (
          <>
            <IconWaveform className="w-3 h-3" />
            <span>Play sample</span>
          </>
        )}
      </button>
      {error && (
        <p className="text-[10px] text-red-600/90 font-medium" role="alert">
          ⚠ {error}
        </p>
      )}
    </div>
  );
}

function previewLoadingLabel(status: SampleStatus | 'idle'): string {
  switch (status) {
    case 'evicting':
      return 'Freeing memory…';
    case 'loading-tts':
      return 'Loading voice engine…';
    case 'synthesizing':
    case 'idle':
    default:
      return 'Synthesising…';
  }
}
