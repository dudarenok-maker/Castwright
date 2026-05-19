import { useEffect, useRef, useState } from 'react';
import { IconAlertTri, IconClose, IconRefresh, IconWaveform } from '../lib/icons';
import { Avatar, Pill } from '../components/primitives';
import { CHAR_COLORS } from '../lib/colors';
import { stripChapterPrefix } from '../lib/format-chapter-title';
import { initialChapters } from '../data/chapters';
import { api } from '../lib/api';
import { useAppSelector } from '../store';
import type { DriftEvent, Character, CharColor, Voice } from '../lib/types';

interface Props {
  events: DriftEvent[];
  characters: Character[];
  onClose: () => void;
  onRegenerateChapter: (characterId: string, chapterId: number) => void;
  /** Optional one-click shortcut for events flagged `autoQueueable` by
      the server (severe drift). When provided, the per-event button on
      autoQueueable rows switches from "Regenerate this chapter" (which
      opens the regen-modal confirmation) to "Auto-regen now" (which
      dispatches regenerateCharacter directly with sensible defaults).
      Plan 20 C1+C2. */
  onAutoQueueRegenerate?: (characterId: string, chapterId: number) => void;
  onDismiss: (eventId: string) => void;
  /** Plan-8 — Listen A/B player. Optional so legacy / mock callers that
      haven't opted in still render the modal without the per-row inline
      player. When omitted the Listen button stays hidden (callers without
      audio context can't usefully expose it). */
  bookId?: string;
  voices?: Voice[];
}

const severityOrder: Array<DriftEvent['severity']> = ['severe', 'moderate', 'mild'];
const severityLabel: Record<DriftEvent['severity'], string> = {
  severe: 'Severe',
  moderate: 'Moderate',
  mild: 'Mild',
};
const severityColor: Record<DriftEvent['severity'], 'danger' | 'warning' | 'neutral'> = {
  severe: 'danger',
  moderate: 'warning',
  mild: 'neutral',
};

