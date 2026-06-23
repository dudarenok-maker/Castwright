import { useEffect, useMemo, useState } from 'react';
import {
  SectionLabel,
  MixedHeading,
  VoiceSwatch,
  Pill,
  VariantsBadge,
  NeedsVariantsBadge,
} from '../components/primitives';
import { StatTile } from '../components/stat-tiles';
import { VoiceCard } from '../components/voice-library-panel';
import { IconPlay, IconSparkle } from '../lib/icons';
import type {
  BaseVoice,
  Character,
  LibraryBook,
  Sentence,
  TtsEngine,
  TtsModelKey,
  Voice,
} from '../lib/types';
import { usedEmotionsByCharacter, countMissingVariants } from '../lib/voice-status';
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
import { findCharacterForVoice, pickMergeSurvivor } from '../lib/voice-character-link';
import { CompareCastModal } from '../modals/compare-cast-modal';
import { RebaselineModalContainer } from '../modals/rebaseline-modal';
import {
  DuplicateReviewModal,
  type DuplicateReviewPair,
  type DuplicateResolution,
} from '../modals/duplicate-review-modal';
import { BulkDuplicateReviewModal } from '../modals/bulk-duplicate-review';
import {
  detectDuplicateCandidates,
  detectIgnoredDuplicatePairs,
  appendAliasToCachedCharacter,
  appendNotLinkedToCachedCharacter,
  removeNotLinkedToCachedCharacter,
  type BookSeriesInfo,
  type DuplicateCandidate,
} from '../lib/cross-book-duplicates';

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
  qwen: 'Qwen',
};

/* Plan 101 — module-level empty list for the defensive library-books
   selector below. Lives outside the component so the selector returns
   the SAME reference across renders when the slice is missing, keeping
   useMemo deps stable in tests that don't register the library slice. */
const EMPTY_LIBRARY_BOOKS: LibraryBook[] = [];

/* Bucket / narrator ids the pill's Merge action refuses to act on. Mirrors
   the guards profile-drawer.tsx uses for its own merge picker — merging
   into or out of a standing background bucket would corrupt the
   bucket semantics, and the narrator is unique by definition. Kept in
   sync with `src/modals/profile-drawer.tsx:110-112`. */
const UNMERGEABLE_IDS = new Set(['narrator', 'unknown-male', 'unknown-female']);

