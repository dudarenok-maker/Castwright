import { useEffect, useRef, useState } from 'react';
import { IconAlertTri, IconClose, IconRefresh, IconWaveform } from '../lib/icons';
import { Avatar, Pill } from '../components/primitives';
import { CHAR_COLORS } from '../lib/colors';
import { stripChapterPrefix } from '../lib/format-chapter-title';
import { api } from '../lib/api';
import { useAppSelector } from '../store';
import type { DriftEvent, Character, CharColor, Voice } from '../lib/types';

/* The modal now renders drift events grouped by book — the user's
   concurrent-multibook workflow means a single open modal can be
   showing drift from Book A AND Book B at the same time. Each event
   carries `bookId`, `chapterTitle`, `snapshot` and `current` from the
   server so the modal is a pure projection of the event payload (no
   joins against the chapters / cast slice, both of which are scoped
   to the active book). */
export interface DriftBookGroup {
  bookId: string;
  bookTitle: string;
  /** Cast for the book the events belong to. Used for avatar colour /
      display name resolution; missing entries fall back to the event's
      embedded `current.name` so cross-book events still render. */
  characters: Character[];
  events: DriftEvent[];
}

interface Props {
  eventsByBook: DriftBookGroup[];
  onClose: () => void;
  onRegenerateChapter: (bookId: string, characterId: string, chapterId: number) => void;
  /** Optional one-click shortcut for events flagged `autoQueueable` by
      the server (severe drift). When provided, the per-event button on
      autoQueueable rows switches from "Regenerate this chapter" (which
      opens the regen-modal confirmation) to "Auto-regen now" (which
      dispatches regenerateCharacter directly with sensible defaults).
      Plan 20 C1+C2. */
  onAutoQueueRegenerate?: (bookId: string, characterId: string, chapterId: number) => void;
  onDismiss: (eventId: string) => void;
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
  eventsByBook,
  onClose,
  onRegenerateChapter,
  onAutoQueueRegenerate,
  onDismiss,
  voices,
}: Props) {
  const totalCount = eventsByBook.reduce((acc, g) => acc + g.events.length, 0);
  if (totalCount === 0) return null;
  const bookCount = eventsByBook.length;

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
                {totalCount} chapter{totalCount === 1 ? '' : 's'} flagged
                {bookCount > 1 && ` across ${bookCount} books`}
              </h3>
            </div>
            <button onClick={onClose} className="p-2 rounded-full hover:bg-ink/5 text-ink/60">
              <IconClose className="w-4 h-4" />
            </button>
          </div>

          <div className="p-6 space-y-8 overflow-y-auto scrollbar-thin">
            <p className="text-sm text-ink/70 leading-relaxed">
              We compared each chapter against the character's established voice profile. The "When
              rendered" column shows the snapshot captured at synthesis time; "Now" shows the live
              profile. Severe and moderate findings are worth a listen — mild ones are usually
              within tolerance.
            </p>

            {eventsByBook.map((group) => (
              <DriftBookSection
                key={group.bookId}
                group={group}
                showBookHeader={bookCount > 1}
                voices={voices}
                onRegenerateChapter={onRegenerateChapter}
                onAutoQueueRegenerate={onAutoQueueRegenerate}
                onDismiss={onDismiss}
              />
            ))}
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

function DriftBookSection({
  group,
  showBookHeader,
  voices,
  onRegenerateChapter,
  onAutoQueueRegenerate,
  onDismiss,
}: {
  group: DriftBookGroup;
  showBookHeader: boolean;
  voices?: Voice[];
  onRegenerateChapter: (bookId: string, characterId: string, chapterId: number) => void;
  onAutoQueueRegenerate?: (bookId: string, characterId: string, chapterId: number) => void;
  onDismiss: (eventId: string) => void;
}) {
  const grouped = group.events.reduce<Record<string, DriftEvent[]>>((acc, e) => {
    (acc[e.severity] ??= []).push(e);
    return acc;
  }, {});
  const findChar = (id: string) => group.characters.find((c) => c.id === id);

  return (
    <section className="space-y-4">
      {showBookHeader && (
        <header className="flex items-center gap-3 pb-2 border-b border-ink/10">
          <span className="text-[10px] uppercase tracking-widest text-ink/45 font-semibold">
            Book
          </span>
          <h4 className="text-sm font-bold text-ink leading-tight flex-1 truncate">
            {group.bookTitle}
          </h4>
          <span className="text-xs text-ink/50 tabular-nums">
            {group.events.length} flagged
          </span>
        </header>
      )}
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
                /* `e.current.name` is always present from the server emit; the
                   cast lookup adds color + the up-to-date display name when
                   the cast slice happens to hold this book. */
                const displayName = char?.name || e.current?.name || e.characterId;
                const colorKey = (char?.color as CharColor | undefined) || 'narrator';
                return (
                  <article
                    key={e.id}
                    className="p-4 rounded-2xl border border-ink/10 bg-white"
                    data-testid={`drift-event-${e.id}`}
                  >
                    <div className="flex items-start gap-3">
                      <Avatar name={displayName} color={colorKey} size={36} />
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 flex-wrap mb-1">
                          <h4 className="text-sm font-bold text-ink">{displayName}</h4>
                          <span className="text-xs text-ink/50">in</span>
                          <span className="text-xs font-semibold text-ink">
                            CH {String(e.chapterId).padStart(2, '0')} ·{' '}
                            {stripChapterPrefix(e.chapterTitle)}
                          </span>
                        </div>
                        <p
                          className="text-[11px] uppercase tracking-wider font-bold mb-2"
                          style={{ color: CHAR_COLORS[colorKey].hex }}
                        >
                          {e.factorLabel}
                        </p>
                        <p className="text-xs text-ink/70 leading-relaxed mb-3">{e.description}</p>
                        <ProfileCompareCard event={e} />
                        <div className="flex items-center gap-2 mt-3">
                          {e.autoQueueable && onAutoQueueRegenerate ? (
                            <button
                              onClick={() =>
                                onAutoQueueRegenerate(group.bookId, e.characterId, e.chapterId)
                              }
                              data-testid={`drift-auto-regen-${e.id}`}
                              title="Skip the confirmation modal — auto-queue this regeneration"
                              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-peach text-ink text-xs font-semibold hover:bg-peach/85"
                            >
                              <IconRefresh className="w-3.5 h-3.5" /> Auto-regen now
                            </button>
                          ) : (
                            <button
                              onClick={() =>
                                onRegenerateChapter(group.bookId, e.characterId, e.chapterId)
                              }
                              data-testid={`drift-regen-${e.id}`}
                              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-ink text-canvas text-xs font-semibold hover:bg-ink-soft"
                            >
                              <IconRefresh className="w-3.5 h-3.5" /> Regenerate this chapter
                            </button>
                          )}
                          {(() => {
                            const rowVoice = voices?.find((v) => v.id === char?.voiceId);
                            /* Listen widget mounts only when the caller plumbed
                               a resolvable voice. Cross-book events whose cast
                               isn't loaded won't have a voice match — gracefully
                               omit the widget in that case. */
                            if (!rowVoice) return null;
                            return (
                              <DriftListenWidget
                                event={e}
                                bookId={group.bookId}
                                voice={rowVoice}
                                character={char}
                              />
                            );
                          })()}
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
    </section>
  );
}

/* Side-by-side "When rendered" vs "Now" profile comparison. Reads the
   structured `snapshot` (pre-render) and `current` (live cast) payloads
   the server attaches to every drift event. Fields that didn't change
   render in muted ink; the changed field (matching `event.factor`) is
   highlighted on the right column. */
function ProfileCompareCard({ event }: { event: DriftEvent }) {
  const snap = event.snapshot ?? {};
  const cur = event.current ?? {};
  const factor = event.factor;
  type Row = {
    label: string;
    factor: string;
    /** Display the pair as text (voice ids, gender, age) or as tone-bar pairs. */
    kind: 'text' | 'tone' | 'attributes';
    before?: string | number;
    after?: string | number;
    beforeAttrs?: string[];
    afterAttrs?: string[];
  };
  const rows: Row[] = [
    {
      label: 'Voice',
      factor: 'voice',
      kind: 'text',
      before: snap.voiceId ?? '—',
      after: cur.voiceId ?? '—',
    },
    {
      label: 'Gender',
      factor: 'gender',
      kind: 'text',
      before: snap.gender ?? '—',
      after: cur.gender ?? '—',
    },
    {
      label: 'Age range',
      factor: 'ageRange',
      kind: 'text',
      before: snap.ageRange ?? '—',
      after: cur.ageRange ?? '—',
    },
    {
      label: 'Warmth',
      factor: 'warmth',
      kind: 'tone',
      before: snap.tone?.warmth,
      after: cur.tone?.warmth,
    },
    {
      label: 'Pace',
      factor: 'pace',
      kind: 'tone',
      before: snap.tone?.pace,
      after: cur.tone?.pace,
    },
    {
      label: 'Authority',
      factor: 'authority',
      kind: 'tone',
      before: snap.tone?.authority,
      after: cur.tone?.authority,
    },
    {
      label: 'Emotion',
      factor: 'emotion',
      kind: 'tone',
      before: snap.tone?.emotion,
      after: cur.tone?.emotion,
    },
    {
      label: 'Attributes',
      factor: 'attributes',
      kind: 'attributes',
      beforeAttrs: snap.attributes ?? [],
      afterAttrs: cur.attributes ?? [],
    },
  ];

  return (
    <div className="rounded-xl border border-ink/10 bg-canvas/50 overflow-hidden text-xs">
      <div className="grid grid-cols-[6.5rem_1fr_1fr] gap-x-3 py-2 px-3 bg-ink/5 text-[10px] uppercase tracking-wider font-semibold text-ink/55">
        <span></span>
        <span>When rendered</span>
        <span>Now</span>
      </div>
      <div className="divide-y divide-ink/5">
        {rows.map((row) => (
          <ProfileCompareRow key={row.factor} row={row} changed={row.factor === factor} />
        ))}
      </div>
    </div>
  );
}

function ProfileCompareRow({
  row,
  changed,
}: {
  row: {
    label: string;
    factor: string;
    kind: 'text' | 'tone' | 'attributes';
    before?: string | number;
    after?: string | number;
    beforeAttrs?: string[];
    afterAttrs?: string[];
  };
  changed: boolean;
}) {
  return (
    <div
      className="grid grid-cols-[6.5rem_1fr_1fr] gap-x-3 py-2 px-3 items-center"
      data-testid={`drift-compare-row-${row.factor}`}
      data-changed={changed ? 'true' : 'false'}
    >
      <span className="text-ink/55 font-medium">{row.label}</span>
      {row.kind === 'tone' ? (
        <>
          <ToneBar value={row.before} muted />
          <ToneBar value={row.after} highlight={changed} />
        </>
      ) : row.kind === 'attributes' ? (
        <>
          <AttributeList values={row.beforeAttrs ?? []} muted />
          <AttributeList
            values={row.afterAttrs ?? []}
            highlight={changed}
            diffAgainst={row.beforeAttrs}
          />
        </>
      ) : (
        <>
          <span className="text-ink/65 tabular-nums truncate">{row.before}</span>
          <span
            className={`tabular-nums truncate ${
              changed ? 'font-semibold text-ink' : 'text-ink/65'
            }`}
          >
            {row.after}
            {changed && <span className="ml-1 text-magenta">←</span>}
          </span>
        </>
      )}
    </div>
  );
}

function ToneBar({
  value,
  muted,
  highlight,
}: {
  value: number | string | undefined;
  muted?: boolean;
  highlight?: boolean;
}) {
  if (typeof value !== 'number') {
    return <span className="text-ink/40">—</span>;
  }
  const pct = Math.max(0, Math.min(100, value));
  return (
    <div className="flex items-center gap-2">
      <div className="flex-1 h-1.5 rounded-full bg-ink/10 overflow-hidden">
        <div
          className={`h-full rounded-full ${
            highlight ? 'bg-magenta' : muted ? 'bg-ink/30' : 'bg-ink/60'
          }`}
          style={{ width: `${pct}%` }}
        />
      </div>
      <span
        className={`tabular-nums w-7 text-right ${
          highlight ? 'font-semibold text-ink' : muted ? 'text-ink/55' : 'text-ink/70'
        }`}
      >
        {pct}
      </span>
      {highlight && <span className="text-magenta">←</span>}
    </div>
  );
}

function AttributeList({
  values,
  diffAgainst,
  muted,
  highlight,
}: {
  values: string[];
  /** If provided, items not in this list render with the "added" badge,
      and any item in this list missing from `values` renders strikethrough. */
  diffAgainst?: string[];
  muted?: boolean;
  highlight?: boolean;
}) {
  if (values.length === 0 && (!diffAgainst || diffAgainst.length === 0)) {
    return <span className="text-ink/40">—</span>;
  }
  if (!diffAgainst) {
    /* Plain "before" rendering — comma-separated. */
    return (
      <span className={`${muted ? 'text-ink/55' : 'text-ink/70'} truncate`}>
        {values.join(', ')}
      </span>
    );
  }
  const before = new Set(diffAgainst);
  const after = new Set(values);
  const added = values.filter((v) => !before.has(v));
  const removed = diffAgainst.filter((v) => !after.has(v));
  const kept = values.filter((v) => before.has(v));
  return (
    <div className="flex flex-wrap gap-1 items-center">
      {kept.map((v) => (
        <span key={`k-${v}`} className="text-ink/65">
          {v}
        </span>
      ))}
      {added.map((v) => (
        <span
          key={`a-${v}`}
          className={`rounded-full px-1.5 py-0.5 text-[10px] font-semibold ${
            highlight ? 'bg-magenta/15 text-magenta' : 'bg-ink/10 text-ink'
          }`}
        >
          + {v}
        </span>
      ))}
      {removed.map((v) => (
        <span key={`r-${v}`} className="text-ink/40 line-through">
          {v}
        </span>
      ))}
      {highlight && <span className="text-magenta">←</span>}
    </div>
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
      <audio ref={chapterRef} onEnded={() => setPlaying((p) => (p === 'A' ? null : p))} />
      <audio ref={voiceRef} onEnded={() => setPlaying((p) => (p === 'B' ? null : p))} />
    </span>
  );
}