export function DriftReportModal({
  events,
  characters,
  onClose,
  onRegenerateChapter,
  onAutoQueueRegenerate,
  onDismiss,
  bookId,
  voices,
}: Props) {
  if (events.length === 0) return null;

  const findChar = (id: string) => characters.find((c) => c.id === id);
  const findChapter = (id: number) =>
    initialChapters.find((c) => c.id === id) || { id, title: `Chapter ${id}` };
  const grouped = events.reduce<Record<string, DriftEvent[]>>((acc, e) => {
    (acc[e.severity] ??= []).push(e);
    return acc;
  }, {});

  return (
    <>
      <div onClick={onClose} className="fixed inset-0 bg-ink/40 z-50 fade-in" />
      <div className="fixed inset-0 z-50 grid place-items-center p-6 pointer-events-none">
        <div className="bg-white rounded-3xl shadow-float w-full max-w-2xl pointer-events-auto fade-in overflow-hidden max-h-[90vh] flex flex-col">
          <div className="px-6 py-4 border-b border-ink/10 flex items-center gap-3">
            <span className="w-10 h-10 rounded-full bg-amber-50 grid place-items-center text-amber-700">
              <IconAlertTri className="w-5 h-5" />
            </span>
            <div className="flex-1 min-w-0">
              <p className="text-[10px] uppercase tracking-widest text-ink/50 font-semibold">
                Voice drift detector
              </p>
              <h3 className="text-base font-bold text-ink leading-tight">
                {events.length} chapter{events.length === 1 ? '' : 's'} flagged
              </h3>
            </div>
            <button onClick={onClose} className="p-2 rounded-full hover:bg-ink/5 text-ink/60">
              <IconClose className="w-4 h-4" />
            </button>
          </div>

          <div className="p-6 space-y-6 overflow-y-auto scrollbar-thin">
            <p className="text-sm text-ink/70 leading-relaxed">
              We compared each chapter against the character's established voice profile. Severe and
              moderate findings are worth a listen — mild ones are usually within tolerance.
            </p>

            {severityOrder.map((sev) => {
              const items = grouped[sev];
              if (!items || items.length === 0) return null;
              return (
                <section key={sev}>
                  <div className="flex items-center gap-3 mb-3">
                    <Pill color={severityColor[sev]}>{severityLabel[sev]}</Pill>
                    <span className="flex-1 h-px bg-ink/10" />
                    <span className="text-xs text-ink/50 tabular-nums">{items.length}</span>
                  </div>
                  <div className="space-y-2">
                    {items.map((e) => {
                      const char = findChar(e.characterId);
                      const chap = findChapter(e.chapterId);
                      return (
                        <article
                          key={e.id}
                          className="p-4 rounded-2xl border border-ink/10 bg-white"
                        >
                          <div className="flex items-start gap-3">
                            {char && (
                              <Avatar name={char.name} color={char.color as CharColor} size={36} />
                            )}
                            <div className="flex-1 min-w-0">
                              <div className="flex items-center gap-2 flex-wrap mb-1">
                                <h4 className="text-sm font-bold text-ink">
                                  {char?.name || e.characterId}
                                </h4>
                                <span className="text-xs text-ink/50">in</span>
                                <span className="text-xs font-semibold text-ink">
                                  CH {String(e.chapterId).padStart(2, '0')} ·{' '}
                                  {stripChapterPrefix(chap.title)}
                                </span>
                              </div>
                              <p
                                className="text-[11px] uppercase tracking-wider font-bold mb-2"
                                style={{
                                  color: CHAR_COLORS[(char?.color as CharColor) || 'narrator'].hex,
                                }}
                              >
                                {e.factorLabel}
                              </p>
                              <p className="text-xs text-ink/70 leading-relaxed mb-3">
                                {e.description}
                              </p>
                              {e.metrics && (
                                <div className="flex items-center gap-3 mb-3 text-xs">
                                  <span className="inline-flex items-center gap-1.5 px-2 py-1 rounded-md bg-canvas border border-ink/10">
                                    <span className="text-ink/50">Now:</span>
                                    <span className="font-bold text-ink tabular-nums">
                                      {e.metrics.current}
                                    </span>
                                  </span>
                                  <span className="inline-flex items-center gap-1.5 px-2 py-1 rounded-md bg-canvas border border-ink/10">
                                    <span className="text-ink/50">Profile:</span>
                                    <span className="font-bold text-ink tabular-nums">
                                      {e.metrics.expected}
                                    </span>
                                  </span>
                                  <span className="text-ink/45">{e.metrics.unit}</span>
                                </div>
                              )}
                              <div className="flex items-center gap-2">
                                {e.autoQueueable && onAutoQueueRegenerate ? (
                                  <button
                                    onClick={() =>
                                      onAutoQueueRegenerate(e.characterId, e.chapterId)
                                    }
                                    data-testid={`drift-auto-regen-${e.id}`}
                                    title="Skip the confirmation modal — auto-queue this regeneration"
                                    className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-peach text-ink text-xs font-semibold hover:bg-peach/85"
                                  >
                                    <IconRefresh className="w-3.5 h-3.5" /> Auto-regen now
                                  </button>
                                ) : (
                                  <button
                                    onClick={() => onRegenerateChapter(e.characterId, e.chapterId)}
                                    data-testid={`drift-regen-${e.id}`}
                                    className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-ink text-canvas text-xs font-semibold hover:bg-ink-soft"
                                  >
                                    <IconRefresh className="w-3.5 h-3.5" /> Regenerate this chapter
                                  </button>
                                )}
                                {(() => {
                                  const rowVoice = voices?.find((v) => v.id === char?.voiceId);
                                  /* Mount the A/B widget only when the caller plumbed
                                     both bookId and a resolvable voice. Pre-fix the
                                     Listen button was a stub regardless — callers
                                     that haven't opted in (legacy / unit-test mocks)
                                     get the original "no Listen" surface. */
                                  if (!bookId || !rowVoice) return null;
                                  return (
                                    <DriftListenWidget
                                      event={e}
                                      bookId={bookId}
                                      voice={rowVoice}
                                      character={char}
                                    />
                                  );
                                })()}
                                {/* Dismiss handled below as the modal-action sibling. */}
                                <button
                                  onClick={() => onDismiss(e.id)}
                                  className="ml-auto text-xs font-medium text-ink/50 hover:text-ink/80"
                                >
                                  Dismiss
                                </button>
                              </div>
                            </div>
                          </div>
                        </article>
                      );
                    })}
                  </div>
                </section>
              );
            })}
          </div>

          <div className="px-6 py-3 border-t border-ink/10 flex items-center justify-between text-xs text-ink/50">
            <span>Drift detection runs after every regeneration.</span>
            <span>Last check: 30 min ago</span>
          </div>
        </div>
      </div>
    </>
  );
}

/* Inline A/B compare player rendered per drift row when the user clicks
   Listen. A = the chapter audio as currently rendered (what the drift
   detector flagged); B = a sample synthesised against the established
   voice profile. Lets the user decide between Regenerate / Dismiss by
   ear, not just the attribute-diff summary.

   Two refs + a single playing-state lets us implement mutex without
   importing the revision-diff useAbPlayback hook — A's URL is static
   (just the chapter audio path) but B's URL needs an async resolve via
   api.getVoiceSample, which is awkward to feed into a useEffect-driven
   src sync. Cleanup useEffect pauses both elements on unmount so the
   browser releases the decode buffers when the modal closes. */
