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
import type { Emotion } from '../lib/types';

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
}: {
  chapterId: number;
  sentenceId: number;
  emotion?: Emotion;
}) {
  const dispatch = useAppDispatch();
  const [open, setOpen] = useState(false);
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
    setOpen(false);
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
      {open && (
        <span
          role="menu"
          className="absolute z-30 left-0 top-full mt-1 min-w-[120px] rounded-lg border border-ink/10 bg-canvas shadow-lg py-1 flex flex-col"
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
