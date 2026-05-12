import { useState } from 'react';
import { IconRefresh, IconClose, IconClock } from '../lib/icons';
import { PrimaryButton } from '../components/primitives';
import { REGEN_REASONS } from '../data/regen-reasons';
import type { Chapter } from '../lib/types';

export type RegenScope = 'this' | 'forward';

interface Props {
  chapter: Chapter | null;
  onClose: () => void;
  onConfirm: (args: { reason: string; scope: RegenScope; note: string }) => void;
}

export function RegenerateModal({ chapter, onClose, onConfirm }: Props) {
  const [reason, setReason] = useState('voice');
  const [scope, setScope]   = useState<RegenScope>('this');
  const [note, setNote]     = useState('');
  if (!chapter) return null;
  const eta = scope === 'this' ? '≈3 min' : '≈14 min for 4 chapters';
  return (
    <>
      <div onClick={onClose} className="fixed inset-0 bg-ink/40 z-50 fade-in"/>
      <div className="fixed inset-0 z-50 grid place-items-center p-6 pointer-events-none">
        <div className="bg-white rounded-3xl shadow-float w-full max-w-xl pointer-events-auto fade-in overflow-hidden">
          <div className="px-6 py-4 border-b border-ink/10 flex items-center gap-3">
            <span className="w-9 h-9 rounded-full bg-peach/15 grid place-items-center text-magenta"><IconRefresh className="w-4 h-4"/></span>
            <div className="flex-1 min-w-0">
              <p className="text-[10px] uppercase tracking-widest text-ink/50 font-semibold">Regenerate</p>
              <h3 className="text-base font-bold text-ink truncate">CH {String(chapter.id).padStart(2, '0')} · {chapter.title}</h3>
            </div>
            <button onClick={onClose} className="p-2 rounded-full hover:bg-ink/5 text-ink/60"><IconClose className="w-4 h-4"/></button>
          </div>

          <div className="p-6 space-y-6">
            <section>
              <p className="text-[11px] uppercase tracking-wider text-ink/50 font-semibold mb-3">What changed?</p>
              <div className="space-y-2">
                {REGEN_REASONS.map(r => (
                  <button key={r.id} onClick={() => setReason(r.id)} className={`w-full text-left p-3 rounded-2xl border transition-all flex items-start gap-3 ${reason === r.id ? 'border-peach bg-peach/[0.06]' : 'border-ink/10 hover:border-ink/20'}`}>
                    <span className={`w-4 h-4 rounded-full border-2 grid place-items-center mt-0.5 shrink-0 ${reason === r.id ? 'border-peach' : 'border-ink/20'}`}>
                      {reason === r.id && <span className="w-1.5 h-1.5 rounded-full bg-peach"/>}
                    </span>
                    <span className="min-w-0">
                      <span className="block text-sm font-semibold text-ink">{r.label}</span>
                      <span className="block text-xs text-ink/60 mt-0.5 leading-relaxed">{r.description}</span>
                      {r.custom && reason === r.id && (
                        <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="What changed?" className="mt-2 w-full px-3 py-2 rounded-xl bg-white border border-ink/10 text-sm focus:outline-none focus:border-peach"/>
                      )}
                    </span>
                  </button>
                ))}
              </div>
            </section>

            <section>
              <p className="text-[11px] uppercase tracking-wider text-ink/50 font-semibold mb-3">How much to regenerate?</p>
              <div className="grid grid-cols-2 gap-2">
                <button onClick={() => setScope('this')} className={`text-left p-3 rounded-2xl border transition-all ${scope === 'this' ? 'border-peach bg-peach/[0.06]' : 'border-ink/10 hover:border-ink/20'}`}>
                  <p className="text-sm font-semibold text-ink">Just this chapter</p>
                  <p className="text-xs text-ink/55 mt-0.5">Fast, safe — keeps everything else intact.</p>
                </button>
                <button onClick={() => setScope('forward')} className={`text-left p-3 rounded-2xl border transition-all ${scope === 'forward' ? 'border-peach bg-peach/[0.06]' : 'border-ink/10 hover:border-ink/20'}`}>
                  <p className="text-sm font-semibold text-ink">This and all subsequent</p>
                  <p className="text-xs text-ink/55 mt-0.5">Use when a voice change should propagate forward.</p>
                </button>
              </div>
            </section>

            <div className="p-4 rounded-2xl bg-canvas border border-ink/10 flex items-center gap-3">
              <span className="w-9 h-9 rounded-full bg-white border border-ink/10 grid place-items-center text-ink/70"><IconClock className="w-4 h-4"/></span>
              <div className="flex-1 min-w-0">
                <p className="text-xs uppercase tracking-wider text-ink/50 font-semibold">Estimated time</p>
                <p className="text-sm font-bold text-ink tabular-nums">{eta}</p>
              </div>
              <span className="text-xs text-ink/55">Existing audio remains available until the new version is ready.</span>
            </div>
          </div>

          <div className="px-6 py-4 border-t border-ink/10 flex items-center justify-end gap-3">
            <button onClick={onClose} className="text-sm font-medium text-ink/60 hover:text-ink">Cancel</button>
            <PrimaryButton variant="dark" onClick={() => onConfirm({ reason, scope, note })}>Regenerate</PrimaryButton>
          </div>
        </div>
      </div>
    </>
  );
}
