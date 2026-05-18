import { useState } from 'react';
import { IconRefresh, IconClose, IconClock } from '../lib/icons';
import { Avatar, PrimaryButton } from '../components/primitives';
import { REGEN_REASONS } from '../data/regen-reasons';
import type { Character, Chapter, CharColor } from '../lib/types';

interface Props {
  characterIds: string[];
  characters: Character[];
  chapters: Chapter[];
  onClose: () => void;
  onConfirm: (args: {
    characterIds: string[];
    chapterIds: number[];
    reason: string;
    note: string;
  }) => void;
}

export function BatchCharacterRegenerateModal({
  characterIds,
  characters,
  chapters,
  onClose,
  onConfirm,
}: Props) {
  const selectedChars = characterIds
    .map((id) => characters.find((c) => c.id === id))
    .filter(Boolean) as Character[];
  const [scope, setScope] = useState<'all' | 'recent'>('all');
  const [reason, setReason] = useState('voice');
  const [note, setNote] = useState('');
  if (selectedChars.length === 0) return null;

  const chapterIds = chapters
    .filter((ch) =>
      selectedChars.some((c) => ch.characters[c.id] && ch.characters[c.id] !== 'skipped'),
    )
    .map((ch) => ch.id);
  const totalLines = selectedChars.reduce((s, c) => s + (c.lines ?? 0), 0);
  const eta = `≈${Math.max(2, Math.round(totalLines / 60))} min`;

  return (
    <>
      <div onClick={onClose} className="fixed inset-0 bg-ink/40 z-50 fade-in" />
      <div className="fixed inset-0 z-50 grid place-items-center p-6 pointer-events-none">
        <div className="bg-white rounded-3xl shadow-float w-full max-w-xl pointer-events-auto fade-in overflow-hidden max-h-[90vh] flex flex-col">
          <div className="px-6 py-4 border-b border-ink/10 flex items-center gap-3">
            <span className="w-10 h-10 rounded-full bg-peach/15 grid place-items-center text-magenta">
              <IconRefresh className="w-5 h-5" />
            </span>
            <div className="flex-1 min-w-0">
              <p className="text-[10px] uppercase tracking-widest text-ink/50 font-semibold">
                Batch regenerate
              </p>
              <h3 className="text-base font-bold text-ink truncate">
                {selectedChars.length} characters' lines
              </h3>
            </div>
            <button onClick={onClose} className="p-2 rounded-full hover:bg-ink/5 text-ink/60">
              <IconClose className="w-4 h-4" />
            </button>
          </div>

          <div className="p-6 space-y-6 overflow-y-auto scrollbar-thin">
            <section>
              <p className="text-[11px] uppercase tracking-wider text-ink/50 font-semibold mb-2">
                Regenerating
              </p>
              <div className="flex flex-wrap gap-2">
                {selectedChars.map((c) => (
                  <span
                    key={c.id}
                    className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full bg-canvas border border-ink/10"
                  >
                    <Avatar name={c.name} color={c.color as CharColor} size={20} />
                    <span className="text-sm font-medium text-ink">{c.name}</span>
                    <span className="text-[11px] text-ink/55 tabular-nums">{c.lines}</span>
                  </span>
                ))}
              </div>
            </section>

            <section>
              <p className="text-[11px] uppercase tracking-wider text-ink/50 font-semibold mb-3">
                Scope
              </p>
              <div className="grid grid-cols-2 gap-2">
                <button
                  onClick={() => setScope('all')}
                  className={`text-left p-3 rounded-2xl border transition-all ${scope === 'all' ? 'border-peach bg-peach/[0.06]' : 'border-ink/10 hover:border-ink/20'}`}
                >
                  <p className="text-sm font-semibold text-ink">All chapters where they appear</p>
                  <p className="text-xs text-ink/55 mt-0.5">
                    {chapterIds.length} chapters · {totalLines} total lines
                  </p>
                </button>
                <button
                  onClick={() => setScope('recent')}
                  className={`text-left p-3 rounded-2xl border transition-all ${scope === 'recent' ? 'border-peach bg-peach/[0.06]' : 'border-ink/10 hover:border-ink/20'}`}
                >
                  <p className="text-sm font-semibold text-ink">
                    Only chapters after the last cast change
                  </p>
                  <p className="text-xs text-ink/55 mt-0.5">
                    Skips chapters voiced before the most recent edit.
                  </p>
                </button>
              </div>
            </section>

            <section>
              <p className="text-[11px] uppercase tracking-wider text-ink/50 font-semibold mb-3">
                What changed?
              </p>
              <div className="space-y-2">
                {REGEN_REASONS.map((r) => (
                  <button
                    key={r.id}
                    onClick={() => setReason(r.id)}
                    className={`w-full text-left p-3 rounded-2xl border transition-all flex items-start gap-3 ${reason === r.id ? 'border-peach bg-peach/[0.06]' : 'border-ink/10 hover:border-ink/20'}`}
                  >
                    <span
                      className={`w-4 h-4 rounded-full border-2 grid place-items-center mt-0.5 shrink-0 ${reason === r.id ? 'border-peach' : 'border-ink/20'}`}
                    >
                      {reason === r.id && <span className="w-1.5 h-1.5 rounded-full bg-peach" />}
                    </span>
                    <span className="min-w-0">
                      <span className="block text-sm font-semibold text-ink">{r.label}</span>
                      <span className="block text-xs text-ink/60 mt-0.5 leading-relaxed">
                        {r.description}
                      </span>
                      {r.custom && reason === r.id && (
                        <input
                          value={note}
                          onChange={(e) => setNote(e.target.value)}
                          placeholder="What changed?"
                          className="mt-2 w-full px-3 py-2 rounded-xl bg-white border border-ink/10 text-sm focus:outline-none focus:border-peach"
                        />
                      )}
                    </span>
                  </button>
                ))}
              </div>
            </section>

            <div className="p-4 rounded-2xl bg-canvas border border-ink/10 flex items-center gap-3">
              <span className="w-9 h-9 rounded-full bg-white border border-ink/10 grid place-items-center text-ink/70">
                <IconClock className="w-4 h-4" />
              </span>
              <div className="flex-1 min-w-0">
                <p className="text-xs uppercase tracking-wider text-ink/50 font-semibold">
                  Will regenerate
                </p>
                <p className="text-sm font-bold text-ink">
                  <span className="tabular-nums">{totalLines}</span> lines ·{' '}
                  <span className="tabular-nums">{chapterIds.length}</span> chapters · ETA{' '}
                  <span className="tabular-nums">{eta}</span>
                </p>
              </div>
            </div>
          </div>

          <div className="px-6 py-4 border-t border-ink/10 flex items-center justify-end gap-3">
            <button onClick={onClose} className="text-sm font-medium text-ink/60 hover:text-ink">
              Cancel
            </button>
            <PrimaryButton
              variant="dark"
              onClick={() => onConfirm({ characterIds, chapterIds, reason, note })}
            >
              Regenerate {selectedChars.length} characters
            </PrimaryButton>
          </div>
        </div>
      </div>
    </>
  );
}