export function LibraryView({ library, onOpenCharacter }: Props) {
  const [tab, setTab] = useState<Tab>('all');
  const [draggingVoiceId, setDraggingVoiceId] = useState<string | null>(null);
  const [familyStatus, setFamilyStatus] = useState<{ key: string; label: string } | null>(null);
  /* Compare affordance (plan 22a + plan 60 + plan 96). Selection is
     local-only (mirrors `cast.tsx`'s ephemeral selection state); the
     pill at the bottom mounts `CompareCastModal` when the user has
     exactly 2 selected. Cross-book pairs are now supported — saves
     propagate to every series-sibling cast.json row that the dedup rule
     recognises as the same person (plan 96, server route
     `POST /cast/:characterId/series-patch`). */
  const [selectedVoiceIds, setSelectedVoiceIds] = useState<string[]>([]);
  const [compareIds, setCompareIds] = useState<[string, string] | null>(null);
  /* Guards the Merge action so a fast double-click can't double-fire the
     mergeCharacters POST while the first response is still in flight.
     Mirrors profile-drawer.tsx's mergeBusy state. */
  const [mergeBusy, setMergeBusy] = useState(false);
  /* Plan 60 — foreign-book casts resolve via on-demand
     `api.getBookState(bookId)`; cached per-component-mount so re-opens
     within the same view-mount are instant. `globalCastFailed` records
     bookIds whose fetch failed so the Compare button stays disabled
     retroactively without retrying on every render. Plan 96 promotes
     `globalCastFetching` to a Set so per-side parallel fetches for a
     cross-book pair don't clobber each other's in-flight state. */
  const [globalCastCache, setGlobalCastCache] = useState<Map<string, Character[]>>(() => new Map());
  const [globalCastFailed, setGlobalCastFailed] = useState<Set<string>>(() => new Set());
  const [globalCastFetching, setGlobalCastFetching] = useState<Set<string>>(() => new Set());
  /* Plan 101 — DuplicateReviewModal state. We hold the candidate's two
     voice ids (stable) rather than a frozen pair snapshot, then derive
     the live pair (+ hydration status) from `duplicateCandidates` below.
     That way the modal's character fields fill in — and its buttons
     enable — the moment a foreign cast lands in `globalCastCache`. null
     when the modal is closed. */
  const [duplicateReviewKey, setDuplicateReviewKey] = useState<{
    aVoiceId: string;
    bVoiceId: string;
  } | null>(null);
  /* fe-9 — bulk per-series duplicate review. Holds the seriesKey
     (`author|series`) of the series whose duplicates are being walked, or
     null when closed. The queue is frozen on open from the series'
     candidate slice. */
  const [bulkReviewSeriesKey, setBulkReviewSeriesKey] = useState<string | null>(null);
  const [bulkReviewQueue, setBulkReviewQueue] = useState<DuplicateCandidate[]>([]);
  /* fs-11 — "Show ignored duplicate suggestions" toggle. Reveals the pairs the
     user previously marked "different on purpose" (notLinkedTo) with an Unmark
     button per pair. */
  const [showIgnored, setShowIgnored] = useState(false);
  const [unmarkBusyKey, setUnmarkBusyKey] = useState<string | null>(null);
  /* fe-34 — variant filter for the Qwen "Designed voices" section. */
  const [variantFilter, setVariantFilter] = useState<'all' | 'has' | 'needs'>('all');
  /* fs-41/fs-50 seam 4b — language facet. null = show all. */
  const [languageFilter, setLanguageFilter] = useState<string | null>(null);
  /* fe-34 — sentences per foreign book, cached from the same getBookState the
     duplicate/compare flows already fetch. The open book reads redux below. */
  const [sentencesByBookId, setSentencesByBookId] = useState<Map<string, Sentence[]>>(
    () => new Map(),
  );
  const dispatch = useAppDispatch();
  const ttsModelKey = useAppSelector((s) => s.ui.ttsModelKey);
  const baseVoices = useAppSelector((s) => s.voices.baseVoices);
  const baseVoicesLoaded = useAppSelector((s) => s.voices.baseVoicesLoaded);
  /* Open book id (null on the global `#/voices` tab). Drives the
     cast-source picker — characters from the open book read from redux,
     all others read from the foreign-cast cache (hydrated on demand by
     `hydrateForeignCast` below). Plan 96 lifted the gate that
     constrained Compare to same-book pairs. */
  const currentBookId = useAppSelector((s) =>
    s.ui.stage.kind === 'ready' ? s.ui.stage.bookId : null,
  );
  /* The rebaseline modal's target book (open book for the book-scoped tab,
     the series' representative book for the per-series global-view buttons). */
  const rebaselineBookId = useAppSelector((s) => s.ui.rebaselineBookId);
  const characters = useAppSelector((s) => s.cast.characters);
  const openBookSentences = useAppSelector((s) => s.manuscript.sentences);
  /* Plan 101 — series metadata per bookId for cross-book duplicate
     detection. The library slice carries the (author, series,
     isStandalone) trio for every book; combining it with `globalCastCache`
     + redux `characters` gives us enough to compute pairwise duplicate
     candidates client-side without any new fetches.

     Defensive read: existing test stores composed before plan 101 don't
     register the library slice — fall back to an empty list so the memo
     simply emits zero candidates and nothing breaks. The real app store
     always carries it (registered in `src/store/index.ts`). */
  const libraryBooks = useAppSelector(
    (s) => (s as { library?: { books?: LibraryBook[] } }).library?.books ?? EMPTY_LIBRARY_BOOKS,
  );
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

  /* Partition Qwen out of family grouping (plan 117). Preset engines keep
     the (engine, name) voice-family grouping — that's resolved server-side
     after honouring overrides, so two characters with the same engine+name
     appear under the same family. Bespoke Qwen voices are 1:1 with
     characters, so they go through status buckets instead. */
  const presetLibrary = useMemo(
    () => library.filter((v) => v.ttsVoice?.provider !== 'qwen'),
    [library],
  );
  const qwenLibrary = useMemo(
    () => library.filter((v) => v.ttsVoice?.provider === 'qwen'),
    [library],
  );
  /* fs-41/fs-50 seam 4b — unique non-English languageCodes present in the
     full library. The facet only renders when this is non-empty (English-only
     or no-languageCode libraries show no facet). */
  const languages = useMemo(
    () => [...new Set(library.map((v) => v.languageCode).filter(Boolean))] as string[],
    [library],
  );
  /* fs-41/fs-50 seam 4b — language-filtered preset library fed into
     buildFamilies; mirrors how variantFilter narrows filteredQwenLibrary. */
  const languageFilteredPresetLibrary = useMemo(
    () =>
      languageFilter === null
        ? presetLibrary
        : presetLibrary.filter((v) => v.languageCode === languageFilter),
    [presetLibrary, languageFilter],
  );
  const families = useMemo(
    () => buildFamilies(languageFilteredPresetLibrary, tab),
    [languageFilteredPresetLibrary, tab],
  );
  /* fs-34 — per-voice designed-variant count for the cross-book Voices badge.
     Resolve each Qwen voice to its character (redux for the open book, the
     global cast cache for others) and count its qwen.variants. */
  const variantCountByVoiceId = useMemo(() => {
    const map = new Map<string, number>();
    for (const v of qwenLibrary) {
      const source =
        v.bookId === currentBookId ? characters : (globalCastCache.get(v.bookId) ?? null);
      const ch = source ? findCharacterForVoice(v, source) : null;
      const n = ch ? Object.keys(ch.overrideTtsVoices?.qwen?.variants ?? {}).length : 0;
      if (n > 0) map.set(v.id, n);
    }
    return map;
  }, [qwenLibrary, currentBookId, characters, globalCastCache]);
  /* fe-34 — per-voice count of in-use emotions that LACK a designed variant.
     Mirrors variantCountByVoiceId but needs the book's sentences (redux for the
     open book, the cache for foreign books — 0 until a book hydrates). */
  const missingVariantCountByVoiceId = useMemo(() => {
    const map = new Map<string, number>();
    for (const v of qwenLibrary) {
      const source =
        v.bookId === currentBookId ? characters : (globalCastCache.get(v.bookId) ?? null);
      const ch = source ? findCharacterForVoice(v, source) : null;
      if (!ch) continue;
      const sents =
        v.bookId === currentBookId ? openBookSentences : (sentencesByBookId.get(v.bookId) ?? []);
      const used = usedEmotionsByCharacter(sents).get(ch.id);
      const n = countMissingVariants(ch, used);
      if (n > 0) map.set(v.id, n);
    }
    return map;
  }, [qwenLibrary, currentBookId, characters, globalCastCache, openBookSentences, sentencesByBookId]);
  const filteredQwenLibrary = useMemo(() => {
    const langFiltered =
      languageFilter === null
        ? qwenLibrary
        : qwenLibrary.filter((v) => v.languageCode === languageFilter);
    if (variantFilter === 'all') return langFiltered;
    const map = variantFilter === 'has' ? variantCountByVoiceId : missingVariantCountByVoiceId;
    return langFiltered.filter((v) => (map.get(v.id) ?? 0) > 0);
  }, [qwenLibrary, languageFilter, variantFilter, variantCountByVoiceId, missingVariantCountByVoiceId]);
  const qwenGroups = useMemo(
    () => buildQwenStatusGroups(filteredQwenLibrary, tab),
    [filteredQwenLibrary, tab],
  );
  /* When a variant filter is active, preset families + the "Needs a voice" bucket
     aren't variant-relevant, so show only the matching Qwen designed voices. */
  const showFamilies = variantFilter === 'all';
  const books = [...new Set(library.map((v) => v.bookId))];

  /* Compare derivations. Memoised so a transient render doesn't recompute
     the same-base / different-base lookup or the disabled-reason string.
     Plan 96 lifted the cross-book guard — per-side `castSourceA` /
     `castSourceB` resolve from redux (open book) or the per-bookId
     foreign-cast cache (plan 60). `canCompare` is true once both sides
     have a cast source OR the missing cast is fetchable (the Compare
     click handler triggers the fetch). */
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
    /* Merge derivations are computed alongside Compare so the pill renders
       both buttons off a single memo. `mergeSource` / `mergeTarget` are
       only populated when canMerge is true; the Merge button reads
       `mergeTarget.name` for its label. */
    let canMerge = false;
    let mergeSource: Character | null = null;
    let mergeTarget: Character | null = null;
    let mergeDisabledReason: string | null = null;
    if (selectedVoices.length !== 2) {
      compareDisabledReason = 'Select exactly 2 voices';
    } else {
      const sideBookIds = selectedVoices.map((v) => v.bookId);
      const failedBookId = sideBookIds.find((id) => globalCastFailed.has(id));
      if (failedBookId) {
        compareDisabledReason = 'Could not load that book — try again later';
      } else {
        /* Resolve a cast source per side. Missing-and-fetchable is a
           valid `canCompare` state because the Compare click handler
           triggers the hydrate; per-side link checks only fire once a
           cast source is in hand. */
        const perSideSources = sideBookIds.map((bookId) =>
          bookId === currentBookId ? characters : (globalCastCache.get(bookId) ?? null),
        );
        const anyMissing = perSideSources.some((s) => s === null);
        if (anyMissing) {
          canCompare = true;
        } else {
          const linkedCharacters = selectedVoices.map((v, i) =>
            findCharacterForVoice(v, perSideSources[i] as Character[]),
          );
          if (linkedCharacters.some((c) => !c)) {
            compareDisabledReason = 'Selected voice is no longer linked to a character';
          } else {
            canCompare = true;
            /* Merge eligibility — strictly tighter than Compare: same
               base voice, same bookId (server only knows how to merge
               within one cast.json), neither side a narrator or
               background bucket. Mirrors the guard list in
               profile-drawer.tsx:204-205. Cross-book duplicates are
               still useful to Compare for tuning continuity, but
               merging them is the wrong shape — that's what the
               manual link-prior flow is for. */
            const [chA, chB] = linkedCharacters as [Character, Character];
            if (badge !== 'same') {
              mergeDisabledReason = 'Merge needs the same base voice on both sides';
            } else if (sideBookIds[0] !== sideBookIds[1]) {
              mergeDisabledReason = 'Cross-book merges aren’t supported';
            } else if (UNMERGEABLE_IDS.has(chA.id) || UNMERGEABLE_IDS.has(chB.id)) {
              mergeDisabledReason = 'Narrator and bucket roles can’t be merged';
            } else if (chA.id === chB.id) {
              mergeDisabledReason = 'Already the same character';
            } else {
              const picked = pickMergeSurvivor(chA, chB);
              mergeTarget = picked.target;
              mergeSource = picked.source;
              canMerge = true;
            }
          }
        }
      }
    }
    return {
      selectedVoices,
      badge,
      canCompare,
      compareDisabledReason,
      canMerge,
      mergeSource,
      mergeTarget,
      mergeDisabledReason,
    };
  }, [selectedVoiceIds, library, currentBookId, characters, globalCastCache, globalCastFailed]);
  const {
    selectedVoices,
    badge,
    canCompare,
    compareDisabledReason,
    canMerge,
    mergeSource,
    mergeTarget,
    mergeDisabledReason,
  } = compareDerivations;

  /* Plan 101 — pure duplicate-candidate derivation. Same-series same-base-
     voice cross-book pairs whose normalised names dedup-match (per the
     `series-prior-dedup` rule) and that aren't already linked via aliases
     or marked as variants via `notLinkedTo`. Hydrated context sources:
     library slice (series metadata), redux cast (open book), foreign-cast
     cache (other books fetched on demand). When a book's cast isn't
     loaded yet the auto-flag still surfaces (better mild false-positive
     than silent miss); the filter kicks in as casts hydrate. */
  const duplicateCandidates = useMemo<DuplicateCandidate[]>(() => {
    if (library.length < 2 || libraryBooks.length === 0) return [];
    const seriesByBookId = new Map<string, BookSeriesInfo>();
    for (const b of libraryBooks) {
      seriesByBookId.set(b.bookId, {
        author: b.author,
        series: b.series,
        isStandalone: b.isStandalone,
      });
    }
    const charactersByBookId = new Map<string, Character[]>(globalCastCache);
    if (currentBookId) charactersByBookId.set(currentBookId, characters);
    return detectDuplicateCandidates({
      library,
      seriesByBookId,
      charactersByBookId,
    });
  }, [library, libraryBooks, currentBookId, characters, globalCastCache]);

  /* Group candidates by family key so each family card knows how many to
     surface in its ⚠ pill. Single-pass map build to keep the family
     render path O(N) on the candidate count. */
  const candidatesByFamily = useMemo(() => {
    const map = new Map<string, DuplicateCandidate[]>();
    for (const c of duplicateCandidates) {
      const list = map.get(c.voiceKey) ?? [];
      list.push(c);
      map.set(c.voiceKey, list);
    }
    return map;
  }, [duplicateCandidates]);

  /* fe-9 — group candidates by series (`author|series` key) so each series
     header can offer a "Review all duplicates in <Series>" button that opens
     the bulk modal seeded with the whole series' queue. The display name is
     the part after the `|` in the seriesKey. */
  const candidatesBySeriesKey = useMemo(() => {
    const map = new Map<string, DuplicateCandidate[]>();
    for (const c of duplicateCandidates) {
      const list = map.get(c.seriesKey) ?? [];
      list.push(c);
      map.set(c.seriesKey, list);
    }
    return map;
  }, [duplicateCandidates]);

  /* fs-11 — the pairs the user previously marked "different on purpose"
     (notLinkedTo). Same hydrated context as `duplicateCandidates`. Only
     computed when the user opens the Ignored section (toggle on) to keep the
     default render path cheap. */
  const ignoredPairs = useMemo<DuplicateCandidate[]>(() => {
    if (!showIgnored) return [];
    if (library.length < 2 || libraryBooks.length === 0) return [];
    const seriesByBookId = new Map<string, BookSeriesInfo>();
    for (const b of libraryBooks) {
      seriesByBookId.set(b.bookId, {
        author: b.author,
        series: b.series,
        isStandalone: b.isStandalone,
      });
    }
    const charactersByBookId = new Map<string, Character[]>(globalCastCache);
    if (currentBookId) charactersByBookId.set(currentBookId, characters);
    return detectIgnoredDuplicatePairs({ library, seriesByBookId, charactersByBookId });
  }, [showIgnored, library, libraryBooks, currentBookId, characters, globalCastCache]);

  /* Unmark a previously "different on purpose" pair: DELETE the symmetric
     notLinkedTo from both books, then reconcile redux (open book) + the
     foreign-cast cache so the pair re-surfaces as a live duplicate candidate
     immediately. Mirrors reconcileDuplicateResolution's variant branch but in
     reverse. */
  async function unmarkIgnoredPair(pair: DuplicateCandidate) {
    const aId = pair.a.character?.id ?? pair.a.voice.id;
    const bId = pair.b.character?.id ?? pair.b.voice.id;
    const key = `${pair.a.voice.bookId}:${aId}|${pair.b.voice.bookId}:${bId}`;
    if (unmarkBusyKey) return;
    setUnmarkBusyKey(key);
    try {
      await api.removeNotLinkedTo({
        bookId: pair.a.voice.bookId,
        characterId: aId,
        otherBookId: pair.b.voice.bookId,
        otherCharacterId: bId,
      });
      const sides = [
        { self: { bookId: pair.a.voice.bookId, characterId: aId }, other: { bookId: pair.b.voice.bookId, characterId: bId } },
        { self: { bookId: pair.b.voice.bookId, characterId: bId }, other: { bookId: pair.a.voice.bookId, characterId: aId } },
      ];
      for (const { self, other } of sides) {
        if (self.bookId === currentBookId) {
          dispatch(
            castActions.removeNotLinked({
              characterId: self.characterId,
              otherBookId: other.bookId,
              otherCharacterId: other.characterId,
            }),
          );
        } else {
          setGlobalCastCache((prev) =>
            removeNotLinkedToCachedCharacter(
              prev,
              self.bookId,
              self.characterId,
              other.bookId,
              other.characterId,
            ),
          );
        }
      }
      dispatch(
        notificationsActions.pushToast({
          kind: 'info',
          message: `Unmarked — "${pair.a.voice.character}" and "${pair.b.voice.character}" can be reviewed as duplicates again.`,
          dedupeKey: `voices-unmark:${key}`,
        }),
      );
    } catch (err) {
      console.error('[voices] unmark not-linked-to failed', err);
      dispatch(
        notificationsActions.pushToast({
          kind: 'error',
          message: 'Couldn’t unmark that pair. Try again.',
          dedupeKey: `voices-unmark-error:${key}`,
        }),
      );
    } finally {
      setUnmarkBusyKey(null);
    }
  }

  /* Freeze the series' candidate queue on open so it doesn't shift as pairs
     resolve (each resolution drops a candidate from `duplicateCandidates`).
     The bulk modal walks its own frozen copy. */
  function openBulkReview(seriesKey: string) {
    const queue = candidatesBySeriesKey.get(seriesKey) ?? [];
    if (queue.length === 0) return;
    setBulkReviewQueue(queue);
    setBulkReviewSeriesKey(seriesKey);
    /* Pre-hydrate every foreign book the queue touches so the first pair's
       buttons aren't stuck loading. The bulk modal also hydrates per-pair,
       but kicking these off now smooths the walk. */
    const foreignBookIds = new Set<string>();
    for (const c of queue) {
      for (const bookId of [c.a.voice.bookId, c.b.voice.bookId]) {
        if (bookId !== currentBookId) foreignBookIds.add(bookId);
      }
    }
    for (const bookId of foreignBookIds) void hydrateForeignCast(bookId);
  }

  /* Per-series representative book for the per-series Rebaseline button.
     Rebaseline is inherently a SERIES operation, so the global Voices view
     surfaces it on each series-group header. The modal needs a single
     anchor bookId per series; we pick the "representative" book:
       1. the book with the most known confirmed cast members
          (globalCastCache size, or redux `characters` for the open book),
       2. tie-break by the latest seriesPosition (from the library slice),
       3. else any book in the series.
     Every series that appears in the voice families has ≥1 book with a
     confirmed cast (a Voice only exists once its book's cast was confirmed),
     so the button shows for every non-standalone series. The series key is
     the (non-null) `bookSeries` carried on each library Voice. */
  const representativeBookIdBySeries = useMemo(() => {
    const seriesPositionByBookId = new Map<string, number | null>();
    for (const b of libraryBooks) seriesPositionByBookId.set(b.bookId, b.seriesPosition);
    /* series → bookId → seen (one entry per distinct book in the series). */
    const bookIdsBySeries = new Map<string, Set<string>>();
    for (const v of library) {
      if (!v.bookSeries) continue;
      const set = bookIdsBySeries.get(v.bookSeries) ?? new Set<string>();
      set.add(v.bookId);
      bookIdsBySeries.set(v.bookSeries, set);
    }
    const castSize = (bookId: string): number => {
      if (bookId === currentBookId) return characters.length;
      return globalCastCache.get(bookId)?.length ?? 0;
    };
    const out = new Map<string, string>();
    for (const [series, bookIds] of bookIdsBySeries) {
      let best: string | null = null;
      for (const bookId of bookIds) {
        if (best === null) {
          best = bookId;
          continue;
        }
        const a = castSize(bookId);
        const b = castSize(best);
        if (a !== b) {
          if (a > b) best = bookId;
          continue;
        }
        const ap = seriesPositionByBookId.get(bookId) ?? -Infinity;
        const bp = seriesPositionByBookId.get(best) ?? -Infinity;
        if (ap > bp) best = bookId;
      }
      if (best) out.set(series, best);
    }
    return out;
  }, [library, libraryBooks, currentBookId, characters, globalCastCache]);

  /* When the selection-pill shows a cross-book same-base-voice pair, is
     there a duplicate candidate matching that exact pair? If yes, the
     pill replaces the disabled "Cross-book merges aren't supported"
     Merge button with a "Review duplicate ↗" button that opens the
     modal pre-populated. */
  const selectionDuplicateCandidate = useMemo<DuplicateCandidate | null>(() => {
    if (selectedVoices.length !== 2 || badge !== 'same') return null;
    const [v0, v1] = selectedVoices;
    if (v0.bookId === v1.bookId) return null;
    return (
      duplicateCandidates.find(
        (c) =>
          (c.a.voice.id === v0.id && c.b.voice.id === v1.id) ||
          (c.a.voice.id === v1.id && c.b.voice.id === v0.id),
      ) ?? null
    );
  }, [selectedVoices, badge, duplicateCandidates]);

  /* Derive the live pair + hydration status for the open review from the
     reactive `duplicateCandidates` memo. The candidate's character fields
     are null until its book's cast hydrates; this memo refills them the
     moment `globalCastCache` lands the cast (its deps cover all the
     sources). When the candidate later drops out of detection (e.g. it
     just got linked → suppressed), we rebuild a fallback pair from the
     library so the modal can still render its closing frame. */
  const duplicateReviewState = useMemo<{
    pair: DuplicateReviewPair | null;
    loading: boolean;
    hydrationError: string | null;
  }>(() => {
    if (!duplicateReviewKey) return { pair: null, loading: false, hydrationError: null };
    const { aVoiceId, bVoiceId } = duplicateReviewKey;
    const match = duplicateCandidates.find(
      (c) =>
        (c.a.voice.id === aVoiceId && c.b.voice.id === bVoiceId) ||
        (c.a.voice.id === bVoiceId && c.b.voice.id === aVoiceId),
    );
    const resolveSide = (
      voiceId: string,
    ): { voice: Voice; character: Character | null } | null => {
      if (match) {
        if (match.a.voice.id === voiceId) return match.a;
        if (match.b.voice.id === voiceId) return match.b;
      }
      const voice = library.find((v) => v.id === voiceId);
      if (!voice) return null;
      const source =
        voice.bookId === currentBookId ? characters : (globalCastCache.get(voice.bookId) ?? null);
      return { voice, character: source ? (findCharacterForVoice(voice, source) ?? null) : null };
    };
    const a = resolveSide(aVoiceId);
    const b = resolveSide(bVoiceId);
    if (!a || !b) return { pair: null, loading: false, hydrationError: null };

    const sideBookIds = [a.voice.bookId, b.voice.bookId];
    const anyFailed = sideBookIds.some((id) => globalCastFailed.has(id));
    const anyFetching = sideBookIds.some((id) => globalCastFetching.has(id));
    const allCastsPresent = sideBookIds.every(
      (id) => id === currentBookId || globalCastCache.has(id),
    );
    const loading = !anyFailed && (anyFetching || !allCastsPresent);
    const hydrationError = anyFailed
      ? 'Couldn’t load one book’s cast — try again later, or use Cancel.'
      : !loading && (!a.character || !b.character)
        ? 'One of these voices is no longer linked to a character. Use Cancel.'
        : null;
    return { pair: { a, b }, loading, hydrationError };
  }, [
    duplicateReviewKey,
    duplicateCandidates,
    library,
    currentBookId,
    characters,
    globalCastCache,
    globalCastFetching,
    globalCastFailed,
  ]);

  /* Open the DuplicateReviewModal for the given candidate. Stores the
     candidate identity and kicks off a foreign-cast hydrate for each side
     that isn't the open book — mirrors `openCompareModal`. No await: the
     `duplicateReviewState` memo reacts to the cast landing and flips the
     modal from its loading state to the enabled link/variant buttons. */
  function openDuplicateReview(candidate: DuplicateCandidate) {
    setDuplicateReviewKey({ aVoiceId: candidate.a.voice.id, bVoiceId: candidate.b.voice.id });
    const foreignBookIds = Array.from(
      new Set(
        [candidate.a.voice.bookId, candidate.b.voice.bookId].filter(
          (id) => id !== currentBookId,
        ),
      ),
    );
    for (const bookId of foreignBookIds) void hydrateForeignCast(bookId);
  }

  /* Reflect a resolved duplicate (link / variant) into whichever cast
     source the duplicate-detection memo reads, so the candidate is
     suppressed immediately instead of re-flagging on the next render.
     Open-book side → redux (the modal already dispatched the matching
     reducer for its own continuity needs; these dispatches are idempotent).
     Foreign side → patch `globalCastCache` in place. Without this the
     server's cross-book alias / notLinkedTo write only reaches the UI on a
     later fresh hydrate — the "merge fails silently then reappears" bug. */
  function reconcileDuplicateResolution(resolution: DuplicateResolution) {
    if (resolution.kind === 'link') {
      const { winnerBookId, winnerCharacterId, addedAlias } = resolution;
      if (winnerBookId === currentBookId) {
        dispatch(
          castActions.applyAddAlias({ characterId: winnerCharacterId, aliasName: addedAlias }),
        );
      } else {
        setGlobalCastCache((prev) =>
          appendAliasToCachedCharacter(prev, winnerBookId, winnerCharacterId, addedAlias),
        );
      }
      return;
    }
    /* variant: write the symmetric notLinkedTo pair to BOTH sides, routing
       each to redux or the cache by whether it's the open book. */
    const sides = [
      { self: resolution.a, other: resolution.b },
      { self: resolution.b, other: resolution.a },
    ];
    for (const { self, other } of sides) {
      if (self.bookId === currentBookId) {
        dispatch(
          castActions.applyNotLinked({
            characterId: self.characterId,
            otherBookId: other.bookId,
            otherCharacterId: other.characterId,
          }),
        );
      } else {
        setGlobalCastCache((prev) =>
          appendNotLinkedToCachedCharacter(
            prev,
            self.bookId,
            self.characterId,
            other.bookId,
            other.characterId,
          ),
        );
      }
    }
  }

  /* Plan 60 + plan 96 — on-demand foreign-cast hydrate. Pure-fetch
     helper: writes the cast into `globalCastCache` on success, records
     the bookId in `globalCastFailed` + pushes a toast on failure, and
     returns the cast (or null) so callers can sequence one or two
     parallel hydrations and then open the Compare modal once both
     sides resolve. `globalCastFetching` is a Set so concurrent
     per-side fetches for a cross-book pair don't clobber each
     other's in-flight state. */
  async function hydrateForeignCast(bookId: string): Promise<Character[] | null> {
    const cached = globalCastCache.get(bookId);
    if (cached) return cached;
    if (globalCastFailed.has(bookId)) return null;
    if (globalCastFetching.has(bookId)) {
      /* Another caller is already fetching — wait for it to land in the
         cache (or fail) by polling a microtask cycle. Simpler than a
         per-bookId promise registry and the wait is bounded by the
         single in-flight request. */
      await new Promise<void>((resolve) => {
        const tick = () => {
          if (globalCastCache.get(bookId) || globalCastFailed.has(bookId)) resolve();
          else setTimeout(tick, 25);
        };
        tick();
      });
      return globalCastCache.get(bookId) ?? null;
    }
    setGlobalCastFetching((prev) => {
      const next = new Set(prev);
      next.add(bookId);
      return next;
    });
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
      const sents = res?.manuscriptEdits?.sentences ?? [];
      setSentencesByBookId((prev) => {
        const next = new Map(prev);
        next.set(bookId, sents);
        return next;
      });
      return cast;
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
      return null;
    } finally {
      setGlobalCastFetching((prev) => {
        if (!prev.has(bookId)) return prev;
        const next = new Set(prev);
        next.delete(bookId);
        return next;
      });
    }
  }

  /* Resolve both selected voices' casts (parallel) then open the
     Compare modal. Source for each side: redux when its bookId matches
     the open book; foreign-cast cache otherwise (lazy-hydrated). Aborts
     opening if any hydrate fails — the failure-side toast fired from
     `hydrateForeignCast` is the user-facing surface.

     Same-bookId pairs (e.g. two voices from one foreign book) dedupe
     to a single fetch — calling hydrateForeignCast twice in the same
     microtask tick can't see its own globalCastFetching set update yet,
     so we collapse upstream. Pairs that are entirely within the open
     book take the synchronous fast-path — no microtask, no await — so
     a Compare click immediately mounts the modal in tests and avoids
     a needless render cycle. */
  function openCompareModal(voicePair: [Voice, Voice]): void {
    const foreignBookIds = Array.from(
      new Set(voicePair.map((v) => v.bookId).filter((id) => id !== currentBookId)),
    );
    if (foreignBookIds.length === 0) {
      setCompareIds([voicePair[0].id, voicePair[1].id]);
      return;
    }
    void (async () => {
      const results = await Promise.all(foreignBookIds.map(hydrateForeignCast));
      if (results.some((r) => r === null)) return;
      setCompareIds([voicePair[0].id, voicePair[1].id]);
    })();
  }

  /* Reuses the same transport profile-drawer.tsx uses
     (layout.tsx:1071-1072): POST /api/books/:bookId/cast/merge → server
     returns the full updated character list, applyMerge writes it into
     the cast slice, preserving local-only voiceId / matchedFrom /
     voiceState on the survivor. The source character's `name` lands on
     the survivor's `aliases[]` per the OpenAPI schema. Selection is
     cleared on success so the pill collapses and the user lands back on
     the families grid with the duplicate gone. */
  async function runMerge(source: Character, target: Character, bookId: string) {
    if (mergeBusy) return;
    setMergeBusy(true);
    try {
      const res = await api.mergeCharacters({ bookId, sourceId: source.id, targetId: target.id });
      dispatch(castActions.applyMerge({ characters: res.characters }));
      setSelectedVoiceIds([]);
      dispatch(
        notificationsActions.pushToast({
          kind: 'info',
          message: `Merged "${source.name}" into "${target.name}".`,
          dedupeKey: `voices-merge:${bookId}:${target.id}`,
        }),
      );
    } catch (err) {
      console.error('[voices] merge failed', err);
      dispatch(
        notificationsActions.pushToast({
          kind: 'error',
          message: `Couldn’t merge "${source.name}" into "${target.name}". Try again.`,
          dedupeKey: `voices-merge-error:${bookId}:${target.id}`,
        }),
      );
    } finally {
      setMergeBusy(false);
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
          if (status === 'loading-tts') setFamilyStatus({ key: family.key, label: 'Loading voice engine…' });
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
          if (status === 'loading-tts') setFamilyStatus({ key, label: 'Loading voice engine…' });
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

  /* Count preset families only — bespoke Qwen voices no longer form
     families (they bucket by status), so counting them here would inflate
     the tile with one-per-character noise (plan 117). */
  const familyCount = new Set(
    presetLibrary
      .filter((v) => v.ttsVoice)
      .map((v) => `${v.ttsVoice!.provider}|${v.ttsVoice!.name}`),
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
        <div className="flex items-center gap-3 flex-wrap">
          {currentBookId && characters.length > 0 && (
            <button
              type="button"
              onClick={() => dispatch(uiActions.openRebaselineModal({ bookId: currentBookId }))}
              data-testid="open-rebaseline"
              title="Move the principal cast onto bespoke Qwen voices across the whole series"
              className="inline-flex items-center gap-2 px-4 py-2 rounded-full bg-magenta text-white text-sm font-semibold hover:bg-magenta/90 transition-colors min-h-[44px] sm:min-h-0"
            >
              <IconSparkle className="w-4 h-4" /> Rebaseline the series
            </button>
          )}
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
            className={`px-4 py-2 rounded-full text-sm font-medium transition-colors ${tab === t.id ? 'bg-ink text-canvas' : 'text-ink/60 hover:text-ink hover:bg-ink/4'}`}
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
      ) : families.length === 0 && qwenGroups.length === 0 && variantFilter === 'all' ? (
        <div className="bg-white rounded-3xl border border-ink/10 shadow-card p-10 text-center">
          <p className="text-sm font-bold text-ink">No voices yet</p>
          <p className="mt-2 text-xs text-ink/60 max-w-md mx-auto">
            Finish setting up a book — once you confirm its cast, every character will appear here
            as a reusable voice.
          </p>
        </div>
      ) : (
        <div className={`space-y-8 ${draggingVoiceId ? 'dragging-voice' : ''}`}>
          {/* fe-9 — per-series bulk duplicate-review entry point. One banner
              above the family grid listing every series that has cross-book
              duplicate candidates; each opens the bulk modal seeded with that
              series' whole queue. Hidden when there are no candidates. */}
          {candidatesBySeriesKey.size > 0 && (
            <div className="rounded-2xl border border-amber-200 bg-amber-50/60 px-4 py-3 flex flex-col gap-2">
              <p className="text-xs font-semibold text-amber-800">
                ⚠ Cross-book duplicate suggestions
              </p>
              <div className="flex flex-wrap gap-2">
                {[...candidatesBySeriesKey.entries()].map(([seriesKey, list]) => {
                  const seriesName = seriesKey.split('|').slice(1).join('|') || seriesKey;
                  return (
                    <button
                      key={seriesKey}
                      type="button"
                      onClick={() => openBulkReview(seriesKey)}
                      data-testid={`bulk-review-${seriesName}`}
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-amber-100 text-amber-800 text-xs font-semibold hover:bg-amber-200 transition-colors min-h-[44px] sm:min-h-0"
                    >
                      Review all duplicates in {seriesName} ({list.length})
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          {/* fs-11 — "Show ignored duplicate suggestions" toggle + the Ignored
              section. Lets the user revisit pairs they marked "different on
              purpose" and Unmark them so they re-surface as candidates. The
              toggle always renders (the user might have ignored every pair, so
              there'd be nothing in the candidate banner to hint at it). */}
          <div className="flex flex-col gap-2">
            <button
              type="button"
              onClick={() => setShowIgnored((v) => !v)}
              data-testid="toggle-ignored-duplicates"
              className="self-start inline-flex items-center gap-1.5 text-xs font-medium text-ink/55 hover:text-ink min-h-[44px] sm:min-h-0"
            >
              {showIgnored ? '▾' : '▸'} {showIgnored ? 'Hide' : 'Show'} ignored duplicate suggestions
            </button>
            {showIgnored && (
              <div className="rounded-2xl border border-ink/10 bg-white px-4 py-3">
                {ignoredPairs.length === 0 ? (
                  <p className="text-xs text-ink/50">
                    No ignored pairs — nothing has been marked “different on purpose” yet.
                  </p>
                ) : (
                  <ul className="space-y-2">
                    {ignoredPairs.map((pair) => {
                      const aId = pair.a.character?.id ?? pair.a.voice.id;
                      const bId = pair.b.character?.id ?? pair.b.voice.id;
                      const key = `${pair.a.voice.bookId}:${aId}|${pair.b.voice.bookId}:${bId}`;
                      return (
                        <li
                          key={key}
                          className="flex items-center justify-between gap-3 flex-wrap"
                        >
                          <span className="text-xs text-ink/70 min-w-0">
                            <span className="font-semibold text-ink">
                              {pair.a.voice.character}
                            </span>{' '}
                            <span className="text-ink/40">({pair.a.voice.bookTitle})</span>{' '}
                            <span className="text-ink/40">↮</span>{' '}
                            <span className="font-semibold text-ink">
                              {pair.b.voice.character}
                            </span>{' '}
                            <span className="text-ink/40">({pair.b.voice.bookTitle})</span>
                          </span>
                          <button
                            type="button"
                            onClick={() => void unmarkIgnoredPair(pair)}
                            disabled={unmarkBusyKey !== null}
                            data-testid={`unmark-${key}`}
                            className="shrink-0 px-3 py-1.5 rounded-full bg-ink/5 text-ink text-xs font-semibold hover:bg-ink/10 disabled:opacity-40 disabled:cursor-not-allowed min-h-[44px] sm:min-h-0"
                          >
                            {unmarkBusyKey === key ? 'Unmarking…' : 'Unmark'}
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </div>
            )}
          </div>
          {/* fs-41/fs-50 seam 4b — language facet. Only shown when ≥1 voice
              carries a non-English languageCode; an all-English library shows
              nothing here, preserving the existing view byte-for-byte. */}
          {languages.length > 0 && (
            <div
              className="flex items-center gap-2 flex-wrap"
              role="group"
              aria-label="Filter by language"
            >
              <span className="text-xs text-ink/50">Language:</span>
              {([null, ...languages] as Array<string | null>).map((code) => {
                const LANGUAGE_LABELS: Record<string, string> = {
                  ru: 'Russian',
                  es: 'Spanish',
                  fr: 'French',
                  de: 'German',
                };
                const label = code === null ? 'All' : (LANGUAGE_LABELS[code] ?? code);
                const active = languageFilter === code;
                return (
                  <button
                    key={code ?? '__all__'}
                    type="button"
                    onClick={() => setLanguageFilter(code)}
                    aria-pressed={active}
                    className={`min-h-[44px] sm:min-h-0 inline-flex items-center px-3 py-2 sm:py-1.5 rounded-full text-sm font-medium transition-colors ${
                      active
                        ? 'bg-ink text-canvas'
                        : 'border border-ink/10 bg-canvas text-ink/70 hover:text-ink hover:bg-ink/4'
                    }`}
                  >
                    {label}
                  </button>
                );
              })}
            </div>
          )}
          {qwenLibrary.length > 0 && (
            <div
              className="flex items-center gap-2 flex-wrap"
              role="group"
              aria-label="Filter by emotion variants"
            >
              <span className="text-xs text-ink/50">Variants:</span>
              {(['all', 'has', 'needs'] as const).map((key) => {
                const label =
                  key === 'all' ? 'All' : key === 'has' ? 'Has variants' : 'Needs variants';
                const active = variantFilter === key;
                return (
                  <button
                    key={key}
                    type="button"
                    onClick={() => setVariantFilter(key)}
                    aria-pressed={active}
                    className={`min-h-[44px] sm:min-h-0 inline-flex items-center px-3 py-2 sm:py-1.5 rounded-full text-sm font-medium transition-colors ${
                      active
                        ? 'bg-ink text-canvas'
                        : 'border border-ink/10 bg-white text-ink/70 hover:text-ink hover:bg-ink/4'
                    }`}
                  >
                    {label}
                  </button>
                );
              })}
              {variantFilter !== 'all' && (
                <span className="text-[11px] text-ink/45">Counts fill in as other books load.</span>
              )}
            </div>
          )}
          {variantFilter !== 'all' && qwenGroups.length === 0 && (
            <div className="bg-white rounded-3xl border border-ink/10 shadow-card p-10 text-center">
              <p className="text-sm font-bold text-ink">No voices match this filter</p>
              <p className="mt-2 text-xs text-ink/60 max-w-md mx-auto">
                {variantFilter === 'has'
                  ? 'No designed voices have emotion variants in the current view.'
                  : 'No designed voices still need emotion variants in the current view.'}
              </p>
            </div>
          )}
          {showFamilies && families.map((f) => (
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
              duplicateCandidates={candidatesByFamily.get(f.key) ?? []}
              onReviewDuplicate={openDuplicateReview}
              representativeBookIdBySeries={representativeBookIdBySeries}
              onRebaselineSeries={(bookId) =>
                dispatch(uiActions.openRebaselineModal({ bookId }))
              }
            />
          ))}
          {qwenGroups.map((g) => (
            <QwenStatusSection
              key={g.status}
              group={g}
              draggingVoiceId={draggingVoiceId}
              setDraggingVoiceId={setDraggingVoiceId}
              onTogglePin={togglePin}
              onOpenCharacter={onOpenCharacter}
              selectedVoiceIds={selectedVoiceIds}
              onToggleSelect={toggleSelect}
              variantCountByVoiceId={variantCountByVoiceId}
              missingVariantCountByVoiceId={missingVariantCountByVoiceId}
              representativeBookIdBySeries={representativeBookIdBySeries}
              onRebaselineSeries={(bookId) =>
                dispatch(uiActions.openRebaselineModal({ bookId }))
              }
            />
          ))}
        </div>
      )}

      {selectedVoiceIds.length > 0 && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-30 fade-in">
          {/* Plan 96 — adopt the .floating-pill-inverse shell that
              cast.tsx uses so the pill stays dark in dark mode. The
              earlier raw `bg-ink text-canvas` flipped to cream-on-dark
              because --ink/--canvas swap; bg-canvas/15 overlays inside
              washed out, making the count badge + Compare button hard
              to read. See styles.css:401-416 for the documented
              failure mode. */}
          <div className="floating-pill-inverse rounded-full shadow-float px-4 py-2 flex items-center gap-3">
            <span className="text-xs text-canvas/60">Selected</span>
            <span className="px-2 py-0.5 rounded-full bg-canvas/15 text-canvas font-bold text-sm tabular-nums">
              {selectedVoiceIds.length}
            </span>
            {badge === 'same' && (
              <span
                role="status"
                className="px-2 py-0.5 rounded-full bg-emerald-500/30 text-emerald-100 text-[11px] font-semibold"
                title="Both selected voices resolve to the same base TTS speaker — the highest-signal compare case"
              >
                same base voice ✓
              </span>
            )}
            {badge === 'different' && (
              <span
                role="status"
                className="px-2 py-0.5 rounded-full bg-amber-400/35 text-amber-50 text-[11px] font-semibold"
                title="The selected voices route to different base TTS speakers — comparing across families is allowed; same-voice characters are the core tuning case"
              >
                different base voices
              </span>
            )}
            <span className="w-px h-5 bg-canvas/20" />
            <button
              onClick={() => {
                if (!canCompare || selectedVoiceIds.length !== 2) return;
                openCompareModal([selectedVoices[0], selectedVoices[1]]);
              }}
              disabled={!canCompare || globalCastFetching.size > 0}
              title={
                globalCastFetching.size > 0
                  ? 'Loading book cast…'
                  : canCompare
                    ? 'Compare these two voices'
                    : (compareDisabledReason ?? undefined)
              }
              className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-canvas/15 text-canvas text-xs font-bold hover:bg-canvas/25 disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {globalCastFetching.size > 0 ? 'Loading…' : 'Compare'}
            </button>
            {selectedVoiceIds.length === 2 && badge === 'same' && (
              /* Merge folds the shorter-named duplicate into the longer
                 one (e.g. Wren → Wren Sparrow). The button is hidden
                 unless both sides resolve to the same base voice; same-
                 book + non-bucket guards live in mergeDisabledReason so
                 the user can see WHY we refuse via the tooltip. */
              <button
                onClick={() => {
                  if (!canMerge || !mergeSource || !mergeTarget) return;
                  void runMerge(mergeSource, mergeTarget, selectedVoices[0].bookId);
                }}
                disabled={!canMerge || mergeBusy}
                title={
                  canMerge && mergeTarget
                    ? `Merge "${mergeSource?.name}" into "${mergeTarget.name}" — keeps "${mergeTarget.name}" as the survivor and stores "${mergeSource?.name}" as an alias`
                    : (mergeDisabledReason ?? undefined)
                }
                className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-canvas/15 text-canvas text-xs font-bold hover:bg-canvas/25 disabled:opacity-40 disabled:cursor-not-allowed max-w-56 truncate"
              >
                {mergeBusy ? 'Merging…' : mergeTarget ? `Merge into ${mergeTarget.name}` : 'Merge'}
              </button>
            )}
            {selectionDuplicateCandidate && (
              /* Plan 101 — cross-book same-base-voice pair selected and
                 the duplicate-detector recognises them as a likely match.
                 The cross-book Merge button stays hidden (its server
                 transport is same-book only); we surface the new
                 DuplicateReviewModal instead. */
              <button
                onClick={() => openDuplicateReview(selectionDuplicateCandidate)}
                title="Same person across books — review and link, or mark as intentional variant"
                className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-canvas/15 text-canvas text-xs font-bold hover:bg-canvas/25 max-w-56 truncate"
              >
                Review duplicate ↗
              </button>
            )}
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
          /* Plan 96 — per-side cast-source resolution. Each voice
             reads from redux when its bookId matches the open book,
             from the plan-60 foreign-cast cache otherwise. Cross-book
             pairs are now allowed and each side resolves independently. */
          const castSourceA =
            va.bookId === currentBookId ? characters : globalCastCache.get(va.bookId);
          const castSourceB =
            vb.bookId === currentBookId ? characters : globalCastCache.get(vb.bookId);
          if (!castSourceA || !castSourceB) return null;
          const charA = findCharacterForVoice(va, castSourceA);
          const charB = findCharacterForVoice(vb, castSourceB);
          if (!charA || !charB) return null;
          return (
            <CompareCastModal
              characters={[charA, charB]}
              library={library}
              ttsModelKey={ttsModelKey}
              propagatesAcrossSeries
              onSaveSide={async (next) => {
                /* Plan 96 — saves always route through the server. The
                   endpoint applies the patch to the source character
                   AND every series-sibling cast.json row that matches
                   the dedup rule; the response tells us which books
                   actually changed so we can mirror those writes into
                   redux (open book) and the foreign-cast cache
                   (everything else). */
                const sideVoice = next.id === charA.id ? va : vb;
                try {
                  const res = await api.seriesPatchCharacter({
                    bookId: sideVoice.bookId,
                    characterId: next.id,
                    patch: {
                      gender: next.gender,
                      ageRange: next.ageRange,
                      tone: next.tone,
                    },
                  });
                  for (const u of res.updated) {
                    if (u.bookId === currentBookId) {
                      dispatch(castActions.updateCharacter(next));
                    } else {
                      setGlobalCastCache((prev) => {
                        const cached = prev.get(u.bookId);
                        if (!cached) return prev;
                        const merged = cached.map((c) =>
                          c.id === u.characterId
                            ? {
                                ...c,
                                gender: next.gender,
                                ageRange: next.ageRange,
                                tone: next.tone,
                              }
                            : c,
                        );
                        const map = new Map(prev);
                        map.set(u.bookId, merged);
                        return map;
                      });
                    }
                  }
                  dispatch(
                    notificationsActions.pushToast({
                      kind: 'info',
                      message:
                        res.updated.length === 1
                          ? 'Saved.'
                          : `Saved to ${res.updated.length} books in this series.`,
                      dedupeKey: `voices-compare-save:${sideVoice.bookId}:${next.id}`,
                    }),
                  );
                  if (res.failed.length > 0) {
                    const titles = res.failed.map((f) => f.bookTitle).join(', ');
                    dispatch(
                      notificationsActions.pushToast({
                        kind: 'error',
                        message: `Could not save to: ${titles}`,
                        dedupeKey: `voices-compare-save-failed:${sideVoice.bookId}:${next.id}`,
                      }),
                    );
                  }
                } catch (err) {
                  console.error('[voices] series-patch save failed', err);
                  dispatch(
                    notificationsActions.pushToast({
                      kind: 'error',
                      message: 'Save failed — try again.',
                      dedupeKey: `voices-compare-save-error:${sideVoice.bookId}:${next.id}`,
                    }),
                  );
                }
              }}
              onClose={() => setCompareIds(null)}
              onOpenProfile={(id) => {
                setCompareIds(null);
                dispatch(uiActions.setOpenProfileId(id));
              }}
            />
          );
        })()}

      {/* Plan 101 — duplicate-review modal. Opens from family-card ⚠
          pill OR from the Review duplicate ↗ pill button. */}
      <DuplicateReviewModal
        open={duplicateReviewKey !== null}
        pair={duplicateReviewState.pair}
        loading={duplicateReviewState.loading}
        hydrationError={duplicateReviewState.hydrationError}
        onClose={() => setDuplicateReviewKey(null)}
        onResolved={(resolution) => {
          reconcileDuplicateResolution(resolution);
          setSelectedVoiceIds([]);
          setDuplicateReviewKey(null);
        }}
      />

      {/* fe-9 — bulk per-series duplicate review. Walks the frozen series
          queue one pair at a time; each resolution reconciles the detection
          sources exactly like the single-pair flow. */}
      {bulkReviewSeriesKey && (
        <BulkDuplicateReviewModal
          open
          candidates={bulkReviewQueue}
          seriesName={bulkReviewSeriesKey.split('|').slice(1).join('|') || bulkReviewSeriesKey}
          currentBookId={currentBookId}
          characters={characters}
          onClose={() => {
            setBulkReviewSeriesKey(null);
            setBulkReviewQueue([]);
          }}
          onResolved={(resolution) => reconcileDuplicateResolution(resolution)}
        />
      )}

      {/* Plan 108 Wave 5 + follow-up — "Rebaseline the series" modal. The
          target book comes from the ui-slice (`rebaselineBookId`): the open
          book for the book-scoped tab, the series' representative book for
          the per-series buttons on the global view. Renders nothing when
          closed or when no book anchor is set. */}
      <RebaselineModalContainer bookId={rebaselineBookId} />
    </div>
  );
}

/* Shared series → book nesting used by BOTH the preset voice-family builder
   and the Qwen status-bucket builder. Members are grouped by book in
   first-seen order, books bucketed by series; then books sort by title
   within a series and series sort alphabetically (standalones — null
   series — sort last under the '~' sentinel). */
function nestBySeriesBook(members: Voice[]): SeriesGroup[] {
  const books = new Map<string, BookGroup>();
  const seriesBuckets = new Map<string, BookGroup[]>();
  const seriesOrder = new Map<string, string | null>();
  for (const v of members) {
    /* `bookSeries` is null for standalones — bucket those under a synthetic
       'standalone' key so the render path can flatten. */
    const seriesKey = v.bookSeries ?? 'standalone';
    let bg = books.get(v.bookId);
    if (!bg) {
      bg = { bookId: v.bookId, bookTitle: v.bookTitle, voices: [] };
      books.set(v.bookId, bg);
      const bucket = seriesBuckets.get(seriesKey) ?? [];
      bucket.push(bg);
      seriesBuckets.set(seriesKey, bucket);
      seriesOrder.set(seriesKey, v.bookSeries ?? null);
    }
    bg.voices.push(v);
  }
  const seriesGroups: SeriesGroup[] = [];
  for (const [seriesKey, bks] of seriesBuckets) {
    seriesGroups.push({
      series: seriesKey === 'standalone' ? null : (seriesOrder.get(seriesKey) as string | null),
      books: bks.sort((a, b) => a.bookTitle.localeCompare(b.bookTitle)),
    });
  }
  seriesGroups.sort((a, b) => (a.series ?? '~').localeCompare(b.series ?? '~'));
  return seriesGroups;
}

/* Build voice families from the flat library list. Filters by tab first
   (so 'current' / 'library' don't leak voices the user isn't asking about
   into the family count), then groups by (provider, name), then sub-groups
   by series → book. Pass only NON-Qwen voices — bespoke Qwen voices are 1:1
   with characters, so family grouping degenerates; they go through
   buildQwenStatusGroups instead. */
function buildFamilies(
  library: Voice[],
  tab: Tab,
): Array<VoiceFamily & { seriesGroups: SeriesGroup[] }> {
  const filtered = library.filter((v) => {
    if (tab === 'all' || tab === 'base') return true;
    return v.source === tab;
  });
  const byKey = new Map<string, VoiceFamily>();
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
      };
      byKey.set(key, fam);
    }
    fam.members.push(v);
    fam.totalUsedIn += v.usedIn;
    if (v.pinned) fam.anyPinned = true;
  }
  const out: Array<VoiceFamily & { seriesGroups: SeriesGroup[] }> = [];
  for (const fam of byKey.values()) {
    out.push({ ...fam, seriesGroups: nestBySeriesBook(fam.members) });
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

type QwenStatus = 'none' | 'designed';

interface QwenStatusGroup {
  status: QwenStatus;
  title: string;
  members: Voice[];
  totalUsedIn: number;
  anyPinned: boolean;
  seriesGroups: SeriesGroup[];
}

/* Bespoke Qwen voices are designed 1:1 per character (plan 108), so the
   (provider, name) voice-family grouping collapses into degenerate
   single-member sections. Instead bucket Qwen voices by design status:
     - 'none'     → ttsVoice.name empty (no designed voiceId) → "Needs a voice"
     - 'designed' → has a designed voiceId → "Designed voices"
   In "Designed voices" each card carries a Designed / Sampled / Generated
   badge driven by `voice.sampled` / `voice.generated`. Same tab filter +
   series → book nesting as
   buildFamilies; "Needs a voice" sorts first so action-needed is at the top. */
function buildQwenStatusGroups(library: Voice[], tab: Tab): QwenStatusGroup[] {
  const filtered = library.filter((v) => {
    if (tab === 'all' || tab === 'base') return true;
    return v.source === tab;
  });
  const buckets: Record<QwenStatus, Voice[]> = { none: [], designed: [] };
  for (const v of filtered) {
    buckets[v.ttsVoice?.name ? 'designed' : 'none'].push(v);
  }
  const order: Array<{ status: QwenStatus; title: string }> = [
    { status: 'none', title: 'Needs a voice' },
    { status: 'designed', title: 'Designed voices' },
  ];
  const out: QwenStatusGroup[] = [];
  for (const { status, title } of order) {
    const members = buckets[status];
    if (members.length === 0) continue;
    out.push({
      status,
      title,
      members,
      totalUsedIn: members.reduce((n, v) => n + v.usedIn, 0),
      anyPinned: members.some((v) => !!v.pinned),
      seriesGroups: nestBySeriesBook(members),
    });
  }
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
  /* Plan 101 — auto-detected cross-book duplicate candidates within this
     family. The header renders a small ⚠ pill summarising the count;
     clicking it opens the DuplicateReviewModal for the first candidate. */
  duplicateCandidates: DuplicateCandidate[];
  onReviewDuplicate: (candidate: DuplicateCandidate) => void;
  /* Plan 108 follow-up — per-series Rebaseline. Each series-group header
     (only the named, non-standalone groups) renders a "✦ Rebaseline the
     series" button that opens the modal against the series' representative
     book. The map is keyed by the series name. */
  representativeBookIdBySeries: Map<string, string>;
  onRebaselineSeries: (bookId: string) => void;
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
  duplicateCandidates,
  onReviewDuplicate,
  representativeBookIdBySeries,
  onRebaselineSeries,
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
          {duplicateCandidates.length > 0 && (
            <button
              type="button"
              onClick={() => onReviewDuplicate(duplicateCandidates[0])}
              title={
                duplicateCandidates.length === 1
                  ? `Possible duplicate: "${duplicateCandidates[0].a.voice.character}" and "${duplicateCandidates[0].b.voice.character}" share this base voice across books in the same series.`
                  : `${duplicateCandidates.length} cross-book duplicate candidates on this base voice — review the first.`
              }
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-amber-100 text-amber-800 text-xs font-semibold hover:bg-amber-200 transition-colors"
            >
              ⚠ {duplicateCandidates.length} duplicate{' '}
              {duplicateCandidates.length === 1 ? 'candidate' : 'candidates'}
            </button>
          )}
          {isBusy && (
            <span className="text-[11px] text-ink/60 italic" aria-live="polite">
              {status?.label}
            </span>
          )}
          <button
            type="button"
            onClick={() => onPlay(family)}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-ink/4 hover:bg-ink/8 text-xs font-medium text-ink transition-colors"
          >
            <IconPlay className="w-3.5 h-3.5" /> Audition base voice
          </button>
        </div>
      </header>
      <div className="space-y-4">
        {seriesGroups.map((sg) => {
          /* Per-series Rebaseline trigger — shown only for named series
             (standalones are excluded) that resolve to a representative
             book. Clicking opens the modal against that book; the modal's
             series-scoped write propagates to the whole series. */
          const repBookId = sg.series ? representativeBookIdBySeries.get(sg.series) : undefined;
          return (
            <div key={sg.series ?? '~standalone'} className="pl-2 border-l-2 border-ink/6">
              {sg.series && (
                <div className="flex items-center justify-between gap-3 mb-2 pl-2 flex-wrap">
                  <p className="text-[11px] uppercase tracking-wider font-semibold text-ink/40">
                    {sg.series}
                  </p>
                  {repBookId && (
                    <button
                      type="button"
                      onClick={() => onRebaselineSeries(repBookId)}
                      data-testid={`rebaseline-series-${sg.series}`}
                      title="Move the principal cast onto bespoke Qwen voices across this series"
                      className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-magenta text-white text-[11px] font-semibold hover:bg-magenta/90 transition-colors min-h-[44px] sm:min-h-0"
                    >
                      <IconSparkle className="w-3.5 h-3.5" /> Rebaseline the series
                    </button>
                  )}
                </div>
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
          );
        })}
      </div>
    </section>
  );
}

interface QwenSectionProps {
  group: QwenStatusGroup;
  draggingVoiceId: string | null;
  setDraggingVoiceId: (id: string | null) => void;
  onTogglePin: (v: Voice) => void;
  onOpenCharacter?: (voice: Voice) => void;
  selectedVoiceIds: string[];
  onToggleSelect: (v: Voice) => void;
  /* fs-34 — designed emotion-variant count per Qwen voiceId (0/absent → no
     badge). Resolved in the parent where the cross-book cast cache lives. */
  variantCountByVoiceId: Map<string, number>;
  /* fe-34 — in-use emotions still lacking a designed variant, per Qwen voiceId
     (0/absent → no badge). Resolved in the parent alongside variantCountByVoiceId. */
  missingVariantCountByVoiceId: Map<string, number>;
  /* Per-series Rebaseline (plan 108 follow-up) — reused verbatim from
     VoiceFamilySection. Rebaseline *creates* designed Qwen voices, so it
     sits naturally on the Qwen sections' series-group headers. */
  representativeBookIdBySeries: Map<string, string>;
  onRebaselineSeries: (bookId: string) => void;
}

/* Status-bucketed Qwen section (plan 117): "Needs a voice" / "Designed
   voices", each nested series → book → character. No "Audition base voice"
   (a status bucket is not one voice) and no ⚠ duplicate pill (unique Qwen
   voiceIds never share a base voice). The "Designed voices" cards carry a
   Designed / Sampled / Generated badge. */
function QwenStatusSection({
  group,
  draggingVoiceId,
  setDraggingVoiceId,
  onTogglePin,
  onOpenCharacter,
  selectedVoiceIds,
  onToggleSelect,
  variantCountByVoiceId,
  missingVariantCountByVoiceId,
  representativeBookIdBySeries,
  onRebaselineSeries,
}: QwenSectionProps) {
  const seriesGroups = group.seriesGroups;
  return (
    <section aria-label={`Qwen · ${group.title}`}>
      <header className="mb-3 flex items-center justify-between gap-4 flex-wrap">
        <div className="min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <h2 className="text-base font-bold text-ink truncate">{group.title}</h2>
            <span className="text-[11px] uppercase tracking-wider font-semibold text-ink/40 shrink-0">
              {ENGINE_LABEL.qwen}
            </span>
          </div>
          <p className="text-xs text-ink/50">
            {group.members.length} {group.members.length === 1 ? 'cast member' : 'cast members'}{' '}
            · {seriesGroups.length}{' '}
            {seriesGroups.length === 1 ? 'series/standalone bucket' : 'series/standalone buckets'}
          </p>
        </div>
      </header>
      <div className="space-y-4">
        {seriesGroups.map((sg) => {
          const repBookId = sg.series ? representativeBookIdBySeries.get(sg.series) : undefined;
          return (
            <div key={sg.series ?? '~standalone'} className="pl-2 border-l-2 border-ink/6">
              {sg.series && (
                <div className="flex items-center justify-between gap-3 mb-2 pl-2 flex-wrap">
                  <p className="text-[11px] uppercase tracking-wider font-semibold text-ink/40">
                    {sg.series}
                  </p>
                  {repBookId && (
                    <button
                      type="button"
                      onClick={() => onRebaselineSeries(repBookId)}
                      data-testid={`rebaseline-series-${sg.series}`}
                      title="Move the principal cast onto bespoke Qwen voices across this series"
                      className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-magenta text-white text-[11px] font-semibold hover:bg-magenta/90 transition-colors min-h-[44px] sm:min-h-0"
                    >
                      <IconSparkle className="w-3.5 h-3.5" /> Rebaseline the series
                    </button>
                  )}
                </div>
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
                          badge={
                            group.status === 'designed' ? (
                              <span className="inline-flex items-center gap-1.5">
                                {v.generated ? (
                                  <Pill color="success">Generated</Pill>
                                ) : v.sampled ? (
                                  <Pill color="peach">Sampled</Pill>
                                ) : (
                                  <Pill color="library">Designed</Pill>
                                )}
                                {(variantCountByVoiceId.get(v.id) ?? 0) > 0 && (
                                  <VariantsBadge count={variantCountByVoiceId.get(v.id)!} />
                                )}
                                {(missingVariantCountByVoiceId.get(v.id) ?? 0) > 0 && (
                                  <NeedsVariantsBadge
                                    count={missingVariantCountByVoiceId.get(v.id)!}
                                  />
                                )}
                              </span>
                            ) : undefined
                          }
                        />
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          );
        })}
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
          If this stays empty, load the Voice engine from the model pill — the Coqui catalog is
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
          The Voice engine isn't reachable, or the loaded model has no published speakers. Load a
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
                Not the active engine — switch your voice engine to assign these
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
          className="px-3 py-2 rounded-full border border-ink/10 bg-white text-sm font-medium text-ink hover:bg-ink/4 focus:outline-hidden focus:ring-2 focus:ring-magenta/30"
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
          className="px-3 py-2 rounded-full border border-ink/10 bg-white text-sm font-medium text-ink hover:bg-ink/4 focus:outline-hidden focus:ring-2 focus:ring-magenta/30"
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
