import { memo, useEffect, useMemo, useRef, useState } from 'react';
import { IconAlertTri, IconChevD, IconClose, IconRefresh, IconWaveform } from '../lib/icons';
import { Avatar, Pill } from '../components/primitives';
import { CHAR_COLORS } from '../lib/colors';
import { stripChapterPrefix } from '../lib/format-chapter-title';
import { api } from '../lib/api';
import { useAppSelector } from '../store';
import {
  distinctDriftChapterCount,
  type DriftGroup,
  type DriftChapterEntry,
} from '../store/revisions-slice';
import type { DriftEvent, Character, CharColor, Voice } from '../lib/types';

/* The modal renders one card per `(book × character × snapshot)` group
   (see `selectDriftGroupsByBook` in `src/store/revisions-slice.ts`).
   Each card shows the snapshot→current diff once at the top, plus an
   expandable strip of per-chapter actions for every chapter affected by
   that diff. A character whose voice profile was edited once collapses
   from N chapter-cards (the old shape) to a single card with N rows
   inside — DOM-node count drops from ~7,200 to ~200 for a 300-event
   modal. */
export interface DriftBookGroupView {
  bookId: string;
  bookTitle: string;
  /** Cast for the book the events belong to. Used for avatar colour /
      display name resolution; missing entries fall back to the event's
      embedded `current.name` so cross-book events still render. */
  characters: Character[];
  /** Pre-grouped drift events from `selectDriftGroupsByBook`. */
  groups: DriftGroup[];
}

interface Props {
  groupsByBook: DriftBookGroupView[];
  onClose: () => void;
  onRegenerateChapter: (bookId: string, characterId: string, chapterId: number) => void;
  /** Optional one-click shortcut for events flagged `autoQueueable` by
      the server (severe drift). When provided, the per-event button on
      autoQueueable rows switches from "Regenerate this chapter" to
      "Auto-regen now". Both trigger an immediate whole-chapter regen
      (plan 114 — the per-character scope was removed); auto-regen just
      skips the extra click. Plan 20 C1+C2. */
  onAutoQueueRegenerate?: (bookId: string, characterId: string, chapterId: number) => void;
  onDismiss: (eventId: string) => void;
  voices?: Voice[];
  /* When set, hides every drift card whose characterId doesn't match.
     Surfaces a "Showing 1 character · Show all" affordance below the
     header so the user can drop the filter without re-opening. Drives
     the per-character pill entry path so the user lands directly on
     the character whose pill they clicked. */
  filterCharacterId?: string | null;
  onClearFilter?: () => void;
}

/* Resolve a display name for the per-character filter banner. The cast
   slice in the active book is the first source (carries the user-edited
   name); cross-book filters fall back to whatever the server embedded
   on the drift event itself (`group.current.name`). Returns null when
   neither side has a name, so the banner can render a safe "this
   character" placeholder. */
