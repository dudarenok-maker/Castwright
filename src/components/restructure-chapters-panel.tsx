/* Chapter restructure panel (plan 51).

   Three operations: merge contiguous chapters, split a chapter at a
   sentence boundary, drag-reorder. Each operation flows through a
   confirm dialog and then a single POST to the matching route. After
   the response, the parent re-fetches book state to refresh the chapter
   list + applies the sentence remap to the manuscript slice.

   Drag uses @dnd-kit with BOTH PointerSensor and KeyboardSensor so
   keyboard users can grab a row with Space and shuffle it with arrows.
   Multi-select uses native checkboxes; the merge button only enables
   when the selected ids are contiguous in current order. Split mounts
   a per-row sentence list (collapsed by default) with a "Split here"
   button per sentence boundary.

   The same component drives both the full-page restructure view
   (entry from listen header) and a modal launched from confirm-cast.
   The two consumers differ only in their wrapper chrome; the panel
   itself is layout-neutral. */

import { useMemo, useState, useCallback } from 'react';
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core';
import {
  SortableContext,
  arrayMove,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { IconDrag, IconChevR, IconClose } from '../lib/icons';
import type { Chapter, Sentence } from '../lib/types';

export interface RestructurePanelProps {
  chapters: Chapter[];
  sentences: Sentence[];
  /** Called when the user confirms a merge operation. */
  onMerge: (chapterIds: number[]) => Promise<void> | void;
  /** Called when the user confirms a split. */
  onSplit: (chapterId: number, afterSentenceId: number) => Promise<void> | void;
  /** Called when the user confirms a reorder. `order` is the array of
      CURRENT chapter ids in their new desired order. */
  onReorder: (order: number[]) => Promise<void> | void;
  /** Called when the user toggles a single chapter's excluded flag
      (plan 70b). One-row at a time — bulk-exclude-via-selection lives
      in the toolbar separately. */
  onExclude?: (chapterId: number, excluded: boolean) => Promise<void> | void;
  /** Called when the user clicks "Refresh chapter names" (plan 70b).
      Triggers re-parse of the source manuscript + first-line promotion
      pass for any chapter still carrying a generic auto-title. */
  onRefreshTitles?: () => Promise<void> | void;
  /** Plan 78 — called when the user clicks the Rename button on a
      chapter row. The consuming view mounts the EditChapterTitleModal
      and re-fetches book state on save. Optional for back-compat with
      mounts that don't yet support rename. */
  onRename?: (chapter: Chapter) => void;
  /** Optional back action — when omitted the back button is hidden
      (e.g. when mounted in a modal that has its own close). */
  onBack?: () => void;
  /** Loading state — disables interactions during an in-flight apply. */
  busy?: boolean;
}

interface SortableChapterRowProps {
  chapter: Chapter;
  position: number;
  sentenceCount: number;
  firstExcerpt: string | null;
  lastExcerpt: string | null;
  selected: boolean;
  expanded: boolean;
  selectable: boolean;
  busy: boolean;
  onToggleSelect: () => void;
  onToggleExpand: () => void;
  chapterSentences: Sentence[];
  onSplitHere: (afterSentenceId: number) => void;
  /** Plan 70b — per-row exclude toggle. Omitted when the consumer
      didn't wire `onExclude` (back-compat with pre-70b mounts). */
  onToggleExcluded?: () => void;
  /** Plan 78 — opens the rename modal for this chapter. Panel-level
      modal mount; row only knows "open rename for me". */
  onRename?: () => void;
}

function SortableChapterRow({
  chapter,
  position,
  sentenceCount,
  firstExcerpt,
  lastExcerpt,
  selected,
  expanded,
  selectable,
  busy,
  onToggleSelect,
  onToggleExpand,
  chapterSentences,
  onSplitHere,
  onToggleExcluded,
  onRename,
}: SortableChapterRowProps) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } =
    useSortable({ id: chapter.id });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.6 : 1,
  };

  const isExcluded = chapter.excluded === true;

  return (
    <li
      ref={setNodeRef}
      style={style}
      data-testid={`restructure-row-${chapter.id}`}
      data-excluded={isExcluded ? 'true' : 'false'}
      className={`bg-white border border-ink/10 rounded-2xl px-4 py-3 flex flex-col gap-2 ${selected ? 'ring-2 ring-magenta/60' : ''} ${isExcluded ? 'opacity-60' : ''}`}
    >
      <div className="flex items-center gap-3">
        <button
          type="button"
          {...attributes}
          {...listeners}
          aria-label={`Reorder chapter ${chapter.title}`}
          disabled={busy}
          className="flex items-center justify-center w-8 h-8 rounded-lg text-ink/40 hover:text-ink/80 hover:bg-ink/5 cursor-grab disabled:cursor-not-allowed"
        >
          <IconDrag className="w-4 h-4" />
        </button>
        <span
          className="w-8 text-center text-xs font-semibold tabular-nums text-ink/60"
          data-testid={`restructure-position-${chapter.id}`}
        >
          {position}
        </span>
        <input
          type="checkbox"
          aria-label={`Select chapter ${chapter.title} for merge`}
          checked={selected}
          disabled={busy || !selectable || isExcluded}
          onChange={onToggleSelect}
          className="w-4 h-4 accent-magenta cursor-pointer disabled:cursor-not-allowed"
          data-testid={`restructure-check-${chapter.id}`}
        />
        <div className="flex-1 min-w-0">
          <div
            className={`text-sm font-semibold text-ink truncate ${isExcluded ? 'line-through' : ''}`}
          >
            {chapter.title}
          </div>
          <div className="text-xs text-ink/55 truncate">
            {sentenceCount} sentence{sentenceCount === 1 ? '' : 's'}
            {chapter.duration ? ` · ${chapter.duration}` : ''}
            {isExcluded ? ' · excluded' : ''}
          </div>
          {firstExcerpt && (
            <div className="text-xs text-ink/50 mt-1 line-clamp-1">
              <span className="text-ink/40">↦ </span>
              {firstExcerpt}
            </div>
          )}
          {lastExcerpt && lastExcerpt !== firstExcerpt && (
            <div className="text-xs text-ink/40 line-clamp-1">
              <span className="text-ink/30">… </span>
              {lastExcerpt}
            </div>
          )}
        </div>
        {onRename && (
          <button
            type="button"
            onClick={onRename}
            disabled={busy}
            className="px-2.5 py-1 rounded-full border border-ink/15 bg-white text-xs font-medium text-ink/70 hover:text-ink hover:border-ink/30 disabled:opacity-40 disabled:cursor-not-allowed"
            data-testid={`chapter-row-${chapter.id}-rename`}
            aria-label={`Rename chapter ${chapter.id}`}
            title="Edit chapter title"
          >
            Rename
          </button>
        )}
        {onToggleExcluded && (
          <button
            type="button"
            onClick={onToggleExcluded}
            disabled={busy}
            className="px-2.5 py-1 rounded-full border border-ink/15 bg-white text-xs font-medium text-ink/70 hover:text-ink hover:border-ink/30 disabled:opacity-40 disabled:cursor-not-allowed"
            data-testid={`restructure-exclude-${chapter.id}`}
            title={isExcluded ? 'Include this chapter in generation' : 'Exclude from generation'}
          >
            {isExcluded ? 'Include' : 'Exclude'}
          </button>
        )}
        <button
          type="button"
          onClick={onToggleExpand}
          disabled={busy || sentenceCount < 2}
          className="px-2.5 py-1 rounded-full border border-ink/15 bg-white text-xs font-medium text-ink/70 hover:text-ink hover:border-ink/30 disabled:opacity-40 disabled:cursor-not-allowed"
          data-testid={`restructure-split-toggle-${chapter.id}`}
        >
          <span className="inline-flex items-center gap-1">
            <IconChevR className={`w-3 h-3 transition-transform ${expanded ? 'rotate-90' : ''}`} />
            Split here…
          </span>
        </button>
      </div>
      {expanded && chapterSentences.length >= 2 && (
        <div
          className="border-t border-ink/5 pt-2 mt-1 flex flex-col gap-1"
          data-testid={`restructure-sentences-${chapter.id}`}
        >
          <div className="text-xs text-ink/55 mb-1">
            Pick the sentence to split after — sentences before stay in this chapter, the rest move
            to a new one.
          </div>
          {chapterSentences.slice(0, chapterSentences.length - 1).map((s) => (
            <div key={s.id} className="flex items-center gap-2 text-xs">
              <span className="w-6 text-ink/40 tabular-nums">{s.id}.</span>
              <span className="flex-1 truncate text-ink/70">{s.text}</span>
              <button
                type="button"
                onClick={() => onSplitHere(s.id)}
                disabled={busy}
                className="px-2 py-0.5 rounded border border-ink/15 bg-white text-[11px] font-medium text-ink/70 hover:text-magenta hover:border-magenta/40 disabled:opacity-40"
                data-testid={`restructure-split-after-${chapter.id}-${s.id}`}
              >
                Split after
              </button>
            </div>
          ))}
        </div>
      )}
    </li>
  );
}

