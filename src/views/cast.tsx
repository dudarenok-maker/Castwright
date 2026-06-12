import { useEffect, useMemo, useRef, useState } from 'react';
import {
  IconLink,
  IconAlertTri,
  IconChevR,
  IconSearch,
  IconCheck,
  IconPlay,
  IconPause,
  IconSpinner,
  IconClose,
} from '../lib/icons';
import {
  SectionLabel,
  MixedHeading,
  Avatar,
  Pill,
  VoiceSwatch,
  ReusedBadge,
} from '../components/primitives';
import { VariantGlyphStrip } from '../components/variant-glyph-strip';
import {
  resolveVoiceStatus,
  statusFilterKeys,
  usedEmotionsByCharacter,
  countMissingVariants,
  type StatusPillColor,
} from '../lib/voice-status';
import { VoiceLibraryPanel } from '../components/voice-library-panel';
import type {
  Character,
  Voice,
  DriftEvent,
  CharColor,
  TtsModelKey,
  TtsEngine,
  Sentence,
} from '../lib/types';
import { useAppSelector, useAppDispatch } from '../store';
import { voicesActions } from '../store/voices-slice';
import { castDesignActions } from '../store/cast-design-slice';
import { useSamplePlayback } from '../lib/use-sample-playback';
import { playSampleWithAutoLoad } from '../lib/play-sample-with-auto-load';
import { sampleScopeFor } from '../lib/sample-scope';
import {
  resolveDisplayTtsVoice,
  resolveTtsVoiceForCharacter,
  sampleModelKeyForEngine,
} from '../lib/tts-voice-mapping';
import { gradientForTtsVoice } from '../lib/voice-palette';
import { TTS_MODEL_OPTIONS, engineForModelKey } from '../lib/tts-models';
import { findVoiceForCharacter } from '../lib/voice-character-link';
import { buildCharacterHint } from '../lib/build-character-hint';
import { CompareCastModal } from '../modals/compare-cast-modal';
import { StaleAudioBanner } from '../components/stale-audio-banner';
import { QwenStatusNotice } from '../components/qwen-status-notice';
import { DesignScopePicker } from '../components/design-scope-picker';
import { api } from '../lib/api';
import type { CastDesignScope } from '../store/cast-design-slice';
import { buildVariantTasks, variantWorkCounts } from '../lib/variant-tasks';

interface Props {
  characters: Character[];
  setCharacters: (next: Character[] | ((prev: Character[]) => Character[])) => void;
  library: Voice[];
  /** fs-34 — the book's attributed sentences, used to count, per character, how
      many distinct per-quote emotions still lack a designed Qwen variant
      ("N tags need a variant"). Optional; absent → no count shown. */
  sentences?: Sentence[];
  title?: string | null;
  /** fe-16 — BCP-47 language of the open book (default 'en'). When it isn't
      English the cast view shows the Qwen design banner and auto-loads Qwen,
      since non-English books are Qwen-locked and every speaking character
      needs a designed voice before it can be generated. */
  bookLanguage?: string;
  onOpenProfile: (id: string | null) => void;
  onShowMatchDetail: (id: string) => void;
  driftEvents: DriftEvent[];
  /* When called with no argument, opens the modal on the full list
     (top-banner entry). When called with a characterId, scopes the
     modal to that character — pill click on a cast row. */
  onShowDrift: (characterId?: string) => void;
}

/* Cast table ordering (display only — sorts a filtered copy, never the store
   order). Rows sort by line count descending so the most-spoken characters
   lead; the two generic minor-cast buckets (`unknown-male` / `unknown-female`,
   see server/src/analyzer/fold-minor-cast.ts) always sink to the bottom
   regardless of their pooled line count. Ties break by name for stability. */
const UNKNOWN_BUCKET_IDS = new Set(['unknown-male', 'unknown-female']);
/* fe-16 — module-level stable empty map so the fallback selector returns the
   SAME reference across renders when the slice field is absent (pre-fe-16
   preloaded test stores), keeping the selector cheap. */
const EMPTY_FALLBACK_MAP: Record<string, string> = {};
export function compareCastRows(a: Character, b: Character): number {
  const aBucket = UNKNOWN_BUCKET_IDS.has(a.id);
  const bBucket = UNKNOWN_BUCKET_IDS.has(b.id);
  if (aBucket !== bBucket) return aBucket ? 1 : -1;
  const byLines = (b.lines ?? 0) - (a.lines ?? 0);
  if (byLines !== 0) return byLines;
  return a.name.localeCompare(b.name);
}

/* Canonical order for the status-filter chips — lifecycle labels (engine
   order: Qwen design → preset states), then 'Unset', then the 'Reused'
   provenance chip last. Absent statuses are skipped, so a given cast only
   shows chips for the statuses it actually contains. */
const CHIP_ORDER = [
  'Needs voice',
  'Designed',
  'Sampled',
  'Generated',
  'Matched',
  'Tuned',
  'Locked',
  'Unset',
  'Reused',
  /* fs-25 / fs-34 — variant capability chips, last. */
  'Variants',
  'Needs variants',
];

/* Display labels for chips whose internal key differs from the chip text.
   The key stays stable (it flows through statusFilters + statusFilterKeys);
   only the displayed text changes. */
const CHIP_LABELS: Record<string, string> = {
  Variants: 'Has variants',
};

