import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { IconStar, IconDrag, IconCheck, IconSearch } from '../lib/icons';
import { VoiceSwatch, Pill } from './primitives';
import type { Character, Voice } from '../lib/types';
import { findCharacterForVoice } from '../lib/voice-character-link';
import { useAppDispatch, useAppSelector } from '../store';
import { assignVoice, type VoiceLibraryEntry } from '../store/voice-library-slice';

type Tab = 'all' | 'current' | 'library';

/* Module-level empty array so the defensive selector below (see
   EMPTY_LIBRARY_BOOKS in voices.tsx for the same pattern) returns a stable
   reference across renders when the `voiceLibrary` slice isn't registered —
   many existing test stores across the app compose CastView without it. */
const EMPTY_LIBRARY_ENTRIES: VoiceLibraryEntry[] = [];

interface VoiceLibraryPanelProps {
  library: Voice[];
  draggingVoiceId: string | null;
  setDraggingVoiceId: (id: string | null) => void;
  compact?: boolean;
  /* Optional Cast-view interactions: when a panel voice is also used by a
     character in the current book, clicking the card opens that character's
     profile drawer, and clicking the swatch bubble plays a voice sample.
     Library/series voices with no matching character stay drag-only. */
  characters?: Character[];
  onOpenProfile?: (id: string) => void;
  onPlaySample?: (character: Character, voice: Voice) => void;
  /* Plan 81 wave 3 — layout mode. Default ('aside') preserves the legacy
     desktop two-pane behaviour: panel caps height to the viewport so it
     can sit sticky alongside the cast table. 'sheet' is for the mobile /
     tablet bottom-sheet on the cast view — the panel fills its sheet
     parent's height instead of self-capping, since the sheet itself
     owns the height envelope. */
  displayMode?: 'aside' | 'sheet';
  /* Plan 81 wave 4 — touch-friendly alternative to drag-and-drop. When
     set, every voice card renders an "Assign" pill alongside its drag
     handle; tapping the pill calls onTapAssign(voice) which the cast
     view uses to enter assignment mode (sticky banner + tap-a-character
     to apply). Drag-and-drop on desktop stays intact regardless. */
  onTapAssign?: (voice: Voice) => void;
  assigningVoiceId?: string | null;
  /* fs-41/fs-50 seam 4a — BCP-47 language of the current book. When set
     to a non-English code, voices whose `languageCode` doesn't match are
     hidden behind a "N hidden · can't read <Language> · show all" toggle
     so the user can't pick a voice that would be cleared at generation.
     English books (`bookLanguage === 'en'` or absent) are unaffected. */
  bookLanguage?: string;
  /* fs-38 Wave 1, Task 16 — the open book's id. Required (alongside
     `characters`) for the "My voices" group's tap-to-assign affordance,
     which dispatches `assignVoice(uuid, { bookId, characterId })`. The
     group renders nothing without both — there's no book to assign into. */
  bookId?: string;
}