function findFilterCharacterName(
  groupsByBook: DriftBookGroupView[],
  characterId: string,
): string | null {
  for (const view of groupsByBook) {
    const cast = view.characters.find((c) => c.id === characterId);
    if (cast?.name) return cast.name;
    const group = view.groups.find((g) => g.characterId === characterId);
    if (group?.current?.name) return group.current.name;
  }
  return null;
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
  groupsByBook,
  onClose,
  onRegenerateChapter,
  onAutoQueueRegenerate,
  onDismiss,
  voices,
  filterCharacterId,
  onClearFilter,
}: Props) {
  /* When a per-character filter is active, prune each book's groups
     down to that character. Empty books drop out so the section
     header doesn't render an empty card. Memoised separately from
     the parent so the unfiltered identity stays stable when the
     filter is cleared. */
  const visibleGroupsByBook = useMemo(() => {
    if (!filterCharacterId) return groupsByBook;
    const out: DriftBookGroupView[] = [];
    for (const view of groupsByBook) {
      const groups = view.groups.filter((g) => g.characterId === filterCharacterId);
      if (groups.length > 0) out.push({ ...view, groups });
    }
    return out;
  }, [groupsByBook, filterCharacterId]);
  const filterCharacterName = filterCharacterId
    ? findFilterCharacterName(groupsByBook, filterCharacterId)
    : null;
  /* Total = unique flagged chapters across every visible group. Dedupe by
     (book, chapter): a chapter can drift for several cast members AND several
     factors, but regenerating it clears all of them, so it counts once.
     Summing per-character `chapters.length` (the prior shape) double-counted a
     chapter shared by two characters; counting raw events also multiplied by
     factor. distinctDriftChapterCount collapses both dimensions. */
  const totalCount = distinctDriftChapterCount(
    visibleGroupsByBook.flatMap((g) => g.groups.flatMap((gr) => gr.events)),
  );
  /* Edge case: filter is set but the matching character has zero
     chapters (race between dispatch + drift slice update). Render
     nothing rather than an empty modal — same null-return contract as
     the unfiltered empty case below. */
  if (totalCount === 0) return null;
  const bookCount = visibleGroupsByBook.length;

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
            {filterCharacterId && onClearFilter ? (
              <div
                className="-mt-2 -mx-2 px-3 py-2 rounded-2xl bg-amber-50/70 border border-amber-200 flex items-center gap-3 text-sm"
                data-testid="drift-report-character-filter-banner"
              >
                <span className="text-ink/75">
                  Showing drift for <span className="font-semibold text-ink">{filterCharacterName ?? 'this character'}</span> only.
                </span>
                <button
                  onClick={onClearFilter}
                  data-testid="drift-report-clear-character-filter"
                  className="ml-auto text-xs font-semibold text-ink/70 hover:text-ink"
                >
                  Show all characters
                </button>
              </div>
            ) : (
              <p className="text-sm text-ink/70 leading-relaxed">
                We compared each chapter against the character's established voice profile. The "When
                rendered" column shows the snapshot captured at synthesis time; "Now" shows the live
                profile. Severe and moderate findings are worth a listen — mild ones are usually
                within tolerance.
              </p>
            )}

            {visibleGroupsByBook.map((view) => (
              <DriftBookSection
                key={view.bookId}
                view={view}
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
  view,
  voices,
  onRegenerateChapter,
  onAutoQueueRegenerate,
  onDismiss,
}: {
  view: DriftBookGroupView;
  voices?: Voice[];
  onRegenerateChapter: (bookId: string, characterId: string, chapterId: number) => void;
  onAutoQueueRegenerate?: (bookId: string, characterId: string, chapterId: number) => void;
  onDismiss: (eventId: string) => void;
}) {
  /* Bucket cards by topSeverity so the severity-ordering UX persists —
     the user reads severe drift first, mild last. */
  const bySeverity = useMemo(() => {
    const acc: Record<DriftEvent['severity'], DriftGroup[]> = {
      severe: [],
      moderate: [],
      mild: [],
    };
    for (const g of view.groups) acc[g.topSeverity].push(g);
    return acc;
  }, [view.groups]);
  const totalChapters = useMemo(
    () => distinctDriftChapterCount(view.groups.flatMap((g) => g.events)),
    [view.groups],
  );
  const findChar = (id: string) => view.characters.find((c) => c.id === id);

  return (
    <section className="space-y-4">
      <header className="flex items-center gap-3 pb-2 border-b border-ink/10">
        <span className="text-[10px] uppercase tracking-widest text-ink/45 font-semibold">
          Book
        </span>
        <h4 className="text-sm font-bold text-ink leading-tight flex-1 truncate">
          {view.bookTitle}
        </h4>
        <span className="text-xs text-ink/50 tabular-nums">{totalChapters} flagged</span>
      </header>

      {severityOrder.map((sev) => {
        const items = bySeverity[sev];
        if (!items || items.length === 0) return null;
        return (
          <section key={sev}>
            <div className="flex items-center gap-3 mb-3">
              <Pill color={severityColor[sev]}>{severityLabel[sev]}</Pill>
              <span className="flex-1 h-px bg-ink/10" />
              <span className="text-xs text-ink/50 tabular-nums">{items.length}</span>
            </div>
            <div className="space-y-2">
              {items.map((g) => {
                const char = findChar(g.characterId);
                return (
                  <DriftGroupCard
                    key={g.groupId}
                    group={g}
                    bookId={view.bookId}
                    character={char}
                    voices={voices}
                    onRegenerateChapter={onRegenerateChapter}
                    onAutoQueueRegenerate={onAutoQueueRegenerate}
                    onDismiss={onDismiss}
                  />
                );
              })}
            </div>
          </section>
        );
      })}
    </section>
  );
}

const DriftGroupCard = memo(function DriftGroupCard({
  group,
  bookId,
  character,
  voices,
  onRegenerateChapter,
  onAutoQueueRegenerate,
  onDismiss,
}: {
  group: DriftGroup;
  bookId: string;
  character: Character | undefined;
  voices?: Voice[];
  onRegenerateChapter: (bookId: string, characterId: string, chapterId: number) => void;
  onAutoQueueRegenerate?: (bookId: string, characterId: string, chapterId: number) => void;
  onDismiss: (eventId: string) => void;
}) {
  /* `e.current.name` is always present from the server emit; the cast
     lookup adds color + the up-to-date display name when the cast slice
     happens to hold this book. */
  const { snapshot, current } = group;
  const displayName = character?.name || current?.name || group.characterId;
  const colorKey = (character?.color as CharColor | undefined) || 'narrator';
  const rowVoice = voices?.find((v) => v.id === character?.voiceId);
  const single = group.chapters.length === 1;
  const [expanded, setExpanded] = useState(single);

  /* Highlight any row whose snapshot ≠ current — the consolidated card
     shows the *full* drift surface, not just the factor that triggered
     the most recent event. The factor strip below the header still
     names which factors fired emits, but the compare table flags every
     differing field so the user can judge the whole picture at once. */
  const changedFactors = useMemo(() => diffFactors(snapshot, current), [snapshot, current]);

  return (
    <article
      className="p-4 rounded-2xl border border-ink/10 bg-white"
      data-testid={`drift-group-${group.groupId}`}
    >
      <div className="flex items-start gap-3">
        <Avatar name={displayName} color={colorKey} size={36} />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap mb-1">
            <h4 className="text-sm font-bold text-ink">{displayName}</h4>
            <span className="text-xs text-ink/50">·</span>
            <span className="text-xs font-semibold text-ink tabular-nums">
              {group.chapters.length} chapter{group.chapters.length === 1 ? '' : 's'}
            </span>
            {!single && (
              <span className="text-[10px] text-ink/45 tabular-nums">
                {group.severityCounts.severe > 0 && (
                  <span className="mr-1">{group.severityCounts.severe}× severe</span>
                )}
                {group.severityCounts.moderate > 0 && (
                  <span className="mr-1">{group.severityCounts.moderate}× moderate</span>
                )}
                {group.severityCounts.mild > 0 && (
                  <span>{group.severityCounts.mild}× mild</span>
                )}
              </span>
            )}
          </div>
          {group.factors.length > 0 && (
            <p
              className="text-[11px] uppercase tracking-wider font-bold mb-2 flex flex-wrap gap-x-2"
              style={{ color: CHAR_COLORS[colorKey].hex }}
              data-testid={`drift-group-factors-${group.groupId}`}
            >
              {group.factors.map((f) => (
                <span key={f}>{factorDisplay(f, group.events)}</span>
              ))}
            </p>
          )}
          <ProfileCompareCard
            snapshot={snapshot}
            current={current}
            changedFactors={changedFactors}
          />

          {single ? (
            <ChapterEntryRow
              entry={group.chapters[0]}
              characterId={group.characterId}
              bookId={bookId}
              character={character}
              voice={rowVoice}
              onRegenerateChapter={onRegenerateChapter}
              onAutoQueueRegenerate={onAutoQueueRegenerate}
              onDismiss={onDismiss}
            />
          ) : (
            <>
              <button
                onClick={() => setExpanded((x) => !x)}
                aria-expanded={expanded}
                data-testid={`drift-group-toggle-${group.groupId}`}
                className="mt-3 inline-flex items-center gap-1.5 text-xs font-semibold text-ink/70 hover:text-ink"
              >
                <IconChevD
                  className={`w-3.5 h-3.5 transition-transform ${expanded ? 'rotate-180' : ''}`}
                />
                {expanded
                  ? 'Hide chapters'
                  : `Show ${group.chapters.length} chapter${group.chapters.length === 1 ? '' : 's'}`}
              </button>
              {expanded && (
                <ul
                  className="mt-2 divide-y divide-ink/5 rounded-xl border border-ink/10 overflow-hidden"
                  data-testid={`drift-group-chapters-${group.groupId}`}
                >
                  {group.chapters.map((entry) => (
                    <li
                      key={`${bookId}|${group.characterId}|${entry.chapterId}`}
                      className="p-2 bg-white"
                    >
                      <ChapterEntryRow
                        entry={entry}
                        characterId={group.characterId}
                        bookId={bookId}
                        character={character}
                        voice={rowVoice}
                        onRegenerateChapter={onRegenerateChapter}
                        onAutoQueueRegenerate={onAutoQueueRegenerate}
                        onDismiss={onDismiss}
                        compact
                      />
                    </li>
                  ))}
                </ul>
              )}
              <div className="flex items-center gap-2 mt-3 flex-wrap">
                {group.allAutoQueueable && onAutoQueueRegenerate && (
                  <button
                    onClick={() => {
                      for (const ch of group.chapters) {
                        onAutoQueueRegenerate(bookId, group.characterId, ch.chapterId);
                      }
                    }}
                    data-testid={`drift-group-auto-regen-all-${group.groupId}`}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-peach text-ink text-xs font-semibold hover:bg-peach/85"
                  >
                    <IconRefresh className="w-3.5 h-3.5" /> Auto-regen all
                  </button>
                )}
                <button
                  onClick={() => {
                    for (const ch of group.chapters) {
                      onRegenerateChapter(bookId, group.characterId, ch.chapterId);
                    }
                  }}
                  data-testid={`drift-group-regen-all-${group.groupId}`}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-ink text-canvas text-xs font-semibold hover:bg-ink-soft"
                >
                  <IconRefresh className="w-3.5 h-3.5" /> Regenerate all
                </button>
                <button
                  onClick={() => {
                    /* Dismiss-all still loops over EVERY event (every
                       factor-event must be dismissed individually so a
                       chapter doesn't reappear on the next poll). */
                    for (const e of group.events) onDismiss(e.id);
                  }}
                  data-testid={`drift-group-dismiss-all-${group.groupId}`}
                  className="ml-auto text-xs font-medium text-ink/50 hover:text-ink/80"
                >
                  Dismiss all
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </article>
  );
});

/* Per-chapter row inside a consolidated card. `compact` is used inside
   the expanded chapter strip (smaller rows + reduced metadata); the
   non-compact form is the single-chapter optimisation that renders
   inline at the bottom of the card. Both render the same Regen / Listen
   / Dismiss surface.

   Takes a `DriftChapterEntry` (one per unique chapter — multi-factor
   events on the same chapter are pre-aggregated upstream in
   `groupDriftEvents`), not a single `DriftEvent`. Dismiss loops over
   every underlying eventId so a one-click dismiss takes down every
   factor-event for the chapter; otherwise the chapter would resurface
   on the next poll for any factor still flagging. */
function ChapterEntryRow({
  entry,
  characterId,
  bookId,
  character,
  voice,
  onRegenerateChapter,
  onAutoQueueRegenerate,
  onDismiss,
  compact,
}: {
  entry: DriftChapterEntry;
  characterId: string;
  bookId: string;
  character?: Character;
  voice?: Voice;
  onRegenerateChapter: (bookId: string, characterId: string, chapterId: number) => void;
  onAutoQueueRegenerate?: (bookId: string, characterId: string, chapterId: number) => void;
  onDismiss: (eventId: string) => void;
  compact?: boolean;
}) {
  /* Substring-stable test ids — the original per-event ids stay valid
     for existing tests (a one-factor chapter still matches
     `drift-event-drift:book-A:1:eliza:voice`). A new per-chapter id
     lets dedup-aware tests assert on chapter-scoped selectors. */
  const eventTestId = entry.representativeEvent.id;
  const chapterTestId = `drift-chapter-${bookId}-${characterId}-${entry.chapterId}`;
  return (
    <div
      className={`flex items-center gap-2 flex-wrap ${compact ? '' : 'mt-3'}`}
      data-testid={`drift-event-${eventTestId}`}
      data-chapter-testid={chapterTestId}
    >
      <span className="text-xs font-semibold text-ink tabular-nums">
        CH {String(entry.chapterId).padStart(2, '0')}
      </span>
      <span className="text-xs text-ink/70 flex-1 min-w-0 truncate">
        {stripChapterPrefix(entry.chapterTitle)}
      </span>
      {entry.autoQueueable && onAutoQueueRegenerate ? (
        <button
          onClick={() => onAutoQueueRegenerate(bookId, characterId, entry.chapterId)}
          data-testid={`drift-auto-regen-${eventTestId}`}
          title="Skip the confirmation modal — auto-queue this regeneration"
          className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-peach text-ink text-[11px] font-semibold hover:bg-peach/85"
        >
          <IconRefresh className="w-3 h-3" /> Auto-regen
        </button>
      ) : (
        <button
          onClick={() => onRegenerateChapter(bookId, characterId, entry.chapterId)}
          data-testid={`drift-regen-${eventTestId}`}
          className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-ink text-canvas text-[11px] font-semibold hover:bg-ink-soft"
        >
          <IconRefresh className="w-3 h-3" /> Regenerate
        </button>
      )}
      {voice && (
        <DriftListenWidget
          event={entry.representativeEvent}
          bookId={bookId}
          voice={voice}
          character={character}
        />
      )}
      <button
        onClick={() => {
          for (const id of entry.eventIds) onDismiss(id);
        }}
        data-testid={`drift-dismiss-${eventTestId}`}
        className="text-[11px] font-medium text-ink/50 hover:text-ink/80"
      >
        Dismiss
      </button>
    </div>
  );
}

/* Returns the set of factor strings whose value differs between two
   profile snapshots. Used to highlight every changed row in the compare
   card (the consolidated card shows the full drift surface, not just
   one trigger factor). */
function diffFactors(
  snap: DriftEvent['snapshot'] | undefined,
  cur: DriftEvent['current'] | undefined,
): Set<string> {
  const out = new Set<string>();
  if (!snap || !cur) return out;
  if (snap.voiceId !== cur.voiceId) out.add('voice');
  if (snap.gender !== cur.gender) out.add('gender');
  if (snap.ageRange !== cur.ageRange) out.add('ageRange');
  if (snap.tone?.warmth !== cur.tone?.warmth) out.add('warmth');
  if (snap.tone?.pace !== cur.tone?.pace) out.add('pace');
  if (snap.tone?.authority !== cur.tone?.authority) out.add('authority');
  if (snap.tone?.emotion !== cur.tone?.emotion) out.add('emotion');
  const a = (snap.attributes ?? []).slice().sort().join('|');
  const b = (cur.attributes ?? []).slice().sort().join('|');
  if (a !== b) out.add('attributes');
  return out;
}

/* Map a factor id back to a display label. Prefer the
   `factorLabel` carried on one of the group's events (server-provided,
   capitalised + localisable), fall back to a title-cased id. */
function factorDisplay(factorId: string, events: DriftEvent[]): string {
  const match = events.find((e) => e.factor === factorId);
  if (match?.factorLabel) return match.factorLabel;
  return factorId.charAt(0).toUpperCase() + factorId.slice(1);
}

/* Side-by-side "When rendered" vs "Now" profile comparison. Reads the
   structured `snapshot` (pre-render) and `current` (live cast) payloads
   the server attaches to every drift event. Fields that didn't change
   render in muted ink; changed fields are highlighted on the right
   column. The consolidated card passes the full set of changed factors
   so every drifting row lights up — not just the single factor that
   triggered the most recent event. */
const ProfileCompareCard = memo(function ProfileCompareCard({
  snapshot,
  current,
  changedFactors,
}: {
  snapshot: DriftEvent['snapshot'] | undefined;
  current: DriftEvent['current'] | undefined;
  changedFactors: Set<string>;
}) {
  const snap = snapshot ?? {};
  const cur = current ?? {};
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
          <ProfileCompareRow
            key={row.factor}
            row={row}
            changed={changedFactors.has(row.factor)}
          />
        ))}
      </div>
    </div>
  );
});