export function CastView({
  characters,
  setCharacters,
  library,
  sentences,
  title,
  bookLanguage = 'en',
  onOpenProfile,
  onShowMatchDetail,
  driftEvents,
  onShowDrift,
}: Props) {
  /* fs-34 — index used emotions per character ONCE (not per row) for the
     "N tags need a variant" cast-row count. */
  const usedEmotions = useMemo(() => usedEmotionsByCharacter(sentences ?? []), [sentences]);
  const [scopeOpen, setScopeOpen] = useState(false);
  const [query, setQuery] = useState('');
  /* fe-16 — non-English books are Qwen-locked. On entry, eagerly load Qwen so
     the user isn't blocked on a manual ModelControlPill load before designing
     voices. One-shot (guarded ref), gated on the install probe so we never try
     to load an uninstalled engine, and fully non-blocking — failures stay
     silent (the banner already tells the user what to do). */
  const isNonEnglish = bookLanguage !== 'en';
  const qwenAutoLoadFired = useRef(false);
  useEffect(() => {
    if (!isNonEnglish || qwenAutoLoadFired.current) return;
    qwenAutoLoadFired.current = true;
    let alive = true;
    void (async () => {
      try {
        const res = await fetch('/api/qwen/detect');
        if (!res.ok) return;
        const body = (await res.json()) as { installed: boolean };
        if (alive && body.installed) await api.loadSidecar({ engine: 'qwen' });
      } catch {
        /* Probe/load unreachable → stay silent; the banner already guides. */
      }
    })();
    return () => {
      alive = false;
    };
  }, [isNonEnglish]);
  /* Voice-matching status filter (multi-select, OR). Each entry is a key
     emitted by `statusFilterKeys` — a lifecycle label ('Needs voice',
     'Generated', …), 'Unset', or 'Reused'. Empty = show all. */
  const [statusFilters, setStatusFilters] = useState<string[]>([]);
  /* Plan 81 wave 3 — the same showLibrary state drives the desktop
     aside (default visible) AND the mobile/tablet bottom-sheet
     (default hidden — opens on Library-pill tap). Lazy init on
     window.innerWidth so the sheet doesn't pop open on phone load.
     SSR-safe: jsdom + tests always hit the desktop default since
     they don't define matchMedia at this code path. */
  const [showLibrary, setShowLibrary] = useState<boolean>(() => {
    if (typeof window === 'undefined') return true;
    return window.innerWidth >= 1024;
  });
  const [draggingVoiceId, setDraggingVoiceId] = useState<string | null>(null);
  const [dropTargetCharId, setDropTargetCharId] = useState<string | null>(null);
  /* Plan 81 wave 4 — touch-friendly assignment mode (additive to drag-drop).
     When a user taps "Assign" on a voice card, assigningVoice holds the
     captured voice; tapping any character row applies it via the same
     handleDrop code path. Cancelled via the sticky banner's Cancel button,
     by tapping the same Assign pill again, or by completing the assignment. */
  const [assigningVoice, setAssigningVoice] = useState<Voice | null>(null);
  const [selectedCharIds, setSelectedCharIds] = useState<string[]>([]);
  const [compareIds, setCompareIds] = useState<[string, string] | null>(null);
  const ttsModelKey = useAppSelector((s) => s.ui.ttsModelKey);
  const ttsEngine = engineForModelKey(ttsModelKey);
  /* "Design full cast" — the open book + the in-flight bulk-design snapshot. */
  const bookId = useAppSelector((s) => (s.ui.stage.kind === 'ready' ? s.ui.stage.bookId : null));
  const designActive = useAppSelector((s) => s.castDesign.active);
  /* fe-16 — per-character render-time fallback engine (Qwen → Kokoro), hydrated
     from book-state. Threaded into resolveVoiceStatus so a character that
     actually rendered in Kokoro shows "Fallback (Kokoro)" instead of its
     design-lifecycle pill. */
  const renderedFallbackByCharacter = useAppSelector(
    (s) => s.cast.renderedFallbackByCharacter ?? EMPTY_FALLBACK_MAP,
  );
  const dispatch = useAppDispatch();
  const playback = useSamplePlayback();
  /* Per-row sample state: { [characterId]: 'loading' | 'error: msg' }. The
     "playing" indicator is derived from the singleton playback hook by
     comparing currentUrl, so multiple rows can't show as "playing" at once. */
  const [rowState, setRowState] = useState<Record<string, { loading?: boolean; error?: string }>>(
    {},
  );
  /* Inline auto-evict banner. Surfaces above the cast table the first
     time a Play click triggers the JIT TTS load and actually unloads the
     analyzer. One-shot per view mount — the user reads it once and the
     pill on the Generation view takes over as the authoritative state. */
  const [evictionBanner, setEvictionBanner] = useState<string | null>(null);
  const setRow = (id: string, patch: { loading?: boolean; error?: string } | null) =>
    setRowState((prev) => {
      const next = { ...prev };
      if (patch === null) delete next[id];
      else next[id] = { ...next[id], ...patch };
      return next;
    });

  const toggleSelect = (id: string) =>
    setSelectedCharIds((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id],
    );
  const driftByChar = (id: string) => driftEvents.filter((d) => d.characterId === id);
  const totalDriftEvents = driftEvents.length;
  const findVoice = (id?: string) => library.find((v) => v.id === id);
  /* A character's effective engine = its per-character override, else the
     project default. Qwen is the only override that diverges from the project
     model key, so the sample/Stop-detection prefix must use the Qwen key for
     a Qwen-pinned character. */
  const effectiveEngineFor = (c: Character): TtsEngine => c.ttsEngine ?? ttsEngine;

  /* fe-32 — demand-driven variant work-list for the scope picker, scoped the
     SAME way the cast rows' "Needs variants" chip is (effective project engine
     OR a matched Qwen library voice) so the picker count can't disagree with
     the rows. Counts every emotion character's missing variants; `hasBase`
     splits the actionable-now total (`readyTasks`) from the work blocked behind
     a missing base voice (`blockedTasks`/`blockedChars`). */
  const isQwenForVariants = (c: Character): boolean =>
    effectiveEngineFor(c) === 'qwen' || findVoiceForCharacter(c, library)?.ttsVoice?.provider === 'qwen';
  const variantTasks = useMemo(
    () => buildVariantTasks(characters, usedEmotions, isQwenForVariants),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [characters, usedEmotions, library, ttsEngine],
  );
  const variantWork = useMemo(() => variantWorkCounts(variantTasks), [variantTasks]);

  /* Status-filter keys for a character, resolved the SAME way the row's
     StatusPill resolves its labels (matched library voice + effective engine)
     so the chips and the rows can't disagree. */
  const statusKeysFor = (c: Character): string[] =>
    statusFilterKeys(c, findVoiceForCharacter(c, library), effectiveEngineFor(c), usedEmotions.get(c.id));

  /* "Design full cast" — every character whose lifecycle is "Needs voice" (a
     Qwen-effective character with no designed voice), most-spoken first. Built
     off the WHOLE cast (not the filtered copy) so the bulk run covers everyone
     regardless of the active status filter. */
  const needsVoiceIds = useMemo(
    () =>
      characters
        .filter(
          (c) =>
            resolveVoiceStatus(c, findVoiceForCharacter(c, library), effectiveEngineFor(c))
              .lifecycle?.label === 'Needs voice',
        )
        .slice()
        .sort(compareCastRows)
        .map((c) => c.id),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [characters, library, ttsEngine],
  );
  const designRunningHere = designActive?.state === 'running' && designActive.bookId === bookId;
  const designRunningElsewhere =
    designActive?.state === 'running' && designActive.bookId !== bookId;
  /* Show the button on a Qwen project with ≥1 undesigned character OR ≥1 variant
     to design, OR while a run for this book is active (so the Cancel control stays
     reachable even after the last row flips and the counts hit 0). */
  const showDesignFullCast =
    (ttsEngine === 'qwen' && (needsVoiceIds.length > 0 || variantWork.totalTasks > 0)) ||
    designRunningHere;
  useEffect(() => {
    if (designRunningHere || designRunningElsewhere) setScopeOpen(false);
  }, [designRunningHere, designRunningElsewhere]);

  const onDesignFullCast = () => {
    if (designRunningHere) {
      if (bookId) void api.pauseCastDesign(bookId);
      return;
    }
    if (!bookId || designRunningElsewhere) return;
    setScopeOpen((v) => !v);
  };

  const startDesign = (scope: CastDesignScope) => {
    setScopeOpen(false);
    if (!bookId) return;
    const modelKey = sampleModelKeyForEngine('qwen', ttsModelKey);
    /* 'variants' alone can only synthesise on top of an existing base, so it
       ships ONLY the ready (has-base) tasks — the server would silently skip
       the rest. 'both' designs the bases first, so it ships every task. Strip
       the UI-only `hasBase` flag before it crosses the API boundary. */
    const scopedVariantTasks =
      scope === 'bases'
        ? []
        : (scope === 'variants' ? variantTasks.filter((t) => t.hasBase) : variantTasks).map(
            ({ characterId, emotions }) => ({ characterId, emotions }),
          );
    dispatch(
      castDesignActions.designAllRequested({
        bookId,
        characterIds: scope === 'variants' ? [] : needsVoiceIds,
        modelKey,
        scope,
        variantTasks: scopedVariantTasks,
      }),
    );
  };

  /* Chip buckets: one per status actually present in the cast, with its live
     count and pill color, ordered canonically. Built off the same resolver as
     the rows so a chip's count always equals its filtered row count. */
  const statusBuckets = useMemo(() => {
    const tally = new Map<string, { color: StatusPillColor; count: number }>();
    for (const c of characters) {
      const effectiveEngine = c.ttsEngine ?? ttsEngine;
      const voice = findVoiceForCharacter(c, library);
      const { lifecycle, reused, hasEmotionVariants } = resolveVoiceStatus(c, voice, effectiveEngine);
      const lifecycleKey = lifecycle?.label ?? 'Unset';
      const lifecycleColor: StatusPillColor = lifecycle?.color ?? 'neutral';
      tally.set(lifecycleKey, {
        color: lifecycleColor,
        count: (tally.get(lifecycleKey)?.count ?? 0) + 1,
      });
      if (reused) {
        tally.set('Reused', { color: 'library', count: (tally.get('Reused')?.count ?? 0) + 1 });
      }
      if (hasEmotionVariants) {
        tally.set('Variants', { color: 'library', count: (tally.get('Variants')?.count ?? 0) + 1 });
      }
      const isQwen = effectiveEngine === 'qwen' || voice?.ttsVoice?.provider === 'qwen';
      if (isQwen && countMissingVariants(c, usedEmotions.get(c.id)) > 0) {
        tally.set('Needs variants', {
          color: 'warning',
          count: (tally.get('Needs variants')?.count ?? 0) + 1,
        });
      }
    }
    return CHIP_ORDER.filter((key) => tally.has(key)).map((key) => ({
      key,
      color: tally.get(key)!.color,
      count: tally.get(key)!.count,
    }));
  }, [characters, library, ttsEngine, usedEmotions]);

  const toggleStatusFilter = (key: string) =>
    setStatusFilters((prev) =>
      prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key],
    );

  const filtered = characters
    .filter((c) => c.name.toLowerCase().includes(query.toLowerCase()))
    .filter(
      (c) => statusFilters.length === 0 || statusKeysFor(c).some((k) => statusFilters.includes(k)),
    )
    .sort(compareCastRows);

  async function playSampleFor(c: Character, voice: Voice | undefined) {
    const sampleVoiceId = sampleScopeFor(c);
    const effectiveEngine = effectiveEngineFor(c);
    const effectiveModelKey = sampleModelKeyForEngine(effectiveEngine, ttsModelKey);
    /* Server appends a hash of (text, voiceName) to the cached filename so
       attribute edits don't return stale audio. Match by prefix (keyed on the
       *effective* model key so a Qwen-pinned row still detects its own
       playback) so we still detect "this character's sample is what's playing". */
    const samplePrefix = `/audio/voices/${encodeURIComponent(sampleVoiceId)}-${effectiveModelKey}`;
    if (playback.isPlaying && playback.currentUrl?.startsWith(samplePrefix)) {
      playback.stop();
      return;
    }
    /* Qwen is bespoke — a sample can only synth once a voice has been designed
       (its voiceId pinned in overrideTtsVoices.qwen). The cast row has no
       in-place design affordance, so point the user at the profile. */
    const designedQwenVoiceId = c.overrideTtsVoices?.qwen?.name;
    if (effectiveEngine === 'qwen' && !designedQwenVoiceId) {
      setRow(c.id, {
        loading: false,
        error: 'No Qwen voice designed yet — open the profile to design one.',
      });
      return;
    }
    const stubTtsVoice = resolveTtsVoiceForCharacter(c, effectiveEngine);
    const subject: Voice = voice ?? {
      id: sampleVoiceId,
      character: c.name,
      bookTitle: '',
      bookId: '',
      attributes: c.attributes ?? [],
      gradient: gradientForTtsVoice(stubTtsVoice.name, sampleVoiceId),
      usedIn: 0,
      source: 'current',
      ttsVoice: stubTtsVoice,
    };
    /* Inject the designed Qwen voiceId so the server resolves it; preserve
       any other-engine override slots already on the matched voice. */
    const requestSubject: Voice =
      effectiveEngine === 'qwen' && designedQwenVoiceId
        ? {
            ...subject,
            overrideTtsVoices: {
              ...(subject.overrideTtsVoices ?? {}),
              qwen: { name: designedQwenVoiceId },
            },
          }
        : subject;
    const characterHint = buildCharacterHint(c);
    setRow(c.id, { loading: true, error: undefined });
    try {
      await playSampleWithAutoLoad({
        args: {
          voiceId: sampleVoiceId,
          voice: requestSubject,
          modelKey: effectiveModelKey,
          characterHint,
        },
        playback,
        /* The row's spinner already signals "something's happening"; the
           per-row label is too cramped for the full status word. So we
           only surface the eviction banner globally — and only when the
           helper confirms the analyzer was actually unloaded. */
        onStatus: (_status, { analyzerEvicted }) => {
          if (analyzerEvicted && !evictionBanner) {
            setEvictionBanner('Analyzer unloaded to free VRAM for TTS.');
          }
        },
      });
      setRow(c.id, { loading: false, error: undefined });
      /* Optimistically advance the Qwen Status pill Designed → Sampled the
         moment the audition synthesises. Only meaningful when a matched
         library voice exists (its id is the store key); the next /api/voices
         hydrate confirms it from the on-disk sample cache. */
      if (effectiveEngine === 'qwen' && voice) {
        dispatch(voicesActions.markSampled({ voiceId: voice.id }));
      }
    } catch (err) {
      setRow(c.id, { loading: false, error: (err as Error).message });
    }
  }

  function applyVoiceToCharacter(charId: string, voice: Voice) {
    setCharacters((prev) =>
      prev.map((c) =>
        c.id === charId
          ? {
              ...c,
              voiceId: voice.id,
              voiceState: voice.source === 'library' ? 'reused' : 'tuned',
              attributes: voice.attributes,
              matchedFrom:
                voice.source === 'library'
                  ? { bookTitle: voice.bookTitle, confidence: 0.92 }
                  : undefined,
            }
          : c,
      ),
    );
  }

  function handleDrop(charId: string) {
    if (!draggingVoiceId) return;
    const voice = findVoice(draggingVoiceId);
    if (!voice) return;
    applyVoiceToCharacter(charId, voice);
    setDraggingVoiceId(null);
    setDropTargetCharId(null);
  }

  /* Plan 81 wave 4 — touch-friendly handler. Fires when the user taps a
     character row while assignment mode is active. Same write semantics
     as handleDrop, then clears assignment mode. */
  function handleTapAssignTarget(charId: string) {
    if (!assigningVoice) return;
    applyVoiceToCharacter(charId, assigningVoice);
    setAssigningVoice(null);
  }

  /* Toggle handler from voice-library-panel's "Assign" pill. Tapping the
     pill on the active voice cancels (sets back to null); tapping it on
     a different voice swaps to that voice. */
  function handleTapAssignToggle(voice: Voice) {
    setAssigningVoice((prev) => (prev?.id === voice.id ? null : voice));
  }

  /* Plan 81 wave 3 — responsive layout split:
     - `<lg:` (mobile + tablet): single-column. The voice library opens
       as a bottom-sheet triggered by the "Library" pill at the top of
       the cast view (full-width on phone, half-height on tablet).
     - `lg:+`: legacy two-pane grid with the right-aside library.
     `showLibrary` controls aside visibility on desktop AND sheet
     visibility on mobile — same state, two surfaces. */
  return (
    <div
      className={`max-w-[1500px] mx-auto px-4 md:px-6 py-6 md:py-10 lg:grid ${showLibrary ? 'lg:grid-cols-[1fr_360px]' : 'lg:grid-cols-1'} gap-6 relative ${draggingVoiceId ? 'dragging-voice' : ''}`}
    >
      <div className="lg:col-span-full -mb-2 space-y-2">
        <QwenStatusNotice />
        <StaleAudioBanner />
      </div>
      {/* Plan 81 wave 4 — sticky assignment-mode banner. Visible whenever
          the user has tapped "Assign" on a voice card. Tapping any
          character row applies the voice; the banner clears on success
          or via the explicit Cancel button. */}
      {assigningVoice && (
        <div
          data-testid="tap-assign-banner"
          className="lg:col-span-full sticky top-16 z-30 mx-auto w-full max-w-[1500px] -mb-2"
        >
          <div className="m-2 sm:m-4 rounded-2xl bg-magenta text-white shadow-float px-4 py-3 flex items-center gap-3">
            <span className="text-sm font-semibold flex-1 min-w-0 truncate">
              Assigning{' '}
              <span className="underline decoration-white/40 underline-offset-2">
                {assigningVoice.character}
              </span>
              {' — '}tap a character row to apply.
            </span>
            <button
              type="button"
              onClick={() => setAssigningVoice(null)}
              className="shrink-0 min-h-[44px] px-3 rounded-full bg-white/15 hover:bg-white/25 text-white text-xs font-semibold"
            >
              Cancel
            </button>
          </div>
        </div>
      )}
      <div>
        <div className="mb-6 md:mb-8 flex items-end justify-between gap-4 md:gap-6 flex-wrap">
          <div className="min-w-0">
            <SectionLabel>Your cast</SectionLabel>
            <div className="mt-4">
              <MixedHeading
                regular="Voices generated from"
                bold={title || 'your manuscript'}
                level="h1"
              />
            </div>
            <p className="mt-3 text-ink/60 max-w-xl">
              Each voice is synthesised from how the character actually speaks in the book. Tune the
              profile, regenerate, or drop in a voice from your library to keep continuity across a
              series.
            </p>
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            {(showDesignFullCast || designRunningElsewhere) && (
              <div className="relative">
                <button
                  onClick={onDesignFullCast}
                  disabled={designRunningElsewhere}
                  data-testid="design-full-cast"
                  aria-haspopup="menu"
                  aria-expanded={scopeOpen}
                  className={`min-h-[44px] px-4 py-2.5 rounded-full text-sm font-semibold inline-flex items-center gap-2 transition-colors ${
                    designRunningElsewhere
                      ? 'bg-ink/5 text-ink/40 cursor-not-allowed'
                      : designRunningHere
                        ? 'bg-ink/6 text-ink/70 hover:bg-ink/10'
                        : 'bg-magenta text-white hover:bg-magenta/90'
                  }`}
                  title={
                    designRunningElsewhere
                      ? 'A design run is already in progress for another book.'
                      : undefined
                  }
                >
                  {designRunningHere ? (
                    <>
                      <IconClose className="w-4 h-4" />
                      <span>
                        Cancel design · {designActive?.done ?? 0}/{designActive?.total ?? 0}
                      </span>
                    </>
                  ) : (
                    <>
                      <IconSpinner className="w-4 h-4" />
                      <span>
                        Design full cast{needsVoiceIds.length > 0 ? ` (${needsVoiceIds.length})` : ''}
                      </span>
                    </>
                  )}
                </button>
                {scopeOpen && !designRunningHere && !designRunningElsewhere && (
                  <>
                    <div className="fixed inset-0 z-40" onClick={() => setScopeOpen(false)} aria-hidden />
                    <DesignScopePicker
                      baseCount={needsVoiceIds.length}
                      variantTotal={variantWork.totalTasks}
                      variantReady={variantWork.readyTasks}
                      variantBlocked={variantWork.blockedTasks}
                      variantBlockedChars={variantWork.blockedChars}
                      onPick={startDesign}
                      onClose={() => setScopeOpen(false)}
                    />
                  </>
                )}
              </div>
            )}
            <button
              onClick={() => setShowLibrary(!showLibrary)}
              className="min-h-[44px] px-4 py-2.5 rounded-full border border-ink/10 bg-white text-sm font-medium text-ink/70 hover:text-ink inline-flex items-center gap-2"
              aria-label={showLibrary ? 'Hide voice library' : 'Show voice library'}
              aria-expanded={showLibrary}
            >
              <IconLink className="w-4 h-4" />
              <span className="hidden sm:inline">{showLibrary ? 'Hide' : 'Show'} library</span>
              <span className="sm:hidden">Library</span>
            </button>
          </div>
        </div>

        {evictionBanner && (
          <div
            role="status"
            className="w-full mb-4 px-4 py-2.5 rounded-2xl border border-emerald-200 bg-emerald-50/70 inline-flex items-center gap-2 text-xs text-emerald-700"
          >
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" />
            <span>{evictionBanner}</span>
            <button
              onClick={() => setEvictionBanner(null)}
              className="ml-auto text-[11px] text-emerald-700/60 hover:text-emerald-700 font-medium"
              aria-label="Dismiss notice"
            >
              Dismiss
            </button>
          </div>
        )}

        {totalDriftEvents > 0 && (
          <button
            onClick={() => onShowDrift()}
            className="w-full mb-4 p-4 rounded-3xl border border-amber-200 bg-amber-50/60 hover:bg-amber-50 transition-colors flex items-center gap-4 text-left"
          >
            <span className="w-10 h-10 rounded-full bg-amber-100 grid place-items-center text-amber-700 shrink-0">
              <IconAlertTri className="w-5 h-5" />
            </span>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-bold text-ink">
                Voice drift detected in {totalDriftEvents} chapter
                {totalDriftEvents === 1 ? '' : 's'}
              </p>
              <p className="text-xs text-ink/65 mt-0.5">
                Some chapters have voices that don't match their established profiles. Click to
                review and decide what to regenerate.
              </p>
            </div>
            <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-amber-700 shrink-0">
              See report <IconChevR className="w-3.5 h-3.5" />
            </span>
          </button>
        )}

        {/* fe-16 — non-English on-ramp. Russian (and any future non-English)
            books render only through Qwen, so every speaking character needs a
            designed voice. Surface that requirement up front; Qwen is being
            loaded in the background (see the entry effect above). */}
        {isNonEnglish && (
          <div
            role="status"
            data-testid="cast-qwen-language-banner"
            className="w-full mb-4 p-4 rounded-3xl border border-purple-deep/20 bg-purple-deep/5 flex items-center gap-4 text-left"
          >
            <span className="w-10 h-10 rounded-full bg-purple-deep/10 grid place-items-center text-purple-deep shrink-0">
              <IconAlertTri className="w-5 h-5" />
            </span>
            <p className="flex-1 text-sm text-ink/80 leading-relaxed">
              <span className="font-bold text-ink">Design a Qwen voice for the narrator and every
              speaking character.</span>{' '}
              This book isn't in English, so it renders through Qwen — undesigned characters can't be
              generated.
            </p>
          </div>
        )}

        <div className="flex items-center gap-2 md:gap-3 mb-4">
          <div className="flex-1 min-w-0 relative">
            <IconSearch className="absolute left-4 top-1/2 -translate-y-1/2 w-4 h-4 text-ink/40" />
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search characters"
              className="w-full min-h-[44px] pl-11 pr-4 py-2.5 rounded-full bg-white border border-ink/10 text-sm focus:outline-hidden focus:border-ink/30"
            />
          </div>
        </div>

        {/* Status filter — one toggle chip per status present in the cast, with
            its live count. Multi-select OR: a row shows if it matches any
            active chip. Filters both the desktop table and the mobile cards
            (both iterate `filtered`). */}
        {statusBuckets.length > 0 && (
          <div
            className="flex items-center gap-2 mb-4 flex-wrap"
            role="group"
            aria-label="Filter by voice status"
          >
            {statusBuckets.map((b) => {
              const active = statusFilters.includes(b.key);
              return (
                <button
                  key={b.key}
                  onClick={() => toggleStatusFilter(b.key)}
                  aria-pressed={active}
                  className={`min-h-[44px] sm:min-h-0 inline-flex items-center gap-1.5 px-3 py-2 sm:py-1.5 rounded-full text-sm font-medium transition-colors ${
                    active
                      ? 'bg-ink text-canvas'
                      : 'border border-ink/10 bg-white text-ink/70 hover:text-ink hover:bg-ink/4'
                  }`}
                >
                  <span>{CHIP_LABELS[b.key] ?? b.key}</span>
                  <span className={`tabular-nums ${active ? 'text-canvas/70' : 'text-ink/40'}`}>
                    {b.count}
                  </span>
                </button>
              );
            })}
            {statusFilters.length > 0 && (
              <button
                onClick={() => setStatusFilters([])}
                className="min-h-[44px] sm:min-h-0 inline-flex items-center gap-1 px-3 py-2 sm:py-1.5 rounded-full text-sm font-medium text-ink/60 hover:text-ink"
              >
                <IconClose className="w-3.5 h-3.5" />
                Clear
              </button>
            )}
          </div>
        )}

        {/* Plan 81 wave 3 — md:+ table layout (legacy, unchanged contract). */}
        <div className="hidden md:block bg-white rounded-3xl border border-ink/10 shadow-card overflow-hidden">
          <div className="grid grid-cols-[40px_1.5fr_1.2fr_1.6fr_0.6fr_1.2fr_1fr_140px] gap-x-3 px-6 py-3 text-[11px] uppercase tracking-wider font-semibold text-ink/50 border-b border-ink/10">
            <span></span>
            <span>Character</span>
            <span>Role</span>
            <span>Voice</span>
            <span className="text-right tabular-nums">Lines</span>
            <span>Tone</span>
            <span>Status</span>
            <span>Sample</span>
          </div>
          {filtered.map((c, i) => {
            const voice = findVoiceForCharacter(c, library);
            const ttsVoice = resolveDisplayTtsVoice(c, voice, ttsEngine);
            const isDropTarget = dropTargetCharId === c.id;
            const sampleVoiceId = sampleScopeFor(c);
            const samplePrefix = `/audio/voices/${encodeURIComponent(sampleVoiceId)}-${sampleModelKeyForEngine(
              effectiveEngineFor(c),
              ttsModelKey,
            )}`;
            const isPlayingThis =
              playback.isPlaying && !!playback.currentUrl?.startsWith(samplePrefix);
            const row = rowState[c.id];
            return (
              <div
                key={c.id}
                data-testid={`cast-row-${c.id}`}
                onDragOver={(e) => {
                  if (draggingVoiceId) {
                    e.preventDefault();
                    setDropTargetCharId(c.id);
                  }
                }}
                onDragLeave={() => setDropTargetCharId((t) => (t === c.id ? null : t))}
                onDrop={(e) => {
                  e.preventDefault();
                  handleDrop(c.id);
                }}
                onClick={() => {
                  if (assigningVoice) {
                    handleTapAssignTarget(c.id);
                    return;
                  }
                  onOpenProfile(c.id);
                }}
                className={`w-full grid grid-cols-[40px_1.5fr_1.2fr_1.6fr_0.6fr_1.2fr_1fr_140px] gap-x-3 px-6 py-4 items-center text-left text-sm hover:bg-ink/2 transition-colors cursor-pointer ${i < filtered.length - 1 ? 'border-b border-ink/5' : ''} ${isDropTarget ? 'drop-active' : ''} ${selectedCharIds.includes(c.id) ? 'bg-peach/4' : ''}`}
              >
                <span
                  onClick={(e) => {
                    e.stopPropagation();
                    toggleSelect(c.id);
                  }}
                  className="grid place-items-center"
                >
                  <span
                    className={`w-5 h-5 rounded-md grid place-items-center transition-colors ${selectedCharIds.includes(c.id) ? 'bg-peach' : 'bg-white border border-ink/20 hover:border-ink/40'}`}
                  >
                    {selectedCharIds.includes(c.id) && <IconCheck className="w-3 h-3 text-white" />}
                  </span>
                </span>
                <span className="flex items-center gap-3 min-w-0">
                  <Avatar name={c.name} color={c.color as CharColor} size={36} />
                  <span className="min-w-0">
                    <span className="flex items-center gap-1.5">
                      <span className="font-semibold text-ink truncate">{c.name}</span>
                      {driftByChar(c.id).length > 0 && (
                        <span
                          title={`${driftByChar(c.id).length} chapter${driftByChar(c.id).length === 1 ? '' : 's'} with voice drift`}
                          onClick={(e) => {
                            e.stopPropagation();
                            onShowDrift(c.id);
                          }}
                          className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded-full bg-amber-100 text-amber-700 text-[10px] font-bold"
                        >
                          <IconAlertTri className="w-2.5 h-2.5" />
                          {driftByChar(c.id).length}
                        </span>
                      )}
                    </span>
                    <span className="block text-xs text-ink/50 truncate">
                      {c.attributes?.slice(0, 2).join(' · ')}
                    </span>
                  </span>
                </span>
                <span className="text-ink/70 truncate">{c.role}</span>
                <span className="flex items-center gap-3 min-w-0">
                  {voice ? (
                    <>
                      {/* Swatch click intentionally bubbles to the row's
                          onClick — so a single click opens the profile drawer
                          AND fires the sample play. The drawer's own swatch
                          coalesces with this play via the in-flight gate in
                          play-sample-with-auto-load. */}
                      <VoiceSwatch
                        voice={voice}
                        size="sm"
                        showLabel={false}
                        onSelect={() => {
                          void playSampleFor(c, voice);
                        }}
                        loading={!!rowState[c.id]?.loading}
                      />
                      <span className="min-w-0">
                        <span className="block text-ink/80 truncate font-medium">
                          {voice.character}
                        </span>
                        {/* Voice profile line is identical for generated and
                            reused rows — the match-source line stacks below
                            it so the user still sees which prebuilt voice the
                            reused character will speak with. */}
                        <TtsVoiceLine ttsVoice={ttsVoice} />
                        {c.matchedFrom && (
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              onShowMatchDetail(c.id);
                            }}
                            className="block text-[11px] text-purple-deep/70 hover:text-purple-deep truncate underline-offset-2 hover:underline"
                          >
                            From {c.matchedFrom.bookTitle} ·{' '}
                            {Math.round((c.matchedFrom.confidence ?? 0) * 100)}%
                          </button>
                        )}
                      </span>
                    </>
                  ) : (
                    <span className="min-w-0">
                      <span className="block text-ink/60 truncate italic">No library voice</span>
                      <TtsVoiceLine ttsVoice={ttsVoice} />
                    </span>
                  )}
                </span>
                <span className="text-right tabular-nums text-ink/80 font-medium">{c.lines}</span>
                <span className="flex flex-wrap gap-1">
                  {c.attributes?.slice(2, 4).map((a) => (
                    <Pill key={a}>{a}</Pill>
                  ))}
                </span>
                <span>
                  <StatusPill
                    c={c}
                    voice={voice}
                    projectEngine={ttsEngine}
                    renderedFallbackEngine={renderedFallbackByCharacter[c.id]}
                    usedEmotionsForChar={usedEmotions.get(c.id)}
                  />
                </span>
                <span
                  onClick={(e) => e.stopPropagation()}
                  className="flex flex-col items-start gap-0.5"
                >
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      void playSampleFor(c, voice);
                    }}
                    disabled={row?.loading}
                    title={
                      isPlayingThis
                        ? 'Stop sample'
                        : row?.loading
                          ? 'Generating…'
                          : `Generate & play a 12-second sample via ${ttsLabel(ttsModelKey)}`
                    }
                    className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-semibold transition-colors ${
                      row?.loading
                        ? 'bg-magenta/10 text-magenta cursor-wait'
                        : isPlayingThis
                          ? 'bg-magenta text-white hover:bg-magenta/90'
                          : 'bg-ink/6 text-ink/80 hover:bg-magenta/15 hover:text-magenta'
                    }`}
                  >
                    {row?.loading ? (
                      <IconSpinner className="w-3 h-3" />
                    ) : isPlayingThis ? (
                      <IconPause className="w-3 h-3" />
                    ) : (
                      <IconPlay className="w-3 h-3" />
                    )}
                    <span>
                      {row?.loading ? 'Generating…' : isPlayingThis ? 'Stop' : 'Play 12s'}
                    </span>
                  </button>
                  {row?.error && (
                    <span
                      className="text-[10px] text-red-600/80 truncate max-w-[130px]"
                      title={row.error}
                    >
                      ⚠ {row.error}
                    </span>
                  )}
                </span>
              </div>
            );
          })}
        </div>

        {/* Plan 81 wave 3 — <md: card list. Each character row collapses
            to a vertical card: checkbox top-left, avatar + name + drift
            badge in the header, role + tone chips + voice swatch + TTS
            line stacked, Status pill + Play-12s button on the action
            row. Drag-drop targets are wired the same way as the desktop
            grid rows so a desktop user with a narrow window still gets
            drag-to-reassign (Wave 4 will add the tap-to-assign affordance
            for touch devices). */}
        <div className="md:hidden flex flex-col gap-3">
          {filtered.map((c) => {
            const voice = findVoiceForCharacter(c, library);
            const ttsVoice = resolveDisplayTtsVoice(c, voice, ttsEngine);
            const isDropTarget = dropTargetCharId === c.id;
            const sampleVoiceId = sampleScopeFor(c);
            const samplePrefix = `/audio/voices/${encodeURIComponent(sampleVoiceId)}-${sampleModelKeyForEngine(
              effectiveEngineFor(c),
              ttsModelKey,
            )}`;
            const isPlayingThis =
              playback.isPlaying && !!playback.currentUrl?.startsWith(samplePrefix);
            const row = rowState[c.id];
            const selected = selectedCharIds.includes(c.id);
            return (
              <div
                key={c.id}
                onDragOver={(e) => {
                  if (draggingVoiceId) {
                    e.preventDefault();
                    setDropTargetCharId(c.id);
                  }
                }}
                onDragLeave={() => setDropTargetCharId((t) => (t === c.id ? null : t))}
                onDrop={(e) => {
                  e.preventDefault();
                  handleDrop(c.id);
                }}
                onClick={() => {
                  if (assigningVoice) {
                    handleTapAssignTarget(c.id);
                    return;
                  }
                  onOpenProfile(c.id);
                }}
                className={`bg-white rounded-2xl border border-ink/10 shadow-card p-4 flex flex-col gap-3 text-left cursor-pointer transition-colors ${isDropTarget ? 'drop-active' : ''} ${selected ? 'bg-peach/4' : ''}`}
              >
                <div className="flex items-start gap-3">
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      toggleSelect(c.id);
                    }}
                    aria-label={selected ? `Deselect ${c.name}` : `Select ${c.name}`}
                    aria-pressed={selected}
                    className="min-w-[44px] min-h-[44px] -m-2.5 p-2.5 grid place-items-center shrink-0"
                  >
                    <span
                      className={`w-6 h-6 rounded-md grid place-items-center transition-colors ${selected ? 'bg-peach' : 'bg-white border border-ink/20'}`}
                    >
                      {selected && <IconCheck className="w-3.5 h-3.5 text-white" />}
                    </span>
                  </button>
                  <Avatar name={c.name} color={c.color as CharColor} size={44} />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-1.5 flex-wrap">
                      <span className="font-semibold text-ink truncate">{c.name}</span>
                      {driftByChar(c.id).length > 0 && (
                        <span
                          title={`${driftByChar(c.id).length} chapter${driftByChar(c.id).length === 1 ? '' : 's'} with voice drift`}
                          onClick={(e) => {
                            e.stopPropagation();
                            onShowDrift(c.id);
                          }}
                          className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded-full bg-amber-100 text-amber-700 text-[10px] font-bold"
                        >
                          <IconAlertTri className="w-2.5 h-2.5" />
                          {driftByChar(c.id).length}
                        </span>
                      )}
                    </div>
                    <p className="text-xs text-ink/60 truncate">{c.role}</p>
                  </div>
                  <span className="shrink-0 tabular-nums text-xs text-ink/60 self-center">
                    {c.lines}{' '}
                    <span className="text-ink/40">{c.lines === 1 ? 'line' : 'lines'}</span>
                  </span>
                </div>
                <div
                  className="flex items-center gap-3 min-w-0"
                  onClick={(e) => e.stopPropagation()}
                >
                  <VoiceSwatch
                    voice={
                      voice ?? {
                        id: sampleVoiceId,
                        character: c.name,
                        bookTitle: '',
                        bookId: '',
                        attributes: c.attributes ?? [],
                        gradient: ['#A55A2A', '#3C194F'],
                        usedIn: 0,
                        source: 'current',
                        ttsVoice,
                      }
                    }
                    size="sm"
                    showLabel={false}
                    onSelect={() => {
                      void playSampleFor(c, voice);
                    }}
                    loading={!!row?.loading}
                  />
                  <div className="flex-1 min-w-0">
                    {voice ? (
                      <span className="block text-sm text-ink/80 truncate font-medium">
                        {voice.character}
                      </span>
                    ) : (
                      <span className="block text-sm text-ink/60 truncate italic">
                        No library voice
                      </span>
                    )}
                    <TtsVoiceLine ttsVoice={ttsVoice} />
                    {c.matchedFrom && (
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          onShowMatchDetail(c.id);
                        }}
                        className="block text-[11px] text-purple-deep/70 hover:text-purple-deep truncate underline-offset-2 hover:underline"
                      >
                        From {c.matchedFrom.bookTitle} ·{' '}
                        {Math.round((c.matchedFrom.confidence ?? 0) * 100)}%
                      </button>
                    )}
                  </div>
                </div>
                {(c.attributes?.length ?? 0) > 0 && (
                  <div className="flex flex-wrap gap-1">
                    {c.attributes?.slice(0, 4).map((a) => (
                      <Pill key={a}>{a}</Pill>
                    ))}
                  </div>
                )}
                <div className="flex items-center justify-between gap-3">
                  <span>
                    <StatusPill
                    c={c}
                    voice={voice}
                    projectEngine={ttsEngine}
                    renderedFallbackEngine={renderedFallbackByCharacter[c.id]}
                    usedEmotionsForChar={usedEmotions.get(c.id)}
                  />
                  </span>
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      void playSampleFor(c, voice);
                    }}
                    disabled={row?.loading}
                    title={
                      isPlayingThis
                        ? 'Stop sample'
                        : row?.loading
                          ? 'Generating…'
                          : `Generate & play a 12-second sample via ${ttsLabel(ttsModelKey)}`
                    }
                    className={`min-h-[44px] inline-flex items-center gap-1.5 px-4 py-2 rounded-full text-xs font-semibold transition-colors ${
                      row?.loading
                        ? 'bg-magenta/10 text-magenta cursor-wait'
                        : isPlayingThis
                          ? 'bg-magenta text-white hover:bg-magenta/90'
                          : 'bg-ink/6 text-ink/80 hover:bg-magenta/15 hover:text-magenta'
                    }`}
                  >
                    {row?.loading ? (
                      <IconSpinner className="w-3.5 h-3.5" />
                    ) : isPlayingThis ? (
                      <IconPause className="w-3.5 h-3.5" />
                    ) : (
                      <IconPlay className="w-3.5 h-3.5" />
                    )}
                    <span>
                      {row?.loading ? 'Generating…' : isPlayingThis ? 'Stop' : 'Play 12s'}
                    </span>
                  </button>
                </div>
                {row?.error && (
                  <span className="text-[10px] text-red-600/80 truncate" title={row.error}>
                    ⚠ {row.error}
                  </span>
                )}
              </div>
            );
          })}
        </div>

        <p className="mt-4 text-xs text-ink/50 text-center hidden md:block">
          {draggingVoiceId
            ? 'Drop the voice on any character row to reassign.'
            : 'Drag a voice from the library onto a character to reuse it across this book and others in the series.'}
        </p>

        {selectedCharIds.length > 0 && (
          /* Plan 81 wave 3 — floating selection pill stays sticky at the
             bottom, but on <sm: drops the avatar pile (no room) and
             clamps its max-width to the viewport so it never overflows
             horizontally on a 375px phone. The action buttons all get
             min-h-[44px] for WCAG touch-target compliance. */
          <div className="fixed bottom-4 sm:bottom-6 left-1/2 -translate-x-1/2 z-30 fade-in max-w-[calc(100vw-1rem)]">
            <div className="floating-pill-inverse rounded-full shadow-float px-3 sm:px-4 py-2 flex items-center gap-2 sm:gap-3">
              <span className="text-xs text-canvas/60 hidden sm:inline">Selected</span>
              <span className="px-2 py-0.5 rounded-full bg-canvas/15 text-canvas font-bold text-sm tabular-nums">
                {selectedCharIds.length}
              </span>
              <span className="hidden sm:flex items-center -space-x-1.5">
                {selectedCharIds.slice(0, 4).map((id) => {
                  const c = characters.find((x) => x.id === id);
                  return c ? (
                    <Avatar key={id} name={c.name} color={c.color as CharColor} size={24} />
                  ) : null;
                })}
              </span>
              <span className="w-px h-5 bg-canvas/20 hidden sm:inline-block" />
              <button
                onClick={() => {
                  if (selectedCharIds.length === 2)
                    setCompareIds([selectedCharIds[0], selectedCharIds[1]]);
                }}
                disabled={selectedCharIds.length !== 2}
                title={
                  selectedCharIds.length === 2
                    ? 'Compare these two cast members'
                    : 'Select exactly 2 to compare'
                }
                className="min-h-[44px] inline-flex items-center gap-1.5 px-3 py-2 rounded-full bg-canvas/15 text-canvas text-xs font-bold hover:bg-canvas/25 disabled:opacity-40 disabled:cursor-not-allowed"
              >
                Compare
              </button>
              <button
                onClick={() => setSelectedCharIds([])}
                aria-label="Clear selection"
                className="min-h-[44px] min-w-[44px] px-2 text-xs text-canvas/70 hover:text-canvas font-medium"
              >
                Clear
              </button>
            </div>
          </div>
        )}

        {compareIds &&
          (() => {
            const [aId, bId] = compareIds;
            const a = characters.find((c) => c.id === aId);
            const b = characters.find((c) => c.id === bId);
            if (!a || !b) return null;
            return (
              <CompareCastModal
                characters={[a, b]}
                library={library}
                ttsModelKey={ttsModelKey}
                onSaveSide={(next) =>
                  setCharacters((prev) => prev.map((c) => (c.id === next.id ? next : c)))
                }
                onClose={() => setCompareIds(null)}
                onOpenProfile={(id) => {
                  setCompareIds(null);
                  onOpenProfile(id);
                }}
              />
            );
          })()}
      </div>

      {/* Plan 81 wave 3 — desktop aside (lg:+). Identical contract to
          the original sticky-aside path; just hidden under lg. */}
      {showLibrary && (
        <aside className="hidden lg:block self-start sticky top-24">
          <VoiceLibraryPanel
            library={library}
            draggingVoiceId={draggingVoiceId}
            setDraggingVoiceId={setDraggingVoiceId}
            compact
            characters={characters}
            onOpenProfile={onOpenProfile}
            onPlaySample={(c, v) => {
              void playSampleFor(c, v);
            }}
            onTapAssign={handleTapAssignToggle}
            assigningVoiceId={assigningVoice?.id ?? null}
          />
        </aside>
      )}

      {/* Plan 81 wave 3 — mobile + tablet bottom-sheet (<lg:). Same
          showLibrary toggle drives this surface so the "Library" pill
          at the top of the cast view feels like a single state. Full-
          height on phone (h-[85vh] leaves a tap-to-dismiss strip at
          the top); half-height on tablet (md:h-[60vh]). Drag-and-drop
          STILL works from inside the sheet — the voice cards inherit
          their normal drag handlers and the underlying cast rows still
          listen for drop events, even though touch users will never
          discover the affordance (tap-to-assign lands in wave 4). */}
      {showLibrary && (
        <div
          className="lg:hidden fixed inset-0 z-40 fade-in"
          role="dialog"
          aria-modal="true"
          aria-label="Voice library"
        >
          <button
            type="button"
            onClick={() => setShowLibrary(false)}
            aria-label="Close voice library"
            className="absolute inset-0 w-full h-full bg-ink/30 cursor-default"
          />
          <div className="absolute bottom-0 left-0 right-0 h-[85vh] md:h-[60vh] bg-white rounded-t-3xl shadow-drawer flex flex-col">
            <div className="flex items-center justify-between px-5 pt-3 pb-2 border-b border-ink/10 shrink-0">
              <span className="w-10 h-1 rounded-full bg-ink/15 absolute left-1/2 top-2 -translate-x-1/2" />
              <h2 className="text-sm font-bold text-ink mt-1">Voice library</h2>
              <button
                type="button"
                onClick={() => setShowLibrary(false)}
                aria-label="Close voice library"
                className="min-w-[44px] min-h-[44px] -m-2 p-2 grid place-items-center text-ink/60 hover:text-ink rounded-full"
              >
                <IconClose className="w-5 h-5" />
              </button>
            </div>
            <div className="flex-1 min-h-0 overflow-hidden">
              <VoiceLibraryPanel
                library={library}
                draggingVoiceId={draggingVoiceId}
                setDraggingVoiceId={setDraggingVoiceId}
                compact
                characters={characters}
                onOpenProfile={(id) => {
                  /* Close the sheet so the profile drawer underneath is
                     visible — sheet's z-40 backdrop would otherwise eat
                     all pointer events meant for the drawer. */
                  setShowLibrary(false);
                  onOpenProfile(id);
                }}
                onPlaySample={(c, v) => {
                  void playSampleFor(c, v);
                }}
                displayMode="sheet"
                onTapAssign={(v) => {
                  /* Capture the voice and close the sheet so the user
                     can see + tap the character rows below. The sticky
                     assignment banner stays visible regardless. */
                  handleTapAssignToggle(v);
                  if (!assigningVoice || assigningVoice.id !== v.id) {
                    setShowLibrary(false);
                  }
                }}
                assigningVoiceId={assigningVoice?.id ?? null}
              />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function ttsLabel(key: TtsModelKey): string {
  return TTS_MODEL_OPTIONS.find((o) => o.id === key)?.label ?? key;
}

/* resolveDisplayTtsVoice now lives in ../lib/tts-voice-mapping (pure + testable
   without booting the view/router). */

/* Engine-aware Status display (plan 117 + reused-badge split). Renders two
   ORTHOGONAL markers via `resolveVoiceStatus`: the lifecycle pill (Needs voice
   → Designed → Generated for Qwen; Matched / Tuned / Locked otherwise) plus a
   small Reused badge whenever the voice was matched from a prior book — so a
   reused Qwen voice reads "Generated · Reused" instead of collapsing to a lone
   "Reused" pill. See src/lib/voice-status.ts for the resolution rules. */
function StatusPill({
  c,
  voice,
  projectEngine,
  renderedFallbackEngine,
  usedEmotionsForChar,
}: {
  c: Character;
  voice: Voice | undefined;
  projectEngine: TtsEngine;
  /* fe-16 — engine this character ACTUALLY rendered in (Qwen → Kokoro
     fallback). `'kokoro'` surfaces the "Fallback (Kokoro)" pill. */
  renderedFallbackEngine?: string | null;
  /* fs-34 — distinct per-quote emotions this character uses in the book.
     Rendered (Qwen only) as a per-emotion glyph strip on line 2. */
  usedEmotionsForChar?: Set<string>;
}) {
  /* Effective engine = the character's own override folded over the project
     default — so a default-engine character on a Qwen project follows the Qwen
     lifecycle (e.g. "Needs voice"), not a stale preset `voiceState` pill. */
  const effectiveEngine = c.ttsEngine ?? projectEngine;
  const { lifecycle, reused } = resolveVoiceStatus(
    c,
    voice,
    effectiveEngine,
    renderedFallbackEngine,
  );
  const isQwen = effectiveEngine === 'qwen' || voice?.ttsVoice?.provider === 'qwen';
  const usedEmotions = usedEmotionsForChar ?? new Set<string>();
  const designed = new Set(Object.keys(c.overrideTtsVoices?.qwen?.variants ?? {}));
  const hasVariants = designed.size > 0;
  const showStrip = isQwen && (usedEmotions.size > 0 || hasVariants);
  if (!lifecycle && !reused && !showStrip) return null;
  return (
    <span className="inline-flex flex-col items-start gap-1.5">
      <span className="inline-flex items-center gap-1.5 flex-wrap">
        {lifecycle && <Pill color={lifecycle.color}>{lifecycle.label}</Pill>}
        {reused && <ReusedBadge />}
      </span>
      {showStrip && <VariantGlyphStrip usedEmotions={usedEmotions} designedEmotions={designed} />}
    </span>
  );
}

interface TtsVoiceLineProps {
  ttsVoice: { provider: string; name: string; description: string };
}
function TtsVoiceLine({ ttsVoice }: TtsVoiceLineProps) {
  /* Qwen is bespoke (no prebuilt catalog) — surface the engine name so a
     Qwen-pinned character reads "Qwen · Designed voice" instead of an empty
     name line. Preset engines keep the name · description shape. */
  const isQwen = ttsVoice.provider === 'qwen';
  return (
    <span
      title={
        isQwen
          ? `Qwen bespoke voice — ${ttsVoice.description}`
          : `Prebuilt ${ttsVoice.provider} voice — ${ttsVoice.description}`
      }
      className="block text-[11px] text-ink/50 truncate"
    >
      {isQwen ? (
        <>
          <span className="font-semibold text-ink/70">Qwen</span>
          {/* Surface the designed voiceId (e.g. "qwen-wren") so the row is
              self-explanatory without opening the profile drawer. Omit the
              segment when no voice has been designed yet — keeps the line
              reading "Qwen · No voice designed yet". */}
          {ttsVoice.name && <span className="text-ink/40"> · {ttsVoice.name}</span>}
          <span className="text-ink/40"> · {ttsVoice.description}</span>
        </>
      ) : (
        <>
          <span className="font-semibold text-ink/70">{ttsVoice.name}</span>
          <span className="text-ink/40"> · {ttsVoice.description}</span>
        </>
      )}
    </span>
  );
}