export function VoiceLibraryPanel({
  library,
  draggingVoiceId,
  setDraggingVoiceId,
  compact = false,
  characters,
  onOpenProfile,
  onPlaySample,
  displayMode = 'aside',
  onTapAssign,
  assigningVoiceId,
  bookLanguage,
  bookId,
}: VoiceLibraryPanelProps) {
  const [query, setQuery] = useState('');
  const [showAll, setShowAll] = useState(false);
  /* fs-38 Wave 1, Task 16 — "My voices" group at the top of the panel. Its
     own tap-to-assign flow (voiceUuid currently showing its inline
     character picker) is deliberately local + self-contained rather than
     reusing the existing `onTapAssign`/`assigningVoiceId` two-step (that
     one is driven by cast.tsx's assign-mode state machine, keyed by
     Voice.familyKey, and completes by dropping onto/tapping a cast ROW —
     a library entry isn't a `Voice` and has no row to complete against). */
  const dispatch = useAppDispatch();
  /* Defensive read (mirrors EMPTY_LIBRARY_BOOKS/EMPTY_CONFIG_VALUES in
     voices.tsx): the panel mounts inside CastView, which many existing test
     stores compose WITHOUT the `voiceLibrary` slice registered — a plain
     `selectMyVoices` (state.voiceLibrary.entries) would throw for all of
     them. Falls back to no entries, which just hides the group (same as a
     freshly-hydrated empty library). Sort mirrors `selectMyVoices`
     (pinned first, then most-recently-updated). */
  const myVoicesEntries = useAppSelector(
    (s) => (s as { voiceLibrary?: { entries: VoiceLibraryEntry[] } }).voiceLibrary?.entries,
  );
  const myVoices = useMemo(
    () =>
      (myVoicesEntries ?? EMPTY_LIBRARY_ENTRIES).slice().sort((a, b) => {
        if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
        return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
      }),
    [myVoicesEntries],
  );
  const [assigningLibraryUuid, setAssigningLibraryUuid] = useState<string | null>(null);
  /* Whether any voice belongs to the open book's series (a sibling book — the
     `source === 'library'` half — that shares its author + series). The server
     tags these `inCurrentSeries`. A standalone (or a one-book series) has none,
     so the "Series" tab is meaningless and we hide it rather than surface an
     empty / wrong-series tab. */
  const hasSeriesVoices = useMemo(
    () => library.some((v) => v.source === 'library' && v.inCurrentSeries),
    [library],
  );
  /* Context-aware default: a series book opens on its "Series" tab (the
     siblings available to reuse); a standalone opens on "This book". The tab
     stays auto-driven until the user picks one — and `library` often arrives
     async, so re-derive when the series signal flips (the ref keeps a manual
     pick from being overwritten when voices load in). */
  const [tab, setTab] = useState<Tab>('current');
  const userPickedRef = useRef(false);
  useEffect(() => {
    if (userPickedRef.current) return;
    setTab(hasSeriesVoices ? 'library' : 'current');
  }, [hasSeriesVoices]);
  const pickTab = (t: Tab) => {
    userPickedRef.current = true;
    setTab(t);
  };
  /* Guard against a selected 'library' tab that no longer exists (voices
     changed out from under it) — fall back to "This book" for filtering and
     the active-state highlight. */
  const activeTab: Tab = tab === 'library' && !hasSeriesVoices ? 'current' : tab;
  /* Tab filter first, then a case-insensitive substring match on the two
     fields a card actually shows (character name + book title). With 75+
     voices the tabs alone don't make a single character findable, so the
     search box is the primary on-ramp on a long series. */
  const q = query.trim().toLowerCase();
  const filtered = library
    .filter((v) => {
      if (activeTab === 'all') return true;
      if (activeTab === 'current') return v.source === 'current';
      /* 'library' tab is labelled "Series": only this book's series siblings,
         not every other book in the workspace. */
      return v.source === 'library' && !!v.inCurrentSeries;
    })
    .filter(
      (v) =>
        !q ||
        v.character.toLowerCase().includes(q) ||
        v.bookTitle.toLowerCase().includes(q),
    );
  /* fs-41/fs-50 seam 4a — language eligibility filter. Only active for
     non-English books: a voice is eligible when its `languageCode` matches
     the book's language. Preset/catalog voices (no `languageCode`) are
     ineligible for a non-English book because they can't read foreign text.
     English books skip the filter entirely so the picker stays byte-identical. */
  const filterByLanguage = !!bookLanguage && bookLanguage !== 'en';
  const isEligible = (v: Voice) => !filterByLanguage || v.languageCode === bookLanguage;
  const shown = filterByLanguage && !showAll ? filtered.filter(isEligible) : filtered;
  const hidden = filterByLanguage && !showAll ? filtered.filter((v) => !isEligible(v)) : [];
  const hiddenCount = hidden.length;
  const languageLabel = bookLanguage
    ? ({ ru: 'Russian', es: 'Spanish', fr: 'French', de: 'German' }[bookLanguage] ?? bookLanguage)
    : '';
  const bookCount = new Set(library.map((v) => v.bookId)).size;
  const tabs: Array<{ id: Tab; label: string }> = [
    { id: 'all', label: 'All' },
    { id: 'current', label: 'This book' },
    ...(hasSeriesVoices ? [{ id: 'library' as Tab, label: 'Series' }] : []),
  ];
  /* `characters` here is always the currently-open book's own cast, so opt
     into the current-book restriction — a same-id foreign-book voice (the
     narrator/unknown-male/unknown-female collision) must never resolve to
     one of this book's own characters. */
  const findCharacter = (v: Voice) =>
    characters ? findCharacterForVoice(v, characters, true) : undefined;
  /* Aside mode keeps the legacy sticky-card sizing. Sheet mode strips
     the rounded card chrome + height cap so the panel can lie flush
     inside the bottom-sheet (which provides its own border + radius
     at the top edge only). */
  const containerClass =
    displayMode === 'sheet'
      ? 'bg-white overflow-hidden flex flex-col h-full'
      : 'bg-white rounded-3xl border border-ink/10 shadow-card overflow-hidden flex flex-col max-h-[calc(100vh-120px)]';
  return (
    <div className={containerClass}>
      <div className="p-5 pb-0">
        <div className="flex items-center justify-between mb-2">
          <h2 className="text-sm font-bold text-ink">Voice library</h2>
          <span className="text-xs text-ink/50">
            {library.length} voices · {bookCount} {bookCount === 1 ? 'book' : 'books'}
          </span>
        </div>
        <p className="text-xs text-ink/50 mb-3">
          {onTapAssign
            ? 'Drag a voice onto a character, or tap "Assign" then tap a character.'
            : 'Drag onto a character to reuse.'}
        </p>
        <div className="flex items-center gap-1 bg-ink/4 rounded-full p-0.5 text-xs">
          {tabs.map((t) => (
            <button
              key={t.id}
              onClick={() => pickTab(t.id)}
              className={`flex-1 px-2 py-1 rounded-full font-medium transition-colors ${activeTab === t.id ? 'bg-white text-ink shadow-card' : 'text-ink/60'}`}
            >
              {t.label}
            </button>
          ))}
        </div>
        <div className="relative mt-3 mb-1">
          <IconSearch className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-ink/40" />
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search voices"
            aria-label="Search voices"
            className="w-full min-h-[44px] fine-pointer:min-h-0 pl-9 pr-3 py-2 rounded-full bg-ink/4 border border-ink/10 text-xs focus:outline-hidden focus:border-ink/30"
          />
        </div>
      </div>
      <div
        data-testid="voice-library-scroll"
        className="p-5 overflow-y-auto scrollbar-thin space-y-2"
      >
        {myVoices.length > 0 && bookId && characters && (
          <div
            data-testid="voice-library-my-voices-group"
            className="mb-3 pb-3 border-b border-ink/10 space-y-2"
          >
            <p className="text-[11px] uppercase tracking-widest text-ink/40 font-semibold px-1">
              My voices
            </p>
            {myVoices.map((entry) => (
              <MyVoiceCard
                key={entry.voiceUuid}
                entry={entry}
                characters={characters}
                assigning={assigningLibraryUuid === entry.voiceUuid}
                onToggleAssign={() =>
                  setAssigningLibraryUuid((cur) =>
                    cur === entry.voiceUuid ? null : entry.voiceUuid,
                  )
                }
                onAssignTo={(characterId) => {
                  dispatch(assignVoice({ voiceUuid: entry.voiceUuid, bookId, characterId }));
                  setAssigningLibraryUuid(null);
                }}
              />
            ))}
          </div>
        )}
        {shown.length === 0 && q ? (
          <p className="text-center text-xs text-ink/40 py-6">
            No voices match “{query.trim()}”
          </p>
        ) : (
          shown.map((v) => (
            <VoiceCard
              /* familyKey (falling back to id) — two unrelated books' same-
                 slug, voiceId-less voices (narrator/unknown-male/female) can
                 share bare `id` in this flat, all-books array, which would
                 otherwise collide on the React key and cross-highlight both
                 cards as the active assign target. */
              key={v.familyKey ?? v.id}
              voice={v}
              draggingVoiceId={draggingVoiceId}
              setDraggingVoiceId={setDraggingVoiceId}
              compact={compact}
              character={findCharacter(v)}
              onOpenProfile={onOpenProfile}
              onPlaySample={onPlaySample}
              onTapAssign={onTapAssign}
              isAssigningTarget={assigningVoiceId === (v.familyKey ?? v.id)}
            />
          ))
        )}
        {filterByLanguage && hiddenCount > 0 && !showAll && (
          <button
            type="button"
            onClick={() => setShowAll(true)}
            className="w-full text-center text-xs text-ink/50 hover:text-ink py-2 min-h-[44px] fine-pointer:min-h-0"
          >
            {hiddenCount} hidden · can&apos;t read {languageLabel} ·{' '}
            <span className="underline">show all</span>
          </button>
        )}
      </div>
    </div>
  );
}