interface PendingOp {
  kind: 'merge' | 'split' | 'reorder';
  description: string;
  apply: () => Promise<void> | void;
}

export function RestructureChaptersPanel({
  chapters,
  sentences,
  onMerge,
  onSplit,
  onReorder,
  onExclude,
  onRefreshTitles,
  onRename,
  onBack,
  busy = false,
}: RestructurePanelProps) {
  /* Drag-reorder works against a local copy so the user can stage changes
     without firing per-drag API calls. Apply commits the new order; Cancel
     reverts. The chapters prop is the source of truth — we re-seed whenever
     it changes (after a successful merge / split / reorder resolves). */
  const [draftOrder, setDraftOrder] = useState<Chapter[]>(chapters);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const [pending, setPending] = useState<PendingOp | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Re-seed draft when chapters change identity (after an apply).
  useMemo(() => {
    setDraftOrder(chapters);
    setSelected(new Set());
    setExpanded(new Set());
  }, [chapters]);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  // Group sentences by chapter for excerpt + count + split lookup.
  const sentencesByChapter = useMemo(() => {
    const map = new Map<number, Sentence[]>();
    for (const s of sentences) {
      let bucket = map.get(s.chapterId);
      if (!bucket) {
        bucket = [];
        map.set(s.chapterId, bucket);
      }
      bucket.push(s);
    }
    for (const bucket of map.values()) bucket.sort((a, b) => a.id - b.id);
    return map;
  }, [sentences]);

  const orderChanged = useMemo(() => {
    if (draftOrder.length !== chapters.length) return true;
    return draftOrder.some((c, i) => c.id !== chapters[i].id);
  }, [draftOrder, chapters]);

  const selectedContiguous = useMemo(() => {
    if (selected.size < 2) return false;
    // Look up positions in the CURRENT (not drafted) chapter list.
    const positions = [...selected]
      .map((id) => chapters.findIndex((c) => c.id === id))
      .filter((i) => i >= 0)
      .sort((a, b) => a - b);
    if (positions.length !== selected.size) return false;
    for (let i = 1; i < positions.length; i++) {
      if (positions[i] !== positions[i - 1] + 1) return false;
    }
    return true;
  }, [selected, chapters]);

  const handleDragEnd = useCallback((event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    setDraftOrder((current) => {
      const fromIdx = current.findIndex((c) => c.id === active.id);
      const toIdx = current.findIndex((c) => c.id === over.id);
      if (fromIdx < 0 || toIdx < 0) return current;
      return arrayMove(current, fromIdx, toIdx);
    });
  }, []);

  const toggleSelect = useCallback((id: number) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const toggleExpand = useCallback((id: number) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const handleMergeClick = useCallback(() => {
    if (!selectedContiguous) return;
    const ids = [...selected].sort((a, b) => {
      const ai = chapters.findIndex((c) => c.id === a);
      const bi = chapters.findIndex((c) => c.id === b);
      return ai - bi;
    });
    const titles = ids.map((id) => chapters.find((c) => c.id === id)?.title).join(', ');
    setPending({
      kind: 'merge',
      description: `Merge ${ids.length} chapters (${titles}) into one. Audio for the merged chapter will be deleted; you will need to regenerate it before listening. Chapters below will be renumbered; their audio is preserved.`,
      apply: async () => {
        await onMerge(ids);
      },
    });
  }, [selected, selectedContiguous, chapters, onMerge]);

  const handleReorderClick = useCallback(() => {
    if (!orderChanged) return;
    setPending({
      kind: 'reorder',
      description: `Reorder ${draftOrder.length} chapters. All chapters' audio is preserved (files renamed in place); no regeneration needed.`,
      apply: async () => {
        await onReorder(draftOrder.map((c) => c.id));
      },
    });
  }, [draftOrder, orderChanged, onReorder]);

  const handleToggleExcluded = useCallback(
    (chapterId: number) => {
      if (!onExclude) return;
      const ch = chapters.find((c) => c.id === chapterId);
      if (!ch) return;
      // No confirm modal — exclude is reversible (Include flips back),
      // matches the soft-hide invariant from the Generate view.
      void onExclude(chapterId, !ch.excluded);
    },
    [chapters, onExclude],
  );

  const handleRefreshTitlesClick = useCallback(() => {
    if (!onRefreshTitles) return;
    setPending({
      kind: 'merge', // confirm UI is generic — reusing the modal
      description:
        'Refresh chapter names? Auto-generated "Chapter N" titles will be re-derived from the source manuscript, and chapters whose first line looks like a name will adopt it. User-customised titles are preserved.',
      apply: async () => {
        await onRefreshTitles();
      },
    });
  }, [onRefreshTitles]);

  const handleSplit = useCallback(
    (chapterId: number, afterSentenceId: number) => {
      const ch = chapters.find((c) => c.id === chapterId);
      setPending({
        kind: 'split',
        description: `Split "${ch?.title ?? `chapter ${chapterId}`}" after sentence ${afterSentenceId}. Audio for both halves will be deleted; you will need to regenerate them. Chapters below will be renumbered; their audio is preserved.`,
        apply: async () => {
          await onSplit(chapterId, afterSentenceId);
        },
      });
    },
    [chapters, onSplit],
  );

  const confirmPending = useCallback(async () => {
    if (!pending) return;
    setError(null);
    try {
      await pending.apply();
      setPending(null);
    } catch (e) {
      setError((e as Error).message || 'Operation failed.');
    }
  }, [pending]);

  const cancelPending = useCallback(() => {
    setPending(null);
    setError(null);
  }, []);

  const cancelSelection = useCallback(() => {
    setSelected(new Set());
  }, []);

  const cancelReorder = useCallback(() => {
    setDraftOrder(chapters);
  }, [chapters]);

  return (
    <div className="flex flex-col gap-4" data-testid="restructure-panel">
      <div
        className="sticky top-16 z-30 -mx-4 px-4 py-2 bg-canvas/95 backdrop-blur-sm border-b border-ink/10 flex items-center gap-2 flex-wrap"
        data-testid="restructure-toolbar"
      >
        {onBack && (
          <button
            type="button"
            onClick={onBack}
            className="px-3 py-1.5 rounded-full border border-ink/15 bg-white text-xs font-medium text-ink/70 hover:text-ink"
          >
            Back
          </button>
        )}
        <button
          type="button"
          onClick={handleMergeClick}
          disabled={busy || !selectedContiguous}
          title={
            selected.size < 2
              ? 'Select 2 or more chapters'
              : !selectedContiguous
                ? 'Selected chapters must be contiguous'
                : 'Merge selected'
          }
          className="px-3 py-1.5 rounded-full bg-magenta text-white text-xs font-medium hover:opacity-90 disabled:opacity-40 disabled:cursor-not-allowed"
          data-testid="restructure-merge-button"
        >
          Merge selected ({selected.size})
        </button>
        {selected.size > 0 && (
          <button
            type="button"
            onClick={cancelSelection}
            disabled={busy}
            className="px-3 py-1.5 rounded-full border border-ink/15 bg-white text-xs font-medium text-ink/70 hover:text-ink"
            data-testid="restructure-cancel-selection"
          >
            Cancel selection
          </button>
        )}
        {onRefreshTitles && (
          <button
            type="button"
            onClick={handleRefreshTitlesClick}
            disabled={busy}
            className="ml-auto px-3 py-1.5 rounded-full border border-ink/15 bg-white text-xs font-medium text-ink/70 hover:text-ink disabled:opacity-40"
            data-testid="restructure-refresh-titles"
            title="Re-derive chapter names from the source manuscript"
          >
            Refresh chapter names
          </button>
        )}
        {orderChanged && (
          <>
            <button
              type="button"
              onClick={handleReorderClick}
              disabled={busy}
              className="px-3 py-1.5 rounded-full bg-ink text-canvas text-xs font-medium hover:opacity-90 disabled:opacity-40"
              data-testid="restructure-apply-reorder"
            >
              Apply reorder
            </button>
            <button
              type="button"
              onClick={cancelReorder}
              disabled={busy}
              className="px-3 py-1.5 rounded-full border border-ink/15 bg-white text-xs font-medium text-ink/70 hover:text-ink"
              data-testid="restructure-cancel-reorder"
            >
              Cancel reorder
            </button>
          </>
        )}
      </div>

      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
        <SortableContext items={draftOrder.map((c) => c.id)} strategy={verticalListSortingStrategy}>
          <ul className="flex flex-col gap-2" data-testid="restructure-list">
            {draftOrder.map((chapter, idx) => {
              const chapterSentences = sentencesByChapter.get(chapter.id) ?? [];
              const firstExcerpt = chapterSentences[0]?.text ?? null;
              const lastExcerpt =
                chapterSentences[chapterSentences.length - 1]?.text ?? null;
              return (
                <SortableChapterRow
                  key={chapter.id}
                  chapter={chapter}
                  position={idx + 1}
                  sentenceCount={chapterSentences.length}
                  firstExcerpt={firstExcerpt}
                  lastExcerpt={lastExcerpt}
                  selected={selected.has(chapter.id)}
                  expanded={expanded.has(chapter.id)}
                  selectable={!busy}
                  busy={busy}
                  onToggleSelect={() => toggleSelect(chapter.id)}
                  onToggleExpand={() => toggleExpand(chapter.id)}
                  chapterSentences={chapterSentences}
                  onSplitHere={(sid) => handleSplit(chapter.id, sid)}
                  onToggleExcluded={
                    onExclude ? () => handleToggleExcluded(chapter.id) : undefined
                  }
                  onRename={onRename ? () => onRename(chapter) : undefined}
                />
              );
            })}
          </ul>
        </SortableContext>
      </DndContext>

      {pending && (
        <div
          className="fixed inset-0 bg-ink/40 z-50 flex items-center justify-center p-4"
          data-testid="restructure-confirm"
        >
          <div className="bg-white rounded-2xl max-w-lg w-full p-5 shadow-card">
            <div className="flex items-start gap-2">
              <div className="flex-1">
                <div className="text-sm font-semibold text-ink mb-2">
                  Confirm chapter {pending.kind}
                </div>
                <p className="text-sm text-ink/70">{pending.description}</p>
                {error && (
                  <div className="mt-3 text-xs text-magenta bg-magenta/5 rounded-lg px-3 py-2">
                    {error}
                  </div>
                )}
              </div>
              <button
                type="button"
                onClick={cancelPending}
                aria-label="Close"
                className="text-ink/40 hover:text-ink"
              >
                <IconClose className="w-4 h-4" />
              </button>
            </div>
            <div className="mt-4 flex justify-end gap-2">
              <button
                type="button"
                onClick={cancelPending}
                disabled={busy}
                className="px-3 py-1.5 rounded-full border border-ink/15 bg-white text-xs font-medium text-ink/70 hover:text-ink"
                data-testid="restructure-confirm-cancel"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={confirmPending}
                disabled={busy}
                className="px-3 py-1.5 rounded-full bg-magenta text-white text-xs font-medium hover:opacity-90 disabled:opacity-40"
                data-testid="restructure-confirm-apply"
              >
                Apply
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
