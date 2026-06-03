import { useMemo, useRef, useState } from 'react';
import { IconRefresh, IconClose } from '../lib/icons';
import { PrimaryButton } from '../components/primitives';
import { useAppDispatch, useAppSelector } from '../store';
import { revisionsActions } from '../store/revisions-slice';
import { stripChapterPrefix } from '../lib/format-chapter-title';
import { api, type SpliceTick } from '../lib/api';

/* fs-26 — per-character "Fix audio" modal, opened from the cast profile drawer.
   Two modes share the server's splice engine:
     - Loudness (remix): apply a dB gain to the character's segments — no GPU,
       the fix for "too quiet". A relative boost survives the chapter loudnorm.
     - Re-record: re-synthesise the character's lines (GPU).
   The user picks which RENDERED chapters to apply it to (default: every chapter
   the character appears in). Chapters run one at a time; each completed splice
   drops a pending A/B revision so the user can audition + accept/reject. */

interface Props {
  characterId: string | null;
  characterName: string;
  bookId: string;
  onClose: () => void;
}

type RowStatus = 'pending' | 'running' | 'done' | 'failed';

const GAIN_MIN = -12;
const GAIN_MAX = 12;

export function FixCharacterAudioModal({ characterId, characterName, bookId, onClose }: Props) {
  const dispatch = useAppDispatch();
  const chapters = useAppSelector((s) => s.chapters.chapters);
  const modelKey = useAppSelector((s) => s.ui.ttsModelKey);

  /* Candidate chapters: RENDERED (has audio) AND the character speaks in them.
     A chapter is rendered once it carries an audioModelKey (or flips done). */
  const candidates = useMemo(
    () =>
      chapters.filter(
        (c) =>
          !!characterId &&
          c.characters?.[characterId] !== undefined &&
          (c.audioModelKey != null || c.state === 'done'),
      ),
    [chapters, characterId],
  );

  const [mode, setMode] = useState<'remix' | 'rerecord'>('remix');
  const [gainDb, setGainDb] = useState(3);
  const [selected, setSelected] = useState<Set<number>>(() => new Set(candidates.map((c) => c.id)));
  const [running, setRunning] = useState(false);
  const [statusById, setStatusById] = useState<Record<number, RowStatus>>({});
  const abortRef = useRef<AbortController | null>(null);

  if (!characterId) return null;
  const firstName = characterName.split(' ')[0] || characterName;

  const toggle = (id: number) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const selectedIds = candidates.filter((c) => selected.has(c.id)).map((c) => c.id);

  const run = async () => {
    if (!selectedIds.length) return;
    setRunning(true);
    const controller = new AbortController();
    abortRef.current = controller;
    for (const chapterId of selectedIds) {
      if (controller.signal.aborted) break;
      setStatusById((s) => ({ ...s, [chapterId]: 'running' }));
      const revisionId = `splice-${bookId}-${chapterId}-${characterId}-${chapterId}`;
      dispatch(
        revisionsActions.enqueuePending({
          id: revisionId,
          chapterId,
          characterId,
          playable: false,
          hasPreviousAudio: true,
          triggeredBy: mode === 'remix' ? `Loudness fix (${firstName})` : `Re-record (${firstName})`,
          segments: [],
        }),
      );
      const onTick = (ev: SpliceTick) => {
        if (ev.type === 'splice_complete') {
          dispatch(revisionsActions.markRevisionPlayable({ chapterId }));
          setStatusById((s) => ({ ...s, [chapterId]: 'done' }));
        } else if (ev.type === 'chapter_failed') {
          setStatusById((s) => ({ ...s, [chapterId]: 'failed' }));
        }
      };
      await api.streamSplice({
        bookId,
        chapterId,
        mode,
        characterId,
        ...(mode === 'remix' ? { gainDb } : { modelKey }),
        onTick,
        signal: controller.signal,
      });
    }
    setRunning(false);
    abortRef.current = null;
  };

  const doneCount = Object.values(statusById).filter((v) => v === 'done').length;
  const failedCount = Object.values(statusById).filter((v) => v === 'failed').length;
  const allFinished = running === false && doneCount + failedCount > 0;

  return (
    <>
      <div
        onClick={running ? undefined : onClose}
        className="fixed inset-0 bg-ink/40 z-50 fade-in"
        data-testid="fix-audio-backdrop"
      />
      <div className="fixed inset-0 z-50 grid place-items-center p-6 pointer-events-none">
        <div className="bg-white rounded-3xl shadow-float w-full max-w-xl pointer-events-auto fade-in overflow-hidden">
          <div className="px-6 py-4 border-b border-ink/10 flex items-center gap-3">
            <span className="w-9 h-9 rounded-full bg-peach/15 grid place-items-center text-magenta">
              <IconRefresh className="w-4 h-4" />
            </span>
            <div className="flex-1 min-w-0">
              <p className="text-[10px] uppercase tracking-widest text-ink/50 font-semibold">
                Fix audio
              </p>
              <h3 className="text-base font-bold text-ink truncate">{characterName}</h3>
            </div>
            <button
              onClick={onClose}
              disabled={running}
              className="p-2 rounded-full hover:bg-ink/5 text-ink/60 disabled:opacity-40"
            >
              <IconClose className="w-4 h-4" />
            </button>
          </div>

          <div className="p-6 space-y-6">
            <section>
              <p className="text-[11px] uppercase tracking-wider text-ink/50 font-semibold mb-3">
                What to fix
              </p>
              <div className="grid grid-cols-2 gap-2">
                <button
                  onClick={() => setMode('remix')}
                  disabled={running}
                  className={`text-left p-3 rounded-2xl border transition-all ${mode === 'remix' ? 'border-peach bg-peach/6' : 'border-ink/10 hover:border-ink/20'}`}
                >
                  <p className="text-sm font-semibold text-ink">Loudness</p>
                  <p className="text-xs text-ink/55 mt-0.5">Boost a too-quiet voice. No re-synthesis — fast.</p>
                </button>
                <button
                  onClick={() => setMode('rerecord')}
                  disabled={running}
                  className={`text-left p-3 rounded-2xl border transition-all ${mode === 'rerecord' ? 'border-peach bg-peach/6' : 'border-ink/10 hover:border-ink/20'}`}
                >
                  <p className="text-sm font-semibold text-ink">Re-record</p>
                  <p className="text-xs text-ink/55 mt-0.5">Re-synthesise the lines. For wrong tone or voice.</p>
                </button>
              </div>
            </section>

            {mode === 'remix' && (
              <section>
                <div className="flex items-center justify-between mb-2">
                  <p className="text-[11px] uppercase tracking-wider text-ink/50 font-semibold">
                    Loudness boost
                  </p>
                  <span className="text-sm font-bold text-ink tabular-nums">
                    {gainDb > 0 ? '+' : ''}
                    {gainDb} dB
                  </span>
                </div>
                <input
                  type="range"
                  min={GAIN_MIN}
                  max={GAIN_MAX}
                  step={1}
                  value={gainDb}
                  disabled={running}
                  onChange={(e) => setGainDb(Number(e.target.value))}
                  className="w-full accent-magenta"
                  aria-label="Loudness boost in decibels"
                />
              </section>
            )}

            <section>
              <div className="flex items-center justify-between mb-2">
                <p className="text-[11px] uppercase tracking-wider text-ink/50 font-semibold">
                  Chapters ({selectedIds.length}/{candidates.length})
                </p>
                {!running && candidates.length > 0 && (
                  <button
                    onClick={() =>
                      setSelected((prev) =>
                        prev.size === candidates.length ? new Set() : new Set(candidates.map((c) => c.id)),
                      )
                    }
                    className="text-xs font-medium text-magenta hover:underline"
                  >
                    {selected.size === candidates.length ? 'Clear all' : 'Select all'}
                  </button>
                )}
              </div>
              {candidates.length === 0 ? (
                <p className="text-sm text-ink/55">
                  {firstName} has no rendered chapters yet — generate audio first.
                </p>
              ) : (
                <div className="max-h-56 overflow-y-auto space-y-1 pr-1">
                  {candidates.map((c) => {
                    const st = statusById[c.id];
                    return (
                      <label
                        key={c.id}
                        className={`flex items-center gap-3 p-2.5 rounded-xl border min-h-[44px] cursor-pointer ${selected.has(c.id) ? 'border-peach/60 bg-peach/4' : 'border-ink/10'}`}
                      >
                        <input
                          type="checkbox"
                          checked={selected.has(c.id)}
                          disabled={running}
                          onChange={() => toggle(c.id)}
                          className="accent-magenta w-4 h-4"
                        />
                        <span className="flex-1 min-w-0 text-sm text-ink truncate">
                          CH {String(c.id).padStart(2, '0')} · {stripChapterPrefix(c.title)}
                        </span>
                        {st === 'running' && <span className="text-xs text-ink/50">…</span>}
                        {st === 'done' && <span className="text-xs text-green-600 font-semibold">✓</span>}
                        {st === 'failed' && <span className="text-xs text-red-500 font-semibold">failed</span>}
                      </label>
                    );
                  })}
                </div>
              )}
            </section>

            {allFinished && (
              <p className="text-sm text-ink/70" data-testid="fix-audio-summary">
                Done — {doneCount} chapter{doneCount === 1 ? '' : 's'} updated
                {failedCount > 0 ? `, ${failedCount} failed` : ''}. Review the new takes in the
                revisions panel.
              </p>
            )}
          </div>

          <div className="px-6 py-4 border-t border-ink/10 flex items-center justify-end gap-3">
            <button
              onClick={onClose}
              disabled={running}
              className="text-sm font-medium text-ink/60 hover:text-ink disabled:opacity-40"
            >
              {allFinished ? 'Close' : 'Cancel'}
            </button>
            <PrimaryButton
              variant="dark"
              onClick={run}
              disabled={running || selectedIds.length === 0}
            >
              {running
                ? `Working… ${doneCount}/${selectedIds.length}`
                : mode === 'remix'
                  ? `Apply to ${selectedIds.length} chapter${selectedIds.length === 1 ? '' : 's'}`
                  : `Re-record ${selectedIds.length} chapter${selectedIds.length === 1 ? '' : 's'}`}
            </PrimaryButton>
          </div>
        </div>
      </div>
    </>
  );
}