interface VoiceCardProps {
  voice: Voice;
  draggingVoiceId: string | null;
  setDraggingVoiceId: (id: string | null) => void;
  compact?: boolean;
  showBookTitle?: boolean;
  pinned?: boolean;
  onTogglePin?: (voice: Voice) => void;
  character?: Character;
  onOpenProfile?: (id: string) => void;
  onPlaySample?: (character: Character, voice: Voice) => void;
  /* Library-view click handler. When set, takes precedence over the
     character+onOpenProfile pair so a voice card is interactive even when
     no character from the currently-loaded cast matches — e.g. the global
     `#/voices` page, where the click navigates to the voice's source book. */
  onSelect?: (voice: Voice) => void;
  /* Multi-select affordance (plan 22a). When BOTH `selected` and
     `onToggleSelect` are set, the card renders a checkbox at top-left that
     toggles selection without firing onSelect/onOpenProfile. Mirrors the
     DOM in `src/views/cast.tsx` (~lines 200-203). When either prop is
     omitted, the legacy drag-only / click-to-open card renders unchanged. */
  selected?: boolean;
  onToggleSelect?: (voice: Voice) => void;
  /* Plan 81 wave 4 — touch-friendly tap-to-assign affordance. When set,
     the card renders an "Assign" pill that fires onTapAssign(voice) so
     phones/tablets (where HTML5 drag-and-drop doesn't fire) can still
     reuse voices. isAssigningTarget surfaces the active state. */
  onTapAssign?: (voice: Voice) => void;
  isAssigningTarget?: boolean;
  /* Optional status pill rendered beside the character name (plan 117).
     The Qwen "Designed voices" section passes a Designed / Generated badge
     here; preset cards leave it unset. */
  badge?: ReactNode;
  /* fs-38 Wave 1, Task 16 — optional extra row below the attribute chips.
     The In-use "Designed voices" cards use this for the shared
     VoiceProvenanceBadge + an inline "Save to my voices" / "View in My
     voices" affordance. Unset elsewhere — no layout change when absent. */
  footer?: ReactNode;
}

