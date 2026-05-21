import { useEffect, useMemo, useState } from 'react';
import { SectionLabel, MixedHeading, VoiceSwatch } from '../components/primitives';
import { StatTile } from '../components/stat-tiles';
import { VoiceCard } from '../components/voice-library-panel';
import { IconPlay } from '../lib/icons';
import type { BaseVoice, Character, TtsEngine, TtsModelKey, Voice } from '../lib/types';
import {
  TTS_ENGINES,
  engineForModelKey,
  engineGroupForModelKey,
  type TtsEngineId,
} from '../lib/tts-models';
import { useAppDispatch, useAppSelector } from '../store';
import { uiActions } from '../store/ui-slice';
import { castActions } from '../store/cast-slice';
import { voicesActions } from '../store/voices-slice';
import { notificationsActions } from '../store/notifications-slice';
import { api } from '../lib/api';
import { useSamplePlayback } from '../lib/use-sample-playback';
import { playBaseVoiceSampleWithAutoLoad } from '../lib/play-sample-with-auto-load';
import { gradientForTtsVoice } from '../lib/voice-palette';
import { findCharacterForVoice } from '../lib/voice-character-link';
import { CompareCastModal } from '../modals/compare-cast-modal';

type Tab = 'all' | 'current' | 'library' | 'base';

interface Props {
  library: Voice[];
  /* Click handler for a voice/character card. The Voices view sits in two
     places: the global `#/voices` page (no book loaded) and the per-book
     "Voices" tab (`#/books/:bookId/library`). Both wire this prop to open
     the linked character's profile drawer — in-place when the voice belongs
     to the currently-open book, by navigating to the source book otherwise.
     When unset, cards stay drag-only (legacy behavior used by tests). */
  onOpenCharacter?: (voice: Voice) => void;
}

/* A voice "family" — every cast Voice that resolves to the same model
   speaker (e.g. every character mapped to Coqui · Asya Anara). Each family
   is the primary axis of the Voices view; cast members hang off it nested
   by book series → book → character. */
interface VoiceFamily {
  key: string;
  engine: TtsEngine;
  name: string;
  description: string;
  members: Voice[];
  totalUsedIn: number;
  primary: Voice;
  anyPinned: boolean;
  gradient: [string, string];
}

interface SeriesGroup {
  series: string | null;
  books: BookGroup[];
}

interface BookGroup {
  bookId: string;
  bookTitle: string;
  voices: Voice[];
}

const ENGINE_LABEL: Record<TtsEngine, string> = {
  coqui: 'Coqui',
  gemini: 'Gemini',
  piper: 'Piper',
  kokoro: 'Kokoro',
};

