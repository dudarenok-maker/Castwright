import { useState } from 'react';
import { IconPlay, IconClose } from '../lib/icons';
import { PrimaryButton } from '../components/primitives';
import type { TtsModelKey } from '../lib/types';

/* P3 — the pre-generation "Choose voice model" prompt. Shown for Qwen books the
   moment the user starts a run, so the quality tier is an explicit choice rather
   than a silent default. The two Qwen tiers mirror the RegenerateModal picker;
   the selected tier is applied to the whole cast (authoritative) by the host
   before generation starts. */
const TIERS: { id: TtsModelKey; label: string; hint: string }[] = [
  { id: 'qwen3-tts-0.6b', label: 'Qwen3-TTS 0.6B', hint: 'Faster · lighter on VRAM' },
  {
    id: 'qwen3-tts-1.7b',
    label: 'Qwen3-TTS 1.7B',
    hint: 'Higher quality + expressive prosody · slower, heavier',
  },
];

interface Props {
  /** Pre-selected tier — 1.7B when the cast is already pinned to it, else 0.6B. */
  defaultTier: TtsModelKey;
  /** True while the host applies the chosen tier to the cast (disables the CTA). */
  busy?: boolean;
  onClose: () => void;
  onConfirm: (tier: TtsModelKey) => void;
}

export function StartGenerationModal({ defaultTier, busy = false, onClose, onConfirm }: Props) {
  /* If the cast is pinned to a tier not in TIERS (shouldn't happen), fall back
     to 0.6B so the modal always has a valid selection. */
  const initial = TIERS.some((t) => t.id === defaultTier) ? defaultTier : 'qwen3-tts-0.6b';
  const [tier, setTier] = useState<TtsModelKey>(initial);
  return (
    <>
      <div onClick={busy ? undefined : onClose} className="fixed inset-0 bg-ink/40 z-50 fade-in" />
      <div className="fixed inset-0 z-50 grid place-items-center p-6 pointer-events-none">
        <div className="bg-white rounded-3xl shadow-float w-full max-w-lg pointer-events-auto fade-in overflow-hidden flex flex-col">
          <div className="px-6 py-4 border-b border-ink/10 flex items-center gap-3">
            <span className="w-9 h-9 rounded-full bg-peach/15 grid place-items-center text-magenta">
              <IconPlay className="w-4 h-4" />
            </span>
            <div className="flex-1 min-w-0">
              <p className="text-[10px] uppercase tracking-widest text-ink/50 font-semibold">
                Start generation
              </p>
              <h3 className="text-base font-bold text-ink truncate">Choose the voice model</h3>
            </div>
            <button
              onClick={onClose}
              disabled={busy}
              className="p-2 rounded-full hover:bg-ink/5 text-ink/60 disabled:opacity-40"
            >
              <IconClose className="w-4 h-4" />
            </button>
          </div>

          <div className="p-6 space-y-3">
            <p className="text-xs text-ink/60 leading-relaxed">
              The higher-quality 1.7B model renders more expressive prosody but is slower and uses
              more VRAM. Applied to the whole cast for this book.
            </p>
            <div className="grid grid-cols-1 gap-2">
              {TIERS.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  onClick={() => setTier(t.id)}
                  aria-pressed={tier === t.id}
                  data-testid={`start-gen-tier-${t.id}`}
                  className={`text-left p-3 rounded-2xl border transition-all min-h-[44px] ${tier === t.id ? 'border-peach bg-peach/6' : 'border-ink/10 hover:border-ink/20'}`}
                >
                  <p className="text-sm font-semibold text-ink">{t.label}</p>
                  <p className="text-xs text-ink/55 mt-0.5">{t.hint}</p>
                </button>
              ))}
            </div>
          </div>

          <div className="px-6 py-4 border-t border-ink/10 flex items-center justify-end gap-3">
            <button
              onClick={onClose}
              disabled={busy}
              className="text-sm font-medium text-ink/60 hover:text-ink disabled:opacity-40"
            >
              Cancel
            </button>
            <PrimaryButton variant="dark" disabled={busy} onClick={() => onConfirm(tier)}>
              {busy ? 'Applying…' : 'Start generating'}
            </PrimaryButton>
          </div>
        </div>
      </div>
    </>
  );
}