export function VoiceCard({
  voice,
  draggingVoiceId,
  setDraggingVoiceId,
  compact = false,
  showBookTitle = true,
  pinned = false,
  onTogglePin,
  character,
  onOpenProfile,
  onPlaySample,
  onSelect,
  selected,
  onToggleSelect,
  onTapAssign,
  isAssigningTarget = false,
  badge,
  footer,
}: VoiceCardProps) {
  const isDragging = draggingVoiceId === (voice.familyKey ?? voice.id);
  const canOpenProfile = !!(character && onOpenProfile);
  const canPlay = !!(character && onPlaySample);
  const interactive = !!onSelect || canOpenProfile;
  const selectable = selected !== undefined && !!onToggleSelect;
  const activate = onSelect
    ? () => onSelect(voice)
    : canOpenProfile
      ? () => onOpenProfile!(character!.id)
      : undefined;
  return (
    <div
      draggable
      onDragStart={(e) => {
        setDraggingVoiceId(voice.familyKey ?? voice.id);
        e.dataTransfer.effectAllowed = 'copy';
      }}
      onDragEnd={() => setDraggingVoiceId(null)}
      onClick={activate}
      role={interactive ? 'button' : undefined}
      tabIndex={interactive ? 0 : undefined}
      onKeyDown={
        activate
          ? (e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                activate();
              }
            }
          : undefined
      }
      className={`group flex items-start gap-3 p-3 rounded-2xl border bg-canvas hover:bg-white border-ink/10 cursor-grab active:cursor-grabbing transition-all ${isDragging ? 'opacity-40 scale-[0.98]' : ''} ${selectable && selected ? 'bg-peach/4' : ''}`}
    >
      {selectable && (
        <span
          onClick={(e) => {
            e.stopPropagation();
            onToggleSelect!(voice);
          }}
          onMouseDown={(e) => e.stopPropagation()}
          className="grid place-items-center pt-0.5"
          aria-label={selected ? 'Deselect voice' : 'Select voice for compare'}
        >
          <span
            className={`w-5 h-5 rounded-md grid place-items-center transition-colors ${selected ? 'bg-peach' : 'bg-white border border-ink/20 hover:border-ink/40'}`}
          >
            {selected && <IconCheck className="w-3 h-3 text-white" />}
          </span>
        </span>
      )}
      <span onClick={(e) => e.stopPropagation()} onMouseDown={(e) => e.stopPropagation()}>
        <VoiceSwatch
          voice={voice}
          size="sm"
          showLabel={false}
          onSelect={canPlay ? () => onPlaySample!(character!, voice) : undefined}
        />
      </span>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <p className="text-sm font-bold text-ink truncate">{voice.character}</p>
          {badge}
          {voice.source === 'library' && voice.usedIn > 1 && (
            <Pill color="library">
              <IconStar className="w-2.5 h-2.5 mr-0.5" />×{voice.usedIn}
            </Pill>
          )}
          {onTogglePin && (
            <button
              type="button"
              onMouseDown={(e) => e.stopPropagation()}
              onClick={(e) => {
                e.stopPropagation();
                onTogglePin(voice);
              }}
              aria-label={pinned ? 'Unpin voice' : 'Pin voice'}
              aria-pressed={pinned}
              className={`ml-auto w-6 h-6 grid place-items-center rounded-full transition-colors shrink-0 ${pinned ? 'bg-peach text-ink' : 'text-ink/30 hover:text-ink hover:bg-ink/6'}`}
            >
              <IconStar className="w-3.5 h-3.5" />
            </button>
          )}
        </div>
        {showBookTitle && <p className="text-[11px] text-ink/60 truncate">{voice.bookTitle}</p>}
        {voice.ttsVoice && (
          <p
            title={`Prebuilt ${voice.ttsVoice.provider} voice — ${voice.ttsVoice.description}`}
            className="text-[11px] mt-0.5 truncate"
          >
            <span className="font-semibold text-ink/70">Voice · {voice.ttsVoice.name}</span>
            <span className="text-ink/40"> · {voice.ttsVoice.description}</span>
          </p>
        )}
        {!compact && (
          <div className="mt-1.5 flex flex-wrap gap-1">
            {voice.attributes.slice(0, 3).map((a) => (
              <Pill key={a}>{a}</Pill>
            ))}
          </div>
        )}
        {footer && (
          <div
            className="mt-1.5 flex items-center gap-2 flex-wrap"
            onClick={(e) => e.stopPropagation()}
            onMouseDown={(e) => e.stopPropagation()}
          >
            {footer}
          </div>
        )}
      </div>
      {onTapAssign ? (
        <button
          type="button"
          onMouseDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation();
            onTapAssign(voice);
          }}
          aria-label={isAssigningTarget ? `Cancel assigning ${voice.character}` : `Assign ${voice.character} to a character`}
          aria-pressed={isAssigningTarget}
          className={`shrink-0 min-h-[44px] min-w-[44px] px-3 inline-flex items-center justify-center rounded-full text-xs font-semibold transition-colors ${isAssigningTarget ? 'bg-magenta text-white hover:bg-magenta/90' : 'bg-ink/6 text-ink/70 hover:bg-ink/10 hover:text-ink'}`}
        >
          {isAssigningTarget ? 'Cancel' : 'Assign'}
        </button>
      ) : (
        <span className="text-ink/30 group-hover:text-ink/60 group-active:text-ink/60 transition-colors mt-1 hidden md:inline">
          <IconDrag className="w-4 h-4" />
        </span>
      )}
    </div>
  );
}

