import { useState } from 'react';
import { IconClose, IconRefresh, IconAB } from '../lib/icons';
import { Avatar } from '../components/primitives';
import { CHAR_COLORS } from '../lib/colors';
import { stripChapterPrefix } from '../lib/format-chapter-title';
import { REGEN_REASONS } from '../data/regen-reasons';
import { parseDuration, formatHours } from '../lib/time';
import { estimateGenMinutes } from '../lib/generation-progress';
import type { Character, Chapter, CharColor } from '../lib/types';

interface Props {
  character: Character | null;
  chapters: Chapter[];
  onClose: () => void;
  /** `preview: false` → regenerate every affected chapter now. `preview: true`
      → render only the first affected chapter (chapterIds[0]) and open the A/B
      gate; the layout fans the rest out on Approve. Either way `chapterIds`
      carries every chapter the character speaks in, in reading order. */
  onConfirm: (args: {
    characterId: string;
    chapterIds: number[];
    reason: string;
    note: string;
    preview: boolean;
  }) => void;
}

export function CharacterRegenerateModal({ character, chapters, onClose, onConfirm }: Props) {
  const [reason, setReason] = useState('voice');
  const [note, setNote] = useState('');
  if (!character) return null;
  const c = CHAR_COLORS[character.color as CharColor] ?? CHAR_COLORS.narrator;

  /* Chapters the character speaks in, in reading order. Regeneration is
     whole-chapter — there is no per-character synthesis server-side, so a
     voice change is applied by re-rendering each affected chapter in full.
     The first chapter is the A/B preview sample. */
  const speakingChapters = chapters.filter(
    (ch) => ch.characters[character.id] && ch.characters[character.id] !== 'skipped',
  );
  const chapterIds = speakingChapters.map((ch) => ch.id);
  const previewChapter = speakingChapters[0] ?? null;
  const n = speakingChapters.length;

  /* Each affected chapter is re-rendered in full, so the wall-clock estimate
     is the combined audio length of those chapters × the target RTF — the
     same model the chapter Regenerate modal uses. */
  const totalSec = speakingChapters.reduce((acc, ch) => acc + parseDuration(ch.duration), 0);
  const minutes = estimateGenMinutes(totalSec);
  const eta = n > 0 ? `≈${minutes < 60 ? `${minutes} min` : formatHours(minutes)}` : '—';

  const fire = (preview: boolean) =>
    onConfirm({ characterId: character.id, chapterIds, reason, note, preview });

  return (
    <>
      <div onClick={onClose} className="fixed inset-0 bg-ink/40 z-50 fade-in" />
      <div className="fixed inset-0 z-50 grid place-items-center p-6 pointer-events-none">
        <div className="bg-white rounded-3xl shadow-float w-full max-w-xl pointer-events-auto fade-in overflow-hidden max-h-[90vh] flex flex-col">
          <div className="px-6 py-4 border-b border-ink/10 flex items-center gap-3">
            <Avatar name={character.name} color={character.color as CharColor} size={40} />
            <div className="flex-1 min-w-0">
              <p className="text-[10px] uppercase tracking-widest text-ink/50 font-semibold">
                Regenerate character
              </p>
              <h3 className="text-base font-bold text-ink truncate">{character.name}</h3>
            </div>
            <button onClick={onClose} className="p-2 rounded-full hover:bg-ink/5 text-ink/60">
              <IconClose className="w-4 h-4" />
            </button>
          </div>

          <div className="p-6 space-y-6 overflow-y-auto scrollbar-thin">
            <section>
              <p className="text-[11px] uppercase tracking-wider text-ink/50 font-semibold mb-2">
                Affected chapters
              </p>
              {n === 0 ? (
                <p className="text-sm text-ink/60">
                  {character.name} doesn't speak in any chapter yet — nothing to regenerate.
                </p>
              ) : (
                <>
                  <p className="text-sm text-ink/70 leading-relaxed mb-3">
                    {character.name} speaks in{' '}
                    <span className="font-semibold text-ink tabular-nums">{n}</span>{' '}
                    {n === 1 ? 'chapter' : 'chapters'}. Each is re-rendered in full with the new
                    profile.
                  </p>
                  <div className="flex flex-wrap gap-1.5" data-testid="regen-affected-chapters">
                    {speakingChapters.map((ch) => {
                      const isPreview = previewChapter?.id === ch.id;
                      return (
                        <span
                          key={ch.id}
                          className={`inline-flex items-center gap-1 px-2 py-1 rounded-full text-[11px] font-semibold tabular-nums ${
                            isPreview
                              ? 'bg-peach text-ink'
                              : 'bg-ink/4 text-ink/70 border border-ink/10'
                          }`}
                          title={stripChapterPrefix(ch.title)}
                        >
                          CH {String(ch.id).padStart(2, '0')}
                          {isPreview && <span className="text-[9px] uppercase">preview</span>}
                        </span>
                      );
                    })}
                  </div>
                </>
              )}
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
                    className={`w-full text-left p-3 rounded-2xl border transition-all flex items-start gap-3 ${reason === r.id ? 'border-peach bg-peach/6' : 'border-ink/10 hover:border-ink/20'}`}
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
                          className="mt-2 w-full px-3 py-2 rounded-xl bg-white border border-ink/10 text-sm focus:outline-hidden focus:border-peach"
                        />
                      )}
                    </span>
                  </button>
                ))}
              </div>
            </section>

            <div
              className="p-4 rounded-2xl border"
              style={{ borderColor: c.ring, background: c.tint }}
            >
              <div className="flex items-center gap-3">
                <span
                  className="w-9 h-9 rounded-full grid place-items-center"
                  style={{ background: c.hex, color: 'white' }}
                >
                  <IconRefresh className="w-4 h-4" />
                </span>
                <div className="flex-1 min-w-0">
                  <p className="text-xs uppercase tracking-wider text-ink/50 font-semibold">
                    Will re-render
                  </p>
                  <p className="text-sm font-bold text-ink">
                    <span className="tabular-nums">{n}</span> {n === 1 ? 'chapter' : 'chapters'}
                  </p>
                </div>
                <span className="text-right">
                  <p className="text-[10px] uppercase tracking-wider text-ink/50 font-semibold">
                    ETA
                  </p>
                  <p className="text-sm font-bold text-ink tabular-nums">{eta}</p>
                </span>
              </div>
              {previewChapter && (
                <p className="mt-3 text-xs text-ink/60 leading-relaxed">
                  Not sure about the new voice? Preview it on CH{' '}
                  {String(previewChapter.id).padStart(2, '0')} first — listen to the old vs new take,
                  then approve to regenerate the rest or reject and re-adjust.
                </p>
              )}
            </div>
          </div>

          <div className="px-6 py-4 border-t border-ink/10 flex items-center justify-end gap-3">
            <button onClick={onClose} className="text-sm font-medium text-ink/60 hover:text-ink">
              Cancel
            </button>
            <button
              onClick={() => fire(false)}
              disabled={n === 0}
              data-testid="regen-character-all"
              className="inline-flex items-center gap-1.5 px-4 py-2.5 rounded-full border border-ink/15 text-ink text-sm font-semibold hover:bg-ink/5 disabled:opacity-40 disabled:cursor-not-allowed"
            >
              <IconRefresh className="w-3.5 h-3.5" /> Regenerate all {n > 0 ? n : ''}
            </button>
            <button
              onClick={() => fire(true)}
              disabled={!previewChapter}
              data-testid="regen-character-preview"
              className="inline-flex items-center gap-1.5 px-4 py-2.5 rounded-full bg-ink text-canvas text-sm font-semibold hover:bg-ink-soft disabled:opacity-40 disabled:cursor-not-allowed"
            >
              <IconAB className="w-3.5 h-3.5" /> Preview CH{' '}
              {previewChapter ? String(previewChapter.id).padStart(2, '0') : ''} first
            </button>
          </div>
        </div>
      </div>
    </>
  );
}