export function LibraryView({ library, onOpenCharacter }: Props) {
  const [tab, setTab] = useState<Tab>('all');
  const [draggingVoiceId, setDraggingVoiceId] = useState<string | null>(null);
  const [familyStatus, setFamilyStatus] = useState<{ key: string; label: string } | null>(null);
  /* Compare affordance (plan 22a + plan 60). Selection is local-only
     (mirrors `cast.tsx`'s ephemeral selection state); the pill at the
     bottom mounts `CompareCastModal` when the user has exactly 2
     selected that resolve to a same-`bookId` pair. Cross-book compare
     is a documented follow-up (BACKLOG #17). */
  const [selectedVoiceIds, setSelectedVoiceIds] = useState<string[]>([]);
  const [compareIds, setCompareIds] = useState<[string, string] | null>(null);
  /* Plan 60 — same-book pairs accessed from the global `#/voices` tab
     resolve their characters via an on-demand `api.getBookState(bookId)`
     fetch (the foreign book's cast is NOT in redux when no book is
     open). Cached in this component-local map for the modal session so
     re-opens within the same view-mount are instant; the cache resets
     when the user navigates away. `globalCastFailed` records bookIds
     whose fetch failed so the Compare button stays disabled
     retroactively without retrying on every render. */
  const [globalCastCache, setGlobalCastCache] = useState<Map<string, Character[]>>(
    () => new Map(),
  );
  const [globalCastFailed, setGlobalCastFailed] = useState<Set<string>>(() => new Set());
  const [globalCastFetching, setGlobalCastFetching] = useState<string | null>(null);
  const dispatch = useAppDispatch();
  const ttsModelKey = useAppSelector((s) => s.ui.ttsModelKey);
  const baseVoices = useAppSelector((s) => s.voices.baseVoices);
  const baseVoicesLoaded = useAppSelector((s) => s.voices.baseVoicesLoaded);
  /* Open book id (null on the global `#/voices` tab). Used to gate Compare:
     v1 only supports comparing voices that belong to the currently-open
     book, because that's the only book whose cast is hydrated in the
     redux store. Cross-book + same-book-from-global Compare are
     follow-ups tracked in `docs/BACKLOG.md` (Could bucket). */
  const currentBookId = useAppSelector((s) =>
    s.ui.stage.kind === 'ready' ? s.ui.stage.bookId : null,
  );
  const characters = useAppSelector((s) => s.cast.characters);
  const playback = useSamplePlayback();
  const activeEngine = engineForModelKey(ttsModelKey);

  const toggleSelect = (v: Voice) => {
    setSelectedVoiceIds((prev) =>
      prev.includes(v.id) ? prev.filter((id) => id !== v.id) : [...prev, v.id],
    );
  };

  /* Hydrate the base-voice catalog once when the Voices view mounts. The
     catalog is small and changes only when the sidecar's loaded model
     changes — refreshing on every mount is cheap and keeps the picker
     honest after a sidecar bounce. */
  useEffect(() => {
    let cancelled = false;
    api
      .getBaseVoices()
      .then((res) => {
        if (!cancelled) dispatch(voicesActions.hydrateBaseVoices(res.voices));
      })
      .catch((err) => {
        console.error('[voices] base catalog hydrate failed', err);
      });
    return () => {
      cancelled = true;
    };
  }, [dispatch]);

  /* Group voices into families. The key is (engine, name) on ttsVoice —
     that's what's resolved server-side after honouring overrides, so two
     characters with the same engine+name appear under the same family
     regardless of how they got there. */
  const families = useMemo(() => buildFamilies(library, tab), [library, tab]);
  const books = [...new Set(library.map((v) => v.bookId))];

  /* Compare derivations. Memoised so a transient render doesn't recompute
     the same-base / different-base lookup or the disabled-reason string.
     `sharedBookId` is non-null when both selected voices share the same
     `bookId` — it picks which cast source to consult when resolving
     `Voice → Character` (redux for the open book, `globalCastCache`
     otherwise per plan 60). */
  const compareDerivations = useMemo(() => {
    const selectedVoices = selectedVoiceIds
      .map((id) => library.find((v) => v.id === id))
      .filter((v): v is Voice => !!v);
    let badge: 'same' | 'different' | null = null;
    if (selectedVoices.length === 2 && selectedVoices[0].ttsVoice && selectedVoices[1].ttsVoice) {
      const k0 = `${selectedVoices[0].ttsVoice.provider}|${selectedVoices[0].ttsVoice.name}`;
      const k1 = `${selectedVoices[1].ttsVoice.provider}|${selectedVoices[1].ttsVoice.name}`;
      badge = k0 === k1 ? 'same' : 'different';
    }
    let compareDisabledReason: string | null = null;
    let canCompare = false;
    let sharedBookId: string | null = null;
    if (selectedVoices.length !== 2) {
      compareDisabledReason = 'Select exactly 2 voices';
    } else if (selectedVoices[0].bookId !== selectedVoices[1].bookId) {
      /* Cross-book compare is BACKLOG #17 — depends on this plan but
         deferred. The disabled tooltip stays the same as plan 22a. */
      compareDisabledReason = 'Cross-book compare not supported yet';
    } else {
      sharedBookId = selectedVoices[0].bookId;
      /* Pick the cast source:
         - `bookId === currentBookId` → redux cast (open book is hydrated).
         - Otherwise → component-local foreign-cast cache (plan 60).
         The global `#/voices` tab (`currentBookId === null`) always
         lands in the second branch; the per-book tab lands here too if
         the user happens to select two voices from a *different* book. */
      const castSource =
        sharedBookId === currentBookId ? characters : globalCastCache.get(sharedBookId);
      if (globalCastFailed.has(sharedBookId)) {
        compareDisabledReason = 'Could not load that book — try again later';
      } else if (!castSource) {
        /* No cast yet for this foreign book — the Compare click triggers
           the fetch. The button is *enabled* here so the click can run;
           gating only re-asserts once the cast resolves. */
        canCompare = true;
      } else {
        const linkedCharacters = selectedVoices.map((v) => findCharacterForVoice(v, castSource));
        if (linkedCharacters.some((c) => !c)) {
          compareDisabledReason = 'Selected voice is no longer linked to a character';
        } else {
          canCompare = true;
        }
      }
    }
    return { selectedVoices, badge, canCompare, compareDisabledReason, sharedBookId };
  }, [selectedVoiceIds, library, currentBookId, characters, globalCastCache, globalCastFailed]);
  const { selectedVoices, badge, canCompare, compareDisabledReason, sharedBookId } =
    compareDerivations;

  /* Plan 60 — on-demand foreign-cast hydrate for same-book Compare from
     the global tab. Resolves `api.getBookState(bookId)` once per session;
     a hit populates `globalCastCache` and immediately opens the modal;
     a miss pushes a toast and adds the bookId to `globalCastFailed` so
     the gate stays closed without retrying on every render. The fetch
     is gated on `globalCastFetching` so a double-click on Compare can't
     fire two parallel requests. */
  async function fetchAndOpenForeignCast(
    bookId: string,
    voicePair: [string, string],
  ): Promise<void> {
    if (globalCastFetching === bookId) return;
    setGlobalCastFetching(bookId);
    try {
      const res = await api.getBookState(bookId);
      const cast = res?.cast?.characters ?? null;
      if (!cast || cast.length === 0) {
        throw new Error('book state has no cast');
      }
      setGlobalCastCache((prev) => {
        const next = new Map(prev);
        next.set(bookId, cast);
        return next;
      });
      setCompareIds(voicePair);
    } catch (err) {
      console.error('[voices] foreign cast fetch failed', err);
      setGlobalCastFailed((prev) => {
        if (prev.has(bookId)) return prev;
        const next = new Set(prev);
        next.add(bookId);
        return next;
      });
      dispatch(
        notificationsActions.pushToast({
          kind: 'error',
          message: 'Could not load that book — try a different pair.',
          dedupeKey: `voices-compare-fetch:${bookId}`,
        }),
      );
    } finally {
      setGlobalCastFetching(null);
    }
  }

  function togglePin(voice: Voice) {
    const next = !voice.pinned;
    dispatch(voicesActions.setPinned({ voiceId: voice.id, pinned: next }));
    api.setVoicePin(voice.id, next).catch((err) => {
      console.error('[voices] pin failed', err);
      dispatch(voicesActions.setPinned({ voiceId: voice.id, pinned: !next }));
    });
  }

  async function playFamilySample(family: VoiceFamily) {
    setFamilyStatus({ key: family.key, label: 'Preparing…' });
    try {
      await playBaseVoiceSampleWithAutoLoad({
        args: { engine: family.engine, speakerName: family.name, modelKey: ttsModelKey },
        playback,
        onStatus: (status) => {
          if (status === 'evicting') setFamilyStatus({ key: family.key, label: 'Freeing memory…' });
          if (status === 'loading-tts') setFamilyStatus({ key: family.key, label: 'Loading TTS…' });
          if (status === 'synthesizing')
            setFamilyStatus({ key: family.key, label: 'Synthesising…' });
        },
      });
    } catch (err) {
      console.error('[voices] family play failed', err);
      setFamilyStatus({ key: family.key, label: (err as Error).message || 'Failed' });
      return;
    }
    setFamilyStatus(null);
  }

  /* Per-base-voice play state — keyed by `${engine}|${name}`. Lets each row
     show its own in-progress label without thrashing the whole tab. */
  async function playBaseVoice(bv: BaseVoice) {
    const key = `${bv.engine}|${bv.name}`;
    setFamilyStatus({ key, label: 'Preparing…' });
    try {
      await playBaseVoiceSampleWithAutoLoad({
        args: { engine: bv.engine, speakerName: bv.name, modelKey: ttsModelKey },
        playback,
        onStatus: (status) => {
          if (status === 'evicting') setFamilyStatus({ key, label: 'Freeing memory…' });
          if (status === 'loading-tts') setFamilyStatus({ key, label: 'Loading TTS…' });
          if (status === 'synthesizing') setFamilyStatus({ key, label: 'Synthesising…' });
        },
      });
    } catch (err) {
      console.error('[voices] base voice play failed', err);
      setFamilyStatus({ key, label: (err as Error).message || 'Failed' });
      return;
    }
    setFamilyStatus(null);
  }

  /* Usage count for a base voice — how many cast members across the
     workspace resolve to this (engine, name). Drives the "Used by N" chip
     in the Base voices tab. */
  const usageByBaseVoice = useMemo(() => {
    const map = new Map<string, number>();
    for (const v of library) {
      if (!v.ttsVoice) continue;
      const k = `${v.ttsVoice.provider}|${v.ttsVoice.name}`;
      map.set(k, (map.get(k) ?? 0) + 1);
    }
    return map;
  }, [library]);

  const tabs: Array<{ id: Tab; label: string }> = [
    { id: 'all', label: `All (${library.length})` },
    { id: 'current', label: `This book (${library.filter((v) => v.source === 'current').length})` },
    {
      id: 'library',
      label: `Series & older (${library.filter((v) => v.source === 'library').length})`,
    },
    { id: 'base', label: `Base voices${baseVoicesLoaded ? ` (${baseVoices.length})` : ''}` },
  ];

  const familyCount = new Set(
    library.filter((v) => v.ttsVoice).map((v) => `${v.ttsVoice!.provider}|${v.ttsVoice!.name}`),
  ).size;

  return (
    <div className="max-w-[1400px] mx-auto px-6 py-10">
      <div className="mb-8 flex items-end justify-between gap-6 flex-wrap">
        <div>
          <SectionLabel>Voice library</SectionLabel>
          <div className="mt-4">
            <MixedHeading regular="Every voice you've" bold="ever generated" level="h1" />
          </div>
          <p className="mt-3 text-ink/60 max-w-2xl">
            Voices are grouped by the model voice they resolve to. Expand a family to see every cast
            member using it across books — handy when one base voice carries through a whole series.
          </p>
        </div>
        <div className="flex items-center gap-3">
          <TtsEngineModelPicker
            modelKey={ttsModelKey}
            onChange={(next) => dispatch(uiActions.setTtsModelKey(next))}
          />
        </div>
      </div>

      <div className="grid grid-cols-4 gap-4 mb-6">
        <StatTile label="Voices" value={library.length} />
        <StatTile label="Families" value={familyCount} />
        <StatTile label="Books" value={books.length} />
        <StatTile label="Pinned" value={library.filter((v) => v.pinned).length} />
      </div>

      <div className="flex items-center gap-1 mb-6 flex-wrap">
        {tabs.map((t) => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={`px-4 py-2 rounded-full text-sm font-medium transition-colors ${tab === t.id ? 'bg-ink text-canvas' : 'text-ink/60 hover:text-ink hover:bg-ink/[0.04]'}`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === 'base' ? (
        <BaseVoiceCatalogPanel
          baseVoices={baseVoices}
          baseVoicesLoaded={baseVoicesLoaded}
          usage={usageByBaseVoice}
          activeEngine={activeEngine}
          onPlay={playBaseVoice}
          status={familyStatus}
        />
      ) : families.length === 0 ? (
        <div className="bg-white rounded-3xl border border-ink/10 shadow-card p-10 text-center">
          <p className="text-sm font-bold text-ink">No voices yet</p>
          <p className="mt-2 text-xs text-ink/60 max-w-md mx-auto">
            Finish setting up a book — once you confirm its cast, every character will appear here
            as a reusable voice.
          </p>
        </div>
      ) : (
        <div className={`space-y-8 ${draggingVoiceId ? 'dragging-voice' : ''}`}>
          {families.map((f) => (
            <VoiceFamilySection
              key={f.key}
              family={f}
              draggingVoiceId={draggingVoiceId}
              setDraggingVoiceId={setDraggingVoiceId}
              onTogglePin={togglePin}
              onPlay={playFamilySample}
              status={familyStatus}
              onOpenCharacter={onOpenCharacter}
              selectedVoiceIds={selectedVoiceIds}
              onToggleSelect={toggleSelect}
            />
          ))}
        </div>
      )}

      {selectedVoiceIds.length > 0 && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-30 fade-in">
          <div className="bg-ink text-canvas rounded-full shadow-float px-4 py-2 flex items-center gap-3">
            <span className="text-xs text-canvas/60">Selected</span>
            <span className="px-2 py-0.5 rounded-full bg-canvas/15 text-canvas font-bold text-sm tabular-nums">
              {selectedVoiceIds.length}
            </span>
            {badge === 'same' && (
              <span
                role="status"
                className="px-2 py-0.5 rounded-full bg-emerald-500/20 text-emerald-200 text-[11px] font-semibold"
                title="Both selected voices resolve to the same base TTS speaker — the highest-signal compare case"
              >
                same base voice ✓
              </span>
            )}
            {badge === 'different' && (
              <span
                role="status"
                className="px-2 py-0.5 rounded-full bg-amber-400/25 text-amber-100 text-[11px] font-semibold"
                title="The selected voices route to different base TTS speakers — comparing across families is allowed; same-voice characters are the core tuning case"
              >
                different base voices
              </span>
            )}
            <span className="w-px h-5 bg-canvas/20" />
            <button
              onClick={() => {
                if (!canCompare || selectedVoiceIds.length !== 2 || !sharedBookId) return;
                /* Path A — pair belongs to the open book: redux cast is
                   hydrated, no fetch needed. Path B — same-book pair from
                   the global tab (or a foreign book inside the per-book
                   tab): consult the cache; if missing, fetch on demand
                   per plan 60. */
                const needsFetch =
                  sharedBookId !== currentBookId && !globalCastCache.has(sharedBookId);
                if (needsFetch) {
                  void fetchAndOpenForeignCast(sharedBookId, [
                    selectedVoiceIds[0],
                    selectedVoiceIds[1],
                  ]);
                } else {
                  setCompareIds([selectedVoiceIds[0], selectedVoiceIds[1]]);
                }
              }}
              disabled={!canCompare || globalCastFetching !== null}
              title={
                globalCastFetching
                  ? 'Loading book cast…'
                  : canCompare
                    ? 'Compare these two voices'
                    : (compareDisabledReason ?? undefined)
              }
              className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-canvas/15 text-canvas text-xs font-bold hover:bg-canvas/25 disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {globalCastFetching ? 'Loading…' : 'Compare'}
            </button>
            <button
              onClick={() => setSelectedVoiceIds([])}
              className="text-xs text-canvas/70 hover:text-canvas font-medium"
            >
              Clear
            </button>
          </div>
        </div>
      )}

      {compareIds &&
        (() => {
          const [aId, bId] = compareIds;
          const va = selectedVoices.find((v) => v.id === aId);
          const vb = selectedVoices.find((v) => v.id === bId);
          if (!va || !vb) return null;
          /* Pick the cast list to resolve against — redux for the open
             book, the plan-60 foreign-cast cache otherwise. */
          const castSource =
            va.bookId === currentBookId ? characters : globalCastCache.get(va.bookId);
          if (!castSource) return null;
          const charA = findCharacterForVoice(va, castSource);
          const charB = findCharacterForVoice(vb, castSource);
          if (!charA || !charB) return null;
          /* Saves only route to redux when the pair belongs to the open
             book; foreign-book edits aren't persisted yet (BACKLOG #17
             owns the cross-book save story). The modal-side onSaveSide
             is still called so the in-modal draft stays consistent. */
          const isForeign = va.bookId !== currentBookId;
          return (
            <CompareCastModal
              characters={[charA, charB]}
              library={library}
              ttsModelKey={ttsModelKey}
              onSaveSide={(next) => {
                if (!isForeign) dispatch(castActions.updateCharacter(next));
              }}
              onClose={() => setCompareIds(null)}
              onOpenProfile={(id) => {
                setCompareIds(null);
                if (!isForeign) dispatch(uiActions.setOpenProfileId(id));
              }}
            />
          );
        })()}
    </div>
  );
}

/* Internal accumulator — kept module-local so the public VoiceFamily type
   stays free of the per-build Map plumbing. */
interface FamilyAccumulator extends VoiceFamily {
  books: Map<string, BookGroup>;
  seriesOrder: Map<string, string | null>;
  seriesBuckets: Map<string, BookGroup[]>;
}

/* Build voice families from the flat library list. Filters by tab first
   (so 'current' / 'library' don't leak voices the user isn't asking about
   into the family count), then groups, then sub-groups by series → book. */
function buildFamilies(
  library: Voice[],
  tab: Tab,
): Array<VoiceFamily & { seriesGroups: SeriesGroup[] }> {
  const filtered = library.filter((v) => {
    if (tab === 'all' || tab === 'base') return true;
    return v.source === tab;
  });
  const byKey = new Map<string, FamilyAccumulator>();
  for (const v of filtered) {
    if (!v.ttsVoice) continue;
    const key = `${v.ttsVoice.provider}|${v.ttsVoice.name}`;
    let fam = byKey.get(key);
    if (!fam) {
      fam = {
        key,
        engine: v.ttsVoice.provider as TtsEngine,
        name: v.ttsVoice.name,
        description: v.ttsVoice.description ?? '',
        members: [],
        totalUsedIn: 0,
        primary: v,
        anyPinned: false,
        gradient: gradientForTtsVoice(v.ttsVoice.name, key) as [string, string],
        books: new Map(),
        seriesOrder: new Map(),
        seriesBuckets: new Map(),
      };
      byKey.set(key, fam);
    }
    fam.members.push(v);
    fam.totalUsedIn += v.usedIn;
    if (v.pinned) fam.anyPinned = true;
    /* Nested grouping. `bookSeries` is null for standalones — bucket those
       under a synthetic 'standalone' key so the render path can flatten. */
    const seriesKey = v.bookSeries ?? 'standalone';
    let bg = fam.books.get(v.bookId);
    if (!bg) {
      bg = { bookId: v.bookId, bookTitle: v.bookTitle, voices: [] };
      fam.books.set(v.bookId, bg);
      const bucket = fam.seriesBuckets.get(seriesKey) ?? [];
      bucket.push(bg);
      fam.seriesBuckets.set(seriesKey, bucket);
      fam.seriesOrder.set(seriesKey, v.bookSeries ?? null);
    }
    bg.voices.push(v);
  }
  /* Project each accumulator into a clean public VoiceFamily with a
     flattened seriesGroups list. */
  const out: Array<VoiceFamily & { seriesGroups: SeriesGroup[] }> = [];
  for (const fam of byKey.values()) {
    const seriesGroups: SeriesGroup[] = [];
    for (const [seriesKey, books] of fam.seriesBuckets) {
      seriesGroups.push({
        series:
          seriesKey === 'standalone' ? null : (fam.seriesOrder.get(seriesKey) as string | null),
        books: books.sort((a, b) => a.bookTitle.localeCompare(b.bookTitle)),
      });
    }
    seriesGroups.sort((a, b) => (a.series ?? '~').localeCompare(b.series ?? '~'));
    out.push({
      key: fam.key,
      engine: fam.engine,
      name: fam.name,
      description: fam.description,
      members: fam.members,
      totalUsedIn: fam.totalUsedIn,
      primary: fam.primary,
      anyPinned: fam.anyPinned,
      gradient: fam.gradient,
      seriesGroups,
    });
  }
  /* Family sort: pinned (any member) first, then total usedIn desc, then
     by speaker name so the order is stable across renders. */
  out.sort((a, b) => {
    if (a.anyPinned !== b.anyPinned) return a.anyPinned ? -1 : 1;
    if (a.totalUsedIn !== b.totalUsedIn) return b.totalUsedIn - a.totalUsedIn;
    return a.name.localeCompare(b.name);
  });
  return out;
}

interface FamilyProps {
  family: VoiceFamily & { seriesGroups: SeriesGroup[] };
  draggingVoiceId: string | null;
  setDraggingVoiceId: (id: string | null) => void;
  onTogglePin: (v: Voice) => void;
  onPlay: (f: VoiceFamily) => void;
  status: { key: string; label: string } | null;
  onOpenCharacter?: (voice: Voice) => void;
  selectedVoiceIds: string[];
  onToggleSelect: (v: Voice) => void;
}
function VoiceFamilySection({
  family,
  draggingVoiceId,
  setDraggingVoiceId,
  onTogglePin,
  onPlay,
  status,
  onOpenCharacter,
  selectedVoiceIds,
  onToggleSelect,
}: FamilyProps) {
  const seriesGroups = family.seriesGroups;
  const isBusy = status?.key === family.key;
  /* Build a Voice-shaped stand-in for the family header swatch so VoiceSwatch
     reuses its existing radial-gradient render path. */
  const headerVoice: Voice = {
    ...family.primary,
    id: family.key,
    character: family.name,
    gradient: family.gradient,
  };
  return (
    <section aria-label={`${ENGINE_LABEL[family.engine]} · ${family.name}`}>
      <header className="mb-3 flex items-center justify-between gap-4 flex-wrap">
        <div className="flex items-center gap-3 min-w-0">
          <span onClick={(e) => e.stopPropagation()}>
            <VoiceSwatch
              voice={headerVoice}
              size="sm"
              showLabel={false}
              onSelect={() => onPlay(family)}
            />
          </span>
          <div className="min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <h2 className="text-base font-bold text-ink truncate">{family.name}</h2>
              <span className="text-[11px] uppercase tracking-wider font-semibold text-ink/40 shrink-0">
                {ENGINE_LABEL[family.engine]}
              </span>
              {family.description && (
                <span className="text-xs text-ink/50 truncate">· {family.description}</span>
              )}
            </div>
            <p className="text-xs text-ink/50">
              {family.members.length} {family.members.length === 1 ? 'cast member' : 'cast members'}{' '}
              · {seriesGroups.length}{' '}
              {seriesGroups.length === 1 ? 'series/standalone bucket' : 'series/standalone buckets'}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {isBusy && (
            <span className="text-[11px] text-ink/60 italic" aria-live="polite">
              {status?.label}
            </span>
          )}
          <button
            type="button"
            onClick={() => onPlay(family)}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-ink/[0.04] hover:bg-ink/[0.08] text-xs font-medium text-ink transition-colors"
          >
            <IconPlay className="w-3.5 h-3.5" /> Audition base voice
          </button>
        </div>
      </header>
      <div className="space-y-4">
        {seriesGroups.map((sg) => (
          <div key={sg.series ?? '~standalone'} className="pl-2 border-l-2 border-ink/[0.06]">
            {sg.series && (
              <p className="text-[11px] uppercase tracking-wider font-semibold text-ink/40 mb-2 pl-2">
                {sg.series}
              </p>
            )}
            <div className="space-y-3">
              {sg.books.map((b) => (
                <div key={b.bookId}>
                  <p className="text-xs font-semibold text-ink/70 mb-1.5 pl-2">{b.bookTitle}</p>
                  <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3 pl-2">
                    {b.voices.map((v) => (
                      <VoiceCard
                        key={v.id}
                        voice={v}
                        draggingVoiceId={draggingVoiceId}
                        setDraggingVoiceId={setDraggingVoiceId}
                        compact={false}
                        showBookTitle={false}
                        pinned={!!v.pinned}
                        onTogglePin={onTogglePin}
                        onSelect={onOpenCharacter}
                        selected={selectedVoiceIds.includes(v.id)}
                        onToggleSelect={onToggleSelect}
                      />
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

interface BasePanelProps {
  baseVoices: BaseVoice[];
  baseVoicesLoaded: boolean;
  usage: Map<string, number>;
  activeEngine: TtsEngine;
  onPlay: (bv: BaseVoice) => void;
  status: { key: string; label: string } | null;
}
function BaseVoiceCatalogPanel({
  baseVoices,
  baseVoicesLoaded,
  usage,
  activeEngine,
  onPlay,
  status,
}: BasePanelProps) {
  if (!baseVoicesLoaded) {
    return (
      <div className="bg-white rounded-3xl border border-ink/10 shadow-card p-10 text-center">
        <p className="text-sm font-bold text-ink">Loading base voices…</p>
        <p className="mt-2 text-xs text-ink/60 max-w-md mx-auto">
          If this stays empty, load the TTS sidecar from the model pill — the Coqui catalog is
          fetched live from the loaded model.
        </p>
      </div>
    );
  }
  if (baseVoices.length === 0) {
    return (
      <div className="bg-white rounded-3xl border border-ink/10 shadow-card p-10 text-center">
        <p className="text-sm font-bold text-ink">No base voices available</p>
        <p className="mt-2 text-xs text-ink/60 max-w-md mx-auto">
          The TTS sidecar isn't reachable, or the loaded model has no published speakers. Load a
          model to populate this list.
        </p>
      </div>
    );
  }
  /* Group by engine so Coqui / Gemini / Piper / Kokoro form their own
     sections — same visual rhythm as the voice-family view. */
  const byEngine = new Map<TtsEngine, BaseVoice[]>();
  for (const bv of baseVoices) {
    const list = byEngine.get(bv.engine) ?? [];
    list.push(bv);
    byEngine.set(bv.engine, list);
  }
  return (
    <div className="space-y-8">
      {Array.from(byEngine.entries()).map(([engine, list]) => (
        <section key={engine} aria-label={ENGINE_LABEL[engine]}>
          <header className="mb-3 flex items-baseline gap-3">
            <h2 className="text-base font-bold text-ink">{ENGINE_LABEL[engine]}</h2>
            <span className="text-xs text-ink/50">{list.length} voices</span>
            {engine !== activeEngine && (
              <span className="text-[11px] text-amber-700 bg-amber-50 border border-amber-200 px-2 py-0.5 rounded-full">
                Not the active engine — switch your TTS model to assign these
              </span>
            )}
          </header>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
            {list.map((bv) => {
              const key = `${bv.engine}|${bv.name}`;
              const inUse = usage.get(key) ?? 0;
              const isBusy = status?.key === key;
              const swatchVoice: Voice = {
                id: key,
                character: bv.name,
                bookId: '',
                bookTitle: '',
                attributes: [],
                usedIn: inUse,
                source: 'library',
                gradient: gradientForTtsVoice(bv.name, key) as [string, string],
                ttsVoice: { provider: bv.engine, name: bv.name, description: '' },
              };
              return (
                <div
                  key={key}
                  className="flex items-start gap-3 p-3 rounded-2xl border bg-canvas border-ink/10"
                >
                  <span onClick={(e) => e.stopPropagation()}>
                    <VoiceSwatch
                      voice={swatchVoice}
                      size="sm"
                      showLabel={false}
                      onSelect={() => onPlay(bv)}
                    />
                  </span>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-bold text-ink truncate">{bv.name}</p>
                    <p className="text-[11px] text-ink/50">
                      {inUse > 0
                        ? `Used by ${inUse} cast ${inUse === 1 ? 'member' : 'members'}`
                        : 'Unused'}
                    </p>
                    {isBusy && (
                      <p className="text-[11px] text-ink/60 italic mt-1" aria-live="polite">
                        {status?.label}
                      </p>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </section>
      ))}
    </div>
  );
}

/* Engine + model dropdowns. Switching engine resets the model to the engine
   group's first option so the selection never lands on a Gemini model while
   the engine reads "Local" (and vice versa). */
interface TtsEngineModelPickerProps {
  modelKey: TtsModelKey;
  onChange: (next: TtsModelKey) => void;
}
function TtsEngineModelPicker({ modelKey, onChange }: TtsEngineModelPickerProps) {
  const currentEngine = engineGroupForModelKey(modelKey);
  const engineGroup = TTS_ENGINES.find((g) => g.id === currentEngine) ?? TTS_ENGINES[0];
  return (
    <>
      <label className="inline-flex items-center gap-2 text-xs text-ink/60">
        <span className="font-medium">Engine</span>
        <select
          value={currentEngine}
          onChange={(e) => {
            const nextGroup = TTS_ENGINES.find((g) => g.id === (e.target.value as TtsEngineId));
            if (!nextGroup) return;
            onChange(nextGroup.models[0].id);
          }}
          className="px-3 py-2 rounded-full border border-ink/10 bg-white text-sm font-medium text-ink hover:bg-ink/[0.04] focus:outline-none focus:ring-2 focus:ring-magenta/30"
          title={engineGroup.hint}
        >
          {TTS_ENGINES.map((g) => (
            <option key={g.id} value={g.id}>
              {g.label}
            </option>
          ))}
        </select>
      </label>
      <label className="inline-flex items-center gap-2 text-xs text-ink/60">
        <span className="font-medium">Model</span>
        <select
          value={modelKey}
          onChange={(e) => onChange(e.target.value as TtsModelKey)}
          className="px-3 py-2 rounded-full border border-ink/10 bg-white text-sm font-medium text-ink hover:bg-ink/[0.04] focus:outline-none focus:ring-2 focus:ring-magenta/30"
        >
          {engineGroup.models.map((m) => (
            <option key={m.id} value={m.id}>
              {m.label}
            </option>
          ))}
        </select>
      </label>
    </>
  );
}

/* Plan 89 C5 — StatTile moved to `src/components/stat-tiles.tsx` so
   sibling components can statically import it without keeping this view
   in the eager graph. Re-export keeps existing call sites working. */
export { StatTile } from '../components/stat-tiles';
