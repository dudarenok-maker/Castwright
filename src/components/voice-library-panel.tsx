import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { IconStar, IconDrag, IconCheck, IconSearch } from '../lib/icons';
import { VoiceSwatch, Pill } from './primitives';
import type { Character, Voice } from '../lib/types';
import { findCharacterForVoice } from '../lib/voice-character-link';

type Tab = 'all' | 'current' | 'library';

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
}: VoiceLibraryPanelProps) {
  const [query, setQuery] = useState('');
  const [showAll, setShowAll] = useState(false);
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
  const languageLabel =
    ({ ru: 'Russian', es: 'Spanish', fr: 'French', de: 'German' } as Record<string, string>)[
      bookLanguage ?? ''
    ] ?? bookLanguage ?? '';
  const bookCount = new Set(library.map((v) => v.bookId)).size;
  const tabs: Array<{ id: Tab; label: string }> = [
    { id: 'all', label: 'All' },
    { id: 'current', label: 'This book' },
    ...(hasSeriesVoices ? [{ id: 'library' as Tab, label: 'Series' }] : []),
  ];
  const findCharacter = (v: Voice) =>
    characters ? findCharacterForVoice(v, characters) : undefined;
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
            className="w-full min-h-[44px] sm:min-h-0 pl-9 pr-3 py-2 rounded-full bg-ink/4 border border-ink/10 text-xs focus:outline-hidden focus:border-ink/30"
          />
        </div>
      </div>
      <div
        data-testid="voice-library-scroll"
        className="p-5 overflow-y-auto scrollbar-thin space-y-2"
      >
        {shown.length === 0 && q ? (
          <p className="text-center text-xs text-ink/40 py-6">
            No voices match “{query.trim()}”
          </p>
        ) : (
          shown.map((v) => (
            <VoiceCard
              key={v.id}
              voice={v}
              draggingVoiceId={draggingVoiceId}
              setDraggingVoiceId={setDraggingVoiceId}
              compact={compact}
              character={findCharacter(v)}
              onOpenProfile={onOpenProfile}
              onPlaySample={onPlaySample}
              onTapAssign={onTapAssign}
              isAssigningTarget={assigningVoiceId === v.id}
            />
          ))
        )}
        {filterByLanguage && hiddenCount > 0 && !showAll && (
          <button
            type="button"
            onClick={() => setShowAll(true)}
            className="w-full text-center text-xs text-ink/50 hover:text-ink py-2 min-h-[44px] sm:min-h-0"
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
}: VoiceCardProps) {
  const isDragging = draggingVoiceId === voice.id;
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
        setDraggingVoiceId(voice.id);
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
            <span className="font-semibold text-ink/70">TTS · {voice.ttsVoice.name}</span>
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
        <span className="text-ink/30 group-hover:text-ink/60 transition-colors mt-1 hidden md:inline">
          <IconDrag className="w-4 h-4" />
        </span>
      )}
    </div>
  );
}