const ProfileCompareRow = memo(function ProfileCompareRow({
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
});

const ToneBar = memo(function ToneBar({
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
});

const AttributeList = memo(function AttributeList({
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
  const diff = useMemo(() => {
    if (!diffAgainst) return null;
    const before = new Set(diffAgainst);
    const after = new Set(values);
    return {
      added: values.filter((v) => !before.has(v)),
      removed: diffAgainst.filter((v) => !after.has(v)),
      kept: values.filter((v) => before.has(v)),
    };
  }, [values, diffAgainst]);
  if (values.length === 0 && (!diffAgainst || diffAgainst.length === 0)) {
    return <span className="text-ink/40">—</span>;
  }
  if (!diff) {
    /* Plain "before" rendering — comma-separated. */
    return (
      <span className={`${muted ? 'text-ink/55' : 'text-ink/70'} truncate`}>
        {values.join(', ')}
      </span>
    );
  }
  return (
    <div className="flex flex-wrap gap-1 items-center">
      {diff.kept.map((v) => (
        <span key={`k-${v}`} className="text-ink/65">
          {v}
        </span>
      ))}
      {diff.added.map((v) => (
        <span
          key={`a-${v}`}
          className={`rounded-full px-1.5 py-0.5 text-[10px] font-semibold ${
            highlight ? 'bg-magenta/15 text-magenta' : 'bg-ink/10 text-ink'
          }`}
        >
          + {v}
        </span>
      ))}
      {diff.removed.map((v) => (
        <span key={`r-${v}`} className="text-ink/40 line-through">
          {v}
        </span>
      ))}
      {highlight && <span className="text-magenta">←</span>}
    </div>
  );
});

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
          className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-canvas border border-ink/10 text-ink/70 hover:text-ink text-[11px] font-medium"
        >
          <IconWaveform className="w-3 h-3" /> Listen
        </button>
      ) : (
        <>
          <button
            data-testid={`drift-play-chapter-${event.id}`}
            onClick={() => (playing === 'A' ? pauseAll() : void playChapter())}
            className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full border text-[11px] font-medium ${playing === 'A' ? 'bg-ink text-canvas border-ink' : 'bg-canvas border-ink/10 text-ink/70 hover:text-ink'}`}
          >
            <IconWaveform className="w-3 h-3" />
            {playing === 'A' ? 'Pause chapter' : 'Chapter'}
          </button>
          <button
            data-testid={`drift-play-voice-${event.id}`}
            onClick={() => (playing === 'B' ? pauseAll() : void playVoice())}
            disabled={busy}
            className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full border text-[11px] font-medium disabled:opacity-50 disabled:cursor-wait ${playing === 'B' ? 'bg-ink text-canvas border-ink' : 'bg-canvas border-ink/10 text-ink/70 hover:text-ink'}`}
          >
            <IconWaveform className="w-3 h-3" />
            {busy ? 'Loading…' : playing === 'B' ? 'Pause voice' : 'Voice profile'}
          </button>
        </>
      )}
      <audio ref={chapterRef} onEnded={() => setPlaying((p) => (p === 'A' ? null : p))} />
      <audio ref={voiceRef} onEnded={() => setPlaying((p) => (p === 'B' ? null : p))} />
    </span>
  );
}