function DriftListenWidget({
  event,
  bookId,
  voice,
  character,
}: {
  event: DriftEvent;
  bookId: string;
  voice: Voice;
  character?: Character;
}) {
  const ttsModelKey = useAppSelector((s) => s.ui.ttsModelKey);
  const [open, setOpen] = useState(false);
  const [playing, setPlaying] = useState<'A' | 'B' | null>(null);
  const [voiceSampleUrl, setVoiceSampleUrl] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const chapterRef = useRef<HTMLAudioElement | null>(null);
  const voiceRef = useRef<HTMLAudioElement | null>(null);

  /* Cleanup on unmount — modal close, parent re-render that drops the
     row, etc. Pause both elements and detach src so the browser doesn't
     hold decode buffers for a now-invisible widget. The audio elements
     are rendered at all times (hidden when !open) so their refs survive
     until React tears down the widget itself; if they were nested inside
     the `open && <audio />` branch, React 18 detaches them BEFORE
     running this cleanup and the refs would be null here. */
  useEffect(() => {
    const a = chapterRef.current;
    const b = voiceRef.current;
    return () => {
      if (a) {
        a.pause();
        a.removeAttribute('src');
      }
      if (b) {
        b.pause();
        b.removeAttribute('src');
      }
    };
  }, []);

  const chapterUrl = `/api/books/${encodeURIComponent(bookId)}/chapters/${event.chapterId}/audio`;

  function pauseAll() {
    chapterRef.current?.pause();
    voiceRef.current?.pause();
    setPlaying(null);
  }

  async function playChapter() {
    voiceRef.current?.pause();
    const el = chapterRef.current;
    if (!el) return;
    /* Set src lazily on first play so a row whose Listen button is never
       clicked doesn't trigger a chapter audio fetch. */
    if (el.src !== window.location.origin + chapterUrl && !el.src.endsWith(chapterUrl)) {
      el.src = chapterUrl;
    }
    try {
      await el.play();
      setPlaying('A');
    } catch {
      setPlaying(null);
    }
  }

  async function playVoice() {
    chapterRef.current?.pause();
    let url = voiceSampleUrl;
    if (!url) {
      setBusy(true);
      try {
        const sample = await api.getVoiceSample({
          voiceId: voice.id,
          voice,
          modelKey: ttsModelKey,
          characterHint: character
            ? {
                description: character.description,
                gender: character.gender as 'male' | 'female' | 'neutral' | undefined,
                ageRange: character.ageRange as
                  | 'child'
                  | 'teen'
                  | 'adult'
                  | 'elderly'
                  | undefined,
              }
            : undefined,
        });
        url = sample.url;
        setVoiceSampleUrl(url);
      } catch {
        setBusy(false);
        return;
      }
      setBusy(false);
    }
    const el = voiceRef.current;
    if (!el || !url) return;
    if (el.src !== url && !el.src.endsWith(url)) {
      el.src = url;
    }
    try {
      await el.play();
      setPlaying('B');
    } catch {
      setPlaying(null);
    }
  }

  return (
    <span className="inline-flex items-center gap-2">
      {!open ? (
        <button
          data-testid={`drift-listen-${event.id}`}
          onClick={() => setOpen(true)}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-canvas border border-ink/10 text-ink/70 hover:text-ink text-xs font-medium"
        >
          <IconWaveform className="w-3.5 h-3.5" /> Listen
        </button>
      ) : (
        <>
          <button
            data-testid={`drift-play-chapter-${event.id}`}
            onClick={() => (playing === 'A' ? pauseAll() : void playChapter())}
            className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full border text-xs font-medium ${playing === 'A' ? 'bg-ink text-canvas border-ink' : 'bg-canvas border-ink/10 text-ink/70 hover:text-ink'}`}
          >
            <IconWaveform className="w-3.5 h-3.5" />
            {playing === 'A' ? 'Pause chapter' : 'Chapter'}
          </button>
          <button
            data-testid={`drift-play-voice-${event.id}`}
            onClick={() => (playing === 'B' ? pauseAll() : void playVoice())}
            disabled={busy}
            className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full border text-xs font-medium disabled:opacity-50 disabled:cursor-wait ${playing === 'B' ? 'bg-ink text-canvas border-ink' : 'bg-canvas border-ink/10 text-ink/70 hover:text-ink'}`}
          >
            <IconWaveform className="w-3.5 h-3.5" />
            {busy ? 'Loading…' : playing === 'B' ? 'Pause voice' : 'Voice profile'}
          </button>
        </>
      )}
      {/* Audio elements always mounted so their refs survive until the
          widget itself unmounts (cleanup useEffect above relies on this). */}
      <audio ref={chapterRef} onEnded={() => setPlaying((p) => (p === 'A' ? null : p))} />
      <audio ref={voiceRef} onEnded={() => setPlaying((p) => (p === 'B' ? null : p))} />
    </span>
  );
}
