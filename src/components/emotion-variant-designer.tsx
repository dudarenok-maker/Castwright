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
import { playSampleWithAutoLoad } from '../lib/play-sample-with-auto-load';
import { buildCharacterHint } from '../lib/build-character-hint';
import { resolveTtsVoiceForCharacter } from '../lib/tts-voice-mapping';
import { gradientForTtsVoice } from '../lib/voice-palette';
import { useMarkCharacterStaleIfRendered } from '../lib/stale-chapters';
import { IconPlay, IconSpinner, IconTrash } from '../lib/icons';
import type { Character, Emotion, TtsModelKey, Voice } from '../lib/types';

const VARIANT_EMOTIONS: { value: Exclude<Emotion, 'neutral'>; label: string }[] = [
  { value: 'whisper', label: 'Whisper' },
  { value: 'angry', label: 'Angry' },
  { value: 'excited', label: 'Excited' },
  { value: 'sad', label: 'Sad' },
];

export function EmotionVariantDesigner({
  bookId,
  character,
  sampleVoiceId,
  modelKey,
  baseDesigned,
  variants,
}: {
  bookId: string;
  character: Character;
  sampleVoiceId: string;
  modelKey: TtsModelKey;
  /** True once the neutral base Qwen voice has been designed. */
  baseDesigned: boolean;
  /** The character's current designed variants, keyed by emotion. */
  variants: Partial<Record<string, { name: string }>> | undefined;
}) {
  const characterId = character.id;
  const dispatch = useAppDispatch();
  const playback = useSamplePlayback();
  const markStale = useMarkCharacterStaleIfRendered();
  const [busy, setBusy] = useState<Record<string, boolean>>({});
  /* Variant voiceIds designed THIS session (merged with the `variants` prop so
     a just-designed variant resolves before the parent's redux round-trip). */
  const [sessionIds, setSessionIds] = useState<Record<string, string>>({});
  const [playBusy, setPlayBusy] = useState<Record<string, boolean>>({});
  const [removeBusy, setRemoveBusy] = useState<Record<string, boolean>>({});
  const [error, setError] = useState<string | null>(null);

  const variantVoiceId = (emotion: string): string | undefined =>
    variants?.[emotion]?.name ?? sessionIds[emotion];

  /* Audition any designed variant (this or a prior session) by replaying its
     cached 12s sample through the shared sample machinery — the variant scope
     `${sampleVoiceId}__${emotion}` + the variant voiceId reproduce the cache
     key the design route wrote, so it's a hit (no re-synth) on a warm sidecar. */
  const playVariant = async (emotion: Exclude<Emotion, 'neutral'>) => {
    const voiceId = variantVoiceId(emotion);
    if (!voiceId) return;
    const scope = `${sampleVoiceId}__${emotion}`;
    const prefix = `/audio/voices/${encodeURIComponent(scope)}-${modelKey}`;
    if (playback.isPlaying && playback.currentUrl?.startsWith(prefix)) {
      playback.stop();
      return;
    }
    const stubTtsVoice = resolveTtsVoiceForCharacter(character, 'qwen');
    const subject: Voice = {
      id: scope,
      character: character.name,
      bookTitle: '',
      bookId: '',
      attributes: character.attributes ?? [],
      gradient: gradientForTtsVoice(stubTtsVoice.name, scope),
      usedIn: 0,
      source: 'current',
      ttsVoice: stubTtsVoice,
      overrideTtsVoices: { qwen: { name: voiceId } },
    } as Voice;
    setPlayBusy((p) => ({ ...p, [emotion]: true }));
    setError(null);
    try {
      await playSampleWithAutoLoad({
        args: { voiceId: scope, voice: subject, modelKey, characterHint: buildCharacterHint(character) },
        playback,
      });
    } catch (e) {
      setError(`${emotion}: ${(e as Error).message}`);
    } finally {
      setPlayBusy((p) => ({ ...p, [emotion]: false }));
    }
  };

  if (!baseDesigned) {
    return (
      <p data-testid="variant-gate-hint" className="text-xs text-ink/50 mt-2">
        Emotion variants become available once this character has a designed base voice.
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
      setSessionIds((s) => ({ ...s, [emotion]: voiceId }));
      /* A (re)designed variant changes how this character's tagged lines render,
         so any already-rendered chapter they speak in is now stale. */
      markStale(character);
      /* Auto-play the fresh audition (the design route returns its cached URL),
         so designing a variant immediately lets you hear it. */
      if (previewUrl) void playback.play(previewUrl);
    } catch (e) {
      setError(`${emotion}: ${(e as Error).message}`);
    } finally {
      setBusy((b) => ({ ...b, [emotion]: false }));
    }
  };

  /* fs-34 — discard a designed variant (drops the slot + its .pt server-side).
     The base voice and sibling variants are untouched; removing one also marks
     rendered chapters stale since those tagged lines now fall back to base. */
  const removeOne = async (emotion: Exclude<Emotion, 'neutral'>) => {
    setRemoveBusy((b) => ({ ...b, [emotion]: true }));
    setError(null);
    try {
      await api.removeQwenVariant(bookId, characterId, emotion);
      dispatch(castActions.removeCharacterEmotionVariant({ characterId, emotion }));
      setSessionIds((s) => {
        const { [emotion]: _dropped, ...rest } = s;
        return rest;
      });
      markStale(character);
    } catch (e) {
      setError(`${emotion}: ${(e as Error).message}`);
    } finally {
      setRemoveBusy((b) => ({ ...b, [emotion]: false }));
    }
  };

  const remaining = VARIANT_EMOTIONS.filter((e) => !variantVoiceId(e.value));
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
          /* Designed if the cast carries the variant OR we designed it this
             session — so the row flips to "Designed + Play" immediately,
             before the parent's redux round-trip lands. */
          const designed = !!variantVoiceId(value);
          const designing = !!busy[value];
          return (
            <div
              key={value}
              className="flex items-center justify-between gap-2 px-2 py-1.5 rounded-lg border border-ink/10 text-xs min-h-[44px] sm:min-h-0"
            >
              <span className="text-ink/80">{label}</span>
              {designed ? (
                <span className="inline-flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => void playVariant(value)}
                    disabled={!!playBusy[value]}
                    aria-label={`Play the ${label} variant sample`}
                    data-testid={`variant-play-${value}`}
                    className="inline-flex items-center justify-center w-4 h-4 text-magenta hover:text-magenta/80 disabled:opacity-40"
                  >
                    {playBusy[value] ? (
                      <IconSpinner className="w-3 h-3 animate-spin" />
                    ) : (
                      <IconPlay className="w-3.5 h-3.5" />
                    )}
                  </button>
                  <span className="text-[10px] font-semibold text-ink/55" data-testid={`variant-done-${value}`}>
                    Designed
                  </span>
                  <button
                    type="button"
                    onClick={() => void removeOne(value)}
                    disabled={!!removeBusy[value]}
                    aria-label={`Remove the ${label} variant`}
                    data-testid={`variant-remove-${value}`}
                    className="inline-flex items-center justify-center w-4 h-4 text-ink/40 hover:text-magenta disabled:opacity-40"
                  >
                    {removeBusy[value] ? (
                      <IconSpinner className="w-3 h-3 animate-spin" />
                    ) : (
                      <IconTrash className="w-3.5 h-3.5" />
                    )}
                  </button>
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
