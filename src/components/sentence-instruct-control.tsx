/* fs-56 — per-line free-text delivery-direction ("instruct") control.

   Mirrors SentenceEmotionControl: an inline chip rendered OUTSIDE the sentence
   text span (so it never perturbs the selection→split offset math), opening a
   small popover. Unlike emotion (a fixed menu), instruct is free text, so the
   popover hosts a <textarea> pre-filled with the line's current instruct —
   authored OR Stage-3-proposed (one field; the control is the single edit
   surface). A hand-set value wins because applyDetectedInstruct is fill-only.

   Audibility/staleness gate on the per-speaker 1.7B model key:
   `character?.ttsModelKey === 'qwen3-tts-1.7b'`. A line is audible iff its
   speaker renders on the 1.7B tier. Note: a character with a stale 1.7B key
   but a non-Qwen ttsEngine could be mis-classified as "audible" — PR4 only
   ever writes this key to Qwen members, matching the hasLiveInstructMember
   precedent (generation.tsx), so this is an accepted simplification. */

import { useEffect, useRef, useState } from 'react';
import { useAppDispatch } from '../store';
import { manuscriptActions } from '../store/manuscript-slice';
import { useMarkCharacterStaleIfRendered } from '../lib/stale-chapters';
import type { Character } from '../lib/types';

const PREVIEW_MAX = 24;

export function SentenceInstructControl({
  chapterId,
  sentenceId,
  instruct,
  character,
}: {
  chapterId: number;
  sentenceId: number;
  instruct?: string;
  character?: Character;
}) {
  const dispatch = useAppDispatch();
  const markStale = useMarkCharacterStaleIfRendered();
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(instruct ?? '');
  const ref = useRef<HTMLSpanElement>(null);
  const chipRef = useRef<HTMLButtonElement>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);

  // Re-sync the draft whenever the popover opens (instruct may have changed via
  // a Detect-emotions run since last open).
  useEffect(() => {
    if (open) {
      setDraft(instruct ?? '');
      taRef.current?.focus();
    }
  }, [open, instruct]);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);

  // 1.7B implies prosody: a line is audible iff its speaker renders on the 1.7B tier.
  const audible = character?.ttsModelKey === 'qwen3-tts-1.7b';

  const commit = (value: string) => {
    dispatch(manuscriptActions.setSentenceInstruct({ chapterId, sentenceId, instruct: value }));
    if (audible && character) markStale({ id: character.id, name: character.name });
    setOpen(false);
    chipRef.current?.focus();
  };

  const current = instruct?.trim() ? instruct.trim() : undefined;
  const preview = current
    ? current.length > PREVIEW_MAX
      ? current.slice(0, PREVIEW_MAX) + '…'
      : current
    : undefined;
  const inaudible = !audible;

  return (
    <span ref={ref} className="relative inline-block align-baseline select-none" contentEditable={false}>
      <button
        ref={chipRef}
        type="button"
        data-testid="instruct-chip"
        aria-label={current ? `Delivery direction: ${current} — edit` : 'Set delivery direction for this line'}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className={
          current
            ? `mx-0.5 inline-flex items-center min-h-[20px] px-1.5 rounded-full text-[10px] font-medium ${inaudible ? 'opacity-50 text-ink/40 bg-ink/5' : 'text-purple-deep/70 bg-purple-deep/5'}`
            : 'mx-0.5 inline-flex items-center justify-center min-w-[44px] min-h-[44px] sm:min-w-0 sm:min-h-0 sm:w-4 sm:h-4 rounded-full text-ink/30 opacity-0 group-hover:opacity-100 focus:opacity-100 coarse-pointer:opacity-40 align-middle transition-opacity'
        }
      >
        {preview ?? <span className="text-xs leading-none" aria-hidden>🎬</span>}
      </button>
      {open && (
        <span
          role="dialog"
          aria-label="Edit delivery direction"
          className="absolute z-50 left-0 top-full mt-1 max-w-[90vw] w-64 rounded-lg border border-ink/10 bg-white picker-surface shadow-lg p-2 flex flex-col gap-2"
        >
          <textarea
            ref={taRef}
            aria-label="Enter delivery direction"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                e.preventDefault();
                setOpen(false);
                chipRef.current?.focus();
              }
            }}
            rows={3}
            placeholder="e.g. a sharp, startled whisper"
            className="w-full max-h-32 resize-none rounded border border-ink/15 px-2 py-1 text-xs text-ink"
          />
          {inaudible && (
            <span className="text-[10px] text-ink/50">
              Delivery directions play when this character is on the Qwen 1.7B tier.
            </span>
          )}
          <div className="flex justify-end gap-2">
            <button type="button" onClick={() => commit('')} className="px-2 py-1 text-xs text-ink/60 hover:text-magenta min-h-[44px] sm:min-h-0">
              Clear
            </button>
            <button type="button" onClick={() => commit(draft)} className="px-2 py-1 text-xs font-semibold text-ink hover:text-magenta min-h-[44px] sm:min-h-0">
              Save
            </button>
          </div>
        </span>
      )}
    </span>
  );
}
