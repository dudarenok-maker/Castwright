import {
  Fragment,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from 'react';
import { useWindowVirtualizer } from '@tanstack/react-virtual';
import {
  IconChevR,
  IconPlus,
  IconCheck,
  IconClose,
  IconArrowDn,
  IconSpinner,
  IconWarning,
  IconEye,
  IconSearch,
} from '../lib/icons';
import { SectionLabel, ColorDot, Pill } from '../components/primitives';
import { CharacterSearchPicker } from '../components/character-search-picker';
import { SentenceEmotionControl } from '../components/sentence-emotion-control';
import { SentenceInstructControl } from '../components/sentence-instruct-control';
import { selectLiveInstruct } from '../store/book-meta-slice';
import { CHAR_COLORS } from '../lib/colors';
import { stripChapterPrefix } from '../lib/format-chapter-title';
import { initialSentences } from '../data/sentences';
import { useAppDispatch, useAppSelector } from '../store';
import { TOUR_STEPS } from '../lib/tour-steps';
import { manuscriptActions } from '../store/manuscript-slice';
import { changeLogActions } from '../store/change-log-slice';
import { uiActions } from '../store/ui-slice';
import { RestructureChaptersButton } from '../components/restructure-chapters-button';
import { DetectEmotionsButton } from '../components/detect-emotions-button';
import { ManuscriptStickyStatsBar } from '../components/manuscript/sticky-stats-bar';
import { ScriptReviewDiff } from '../components/script-review-diff';
import { api } from '../lib/api';
import { scriptReviewActions, selectActiveReview, type ReviewOpWithChapter } from '../store/script-review-slice';
import { notificationsActions } from '../store/notifications-slice';
import { rpdWarningFor, planApply } from '../lib/script-review-apply';
import type { Character, Chapter, Sentence, CharColor } from '../lib/types';
import type { SeriesRosterEntry } from '../lib/api';

/* fs-58 — Unit-A per-run default model. No persisted model-picker knob in
   Unit A; a per-run local-model option is deferred to srv-48. Used both for
   the per-run `model` opt and to compute the whole-book RPD warning. */
const REVIEW_MODEL = 'gemma-4-31b-it';

interface Props {
  characters: Character[];
  chapters: Chapter[];
  currentChapterId: number | null;
  setCurrentChapterId: (id: number) => void;
  sentencesFromStore?: Sentence[];
  onOpenProfile?: (id: string) => void;
  onStartGenerating?: () => void;
  /* Plan: low-confidence-triage-polish — prior-series roster (from
     LayoutContext) and the materialise-then-assign callback. The
     reassign pickers render roster entries below the local cast under
     a "From prior books in this series" separator; picking one fires
     onAddFromSeriesRoster which POSTs /cast/add-from-roster, dispatches
     castActions.addCharacter with the response, and returns the newly-
     minted local id so the picker can immediately reassign the
     sentence. */
  priorRoster?: SeriesRosterEntry[];
  onAddFromSeriesRoster?: (entry: SeriesRosterEntry) => Promise<string>;
}

interface IndexedSentence extends Sentence {
  absIdx: number;
}
interface Segment {
  id: string;
  characterId: string;
  sentences: IndexedSentence[];
}
interface Drag {
  boundaryIdx: number;
  anchorY: number;
  candidateSentenceIdx: number | null;
}

/* Inline hamburger icon — no equivalent in lib/icons.tsx yet, and adding
   one globally would widen the icon set for a single mobile-only use.
   Plan 81 Wave 3 introduces this; promote to lib/icons.tsx if a second
   view starts needing it. */
function IconMenu({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
    >
      <line x1="3" y1="6" x2="21" y2="6" />
      <line x1="3" y1="12" x2="21" y2="12" />
      <line x1="3" y1="18" x2="21" y2="18" />
    </svg>
  );
}

export function ManuscriptView({
  characters,
  chapters,
  currentChapterId,
  setCurrentChapterId,
  sentencesFromStore,
  onOpenProfile,
  onStartGenerating,
  priorRoster,
  onAddFromSeriesRoster,
}: Props) {
  const dispatch = useAppDispatch();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const bookId = useAppSelector((s) => ((s as any).ui?.stage as { bookId?: string } | undefined)?.bookId ?? null);
  const liveInstruct = useAppSelector(selectLiveInstruct(bookId));
  const [reviewLoading, setReviewLoading] = useState(false);
  /* fs-58 — whole-book opt-in is gated behind a small disclosure so the
     per-chapter "Review Script" stays the primary, low-cost default. */
  const [reviewMenuOpen, setReviewMenuOpen] = useState(false);
  const reviewMenuRef = useRef<HTMLDivElement>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const hasActiveReview = useAppSelector((s) => !!(bookId && (s as any).scriptReview && selectActiveReview(s as any, bookId)));
  /* Sentences are the single source of truth in Redux. All edits go via
     dispatch(manuscriptActions.*) — no local copy. */
  const sentences: Sentence[] = sentencesFromStore ?? initialSentences;
  /* Keep a ref so async handlers (e.g. handleReviewScript) always read
     the LIVE sentences even after an await, without depending on a
     potentially stale closure. */
  const sentencesRef = useRef<Sentence[]>(sentences);
  sentencesRef.current = sentences;
  const [selectedSeg, setSelectedSeg] = useState<string | null>(null);
  const [filterChar, setFilterChar] = useState<string | null>(null);
  const [chapterFilter, setChapterFilter] = useState<string>('');
  const [drag, setDrag] = useState<Drag | null>(null);
  /* Plan 81 Wave 3 — mobile/tablet drawer + bottom-sheet toggles. These
     are local UI state, not router state: the drawer auto-closes on
     chapter pick (mobile/tablet two-pane semantics), and the inspector
     sheet auto-closes on segment-cleared. Never rendered above `lg:`
     (the panels are inline at desktop), so toggling them on a desktop
     viewport is a no-op. */
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const currentChapter = chapters.find((c) => c.id === currentChapterId) || chapters[0];
  const currentIdx = chapters.findIndex((c) => c.id === currentChapterId);
  const prevChapter = chapters[currentIdx - 1];
  const nextChapter = chapters[currentIdx + 1];
  const containerRef = useRef<HTMLDivElement>(null);
  const articleRef = useRef<HTMLElement>(null);
  const selection = useSentenceSelection(articleRef);

  /* Substring match on title plus "CH NN" / bare id so the user can jump
     by either the chapter name or its index. Empty filter passes everything
     through, so the regular flow is unchanged. */
  const filteredChapters = useMemo(() => {
    const q = chapterFilter.trim().toLowerCase();
    if (!q) return chapters;
    return chapters.filter(
      (ch) =>
        ch.title.toLowerCase().includes(q) ||
        String(ch.id).includes(q) ||
        `ch ${String(ch.id).padStart(2, '0')}`.includes(q),
    );
  }, [chapters, chapterFilter]);

  /* Keep the active chapter visible inside the chapter card's internal
     scroller. Without this, Prev/Next on a 500-chapter book silently
     moves the selection off-screen because the row sits below the
     viewport of its scroll container. scrollIntoView({block:'nearest'})
     is a no-op when the row is already visible, so no jitter.
     scrollIntoView is missing in jsdom, so guard so tests don't crash. */
  const chapterRowRefs = useRef<Map<number, HTMLButtonElement>>(new Map());
  useEffect(() => {
    if (currentChapterId == null) return;
    const el = chapterRowRefs.current.get(currentChapterId);
    if (el && typeof el.scrollIntoView === 'function') {
      el.scrollIntoView({ block: 'nearest' });
    }
  }, [currentChapterId]);

  /* fs-58 — dismiss the review-scope disclosure on outside-click (pointerdown)
     or Escape. Mirrors the NavDrawer / HelpMenu pattern in top-bar.tsx. */
  useEffect(() => {
    if (!reviewMenuOpen) return;
    function onDocPointerDown(e: PointerEvent) {
      const t = e.target as Node | null;
      if (!t) return;
      if (reviewMenuRef.current?.contains(t)) return;
      setReviewMenuOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setReviewMenuOpen(false);
    }
    document.addEventListener('pointerdown', onDocPointerDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onDocPointerDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [reviewMenuOpen]);

  /* Segments are scoped to the currently-selected chapter so the manuscript
     view shows only sentences from that chapter — clicking a chapter in
     the sidebar narrows the middle pane. `absIdx` stays anchored to the
     full sentences[] array so drag/boundary-move edits still target the
     correct sentence ids even though the view is filtered. */
  const segments: Segment[] = useMemo(() => {
    const segs: Segment[] = [];
    for (let i = 0; i < sentences.length; i++) {
      const s = sentences[i];
      if (currentChapterId != null && s.chapterId !== currentChapterId) continue;
      const last = segs[segs.length - 1];
      if (last && last.characterId === s.characterId) last.sentences.push({ ...s, absIdx: i });
      else
        segs.push({
          id: `seg_${segs.length}`,
          characterId: s.characterId,
          sentences: [{ ...s, absIdx: i }],
        });
    }
    return segs;
  }, [sentences, currentChapterId]);

  /* Per-chapter counts so the "X speakers · Y low-confidence" stats above
     the manuscript reflect what's actually visible. */
  const counts = useMemo(() => {
    const m: Record<string, number> = {};
    for (const s of sentences) {
      if (currentChapterId != null && s.chapterId !== currentChapterId) continue;
      m[s.characterId] = (m[s.characterId] || 0) + 1;
    }
    return m;
  }, [sentences, currentChapterId]);

  /* Guided-tour demonstrations of the manuscript controls (fe-38 final
     acceptance). On the "Who says each line" step we dim the manuscript to
     one speaker so the colour-coding reads clearly; on "Chapters & paragraphs"
     we open the segment inspector ("side draw") on a character line. We pick a
     non-narrator (a named character) when one speaks in this chapter so the
     demo is vivid, and undo the demo state once the tour leaves the manuscript. */
  const tourStepId = useAppSelector((s) =>
    s.tour?.active ? (TOUR_STEPS[s.tour.stepIndex]?.id ?? null) : null,
  );
  const tourAppliedRef = useRef(false);
  useEffect(() => {
    const onManuscriptStep = tourStepId === 's4-line' || tourStepId === 's5-boundary';
    if (onManuscriptStep) {
      const spoken = segments.find((g) => g.characterId !== 'narrator') ?? segments[0];
      if (tourStepId === 's4-line') {
        setSelectedSeg(null);
        setInspectorOpen(false);
        setFilterChar(spoken ? spoken.characterId : null);
      } else {
        setFilterChar(null);
        if (spoken) {
          setSelectedSeg(spoken.id);
          setInspectorOpen(true);
        }
      }
      tourAppliedRef.current = true;
    } else if (tourAppliedRef.current) {
      tourAppliedRef.current = false;
      setFilterChar(null);
      setSelectedSeg(null);
      setInspectorOpen(false);
    }
  }, [tourStepId, segments]);

  /* Order the Detected sidebar by line count in the current chapter so
     the user lands on the busiest speakers first — no scroll past silent
     characters to filter / reassign the chapter's actual dialogue. Roster
     order is the stable tiebreaker, so equal-count rows (notably the
     zero-count tail) keep their original order. */
  const sortedDetectedCharacters = useMemo(() => {
    const indexed = characters.map((c, i) => ({ c, i, n: counts[c.id] ?? 0 }));
    indexed.sort((a, b) => b.n - a.n || a.i - b.i);
    return indexed.map((x) => x.c);
  }, [characters, counts]);

  /* Cross-chapter low-confidence aggregate — feeds the per-chapter amber
     count badge in the sidebar so the user can scan the chapter list and
     pick which chapters need triage attention without opening each one.
     Same 0.75 threshold as the header pill + SegmentRow pill + chapter
     low-conf navigator (see plan 90 invariant #4). O(N) over all
     sentences; runs once per sentences change. */
  const lowConfCountsByChapter = useMemo(() => {
    const m: Record<number, number> = {};
    for (const s of sentences) {
      if (s.confidence != null && s.confidence < 0.75) {
        m[s.chapterId] = (m[s.chapterId] ?? 0) + 1;
      }
    }
    return m;
  }, [sentences]);

  /* Sentences scoped to the current chapter — used by the low-confidence
     stat. Keep separate from the segments loop so memo invalidation is
     granular. */
  const chapterSentences = useMemo(() => {
    if (currentChapterId == null) return sentences;
    return sentences.filter((s) => s.chapterId === currentChapterId);
  }, [sentences, currentChapterId]);

  const findChar = useCallback((id: string) => characters.find((c) => c.id === id), [characters]);

  /* Plan 92 — virtualise the segment list above ~60 segments. Below
     that the cost of windowing (extra wrapper divs, layout-effect
     measurement, scroll-translate math) outweighs the rendered-row
     savings; above it the per-segment perf cost during boundary drag
     is what the user feels as jank. The threshold also keeps jsdom
     tests on the flat path (their fixtures are 1–10 sentences). */
  const virtualEnabled = segments.length >= 60;
  /* `useWindowVirtualizer` virtualises against the document scroll —
     which matches the manuscript view's current architecture (the
     `<article>` is just a content block, page scroll lives on the
     body). `scrollMargin` is the offset from the document top to the
     start of the virtualised region, so the virtualizer can map scroll
     positions to virtual-item indices correctly. */
  const [scrollMargin, setScrollMargin] = useState(0);
  useLayoutEffect(() => {
    /* Read the article's top offset from the document — invalidates
       on every chapter switch since header heights shift between
       chapters of different titles + segments. */
    const node = articleRef.current;
    if (!node) return;
    let frame = 0;
    const measure = () => {
      const rect = node.getBoundingClientRect();
      setScrollMargin(rect.top + window.scrollY);
    };
    measure();
    /* Re-measure on resize since the article's offsetTop can shift when
       header layout reflows. */
    const onResize = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(measure);
    };
    window.addEventListener('resize', onResize);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener('resize', onResize);
    };
  }, [currentChapterId, segments.length]);
  const virtualizer = useWindowVirtualizer({
    count: virtualEnabled ? segments.length : 0,
    estimateSize: () => 220,
    overscan: 5,
    scrollMargin,
  });
  const virtualItems = virtualEnabled ? virtualizer.getVirtualItems() : [];
  const virtualTotalSize = virtualEnabled ? virtualizer.getTotalSize() : 0;

  /* Plan: low-confidence-triage-polish — derive the ordered list of
     low-confidence sentence ids (confidence < 0.75) for the current
     chapter. Pairs with the header pill's ▲/▼ + J/K shortcuts that
     jump to the next/previous misattributed sentence. The 0.75
     threshold matches the existing stat counter (line 480 below) and
     the SegmentRow Low-confidence pill rendered around line 980. */
  const lowConfidenceSentenceIds = useMemo(
    () =>
      chapterSentences
        .filter((s) => s.confidence != null && s.confidence < 0.75)
        .map((s) => s.id),
    [chapterSentences],
  );
  const [lowConfCursor, setLowConfCursor] = useState(0);
  /* Reset the cursor when we switch chapters or the list shrinks below it. */
  useEffect(() => {
    if (lowConfCursor >= lowConfidenceSentenceIds.length) {
      setLowConfCursor(0);
    }
  }, [lowConfCursor, lowConfidenceSentenceIds.length]);

  const jumpToLowConfidence = useCallback(
    (direction: 1 | -1) => {
      const k = lowConfidenceSentenceIds.length;
      if (k === 0 || currentChapterId == null) return;
      const next = (lowConfCursor + direction + k) % k;
      setLowConfCursor(next);
      const targetSentenceId = lowConfidenceSentenceIds[next];
      /* Open the inspector on the segment containing the targeted
         sentence. Segments are derived per current chapter (above), so
         a substring scan is bounded. */
      const containingSegIdx = segments.findIndex((g) =>
        g.sentences.some((s) => s.id === targetSentenceId),
      );
      const containingSeg = containingSegIdx >= 0 ? segments[containingSegIdx] : null;
      if (containingSeg) {
        setSelectedSeg(containingSeg.id);
        setInspectorOpen(true);
      }
      /* Plan 92 — when virtualised, the target sentence may be off-screen
         (its segment not yet in DOM). Bring the containing segment into
         the window first via `scrollToIndex`, then refine to the sentence
         span on the next frame. Below the virtualisation threshold the
         span is always in DOM, so the existing scrollIntoView path
         applies directly. */
      const refine = () => {
        const root = articleRef.current ?? document;
        const el = root.querySelector?.(`[data-sentence-id="${targetSentenceId}"]`) as
          | HTMLElement
          | null;
        if (el && typeof el.scrollIntoView === 'function') {
          el.scrollIntoView({ block: 'center', behavior: 'smooth' });
        }
      };
      if (virtualEnabled && containingSegIdx >= 0) {
        virtualizer.scrollToIndex(containingSegIdx, { align: 'center' });
        requestAnimationFrame(refine);
      } else {
        refine();
      }
    },
    [lowConfidenceSentenceIds, lowConfCursor, segments, currentChapterId, virtualEnabled, virtualizer],
  );

  /* J / K keyboard shortcuts for next / previous low-confidence
     attribution. Guarded against firing while the user is typing in
     an input / textarea / contenteditable (e.g. the chapter filter,
     the picker search input). No-op when there are no low-confidence
     sentences in the current chapter. */
  useEffect(() => {
    if (lowConfidenceSentenceIds.length === 0) return;
    function onKeyDown(e: KeyboardEvent) {
      if (e.altKey || e.ctrlKey || e.metaKey) return;
      const tgt = e.target as HTMLElement | null;
      if (
        tgt &&
        (tgt.tagName === 'INPUT' ||
          tgt.tagName === 'TEXTAREA' ||
          tgt.isContentEditable)
      ) {
        return;
      }
      if (e.key === 'j' || e.key === 'J') {
        e.preventDefault();
        jumpToLowConfidence(1);
      } else if (e.key === 'k' || e.key === 'K') {
        e.preventDefault();
        jumpToLowConfidence(-1);
      }
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [jumpToLowConfidence, lowConfidenceSentenceIds.length]);

  /* Plan 81 wave 4 — pointer events instead of mouse events so phone +
     tablet touch drives the same boundary-move flow. PointerEvent
     normalises mouse + touch + pen into one handler; the underlying
     state machine (setDrag, candidateSentenceIdx, commitBoundaryMove)
     stays unchanged. setPointerCapture pins all subsequent move/up
     events to the originating element so the user can drag past the
     viewport edge on a phone without losing the gesture. */
  const onBoundaryPointerDown = (boundaryIdx: number, e: React.PointerEvent) => {
    e.preventDefault();
    setDrag({ boundaryIdx, anchorY: e.clientY, candidateSentenceIdx: null });
    document.body.classList.add('dragging-boundary');
    /* Capture the pointer on the source element so subsequent events
       fire there even if the pointer moves past the viewport. Safe on
       all PointerEvent-capable browsers; harmless if it throws. */
    try {
      (e.target as Element).setPointerCapture?.(e.pointerId);
    } catch {
      /* Older browsers may throw on capture — fall through gracefully. */
    }
  };

  function commitBoundaryMove(d: Drag) {
    const segAbove = segments[d.boundaryIdx - 1];
    const segBelow = segments[d.boundaryIdx];
    if (!segAbove || !segBelow || d.candidateSentenceIdx == null) return;
    const anchorIdx = segBelow.sentences[0].absIdx;
    const candIdx = d.candidateSentenceIdx;
    const ids: number[] = [];
    let newCharacterId: string;
    if (candIdx < anchorIdx) {
      newCharacterId = segBelow.characterId;
      for (let i = candIdx; i < anchorIdx; i++) ids.push(sentences[i].id);
    } else {
      newCharacterId = segAbove.characterId;
      for (let i = anchorIdx; i <= candIdx; i++) ids.push(sentences[i].id);
    }
    if (ids.length && currentChapterId != null) {
      dispatch(
        manuscriptActions.setSentencesCharacter({
          chapterId: currentChapterId,
          sentenceIds: ids,
          characterId: newCharacterId,
        }),
      );
      dispatch(
        changeLogActions.bumpBoundaryMove({ chapterId: currentChapterId, count: ids.length }),
      );
    }
  }

  useEffect(() => {
    if (!drag) return;
    /* Plan 81 wave 4 — pointer events fire for mouse + touch + pen.
       Touch users need pointermove + pointerup to drive the same
       candidate-sentence detection the mouse path used. */
    const onMove = (e: globalThis.PointerEvent) => {
      const el = document.elementFromPoint(e.clientX, e.clientY) as HTMLElement | null;
      const sentenceEl = el?.closest?.('[data-sentence-idx]') as HTMLElement | null;
      if (sentenceEl) {
        const idx = Number(sentenceEl.dataset.sentenceIdx);
        setDrag((d) =>
          d && d.candidateSentenceIdx !== idx ? { ...d, candidateSentenceIdx: idx } : d,
        );
      }
    };
    const onUp = () => {
      setDrag((d) => {
        if (d && d.candidateSentenceIdx != null) commitBoundaryMove(d);
        return null;
      });
      document.body.classList.remove('dragging-boundary');
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [drag?.boundaryIdx]);

  function reassignSegment(seg: Segment, newCharId: string) {
    /* Segments are built per current chapter (src/views/manuscript.tsx:80-90),
       so every sentence inside one segment shares the same chapterId. */
    const chapterId = seg.sentences[0]?.chapterId;
    if (chapterId == null) return;
    const ids = seg.sentences.map((s) => s.id);
    dispatch(
      manuscriptActions.setSentencesCharacter({
        chapterId,
        sentenceIds: ids,
        characterId: newCharId,
      }),
    );
    dispatch(changeLogActions.bumpBoundaryMove({ chapterId, count: ids.length }));
  }

  function assignSelectionTo(newCharacterId: string) {
    if (!selection || currentChapterId == null) return;
    /* Scope the lookup to the current chapter — sentence ids restart at 1
       per chapter, so a `s.id === selection.sentenceId` match alone would
       silently return chapter 1's same-id sentence when the user is on a
       later chapter. */
    const sentence = sentences.find(
      (s) => s.chapterId === currentChapterId && s.id === selection.sentenceId,
    );
    if (!sentence) return;
    const len = sentence.text.length;
    /* Whole sentence selected → simple reassign. Otherwise split into
       three pieces with the middle reassigned. The reducer drops empty
       pieces, so leading/trailing zero-length splits are safe. */
    if (selection.start <= 0 && selection.end >= len) {
      dispatch(
        manuscriptActions.setSentenceCharacter({
          chapterId: currentChapterId,
          sentenceId: selection.sentenceId,
          characterId: newCharacterId,
        }),
      );
    } else {
      dispatch(
        manuscriptActions.splitSentence({
          chapterId: currentChapterId,
          sentenceId: selection.sentenceId,
          offsets: [selection.start, selection.end],
          characterIds: [sentence.characterId, newCharacterId, sentence.characterId],
        }),
      );
    }
    dispatch(changeLogActions.bumpBoundaryMove({ chapterId: currentChapterId, count: 1 }));
    window.getSelection()?.removeAllRanges();
  }

  /* Defensive guard for the empty-chapters transient (e.g. the manuscript
     slice rehydrating after a reparse, or a stale URL pointing at a book
     whose chapter list hasn't loaded yet). The whole view dereferences
     currentChapter.* down in the main pane, so without this the page
     crashes with "Cannot read properties of undefined (reading 'id')".
     Render nothing rather than a half-built skeleton — the parent route
     swaps us back in as soon as chapters arrive. */
  if (!currentChapter) return null;

  /* Wrap setCurrentChapterId so picking a chapter on mobile/tablet
     auto-closes the drawer — the user's intent is "go to this chapter,"
     not "browse the chapter list while reading the prose underneath."
     Desktop is unaffected because the drawer is never opened there. */
  const handleChapterPick = (id: number) => {
    setCurrentChapterId(id);
    setSidebarOpen(false);
  };

  const selectedSegObj = segments.find((s) => s.id === selectedSeg);

  /* The sidebar (chapters + detected) and the inspector panel are
     rendered as their own subtrees so the same markup can show inline
     on `lg:` (sticky asides) AND inside drawer/sheet overlays on
     `<lg:`. */
  const sidebarPanels = (
    <SidebarPanels
      chapters={chapters}
      filteredChapters={filteredChapters}
      chapterFilter={chapterFilter}
      setChapterFilter={setChapterFilter}
      currentChapterId={currentChapterId}
      onChapterPick={handleChapterPick}
      chapterRowRefs={chapterRowRefs}
      characters={sortedDetectedCharacters}
      counts={counts}
      lowConfCountsByChapter={lowConfCountsByChapter}
      filterChar={filterChar}
      setFilterChar={setFilterChar}
      onOpenProfile={onOpenProfile}
    />
  );

  const inspectorContent = (
    <SegmentInspector
      seg={selectedSegObj}
      characters={characters}
      priorRoster={priorRoster}
      onAddFromSeriesRoster={onAddFromSeriesRoster}
      findChar={findChar}
      onClose={() => {
        setSelectedSeg(null);
        setInspectorOpen(false);
      }}
      onReassignSegment={(seg, newCharId) => {
        reassignSegment(seg, newCharId);
        setSelectedSeg(null);
        setInspectorOpen(false);
      }}
      onReassignSentence={(chapterId, sentenceId, newCharId) => {
        dispatch(
          manuscriptActions.setSentenceCharacter({
            chapterId,
            sentenceId,
            characterId: newCharId,
          }),
        );
        dispatch(changeLogActions.bumpBoundaryMove({ chapterId, count: 1 }));
      }}
      onOpenProfile={onOpenProfile}
    />
  );

  /* fs-58 — LLM script-review trigger. The model is per-run in Unit A (no
     persisted knob); we pass the server free-tier default so the RPD warning
     can reason about quota. Per-chapter (the default) uses one request; a
     whole-book sweep fires one request per chapter, so the RPD warning below
     gates it when the book is longer than the model's daily cap. */
  const reviewModel = REVIEW_MODEL;
  /* Non-excluded chapters are the ones a whole-book sweep would actually hit
     (excluded chapters never reach the analyzer). */
  const reviewableChapterCount = chapters.filter((c) => !c.excluded).length;
  const rpdWarning = rpdWarningFor(reviewableChapterCount, reviewModel);

  async function handleReviewScript(wholeBook: boolean) {
    if (!bookId || reviewLoading) return;
    if (!wholeBook && currentChapterId == null) return;
    const allOps: ReviewOpWithChapter[] = [];
    setReviewLoading(true);
    setReviewMenuOpen(false);
    try {
      await api.reviewScript(bookId, {
        /* Omitting chapterId reviews every (non-excluded) chapter server-side. */
        ...(wholeBook ? {} : { chapterId: currentChapterId ?? undefined }),
        model: reviewModel,
        onOps: ({ chapterId: chId, ops }) => {
          for (const op of ops) allOps.push({ ...op, chapterId: chId });
        },
      });
      /* fs-58 Task 11 — run planApply at seed time so ops that can't be
         resolved against the LIVE sentences (stale ids, missing anchors,
         invalid merges) land in `unappliable` rather than appearing as
         selectable no-ops in the diff modal. The Apply-time planApply in
         the modal stays — it's the TOCTOU re-validation for any edits
         that arrived between stream-complete and the user clicking Accept.
         sentencesRef.current gives the latest Redux value even after the
         await, without depending on the stale-closure capture. */
      const live = sentencesRef.current.map((s) => ({
        id: s.id,
        chapterId: s.chapterId,
        text: s.text,
        characterId: s.characterId,
      }));
      /* planApply filters from allOps whose entries are ReviewOpWithChapter —
         the chapterId is preserved on each returned object at runtime, so
         casting back to the wider type is safe here. */
      const { appliable, unappliable } = planApply(allOps, live, new Set(characters.map((c) => c.id))) as {
        appliable: ReviewOpWithChapter[];
        unappliable: Array<{ op: ReviewOpWithChapter; reason: string }>;
      };
      dispatch(scriptReviewActions.setReview({ bookId, ops: appliable, unappliable }));
    } catch (err) {
      dispatch(
        notificationsActions.pushToast({
          kind: 'error',
          message: err instanceof Error ? err.message : 'Script review failed.',
        }),
      );
    } finally {
      setReviewLoading(false);
    }
  }

  return (
    <div
      className="max-w-[1500px] mx-auto px-3 md:px-6 py-6 md:py-8 lg:grid lg:grid-cols-[280px_1fr_360px] lg:gap-6"
      ref={containerRef}
    >
      {/* fs-58 — ScriptReviewDiff modal: fixed-overlay, renders null when no active review */}
      {hasActiveReview && bookId && <ScriptReviewDiff bookId={bookId} />}

      {/* Desktop-only sticky sidebar (chapters + detected).
          Sidebar shell — flex column with no outer scroll. Each card owns
          its own internal scroll region (min-h-0 + overflow-y-auto on the
          list) so a 500-chapter book never pushes the cast off-screen.
          Both cards share the vertical space equally (flex-1 + basis-0)
          so they're the same height regardless of how much content each
          holds.
          On `<lg:` the same markup is rendered inside <Drawer> further
          down, with `lg:hidden` on the trigger and `hidden lg:flex` on
          this column so neither path duplicates. */}
      <div className="hidden lg:flex self-start sticky top-24 h-[calc(100vh-100px)] flex-col gap-4">
        {sidebarPanels}
      </div>

      <main className="min-w-0">
        {/* Mobile/tablet local header bar — hamburger (open chapter list)
            on `<lg:` only. Lives inside the view, not in the global
            top-bar, so it can't interfere with the shared shell. */}
        <div className="lg:hidden mb-3 flex items-center gap-2">
          <button
            type="button"
            onClick={() => setSidebarOpen(true)}
            aria-label="Open chapter list"
            className="inline-flex items-center justify-center min-w-11 min-h-11 px-3 rounded-xl border border-ink/10 bg-white text-ink/70 hover:text-ink hover:border-ink/30"
          >
            <IconMenu className="w-5 h-5" />
            <span className="ml-2 text-sm font-semibold">Chapters</span>
          </button>
        </div>
        <div className="mb-6">
          <SectionLabel>Manuscript analysis</SectionLabel>
          {/* Actions stack BELOW the title: the manuscript main column is narrow
              (a wide chapter sidebar sits beside it), so a title + 3 action
              buttons on one row starved the flex-1 title to zero width. Stacking
              keeps the title full-width at every viewport with no horizontal
              scroll. */}
          <div className="mt-4 flex flex-col gap-4">
            <h1 className="min-w-0 wrap-break-word text-2xl md:text-3xl lg:text-4xl font-medium leading-[1.1] tracking-tight">
              Chapter {currentChapter.id} —{' '}
              <span className="font-bold">{stripChapterPrefix(currentChapter.title)}</span>
              {currentChapter.excluded && (
                <span className="ml-3 align-middle inline-block">
                  <Pill>Excluded</Pill>
                </span>
              )}
            </h1>
            <div className="flex flex-wrap items-center gap-2">
              <RestructureChaptersButton
                onClick={() => dispatch(uiActions.changeView('restructure'))}
              />
              <DetectEmotionsButton disabled={sentences.length === 0} />
              {/* fs-58 — LLM script-review trigger. Primary = per-chapter
                  (low-cost default); the ⌄ disclosure opens the whole-book
                  opt-in, which is RPD-gated when the book is longer than the
                  selected model's daily cap. */}
              <div ref={reviewMenuRef} className="relative shrink-0 inline-flex items-stretch">
                <button
                  data-testid="review-script-chapter"
                  onClick={() => void handleReviewScript(false)}
                  disabled={reviewLoading || !bookId}
                  className="inline-flex items-center gap-2 px-4 min-h-[44px] sm:min-h-0 py-2 rounded-l-full border border-ink/20 bg-white text-ink text-sm font-semibold hover:bg-ink/5 disabled:opacity-50"
                >
                  {reviewLoading ? 'Reviewing…' : 'Review Script'}
                </button>
                <button
                  data-testid="review-script-menu-toggle"
                  onClick={() => setReviewMenuOpen((o) => !o)}
                  disabled={reviewLoading || !bookId}
                  aria-label="Script review options"
                  aria-expanded={reviewMenuOpen}
                  className="inline-flex items-center justify-center px-2 min-h-[44px] sm:min-h-0 py-2 rounded-r-full border border-l-0 border-ink/20 bg-white text-ink/60 hover:bg-ink/5 hover:text-ink disabled:opacity-50"
                >
                  <IconArrowDn className="w-4 h-4" />
                </button>
                {reviewMenuOpen && (
                  <div className="absolute top-full left-0 mt-2 z-50 w-72 rounded-2xl border border-ink/10 bg-white picker-surface shadow-float p-3 space-y-2">
                    <p className="text-[11px] uppercase tracking-wider font-semibold text-ink/50">
                      Review scope
                    </p>
                    <button
                      data-testid="review-script-wholebook"
                      onClick={() => void handleReviewScript(true)}
                      disabled={reviewLoading || !bookId}
                      className="w-full text-left px-3 min-h-[44px] sm:min-h-0 py-2 rounded-xl hover:bg-ink/5 text-sm font-medium text-ink disabled:opacity-50"
                    >
                      Review whole book
                      <span className="block text-xs font-normal text-ink/50">
                        {reviewableChapterCount} chapter
                        {reviewableChapterCount === 1 ? '' : 's'}
                      </span>
                    </button>
                    {rpdWarning && (
                      <p
                        data-testid="review-script-rpd-warning"
                        className="text-xs text-magenta leading-relaxed px-1"
                      >
                        This book has {rpdWarning.chapterCount} chapters; the
                        selected model allows only {rpdWarning.rpd} reviews/day —
                        switch to a local model or review per chapter.
                      </p>
                    )}
                  </div>
                )}
              </div>
              {onStartGenerating && (
                <button
                  onClick={onStartGenerating}
                  className="shrink-0 inline-flex items-center gap-2 px-5 min-h-11 py-3 rounded-full bg-ink text-canvas text-sm font-semibold hover:bg-ink/90 shadow-card"
                >
                  Approve cast &amp; start generating
                  <IconChevR className="w-4 h-4" />
                </button>
              )}
            </div>
          </div>
        </div>
        {/* Plan 98 — sticky stats bar lifted out of the header card so it
            sticks for the entire manuscript scroll (not just within the
            short header card's height). Same row content as before:
            segments · speakers · low-confidence ▲ ▼ · Prev/Next. */}
        <ManuscriptStickyStatsBar
          currentChapter={currentChapter}
          segmentCount={segments.length}
          speakerCount={Object.keys(counts).length}
          lowConfCount={lowConfidenceSentenceIds.length}
          prevChapter={prevChapter}
          nextChapter={nextChapter}
          onJumpLowConf={jumpToLowConfidence}
          onPickChapter={setCurrentChapterId}
        />

        {currentChapter.excluded ? (
          <div className="bg-white rounded-3xl border border-ink/10 shadow-card p-6 md:p-10 text-center">
            <p className="text-base font-semibold text-ink/70">
              This chapter was excluded at import.
            </p>
            <p className="mt-2 text-sm text-ink/55 max-w-md mx-auto leading-relaxed">
              It wasn't sent to the analyzer, so there are no sentences or speakers to review here.
              The chapter won't be voiced. To bring it back, open the{' '}
              <span className="font-semibold text-ink/70">Generate</span> view and click{' '}
              <span className="font-semibold text-ink/70">Include in book</span> on this row.
            </p>
          </div>
        ) : (
          <div className="bg-white rounded-3xl border border-ink/10 shadow-card p-5 md:p-10">
            <article ref={articleRef} className="font-serif text-[17px] leading-[1.8] text-ink/90">
              {virtualEnabled ? (
                /* Plan 92 — windowed render. The article becomes a
                   positioned container of `virtualTotalSize` px; each
                   visible virtual item is absolute-positioned with
                   `translateY`. `measureElement` reads each row's true
                   height after mount so the virtualizer corrects its
                   estimateSize over the first few frames. Boundary
                   handles render inside each row's wrapper so they
                   move with their segment. */
                <div
                  data-testid="manuscript-virtual-container"
                  style={{ position: 'relative', height: virtualTotalSize }}
                >
                  {virtualItems.map((virtualItem) => {
                    const seg = segments[virtualItem.index];
                    const isLast = virtualItem.index === segments.length - 1;
                    return (
                      <div
                        key={virtualItem.key}
                        data-index={virtualItem.index}
                        ref={virtualizer.measureElement}
                        style={{
                          position: 'absolute',
                          top: 0,
                          left: 0,
                          width: '100%',
                          transform: `translateY(${virtualItem.start - virtualizer.options.scrollMargin}px)`,
                        }}
                      >
                        <SegmentRow
                          seg={seg}
                          characters={characters}
                          priorRoster={priorRoster}
                          onAddFromSeriesRoster={onAddFromSeriesRoster}
                          selected={selectedSeg === seg.id}
                          dimmed={!!filterChar && filterChar !== seg.characterId}
                          drag={drag}
                          onSelect={() => setSelectedSeg(seg.id)}
                          onShowDetails={() => {
                            setSelectedSeg(seg.id);
                            setInspectorOpen(true);
                          }}
                          onReassignSegment={(newCharId) => reassignSegment(seg, newCharId)}
                          onOpenProfile={onOpenProfile}
                          findChar={findChar}
                          liveInstruct={liveInstruct}
                        />
                        {!isLast && (
                          <BoundaryHandle
                            boundaryIdx={virtualItem.index + 1}
                            drag={drag}
                            onPointerDown={onBoundaryPointerDown}
                          />
                        )}
                      </div>
                    );
                  })}
                </div>
              ) : (
                segments.map((seg, segIdx) => (
                  <Fragment key={seg.id}>
                    <SegmentRow
                      seg={seg}
                      characters={characters}
                      priorRoster={priorRoster}
                      onAddFromSeriesRoster={onAddFromSeriesRoster}
                      selected={selectedSeg === seg.id}
                      dimmed={!!filterChar && filterChar !== seg.characterId}
                      drag={drag}
                      onSelect={() => setSelectedSeg(seg.id)}
                      onShowDetails={() => {
                        setSelectedSeg(seg.id);
                        setInspectorOpen(true);
                      }}
                      onReassignSegment={(newCharId) => reassignSegment(seg, newCharId)}
                      onOpenProfile={onOpenProfile}
                      findChar={findChar}
                      liveInstruct={liveInstruct}
                    />
                    {segIdx < segments.length - 1 && (
                      <BoundaryHandle
                        boundaryIdx={segIdx + 1}
                        drag={drag}
                        onPointerDown={onBoundaryPointerDown}
                      />
                    )}
                  </Fragment>
                ))
              )}
            </article>
          </div>
        )}

      </main>

      {/* Inspector aside — single mounted instance for tablet + desktop.
          At `lg:` it lives in the grid's third column as a sticky aside.
          At `md:` (768–1023) it falls into the same column but the parent
          grid is single-column (only `lg:` enables three columns), so it
          stacks below `<main>` inline as a full-width card. At `<md:` it
          stays mounted but `hidden md:block` removes it visually — the
          mobile bottom-sheet below uses a fresh subtree when opened so
          we don't end up with two simultaneously-visible inspectors. */}
      <aside className="hidden md:block lg:self-start lg:sticky lg:top-24 lg:max-h-[calc(100vh-100px)] mt-6 lg:mt-0">
        {inspectorContent}
      </aside>

      {/* Mobile sidebar drawer — slides in from the left, traps the
          chapter+detected cards. `lg:hidden` so it never mounts on
          desktop. The drawer body reuses sidebarPanels via the same
          flex-column layout the sticky aside uses. */}
      <Drawer
        open={sidebarOpen}
        onClose={() => setSidebarOpen(false)}
        title="Chapters"
        side="left"
      >
        <div className="flex flex-col gap-4 h-full">{sidebarPanels}</div>
      </Drawer>

      {/* Mobile bottom-sheet inspector — only opened when the user taps
          the "Details" pill on a SegmentRow at `<md:`. Tablet/desktop
          render the inspector inline / aside instead (see above).
          The sheet closes on outer-tap, on the close button, and on
          successful reassignment. */}
      <BottomSheet
        open={inspectorOpen && !!selectedSegObj}
        onClose={() => setInspectorOpen(false)}
      >
        {inspectorContent}
      </BottomSheet>

      <SelectionPopover sel={selection} characters={characters} onAssign={assignSelectionTo} />
    </div>
  );
}

/* ── Sidebar panels — chapter list + detected cast.
   Extracted so the same DOM can render inside the sticky desktop aside
   AND inside the mobile/tablet drawer overlay without duplicating ~150
   lines of markup. */
interface SidebarPanelsProps {
  chapters: Chapter[];
  filteredChapters: Chapter[];
  chapterFilter: string;
  setChapterFilter: (v: string) => void;
  currentChapterId: number | null;
  onChapterPick: (id: number) => void;
  chapterRowRefs: RefObject<Map<number, HTMLButtonElement>>;
  characters: Character[];
  counts: Record<string, number>;
  /* Plan 98 — per-chapter low-confidence count, keyed by chapter id.
     Used to render the amber count badge on chapter rows so users can
     scan the chapter list for which chapters need triage attention. */
  lowConfCountsByChapter: Record<number, number>;
  filterChar: string | null;
  setFilterChar: (v: string | null) => void;
  onOpenProfile?: (id: string) => void;
}

function SidebarPanels({
  chapters,
  filteredChapters,
  chapterFilter,
  setChapterFilter,
  currentChapterId,
  onChapterPick,
  chapterRowRefs,
  characters,
  counts,
  lowConfCountsByChapter,
  filterChar,
  setFilterChar,
  onOpenProfile,
}: SidebarPanelsProps) {
  return (
    <>
      <aside className="bg-white rounded-3xl border border-ink/10 shadow-card overflow-hidden flex-1 basis-0 min-h-0 flex flex-col">
        <div className="shrink-0 px-5 pt-5 pb-3">
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-sm font-bold text-ink">Chapters</h2>
            <span className="inline-flex items-center justify-center min-w-[24px] h-6 px-2 rounded-full bg-ink/6 text-[11px] font-semibold text-ink/60 tabular-nums">
              {chapterFilter.trim()
                ? `${filteredChapters.length}/${chapters.length}`
                : chapters.length}
            </span>
          </div>
          <label className="relative block">
            <IconSearch className="w-3.5 h-3.5 absolute left-3 top-1/2 -translate-y-1/2 text-ink/40 pointer-events-none" />
            <input
              type="text"
              value={chapterFilter}
              onChange={(e) => setChapterFilter(e.target.value)}
              placeholder="Filter chapters…"
              aria-label="Filter chapters"
              className="w-full rounded-lg border border-ink/10 bg-white pl-8 pr-2 py-1.5 text-xs text-ink placeholder:text-ink/40 focus:outline-hidden focus:border-peach"
            />
          </label>
        </div>
        <ul className="flex-1 min-h-0 overflow-y-auto scrollbar-thin px-5 pb-5 space-y-0.5">
          {filteredChapters.map((ch) => {
            const active = currentChapterId === ch.id;
            const excluded = !!ch.excluded;
            const lowConfCount = lowConfCountsByChapter[ch.id] ?? 0;
            const titleCls = excluded
              ? 'font-medium text-ink/40 line-through decoration-1'
              : active
                ? 'font-semibold text-ink'
                : 'font-medium text-ink/80';
            return (
              <li key={ch.id}>
                <button
                  onClick={() => onChapterPick(ch.id)}
                  ref={(el) => {
                    if (el) chapterRowRefs.current?.set(ch.id, el);
                    else chapterRowRefs.current?.delete(ch.id);
                  }}
                  className={`w-full flex items-center gap-3 px-3 py-2 rounded-xl text-left transition-colors relative ${active ? 'bg-ink/5' : 'hover:bg-ink/3'}`}
                  title={
                    excluded ? 'Excluded — not analyzed, no audio will be generated.' : undefined
                  }
                >
                  {active && (
                    <span className="absolute left-0 top-2 bottom-2 w-[3px] rounded-full bg-peach" />
                  )}
                  <span
                    className={`text-[11px] font-bold tabular-nums w-7 ${excluded ? 'text-ink/30' : active ? 'text-magenta' : 'text-ink/40'}`}
                  >
                    CH {String(ch.id).padStart(2, '0')}
                  </span>
                  <span className="flex-1 min-w-0">
                    <span className={`block text-sm truncate ${titleCls}`}>
                      {stripChapterPrefix(ch.title)}
                    </span>
                    <span
                      className={`block text-[11px] tabular-nums ${excluded ? 'text-ink/45 italic' : 'text-ink/50'}`}
                    >
                      {excluded ? 'Excluded' : ch.duration}
                    </span>
                  </span>
                  {!excluded && lowConfCount > 0 && (
                    <span
                      data-testid={`chapter-low-conf-badge-${ch.id}`}
                      className="shrink-0 inline-flex items-center justify-center min-w-[20px] h-[18px] px-1.5 rounded-full bg-amber-100 text-amber-800 text-[10px] font-semibold tabular-nums"
                      title={`${lowConfCount} low-confidence sentence${lowConfCount === 1 ? '' : 's'} in this chapter`}
                      aria-label={`${lowConfCount} low-confidence`}
                    >
                      {lowConfCount}
                    </span>
                  )}
                  {!excluded && ch.state === 'in_progress' && (
                    <IconSpinner className="w-3 h-3 text-magenta shrink-0" />
                  )}
                  {!excluded && ch.state === 'done' && (
                    <IconCheck className="w-3 h-3 text-emerald-600 shrink-0" />
                  )}
                  {!excluded && ch.state === 'failed' && (
                    <IconWarning className="w-3 h-3 text-rose-600 shrink-0" />
                  )}
                </button>
              </li>
            );
          })}
          {filteredChapters.length === 0 && (
            <li className="px-3 py-2 text-[11px] text-ink/45 italic">
              No chapters match "{chapterFilter.trim()}".
            </li>
          )}
        </ul>
      </aside>

      <aside data-tour-id="detected-speakers" className="bg-white rounded-3xl border border-ink/10 shadow-card overflow-hidden flex-1 basis-0 min-h-0 flex flex-col">
        <div className="shrink-0 px-5 pt-5 pb-3 flex items-center justify-between">
          <h2 className="text-sm font-bold text-ink">Detected</h2>
          <span className="inline-flex items-center justify-center min-w-[24px] h-6 px-2 rounded-full bg-ink/6 text-[11px] font-semibold text-ink/60 tabular-nums">
            {characters.length}
          </span>
        </div>
        {/* Single scroll region for the cast list + "Add character" +
            help text, mirroring the prior in-card flow but bounded so
            the chapter card next to it isn't crowded out. */}
        <div className="flex-1 min-h-0 overflow-y-auto scrollbar-thin px-5 pb-5">
          <ul className="space-y-1">
            {characters.map((c) => {
              const active = filterChar === c.id;
              const cc = CHAR_COLORS[c.color as CharColor] ?? CHAR_COLORS.narrator;
              /* Silent in this chapter — dim but still clickable so
                 cross-chapter reassignment / filter targeting still
                 reaches characters who never speak here. */
              const silent = !active && (counts[c.id] ?? 0) === 0;
              return (
                <li key={c.id}>
                  <div
                    data-character-id={c.id}
                    className={`group/char relative w-full flex items-center gap-2 px-3 py-2 rounded-xl text-left transition-colors ${active ? '' : 'hover:bg-ink/3'} ${silent ? 'opacity-60' : ''}`}
                    style={
                      active
                        ? { background: cc.tint, boxShadow: `inset 0 0 0 1px ${cc.ring}` }
                        : undefined
                    }
                  >
                    {active && (
                      <span
                        className="absolute left-0 top-2 bottom-2 w-[3px] rounded-full"
                        style={{ background: cc.hex }}
                      />
                    )}
                    <button
                      onClick={() => setFilterChar(active ? null : c.id)}
                      className="flex-1 min-w-0 flex items-center gap-3 text-left"
                      title={active ? 'Clear filter' : 'Filter manuscript to this character'}
                    >
                      <ColorDot color={c.color as CharColor} size={10} />
                      <span className="flex-1 min-w-0">
                        <span
                          className={`block text-sm truncate ${active ? 'font-bold' : 'font-medium text-ink'}`}
                          style={active ? { color: cc.hex } : undefined}
                        >
                          {c.name}
                        </span>
                        <span className="block text-xs text-ink/50 truncate">{c.role}</span>
                      </span>
                      <span
                        className={`text-xs tabular-nums ${active ? 'font-semibold' : 'text-ink/50'}`}
                        style={active ? { color: cc.hex } : undefined}
                      >
                        {counts[c.id] || 0}
                      </span>
                    </button>
                    {onOpenProfile && (
                      <button
                        onClick={() => onOpenProfile(c.id)}
                        title={`Open ${c.name} profile`}
                        aria-label={`Open ${c.name} profile`}
                        className={`min-w-11 min-h-11 p-1.5 inline-flex items-center justify-center rounded-lg text-ink/40 hover:text-ink hover:bg-ink/5 transition-opacity ${active ? 'opacity-100' : 'opacity-0 group-hover/char:opacity-100 focus:opacity-100'}`}
                      >
                        <IconEye className="w-4 h-4" />
                      </button>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
          <button className="mt-4 w-full flex items-center justify-center gap-2 px-3 py-2 min-h-11 rounded-xl border border-dashed border-ink/20 text-sm text-ink/60 hover:border-peach hover:text-peach transition-colors">
            <IconPlus className="w-4 h-4" /> Add character
          </button>
          <hr className="my-5 border-ink/10" />
          <div className="text-xs text-ink/50 leading-relaxed space-y-2">
            <p>
              <span className="font-semibold text-ink/70">Move a boundary:</span> drag the line
              between paragraphs and drop onto any sentence.
            </p>
            <p>
              <span className="font-semibold text-ink/70">Reassign:</span> hover any paragraph and
              use the dropdown.
            </p>
            <p>
              <span className="font-semibold text-ink/70">Profile:</span> click a character's name
              to open their full profile.
            </p>
          </div>
        </div>
      </aside>
    </>
  );
}

/* ── Drawer (mobile/tablet chapter list)
   A simple fixed-position slide-out panel. Only renders below `lg:` per
   the container `lg:hidden` wrapper at the call site, but we also early-
   return when `open` is false so the (open) DOM cost is paid only when
   the user actually opens it. Closes on backdrop tap + on the close
   button + on Escape. */
function Drawer({
  open,
  onClose,
  title,
  side,
  children,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  side: 'left' | 'right';
  children: ReactNode;
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);
  if (!open) return null;
  const sideCls = side === 'left' ? 'left-0' : 'right-0';
  return (
    <div className="lg:hidden fixed inset-0 z-40" role="dialog" aria-modal="true" aria-label={title}>
      <div
        className="absolute inset-0 bg-ink/40"
        onClick={onClose}
        aria-hidden="true"
      />
      <div
        className={`absolute top-0 bottom-0 ${sideCls} w-[88%] max-w-[360px] bg-canvas shadow-card flex flex-col`}
      >
        <div className="shrink-0 flex items-center justify-between px-4 py-3 border-b border-ink/10">
          <h2 className="text-sm font-bold text-ink">{title}</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close drawer"
            className="min-w-11 min-h-11 inline-flex items-center justify-center rounded-full text-ink/60 hover:text-ink hover:bg-ink/5"
          >
            <IconClose className="w-5 h-5" />
          </button>
        </div>
        <div
          className="flex-1 min-h-0 overflow-y-auto scrollbar-thin p-3"
          style={{ ['--scrollbar-thin-radius' as string]: '0px' } as React.CSSProperties}
        >
          {children}
        </div>
      </div>
    </div>
  );
}

/* ── BottomSheet (mobile segment inspector)
   Rises from the bottom edge with a backdrop. Only used at `<md:` —
   tablet renders the inspector inline below prose, desktop renders it
   as a sticky aside. Capped at ~85vh so the user can still see context
   above the sheet. */
function BottomSheet({
  open,
  onClose,
  children,
}: {
  open: boolean;
  onClose: () => void;
  children: ReactNode;
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div
      className="md:hidden fixed inset-0 z-40"
      role="dialog"
      aria-modal="true"
      aria-label="Segment details"
    >
      <div
        className="absolute inset-0 bg-ink/40"
        onClick={onClose}
        aria-hidden="true"
      />
      <div className="absolute left-0 right-0 bottom-0 max-h-[85vh] flex flex-col">
        {/* Drag handle bar — purely visual cue that this is a sheet.
            No actual drag-to-dismiss yet; close via backdrop tap or
            the inspector's own close button. */}
        <div className="shrink-0 flex justify-center pt-2 pb-1 bg-white rounded-t-3xl">
          <span className="w-10 h-1 rounded-full bg-ink/20" />
        </div>
        <div className="flex-1 min-h-0 overflow-hidden bg-white">{children}</div>
      </div>
    </div>
  );
}

interface SegmentRowProps {
  seg: Segment;
  characters: Character[];
  priorRoster?: SeriesRosterEntry[];
  onAddFromSeriesRoster?: (entry: SeriesRosterEntry) => Promise<string>;
  selected: boolean;
  dimmed: boolean;
  drag: Drag | null;
  onSelect: () => void;
  onShowDetails: () => void;
  onReassignSegment: (newCharId: string) => void;
  onOpenProfile?: (id: string) => void;
  findChar: (id: string) => Character | undefined;
  liveInstruct: boolean;
}

function SegmentRow({
  seg,
  characters,
  priorRoster,
  onAddFromSeriesRoster,
  selected,
  dimmed,
  drag,
  onSelect,
  onShowDetails,
  onReassignSegment,
  onOpenProfile,
  findChar,
  liveInstruct,
}: SegmentRowProps) {
  const [hovered, setHovered] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const reassignBtnRef = useRef<HTMLButtonElement>(null);
  const char = findChar(seg.characterId);
  const c = CHAR_COLORS[char?.color as CharColor] ?? CHAR_COLORS.narrator;

  return (
    <div
      className={`group relative -mx-4 px-4 py-2 rounded-xl transition-all cursor-pointer ${dimmed ? 'opacity-40' : ''} ${selected ? 'ring-1 ring-peach/40' : 'hover:bg-ink/2'}`}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onClick={onSelect}
    >
      <span
        className="absolute left-0 top-2 bottom-2 w-[3px] rounded-full"
        style={{ background: c.hex }}
      />
      <span
        className="absolute inset-0 rounded-xl pointer-events-none"
        style={{ background: c.tint }}
      />
      <div className="relative">
        <div className="flex items-center gap-2 mb-1">
          {onOpenProfile && char ? (
            <button
              onClick={(e) => {
                e.stopPropagation();
                onOpenProfile(char.id);
              }}
              title={`Open ${char.name} profile`}
              className="text-[11px] uppercase tracking-wider font-semibold hover:underline underline-offset-2"
              style={{ color: c.hex }}
            >
              {char.name}
            </button>
          ) : (
            <span
              className="text-[11px] uppercase tracking-wider font-semibold"
              style={{ color: c.hex }}
            >
              {char?.name}
            </span>
          )}
          {seg.sentences.some((s) => s.confidence != null && s.confidence < 0.75) && (
            <Pill color="warning">Low confidence</Pill>
          )}
          <span
            className={`ml-auto flex items-center gap-1 transition-opacity ${hovered || selected ? 'opacity-100' : 'opacity-0'}`}
          >
            {/* Mobile-only "Details" pill — opens the inspector bottom
                sheet. Hidden on `md:` and up because tablet shows the
                inspector inline below the prose and desktop shows it
                as a sticky aside; in both cases tapping a segment
                already surfaces the inspector content. */}
            {selected && (
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  onShowDetails();
                }}
                className="md:hidden inline-flex items-center gap-1 px-3 min-h-11 py-1 rounded-md bg-peach text-ink text-xs font-semibold"
              >
                Details
              </button>
            )}
            <button
              ref={reassignBtnRef}
              onClick={(e) => {
                e.stopPropagation();
                setMenuOpen(!menuOpen);
              }}
              className="px-2 py-1 rounded-md bg-white border border-ink/10 text-[11px] font-medium text-ink/70 hover:text-ink hover:border-ink/30 inline-flex items-center gap-1"
            >
              Reassign <IconArrowDn className="w-3 h-3" />
            </button>
            {menuOpen && (
              <CharacterSearchPicker
                characters={characters}
                priorRoster={priorRoster}
                currentCharacterId={seg.characterId}
                onPick={(id) => onReassignSegment(id)}
                onAddFromSeriesRoster={onAddFromSeriesRoster}
                onClose={() => setMenuOpen(false)}
                anchorRef={reassignBtnRef}
                placement="bottom-end"
              />
            )}
          </span>
        </div>
        <div>
          {seg.sentences.map((s, i) => {
            const isCandidate = drag && drag.candidateSentenceIdx === s.absIdx;
            const isLast = i === seg.sentences.length - 1;
            return (
              <Fragment key={s.id}>
                <span
                  data-sentence-id={s.id}
                  data-sentence-idx={s.absIdx}
                  className={`inline transition-colors ${isCandidate ? 'sentence-candidate' : ''}`}
                  {...(s.absIdx === 0 ? { 'data-tour-id': 'manuscript-line' } : {})}
                >
                  {renderSentenceText(s.text)}
                </span>
                {/* fs-25 — per-quote emotion control. Shown for dialogue (the
                    common case) and for any already-tagged sentence, rendered
                    outside the text span so selection offsets are unaffected. */}
                {(seg.characterId !== 'narrator' || s.emotion) && (
                  <SentenceEmotionControl
                    chapterId={s.chapterId}
                    sentenceId={s.id}
                    emotion={s.emotion}
                    character={char}
                  />
                )}
                {/* fs-56 — per-line delivery-direction control, ungated (narrator included). */}
                <SentenceInstructControl
                  chapterId={s.chapterId}
                  sentenceId={s.id}
                  instruct={s.instruct}
                  character={char}
                  liveInstruct={liveInstruct}
                />
                {!isLast && ' '}
              </Fragment>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function BoundaryHandle({
  boundaryIdx,
  drag,
  onPointerDown,
}: {
  boundaryIdx: number;
  drag: Drag | null;
  /* Plan 81 wave 4 — PointerEvent (not MouseEvent) so touch + pen + mouse
     all flow through the same gesture. setPointerCapture in the parent
     keeps the gesture alive past the viewport edge on phones. */
  onPointerDown: (idx: number, e: React.PointerEvent) => void;
}) {
  const isThisDragging = drag?.boundaryIdx === boundaryIdx;
  return (
    <div className="relative h-4 -my-1 group">
      <span
        onPointerDown={(e) => onPointerDown(boundaryIdx, e)}
        /* `touch-action: none` so the browser doesn't intercept the
           gesture for scrolling — we own the drag end-to-end. */
        style={{ touchAction: 'none' }}
        className={`absolute left-0 right-0 top-1/2 -translate-y-1/2 h-3 cursor-ns-resize transition-colors ${isThisDragging ? 'bg-peach/40' : 'bg-transparent group-hover:bg-peach/40'}`}
        {...(boundaryIdx === 1 ? { 'data-tour-id': 'chapter-boundary' } : {})}
      />
      {/* Plan 81 wave 4 — `coarse:opacity-60` keeps the boundary-handle
          label faintly visible on touch devices that don't expose hover.
          `(pointer: coarse)` is the standard query. Wave 4 ships a
          `@media (pointer: coarse) { .... }` rule in styles.css to
          back this — see the hover-audit section there. */}
      <span
        className={`absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 px-2 py-0.5 rounded-full bg-white border text-[10px] font-medium uppercase tracking-wider transition-opacity pointer-events-none ${isThisDragging ? 'opacity-100 border-peach text-magenta pulse-ring' : 'opacity-0 group-hover:opacity-100 coarse-pointer:opacity-60 border-ink/15 text-ink/50'}`}
      >
        {isThisDragging ? 'drop on a sentence' : 'drag to move'}
      </span>
    </div>
  );
}

interface InspectorProps {
  seg: Segment | undefined;
  characters: Character[];
  priorRoster?: SeriesRosterEntry[];
  onAddFromSeriesRoster?: (entry: SeriesRosterEntry) => Promise<string>;
  findChar: (id: string) => Character | undefined;
  onClose: () => void;
  onReassignSegment: (seg: Segment, newCharId: string) => void;
  onReassignSentence: (chapterId: number, sentenceId: number, newCharId: string) => void;
  onOpenProfile?: (id: string) => void;
}

interface SentencePickerRowProps {
  sentence: Sentence;
  characters: Character[];
  priorRoster?: SeriesRosterEntry[];
  isOpen: boolean;
  onToggle: () => void;
  onClose: () => void;
  onPick: (newCharId: string) => void;
  onAddFromSeriesRoster?: (entry: SeriesRosterEntry) => Promise<string>;
}

/* Per-sentence reassign row inside the SegmentInspector. Extracted from
   the parent so each row carries its own anchor ref — the portalled
   CharacterSearchPicker positions itself off this ref. Map-of-refs at
   the parent was the alternative; this is simpler and avoids stale-ref
   bookkeeping when the sentence list re-orders after a split/merge. */
function SentencePickerRow({
  sentence,
  characters,
  priorRoster,
  isOpen,
  onToggle,
  onClose,
  onPick,
  onAddFromSeriesRoster,
}: SentencePickerRowProps) {
  const btnRef = useRef<HTMLButtonElement>(null);
  return (
    <li className="bg-canvas/60 rounded-xl p-3">
      <p className="text-xs text-ink/80 leading-snug line-clamp-3 font-serif">
        {renderSentenceText(sentence.text)}
      </p>
      <div className="mt-2">
        <button
          ref={btnRef}
          type="button"
          onClick={onToggle}
          className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-[11px] font-medium text-ink/70 bg-white border border-ink/10 hover:border-ink/30"
        >
          Reassign just this one
          <IconArrowDn className="w-3 h-3" />
        </button>
        {isOpen && (
          <CharacterSearchPicker
            characters={characters}
            priorRoster={priorRoster}
            currentCharacterId={sentence.characterId}
            onPick={onPick}
            onAddFromSeriesRoster={onAddFromSeriesRoster}
            onClose={onClose}
            anchorRef={btnRef}
            placement="bottom-start"
          />
        )}
      </div>
    </li>
  );
}

function SegmentInspector({
  seg,
  characters,
  priorRoster,
  onAddFromSeriesRoster,
  findChar,
  onClose,
  onReassignSegment,
  onReassignSentence,
  onOpenProfile,
}: InspectorProps) {
  /* Which per-sentence picker is open, if any. Single instance — closing
     one by picking auto-closes; opening another flips this state. */
  const [openSentencePicker, setOpenSentencePicker] = useState<number | null>(null);
  const [segmentPickerOpen, setSegmentPickerOpen] = useState(false);
  const segmentBtnRef = useRef<HTMLButtonElement>(null);
  if (!seg)
    return (
      <div className="bg-white rounded-3xl border border-dashed border-ink/15 p-6 text-sm text-ink/50">
        <p className="font-medium text-ink/70">Select a paragraph to inspect or reassign.</p>
        <p className="mt-2 leading-relaxed">
          Or <span className="font-medium text-ink/70">highlight any text</span> inside a sentence
          to split it off and assign that piece to a different character — useful when a dialogue
          tag got lumped in with the spoken line.
        </p>
      </div>
    );
  const c = findChar(seg.characterId);
  if (!c) return null;
  const cc = CHAR_COLORS[c.color as CharColor] ?? CHAR_COLORS.narrator;
  const minConf = Math.min(...seg.sentences.map((s) => s.confidence ?? 1));
  return (
    /* Inspector card — flex column bounded to viewport. Segment name +
       confidence stay pinned at the top, the long character / per-sentence
       lists scroll in the middle, the help text stays pinned at the bottom.
       Without this the 30-character "Reassign whole segment to" list spills
       past the viewport on large casts.
       At `<md:` the parent is a bottom-sheet (height capped at 85vh by the
       sheet); the inner max-h-[calc(100vh-100px)] still applies but the
       sheet shell wins, so the lists scroll inside the sheet body. */
    <div className="bg-white rounded-3xl md:border md:border-ink/10 md:shadow-card overflow-hidden flex flex-col max-h-[calc(100vh-100px)] h-full">
      <div className="shrink-0 p-5 pb-0 flex items-center gap-3">
        <span className="w-1 h-8 rounded-full" style={{ background: cc.hex }} />
        <div className="flex-1 min-w-0">
          <p className="text-[11px] uppercase tracking-wider text-ink/50 font-semibold">
            Selected segment
          </p>
          <h3 className="text-base font-bold text-ink truncate">{c.name}</h3>
        </div>
        {onOpenProfile && (
          <button
            onClick={() => onOpenProfile(c.id)}
            title={`Open ${c.name} profile`}
            aria-label={`Open ${c.name} profile`}
            className="inline-flex items-center gap-1.5 px-2.5 min-h-11 py-1.5 rounded-full text-[11px] font-semibold text-ink/70 hover:text-ink hover:bg-ink/5"
          >
            <IconEye className="w-3.5 h-3.5" /> Profile
          </button>
        )}
        <button
          onClick={onClose}
          aria-label="Close inspector"
          className="min-w-11 min-h-11 inline-flex items-center justify-center rounded-full hover:bg-ink/5 text-ink/60"
        >
          <IconClose className="w-4 h-4" />
        </button>
      </div>
      <div className="shrink-0 px-5 mt-4">
        <p className="text-[11px] uppercase tracking-wider text-ink/50 font-semibold mb-2">
          Confidence
        </p>
        <div className="flex items-center gap-3">
          <div className="flex-1 h-1.5 rounded-full bg-ink/10 overflow-hidden">
            <div
              className="h-full rounded-full"
              style={{
                width: `${minConf * 100}%`,
                background: minConf < 0.75 ? '#C58B2B' : cc.hex,
              }}
            />
          </div>
          <span className="text-sm font-semibold text-ink tabular-nums">
            {Math.round(minConf * 100)}%
          </span>
        </div>
      </div>
      <div className="flex-1 min-h-0 overflow-y-auto scrollbar-thin">
        <div className="px-5 mt-5">
          <p className="text-[11px] uppercase tracking-wider text-ink/50 font-semibold mb-2">
            Reassign whole segment to
          </p>
          <button
            ref={segmentBtnRef}
            type="button"
            onClick={() => setSegmentPickerOpen((v) => !v)}
            className="w-full flex items-center gap-3 px-3 py-2 min-h-11 rounded-xl text-left bg-canvas/60 border border-ink/10 hover:border-ink/30 transition-colors"
          >
            <ColorDot color={c.color as CharColor} />
            <span className="text-sm flex-1 truncate" style={{ color: cc.hex }}>
              {c.name}
            </span>
            <span className="text-[11px] text-ink/50">Change…</span>
          </button>
          {segmentPickerOpen && (
            <CharacterSearchPicker
              characters={characters}
              priorRoster={priorRoster}
              currentCharacterId={seg.characterId}
              onPick={(id) => onReassignSegment(seg, id)}
              onAddFromSeriesRoster={onAddFromSeriesRoster}
              onClose={() => setSegmentPickerOpen(false)}
              anchorRef={segmentBtnRef}
              placement="bottom-start"
              minWidth={320}
            />
          )}
        </div>
        {seg.sentences.length > 1 && (
          <div className="px-5 mt-5">
            <p className="text-[11px] uppercase tracking-wider text-ink/50 font-semibold mb-2">
              Per-sentence reassign
            </p>
            <ul className="space-y-2">
              {seg.sentences.map((s) => (
                <SentencePickerRow
                  key={s.id}
                  sentence={s}
                  characters={characters}
                  priorRoster={priorRoster}
                  isOpen={openSentencePicker === s.id}
                  onToggle={() =>
                    setOpenSentencePicker((curr) => (curr === s.id ? null : s.id))
                  }
                  onClose={() => setOpenSentencePicker(null)}
                  onPick={(id) => onReassignSentence(s.chapterId, s.id, id)}
                  onAddFromSeriesRoster={onAddFromSeriesRoster}
                />
              ))}
            </ul>
          </div>
        )}
        <div className="h-5" />
      </div>
      <div className="shrink-0 p-5 border-t border-ink/10 text-xs text-ink/50 leading-relaxed space-y-1">
        <p>
          <span className="font-semibold text-ink/70">Highlight text</span> inside any sentence to
          split it and assign that piece elsewhere.
        </p>
        <p>
          <span className="font-semibold text-ink/70">Drag a boundary</span> onto a sentence to move
          the whole-paragraph cut.
        </p>
      </div>
    </div>
  );
}

/* ── Sentence text rendering ───────────────────────────────────────────────
   fs-25 retired the legacy inline audio-tag chip system (`[shouting]` etc.) in
   favour of the structured `Sentence.emotion` field — per-quote expressiveness
   is now an emotion chip, not bracketed text. Stored `sentence.text` is kept
   clean (seeded into `emotion` + stripped at analysis-cache write and by the
   one-time migration), so the text renders as a single span. The span still
   carries `data-text-offset={0}` so the selection→split hook can reconstruct
   sentence-relative offsets. */

function renderSentenceText(text: string) {
  if (!text) return null;
  return <span data-text-offset={0}>{text}</span>;
}

/* ── Selection-based split popover ─────────────────────────────────────── */

interface SelectionInfo {
  sentenceId: number;
  start: number;
  end: number;
  rect: DOMRect;
}

/* Walks up from a Range endpoint to the nearest span carrying
   `data-text-offset` and adds the in-node offset, giving the position
   relative to the full `sentence.text` string. */
function sentenceOffsetFromRangePoint(node: Node, offsetInNode: number): number | null {
  const partEl = (
    node.nodeType === Node.TEXT_NODE ? node.parentElement : (node as HTMLElement)
  )?.closest('[data-text-offset]') as HTMLElement | null;
  if (!partEl) return null;
  const base = Number(partEl.dataset.textOffset);
  if (!Number.isFinite(base)) return null;
  return base + offsetInNode;
}

function useSentenceSelection(containerRef: RefObject<HTMLElement | null>): SelectionInfo | null {
  const [sel, setSel] = useState<SelectionInfo | null>(null);
  useEffect(() => {
    const handler = () => {
      const s = window.getSelection();
      if (!s || s.isCollapsed || s.rangeCount === 0) {
        setSel(null);
        return;
      }
      const range = s.getRangeAt(0);
      const startParent =
        range.startContainer.nodeType === Node.TEXT_NODE
          ? range.startContainer.parentElement
          : (range.startContainer as HTMLElement);
      const endParent =
        range.endContainer.nodeType === Node.TEXT_NODE
          ? range.endContainer.parentElement
          : (range.endContainer as HTMLElement);
      const startEl = startParent?.closest('[data-sentence-id]') as HTMLElement | null;
      const endEl = endParent?.closest('[data-sentence-id]') as HTMLElement | null;
      if (!startEl || startEl !== endEl) {
        setSel(null);
        return;
      }
      if (containerRef.current && !containerRef.current.contains(startEl)) {
        setSel(null);
        return;
      }
      const sentenceId = Number(startEl.getAttribute('data-sentence-id'));
      if (!Number.isFinite(sentenceId)) {
        setSel(null);
        return;
      }
      const start = sentenceOffsetFromRangePoint(range.startContainer, range.startOffset);
      const end = sentenceOffsetFromRangePoint(range.endContainer, range.endOffset);
      if (start == null || end == null || start === end) {
        setSel(null);
        return;
      }
      const rect = range.getBoundingClientRect();
      setSel({ sentenceId, start: Math.min(start, end), end: Math.max(start, end), rect });
    };
    document.addEventListener('selectionchange', handler);
    return () => document.removeEventListener('selectionchange', handler);
  }, [containerRef]);
  return sel;
}

interface SelectionPopoverProps {
  sel: SelectionInfo | null;
  characters: Character[];
  onAssign: (characterId: string) => void;
}

function SelectionPopover({ sel, characters, onAssign }: SelectionPopoverProps) {
  if (!sel) return null;
  const top = sel.rect.top - 8;
  const left = sel.rect.left + sel.rect.width / 2;
  return (
    <div
      style={{ position: 'fixed', top, left, transform: 'translate(-50%, -100%)', zIndex: 60 }}
      className="bg-white rounded-2xl border border-ink/10 shadow-card p-2 min-w-[200px]"
      /* preventDefault on mousedown keeps the text selection alive until
            we read it inside onAssign. */
      onMouseDown={(e) => e.preventDefault()}
    >
      <p className="text-[11px] uppercase tracking-wider text-ink/50 font-semibold px-2 pt-1">
        Assign selection to
      </p>
      {/* Smaller-radius parent (rounded-2xl = 16px) — override the
          scrollbar-thin utility's default 24px bottom-corner clip-path. */}
      <div
        className="flex flex-col gap-0.5 mt-1 max-h-64 overflow-y-auto scrollbar-thin"
        style={{ ['--scrollbar-thin-radius' as string]: '16px' } as React.CSSProperties}
      >
        {characters.map((c) => (
          <button
            key={c.id}
            onMouseDown={(e) => {
              e.preventDefault();
              onAssign(c.id);
            }}
            className="flex items-center gap-2 px-3 py-1.5 rounded-lg hover:bg-ink/4 text-left"
          >
            <ColorDot color={c.color as CharColor} />
            <span className="text-sm text-ink">{c.name}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
