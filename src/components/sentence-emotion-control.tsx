/* fs-25 — per-quote emotion control for the manuscript view.

   Shows a sentence's delivery emotion as a small chip and lets the user change
   it from a fixed menu (neutral/whisper/angry/excited/sad). A hand-set value is
   the manual override that wins over analyzer/seed emotion and persists through
   the manuscript-edits store. `neutral` clears the field.

   Rendered OUTSIDE the sentence text span so it never perturbs the
   selection→split offset math (which keys on `data-text-offset` inside the
   text). Engine-agnostic by design: the tag is additive data that only becomes
   audible on Qwen (variant selection); on Kokoro/XTTS it's a no-op, so the
   control still lets you tag (it survives an engine switch). */

import { useEffect, useRef, useState } from 'react';
import { useAppDispatch } from '../store';
import { manuscriptActions } from '../store/manuscript-slice';
import { useSamplePlayback } from '../lib/use-sample-playback';
import {
  playEmotionVariantSample,
  variantVoiceIdFor,
} from '../lib/play-emotion-variant';
import { useMarkCharacterStaleIfRendered } from '../lib/stale-chapters';
import { IconPlay, IconSpinner } from '../lib/icons';
import type { Character, Emotion } from '../lib/types';

export const EMOTION_OPTIONS: { value: Emotion; label: string }[] = [
  { value: 'neutral', label: 'Neutral' },
  { value: 'whisper', label: 'Whisper' },
  { value: 'angry', label: 'Angry' },
  { value: 'excited', label: 'Excited' },
  { value: 'sad', label: 'Sad' },
];

/* Subtle per-emotion tint so a tagged quote reads at a glance. Neutral has no
   chip. Uses design tokens only (no hex literals). */
const EMOTION_CLASS: Record<Exclude<Emotion, 'neutral'>, string> = {
  whisper: 'text-purple-deep/70 bg-purple-deep/5',
  angry: 'text-magenta bg-magenta/8',
  excited: 'text-magenta bg-peach/20',
  sad: 'text-ink/55 bg-ink/5',
};

export function SentenceEmotionControl({
  chapterId,
  sentenceId,
  emotion,
  character,
}: {
  chapterId: number;
  sentenceId: number;
  emotion?: Emotion;
  /** fe-31 — the sentence's speaking character, threaded so the chip can
      preview the designed emotion variant. Absent → no preview affordance
      (e.g. an unresolved characterId). */
  character?: Character;
}) {
  const dispatch = useAppDispatch();
  const playback = useSamplePlayback();
  const markStale = useMarkCharacterStaleIfRendered();
  const [open, setOpen] = useState(false);
  const [previewing, setPreviewing] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const ref = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);

  const current = emotion && emotion !== 'neutral' ? emotion : undefined;
  const choose = (value: Emotion) => {
    dispatch(manuscriptActions.setSentenceEmotion({ chapterId, sentenceId, emotion: value }));
    /* fs-34 — an emotion edit only changes the audio when it actually selects a
       different voice: a Qwen character WITH a designed variant for this emotion.
       Otherwise synth is byte-identical (plan-177 invariant), so don't raise a
       false-positive stale banner. */
    if (
      value !== 'neutral' &&
      character?.ttsEngine === 'qwen' &&
      variantVoiceIdFor(character, value)
    ) {
      markStale({ id: character.id, name: character.name });
    }
    setNote(null);
    setOpen(false);
  };

  /* fe-31 — only Qwen renders emotion variants audibly; Kokoro/XTTS ignore the
     tag, so the preview is disabled there with an explanatory tooltip. */
  const isQwen = character?.ttsEngine === 'qwen';
  const hasVariant = current && character ? !!variantVoiceIdFor(character, current) : false;
  const firstName = character ? character.name.split(' ')[0] || character.name : '';

  const preview = async () => {
    if (!current || !character || !isQwen || previewing) return;
    setPreviewing(true);
    setNote(null);
    try {
      const { fellBackToBase } = await playEmotionVariantSample(character, current, playback);
      if (fellBackToBase) {
        setNote(`no ${current} variant for ${firstName} — renders neutral`);
      }
    } catch (e) {
      setNote((e as Error).message);
    } finally {
      setPreviewing(false);
    }
  };

  return (
    <span ref={ref} className="relative inline-block align-baseline select-none" contentEditable={false}>
      <button
        type="button"
        data-testid="emotion-chip"
        aria-label={current ? `Emotion: ${current} — change` : 'Set emotion for this line'}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className={
          current
            ? `mx-0.5 inline-flex items-center min-h-[20px] px-1.5 rounded-full text-[10px] font-semibold uppercase tracking-wide ${EMOTION_CLASS[current]}`
            : 'mx-0.5 inline-flex items-center justify-center min-w-[44px] min-h-[44px] sm:min-w-0 sm:min-h-0 sm:w-4 sm:h-4 rounded-full text-ink/30 hover:text-ink/60 coarse-pointer:text-ink/40 align-middle'
        }
      >
        {current ?? <span className="text-xs leading-none" aria-hidden>🎭</span>}
      </button>
      {/* fe-31 — preview the designed emotion variant. Only shown for a tagged
          (non-neutral) line that has a resolved character. Disabled for non-Qwen
          engines (the tag is inaudible there). */}
      {current && character && (
        <button
          type="button"
          data-testid="emotion-preview"
          disabled={!isQwen || previewing}
          aria-label={
            isQwen
              ? `Preview ${current} delivery for ${firstName}`
              : 'Emotion only audible on Qwen'
          }
          title={
            isQwen
              ? hasVariant
                ? `Preview ${current} variant`
                : `Preview (no ${current} variant — renders neutral)`
              : 'Emotion only audible on Qwen'
          }
          onClick={() => void preview()}
          className="mx-0.5 inline-flex items-center justify-center min-w-[44px] min-h-[44px] sm:min-w-0 sm:min-h-0 sm:w-4 sm:h-4 rounded-full align-middle text-ink/40 hover:text-magenta disabled:opacity-40 disabled:hover:text-ink/40"
        >
          {previewing ? (
            <IconSpinner className="w-3 h-3 animate-spin" />
          ) : (
            <IconPlay className="w-3 h-3" />
          )}
        </button>
      )}
      {note && (
        <span
          data-testid="emotion-preview-note"
          className="mx-0.5 text-[10px] text-ink/50 align-middle"
        >
          {note}
        </span>
      )}
      {open && (
        <span
          role="menu"
          className="absolute z-50 left-0 top-full mt-1 min-w-[120px] rounded-lg border border-ink/10 bg-white picker-surface shadow-lg py-1 flex flex-col"
        >
          {EMOTION_OPTIONS.map((opt) => (
            <button
              key={opt.value}
              type="button"
              role="menuitem"
              onClick={() => choose(opt.value)}
              className={`text-left px-3 py-1.5 text-xs hover:bg-ink/5 min-h-[44px] sm:min-h-0 ${
                (opt.value === 'neutral' && !current) || opt.value === current
                  ? 'font-semibold text-ink'
                  : 'text-ink/70'
              }`}
            >
              {opt.label}
            </button>
          ))}
        </span>
      )}
    </span>
  );
}
