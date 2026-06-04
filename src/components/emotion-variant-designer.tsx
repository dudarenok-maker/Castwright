/* fs-25 — cast/profile-drawer controls for designing a Qwen character's
   emotion VARIANTS (whisper/angry/excited/sad). Gated on the neutral BASE voice
   existing — until then the controls are replaced by a "Design the main voice
   first" hint (a variant is designed from the persona + an emotion clause, and
   only makes sense once the base identity is set). Neutral is the base, never a
   variant.

   Each variant designs INDEPENDENTLY via the existing design route (Wave 3,
   `api.designQwenVoice` with `emotion`); designing one never blocks the others,
   and "Design all remaining" fires the not-yet-designed ones in sequence. On
   success the variant is recorded in redux (`setCharacterEmotionVariant`) so the
   Variants badge + cast filter update live — the server already persisted it. */

import { useState } from 'react';
import { api } from '../lib/api';
import { useAppDispatch } from '../store';
import { castActions } from '../store/cast-slice';
import { useSamplePlayback } from '../lib/use-sample-playback';
import { IconPlay, IconSpinner } from '../lib/icons';
import type { Emotion, TtsModelKey } from '../lib/types';

const VARIANT_EMOTIONS: { value: Exclude<Emotion, 'neutral'>; label: string }[] = [
  { value: 'whisper', label: 'Whisper' },
  { value: 'angry', label: 'Angry' },
  { value: 'excited', label: 'Excited' },
  { value: 'sad', label: 'Sad' },
];

export function EmotionVariantDesigner({
  bookId,
  characterId,
  sampleVoiceId,
  modelKey,
  baseDesigned,
  variants,
}: {
  bookId: string;
  characterId: string;
  sampleVoiceId: string;
  modelKey: TtsModelKey;
  /** True once the neutral base Qwen voice has been designed. */
  baseDesigned: boolean;
  /** The character's current designed variants, keyed by emotion. */
  variants: Partial<Record<string, { name: string }>> | undefined;
}) {
  const dispatch = useAppDispatch();
  const playback = useSamplePlayback();
  const [busy, setBusy] = useState<Record<string, boolean>>({});
  /* Audition URL per emotion, captured from the design response so a
     just-designed variant can be previewed without a full generation run.
     (Playback for a variant designed in a PRIOR session is the deferred 5d
     follow-up — its audition is cached server-side but not yet wired here.) */
  const [urls, setUrls] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);

  if (!baseDesigned) {
    return (
      <p data-testid="variant-gate-hint" className="text-xs text-ink/50 mt-2">
        Design the main voice first to add emotion variants.
      </p>
    );
  }

  const designOne = async (emotion: Exclude<Emotion, 'neutral'>) => {
    setBusy((b) => ({ ...b, [emotion]: true }));
    setError(null);
    try {
      const { voiceId, previewUrl } = await api.designQwenVoice(bookId, characterId, {
        sampleVoiceId: `${sampleVoiceId}__${emotion}`,
        modelKey,
        emotion,
      });
      dispatch(castActions.setCharacterEmotionVariant({ characterId, emotion, voiceId }));
      if (previewUrl) {
        setUrls((u) => ({ ...u, [emotion]: previewUrl }));
        void playback.play(previewUrl);
      }
    } catch (e) {
      setError(`${emotion}: ${(e as Error).message}`);
    } finally {
      setBusy((b) => ({ ...b, [emotion]: false }));
    }
  };

  const remaining = VARIANT_EMOTIONS.filter((e) => !variants?.[e.value]);
  const designAll = async () => {
    for (const e of remaining) await designOne(e.value);
  };

  return (
    <div data-testid="variant-designer" className="mt-3">
      <div className="flex items-center justify-between mb-1.5">
        <span className="text-xs font-semibold text-ink/70">Emotion variants</span>
        {remaining.length > 1 && (
          <button
            type="button"
            onClick={designAll}
            disabled={Object.values(busy).some(Boolean)}
            className="text-[11px] text-magenta hover:underline disabled:opacity-40 min-h-[44px] sm:min-h-0"
          >
            Design all remaining
          </button>
        )}
      </div>
      <div className="grid grid-cols-2 gap-1.5">
        {VARIANT_EMOTIONS.map(({ value, label }) => {
          /* Designed if the cast already carries the variant OR we just designed
             it this session (url captured) — so the row flips to "Designed +
             Play" immediately, before the parent's redux round-trip lands. */
          const designed = !!variants?.[value] || !!urls[value];
          const designing = !!busy[value];
          return (
            <div
              key={value}
              className="flex items-center justify-between gap-2 px-2 py-1.5 rounded-lg border border-ink/10 text-xs min-h-[44px] sm:min-h-0"
            >
              <span className="text-ink/80">{label}</span>
              {designed ? (
                <span className="inline-flex items-center gap-2">
                  {urls[value] && (
                    <button
                      type="button"
                      onClick={() =>
                        playback.currentUrl === urls[value] ? playback.stop() : void playback.play(urls[value])
                      }
                      aria-label={`Play the ${label} variant sample`}
                      data-testid={`variant-play-${value}`}
                      className="inline-flex items-center justify-center w-4 h-4 text-magenta hover:text-magenta/80"
                    >
                      <IconPlay className="w-3.5 h-3.5" />
                    </button>
                  )}
                  <span className="text-[10px] font-semibold text-ink/55" data-testid={`variant-done-${value}`}>
                    Designed
                  </span>
                </span>
              ) : (
                <button
                  type="button"
                  onClick={() => designOne(value)}
                  disabled={designing}
                  aria-label={`Design the ${label} variant`}
                  className="inline-flex items-center gap-1 text-[11px] text-magenta hover:underline disabled:opacity-40"
                >
                  {designing && <IconSpinner className="w-3 h-3 animate-spin" />}
                  {designing ? 'Designing…' : 'Design'}
                </button>
              )}
            </div>
          );
        })}
      </div>
      {error && <p className="text-[11px] text-magenta mt-1.5">{error}</p>}
    </div>
  );
}