/* fs-38 Wave 1, Task 16 — one "My voices" group row: a compact card (name +
   Assign pill) that expands into a row of character-name buttons when
   tapped. Tapping a character completes the assign immediately — no
   separate "drop onto a row" step, since there's no cast row to drop onto
   here (the parent owns the actual dispatch via `onAssignTo`). */
function MyVoiceCard({
  entry,
  characters,
  assigning,
  onToggleAssign,
  onAssignTo,
}: {
  entry: VoiceLibraryEntry;
  characters: Character[];
  assigning: boolean;
  onToggleAssign: () => void;
  onAssignTo: (characterId: string) => void;
}) {
  return (
    <div>
      <div className="flex items-center gap-3 p-3 rounded-2xl border bg-canvas hover:bg-white border-ink/10">
        <span className="flex-1 min-w-0 text-sm font-bold text-ink truncate">{entry.name}</span>
        <button
          type="button"
          onClick={onToggleAssign}
          aria-pressed={assigning}
          aria-label={assigning ? `Cancel assigning ${entry.name}` : `Assign ${entry.name} to a character`}
          data-testid={`my-voices-panel-assign-${entry.voiceUuid}`}
          className={`shrink-0 min-h-[44px] min-w-[44px] px-3 inline-flex items-center justify-center rounded-full text-xs font-semibold transition-colors ${assigning ? 'bg-magenta text-white hover:bg-magenta/90' : 'bg-ink/6 text-ink/70 hover:bg-ink/10 hover:text-ink'}`}
        >
          {assigning ? 'Cancel' : 'Assign'}
        </button>
      </div>
      {assigning && (
        <div className="mt-1.5 pl-2 flex flex-wrap gap-1.5">
          {characters.map((c) => (
            <button
              key={c.id}
              type="button"
              onClick={() => onAssignTo(c.id)}
              data-testid={`my-voices-panel-assign-target-${entry.voiceUuid}-${c.id}`}
              className="px-2.5 py-1.5 rounded-full text-[11px] font-medium bg-ink/4 hover:bg-magenta/15 hover:text-magenta text-ink/70 min-h-[44px] fine-pointer:min-h-0"
            >
              {c.name}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
