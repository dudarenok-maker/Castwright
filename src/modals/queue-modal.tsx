/* Plan 102 — global queue modal.
 *
 * Mounted in Layout; renders nothing when `ui.queueModalOpen` is false.
 * Lists every workspace queue entry grouped by book, with per-row
 * Move-up / Move-down / Cancel actions and a queue-global Resume / Pause
 * control at the top. The in-flight entry is pinned at the top of its book
 * group and the reorder pills are hidden on it.
 *
 * Responsive per CLAUDE.md mobile protocol:
 *   - phone (`<640px`)  → full-screen sheet
 *   - tablet/desktop     → dialog centered on screen
 *
 * The reorder UI is tap-pill only for v1 (Move up / Move down buttons).
 * Drag-to-reorder lives in a follow-up (BACKLOG) — tap pills satisfy the
 * touch-equivalence rule for desktop AND mobile in one path, keeping the
 * shipped modal small. Touch targets are ≥44×44 px per WCAG 2.5.5. */

import { useMemo, useEffect, useState, type JSX } from 'react';
import { useAppDispatch, useAppSelector } from '../store';
import {
  selectActiveGenerationView,
  selectInFlightEntryIds,
  selectQueueByBook,
  selectQueueCount,
  selectQueueLoaded,
  selectQueuePaused,
  type ActiveGenerationView,
  type QueueEntry,
  type TtsEngine,
} from '../store/queue-slice';
import {
  cancelQueueEntry,
  clearQueue,
  confirmFallbackEntry,
  loadQueue,
  reorderQueue,
  retryQueueEntry,
  setQueuePaused,
  skipFallbackEntry,
} from '../store/queue-thunks';
import { chaptersActions } from '../store/chapters-slice';
import { uiActions } from '../store/ui-slice';
import { IconClose, IconDrag, IconPause, IconPlay, IconRefresh, IconTrash } from '../lib/icons';
import { PrimaryButton } from '../components/primitives';
import { ConfirmDialog } from './confirm-dialog';

interface QueueModalProps {
  open: boolean;
  onClose: () => void;
}

/* Plan 108 Wave 3 — human-readable engine names for the per-row badge. */
const ENGINE_LABELS: Record<TtsEngine, string> = {
  kokoro: 'Kokoro',
  qwen: 'Qwen',
  coqui: 'Coqui XTTS',
  gemini: 'Gemini',
  piper: 'Piper',
};

function engineLabel(engine: TtsEngine): string {
  return ENGINE_LABELS[engine] ?? engine;
}

export function QueueModal({ open, onClose }: QueueModalProps) {
  const dispatch = useAppDispatch();
  const groupedByBook = useAppSelector(selectQueueByBook);
  const paused = useAppSelector(selectQueuePaused);
  const loaded = useAppSelector(selectQueueLoaded);
  const count = useAppSelector(selectQueueCount);
  /* ALL in-flight entry ids — under queue-sole concurrency multiple chapters
     run at once, so every in_progress row renders "In flight" and is
     non-draggable / non-cancellable (a running entry 409s on DELETE). */
  const inFlightIds = useAppSelector(selectInFlightEntryIds);
  /* Read-side honesty — when the workspace queue is empty but a generation
     stream is live (the reconcile-driven first-run / resume path writes no
     queue entry), show that run instead of a misleading "Empty". `null` when
     there ARE real entries or no stream is running. */
  const activeView = useAppSelector(selectActiveGenerationView);
  const bookTitles = useAppSelector((s) => s.library.books);
  /* Plan 108 Wave 3 — when a multi-TTS chapter is queued but the user hasn't
     opted into keeping both engines resident, the row shows the same advisory
     the generation flow emits (enable dual-model mode in Account settings to
     avoid engine-swap latency). */
  const dualModelEnabled = useAppSelector((s) => s.account?.dualModelEnabled ?? false);

  /* "Clear queue" confirm-dialog state. `alsoStop` mirrors the dialog's
     "Also stop generation in progress" checkbox. */
  const [confirmClear, setConfirmClear] = useState(false);
  const [alsoStop, setAlsoStop] = useState(false);

  /* Refresh the queue snapshot whenever the modal opens — covers the
     cross-tab case where another tab mutated the queue while ours was
     closed. Cheap call (one /api/queue GET). */
  useEffect(() => {
    if (open) {
      dispatch(loadQueue()).catch((e: unknown) => {
        console.warn('[queue-modal] loadQueue failed', e);
      });
    }
  }, [open, dispatch]);

  const lookupBookTitle = useMemo(() => {
    const map = new Map<string, string>();
    for (const b of bookTitles) map.set(b.bookId, b.title);
    return (bookId: string): string => map.get(bookId) ?? bookId;
  }, [bookTitles]);

  if (!open) return null;

  const togglePause = (): void => {
    dispatch(setQueuePaused(!paused)).catch((e: unknown) => {
      console.warn('[queue-modal] setPaused failed', e);
    });
  };

  /* True when a generation stream is live — either real in_progress entries or
     the read-side-honesty overlay (a run with no queue entries behind it). The
     "Also stop generation" option is only meaningful then. */
  const hasLiveGeneration = inFlightIds.size > 0 || activeView != null;
  /* The Clear button is offered whenever there's something to clear OR a live
     run to stop — the latter covers the "0 entries · generating in the
     background" state where there's otherwise no way to stop it. */
  const canClear = count > 0 || hasLiveGeneration;

  const openClearConfirm = (): void => {
    setAlsoStop(false);
    setConfirmClear(true);
  };
  const handleClear = (): void => {
    /* No pending entries → the only action is stopping the live run (force).
       Pending entries → force only when the user opted to also stop. */
    const stop = count === 0 || alsoStop;
    if (stop && hasLiveGeneration) dispatch(chaptersActions.requestStreamHalt());
    dispatch(clearQueue({ force: stop })).catch((e: unknown) => {
      console.warn('[queue-modal] clearQueue failed', e);
    });
    setConfirmClear(false);
    setAlsoStop(false);
  };

  return (
    <>
      <div
        onClick={onClose}
        className="fixed inset-0 bg-ink/40 z-50 fade-in"
        data-testid="queue-modal-backdrop"
      />
      <div
        className="fixed inset-0 z-50 grid sm:place-items-center sm:p-6 pointer-events-none"
        role="dialog"
        aria-modal="true"
        aria-label="Generation queue"
      >
        <div className="bg-white sm:rounded-3xl shadow-float w-full h-full sm:h-auto sm:max-w-2xl sm:max-h-[90vh] pointer-events-auto fade-in flex flex-col">
          {/* Header */}
          <div className="px-6 py-4 border-b border-ink/10 flex items-center gap-3 sticky top-0 bg-white/95 backdrop-blur-md">
            <div className="flex-1 min-w-0">
              <p className="text-[10px] uppercase tracking-widest text-ink/50 font-semibold">
                Generation queue
              </p>
              <h3 className="text-base font-bold text-ink">
                {count > 0
                  ? `${count} ${count === 1 ? 'entry' : 'entries'} pending`
                  : activeView
                    ? 'Generating…'
                    : 'Empty'}
              </h3>
            </div>
            {canClear && (
              <button
                onClick={openClearConfirm}
                className="inline-flex items-center gap-1.5 px-3 py-2 rounded-full bg-ink/5 hover:bg-red-50 hover:text-red-700 text-sm font-medium text-ink min-h-[44px] sm:min-h-0"
                data-testid="queue-modal-clear"
              >
                <IconTrash className="w-4 h-4" /> Clear queue
              </button>
            )}
            {count > 0 && (
              <button
                onClick={togglePause}
                className="inline-flex items-center gap-1.5 px-3 py-2 rounded-full bg-ink/5 hover:bg-ink/10 text-sm font-medium text-ink min-h-[44px] sm:min-h-0"
                data-testid="queue-modal-pause"
              >
                {paused ? (
                  <>
                    <IconPlay className="w-4 h-4" /> Resume
                  </>
                ) : (
                  <>
                    <IconPause className="w-4 h-4" /> Pause
                  </>
                )}
              </button>
            )}
            <button
              onClick={onClose}
              className="p-2 rounded-full hover:bg-ink/5 text-ink/60 min-h-[44px] min-w-[44px] sm:min-h-0 sm:min-w-0"
              aria-label="Close queue"
            >
              <IconClose className="w-4 h-4" />
            </button>
          </div>

          {/* Body */}
          <div className="px-6 py-5 flex-1 overflow-y-auto scrollbar-thin">
            {!loaded ? (
              <p className="text-sm text-ink/60">Loading queue…</p>
            ) : count === 0 && activeView ? (
              <ActiveGenerationSection
                view={activeView}
                title={lookupBookTitle(activeView.bookId)}
              />
            ) : count === 0 ? (
              <div className="py-10 text-center">
                <p className="text-sm text-ink/60">No chapters queued.</p>
                <p className="text-xs text-ink/40 mt-1">
                  Click "Add to queue" on any chapter to start.
                </p>
              </div>
            ) : (
              <div className="space-y-6">
                {groupedByBook.map(({ bookId, entries }) => (
                  <BookGroup
                    key={bookId}
                    title={lookupBookTitle(bookId)}
                    entries={entries}
                    inFlightIds={inFlightIds}
                    dualModelEnabled={dualModelEnabled}
                    onReorder={(newOrderForGroup) => {
                      /* Reorder within the GROUP requires building the full
                         workspace-level order: this group's new order, then any
                         other book's entries in their existing order, MINUS
                         every in-flight entry (the server's reorder() excludes
                         all in_progress rows from the reorderable list). */
                      const orderable = groupedByBook
                        .flatMap((g) => (g.bookId === bookId ? newOrderForGroup : g.entries))
                        .filter((e) => !inFlightIds.has(e.id))
                        .map((e) => e.id);
                      dispatch(reorderQueue(orderable)).catch((e: unknown) => {
                        console.warn('[queue-modal] reorder failed', e);
                      });
                    }}
                    onCancel={(entryId) => {
                      dispatch(cancelQueueEntry(entryId)).catch(() => {
                        /* Toast surfaced inside the thunk's 409 handler. */
                      });
                    }}
                    onForceRemove={(entryId) => {
                      /* Force-drop a stuck in_progress entry (orphaned after a
                         reload — the dispatcher won't reconcile or re-claim it).
                         No 409 path: force bypasses the in_progress guard. */
                      dispatch(cancelQueueEntry(entryId, { force: true })).catch(() => {});
                    }}
                    onRetry={(entryId) => {
                      /* Re-queue a FAILED entry — status → queued, so the
                         dispatcher re-claims it and re-runs the chapter. */
                      dispatch(retryQueueEntry(entryId)).catch(() => {});
                    }}
                    onConfirmFallback={(entryId) => {
                      /* Loud-fallback gate: render this parked chapter anyway
                         (in Kokoro). awaiting_confirm → queued + confirmed; the
                         dispatcher re-claims it and the worker renders through. */
                      dispatch(confirmFallbackEntry(entryId)).catch(() => {});
                    }}
                    onSkipFallback={(entryId) => {
                      /* Loud-fallback gate: skip this parked chapter rather than
                         render undesigned voices in Kokoro. awaiting_confirm →
                         removed. */
                      dispatch(skipFallbackEntry(entryId)).catch(() => {});
                    }}
                  />
                ))}
              </div>
            )}
          </div>
        </div>
      </div>

      <ConfirmDialog
        open={confirmClear}
        eyebrow="Queue"
        variant="danger"
        icon={<IconTrash className="w-4 h-4" />}
        title="Clear queue"
        confirmLabel="Clear queue"
        onConfirm={handleClear}
        onClose={() => setConfirmClear(false)}
        body={
          <div className="space-y-3">
            <p>
              {count > 0
                ? `Remove all ${count} pending ${count === 1 ? 'entry' : 'entries'} from the queue?`
                : 'Stop the generation running in the background?'}
            </p>
            {count > 0 && hasLiveGeneration && (
              <label className="flex items-center gap-2 text-sm text-ink/75 cursor-pointer">
                <input
                  type="checkbox"
                  checked={alsoStop}
                  onChange={(e) => setAlsoStop(e.target.checked)}
                  data-testid="queue-clear-also-stop"
                  className="w-4 h-4 rounded border-ink/30 text-magenta focus:ring-magenta"
                />
                Also stop generation in progress
              </label>
            )}
          </div>
        }
      />
    </>
  );
}

/* Read-side honesty section — shown when the workspace queue holds no real
   entries but a generation stream is live. The rows are SYNTHETIC (derived
   from chapters.activeStream + the viewed book's chapter rows), so they carry
   NO reorder / cancel / drag controls — there's nothing on the server to
   mutate. Same-book streams list the in-flight + queued chapters; a cross-book
   stream (slice holds a different book) shows only the done/total summary. */
function ActiveGenerationSection({ view, title }: { view: ActiveGenerationView; title: string }) {
  return (
    <section data-testid="queue-modal-active-generation">
      <h4 className="text-xs uppercase tracking-widest text-ink/50 font-semibold mb-2">{title}</h4>
      <p className="text-xs text-ink/50 mb-2">
        Generating · {view.done}/{view.total} chapters
        <span className="text-ink/35"> · not in the queue</span>
      </p>
      {view.chapters && view.chapters.length > 0 ? (
        <ul className="space-y-1.5">
          {view.chapters.map((row) => (
            <li
              key={row.id}
              data-testid={`queue-active-chapter-${row.id}`}
              className={`flex items-center gap-2 px-3 py-2 rounded-2xl border ${
                row.state === 'in_progress'
                  ? 'border-magenta/40 bg-magenta/5'
                  : 'border-ink/10 bg-white'
              }`}
            >
              <div className="flex-1 min-w-0">
                <div className="text-sm font-medium text-ink truncate">Chapter {row.id}</div>
                <div className="text-xs text-ink/50">
                  {row.state === 'in_progress' ? 'Generating' : 'Queued'}
                </div>
              </div>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-xs text-ink/40">
          Generation is running for this book in the background.
        </p>
      )}
    </section>
  );
}

interface BookGroupProps {
  title: string;
  entries: QueueEntry[];
  inFlightIds: Set<string>;
  dualModelEnabled: boolean;
  onReorder: (entries: QueueEntry[]) => void;
  onCancel: (entryId: string) => void;
  onForceRemove: (entryId: string) => void;
  onRetry: (entryId: string) => void;
  onConfirmFallback: (entryId: string) => void;
  onSkipFallback: (entryId: string) => void;
}

function BookGroup({
  title,
  entries,
  inFlightIds,
  dualModelEnabled,
  onReorder,
  onCancel,
  onForceRemove,
  onRetry,
  onConfirmFallback,
  onSkipFallback,
}: BookGroupProps) {
  const moveUp = (idx: number): void => {
    if (idx <= 0) return;
    const next = [...entries];
    [next[idx - 1], next[idx]] = [next[idx], next[idx - 1]];
    onReorder(next);
  };
  const moveDown = (idx: number): void => {
    if (idx >= entries.length - 1) return;
    const next = [...entries];
    [next[idx], next[idx + 1]] = [next[idx + 1], next[idx]];
    onReorder(next);
  };

  /* Plan 102 polish — desktop drag-to-reorder.
     Pointer-events based for browser breadth; the handle is hidden via
     `hidden sm:flex` on coarse-pointer devices so touch users continue to
     rely on the Move up / Move down pills.

     Drag model: pointerdown on the ⋮⋮ handle captures the dragged entry
     id; window-level pointermove tracks which row the pointer is over
     (via [data-entry-id] on each li); pointerup commits the reorder by
     splicing the dragged entry into the drop target's slot in the
     group's order, then bubbling the new order via onReorder. */
  const [drag, setDrag] = useState<{ fromId: string; overId: string | null } | null>(null);

  useEffect(() => {
    if (!drag) return;
    const onMove = (e: globalThis.PointerEvent): void => {
      const el = document.elementFromPoint(e.clientX, e.clientY) as HTMLElement | null;
      const rowEl = el?.closest?.('[data-entry-id]') as HTMLElement | null;
      const id = rowEl?.dataset.entryId ?? null;
      /* Skip self-hover and any in-flight (pinned) row — none is a
         valid drop target. */
      const valid = id != null && id !== drag.fromId && !inFlightIds.has(id);
      setDrag((d) =>
        d && d.overId !== (valid ? id : null) ? { ...d, overId: valid ? id : null } : d,
      );
    };
    const onUp = (): void => {
      setDrag((d) => {
        if (d && d.overId) {
          const fromIdx = entries.findIndex((e) => e.id === d.fromId);
          const toIdx = entries.findIndex((e) => e.id === d.overId);
          if (fromIdx !== -1 && toIdx !== -1 && fromIdx !== toIdx) {
            const next = [...entries];
            const [moved] = next.splice(fromIdx, 1);
            next.splice(toIdx, 0, moved);
            onReorder(next);
          }
        }
        return null;
      });
      document.body.classList.remove('dragging-queue-entry');
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
    };
    /* `entries` + `inFlightIds` are captured at drag-start time intentionally —
       reordering during an in-flight drag is rare and would require resync;
       eslint exhaustive-deps would force a re-subscribe on every queue mutation. */
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [drag?.fromId]);

  const onDragStart =
    (fromId: string) =>
    (e: React.PointerEvent<HTMLButtonElement>): void => {
      e.preventDefault();
      setDrag({ fromId, overId: null });
      document.body.classList.add('dragging-queue-entry');
      try {
        (e.target as Element).setPointerCapture?.(e.pointerId);
      } catch {
        /* Older browsers may throw on capture — fall through. */
      }
    };

  return (
    <section>
      <h4 className="text-xs uppercase tracking-widest text-ink/50 font-semibold mb-2">{title}</h4>
      <ul className="space-y-1.5" data-testid={`queue-modal-group-${title}`}>
        {entries.map((entry, idx) => {
          const isInFlight = inFlightIds.has(entry.id);
          return (
            <li
              key={entry.id}
              data-testid={`queue-entry-${entry.id}`}
              data-entry-id={entry.id}
              className={`flex items-center gap-2 px-3 py-2 rounded-2xl border transition-colors ${
                isInFlight
                  ? 'border-magenta/40 bg-magenta/5'
                  : drag?.overId === entry.id
                    ? 'border-magenta/60 bg-magenta/10'
                    : drag?.fromId === entry.id
                      ? 'border-ink/10 bg-white opacity-40'
                      : 'border-ink/10 bg-white'
              }`}
            >
              {!isInFlight && (
                /* Desktop-only drag handle — hidden on touch so users
                   fall back to the Move up / Move down pills (which work
                   on every viewport per the CLAUDE.md touch-equivalence
                   rule). Cursor reflects drag state for clarity. */
                <button
                  type="button"
                  onPointerDown={onDragStart(entry.id)}
                  aria-label="Drag to reorder"
                  data-testid={`queue-entry-${entry.id}-drag`}
                  className="hidden sm:flex items-center justify-center text-ink/30 hover:text-ink/60 cursor-grab active:cursor-grabbing touch-none p-1 -ml-1"
                >
                  <IconDrag className="w-4 h-4" />
                </button>
              )}
              <div className="flex-1 min-w-0">
                <div className="text-sm font-medium text-ink truncate">
                  Chapter {entry.chapterId}
                  {entry.characterId ? ` · ${entry.characterId}` : ''}
                </div>
                <div
                  className={`text-xs ${
                    entry.status === 'awaiting_confirm' ? 'text-magenta' : 'text-ink/50'
                  }`}
                  data-testid={`queue-entry-${entry.id}-status`}
                >
                  {isInFlight
                    ? `In flight${entry.progress != null ? ` · ${Math.round(entry.progress * 100)}%` : ''}`
                    : entry.status === 'failed'
                      ? `Failed${entry.errorReason ? ` · ${entry.errorReason}` : ''}`
                      : entry.status === 'awaiting_confirm'
                        ? `Needs confirmation · no designed Qwen voice for ${
                            (entry.fallbackCharacters ?? [])
                              .map((c) => c.name ?? c.id)
                              .join(', ') || 'some characters'
                          } → would render in Kokoro`
                        : entry.status === 'paused'
                          ? 'Paused'
                          : 'Queued'}
                </div>
                {/* Plan 108 Wave 3 — name the TTS engine(s) this chapter needs.
                    Single: "Kokoro"; multi: "Kokoro + Qwen". Absent on legacy /
                    unresolved entries (no badge rather than a misleading one). */}
                {entry.requiredEngines && entry.requiredEngines.length > 0 && (
                  <div className="mt-1 flex flex-wrap items-center gap-1">
                    <span
                      className={`inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-semibold ${
                        entry.multiTts ? 'bg-magenta/10 text-magenta' : 'bg-ink/5 text-ink/60'
                      }`}
                      data-testid={`queue-entry-${entry.id}-engines`}
                    >
                      {entry.requiredEngines.map(engineLabel).join(' + ')}
                    </span>
                  </div>
                )}
                {/* Multi-TTS + dual-model OFF → same advisory the generation
                    flow surfaces: enabling dual-model mode avoids engine-swap
                    latency. Subtle, non-blocking. */}
                {entry.multiTts && !dualModelEnabled && (
                  <p
                    className="mt-1 text-[10px] leading-tight text-ink/45"
                    data-testid={`queue-entry-${entry.id}-dual-model-warning`}
                  >
                    Mixes TTS engines. Turn on "Keep both TTS engines loaded" in Account settings to
                    avoid engine-swap latency.
                  </p>
                )}
              </div>
              {entry.status === 'awaiting_confirm' && (
                /* Loud-fallback gate: this chapter is parked because a Qwen
                   character has no designed voice. "Render anyway" confirms the
                   Kokoro fallback (→ queued); "Skip" drops the chapter. */
                <>
                  <button
                    onClick={() => onConfirmFallback(entry.id)}
                    aria-label="Render anyway in Kokoro"
                    title="Render anyway (Kokoro fallback)"
                    className="px-2 py-1 rounded-full text-xs font-semibold bg-magenta/10 text-magenta hover:bg-magenta/20 min-h-[44px] sm:min-h-0"
                    data-testid={`queue-entry-${entry.id}-confirm-fallback`}
                  >
                    Render anyway
                  </button>
                  <button
                    onClick={() => onSkipFallback(entry.id)}
                    aria-label="Skip this chapter"
                    title="Skip this chapter"
                    className="px-2 py-1 rounded-full text-xs font-semibold bg-ink/5 text-ink/60 hover:bg-ink/10 min-h-[44px] sm:min-h-0"
                    data-testid={`queue-entry-${entry.id}-skip-fallback`}
                  >
                    Skip
                  </button>
                </>
              )}
              {!isInFlight && entry.status === 'failed' && (
                /* Failed entries linger in the queue (not done-pruned) so the
                   user can re-run the chapter without re-navigating. Retry
                   flips the entry back to `queued`; the dispatcher re-claims
                   it. The cancel/trash control below still removes it. */
                <button
                  onClick={() => onRetry(entry.id)}
                  aria-label="Retry entry"
                  title="Retry"
                  className="p-2 rounded-full hover:bg-magenta/10 text-ink/60 hover:text-magenta min-h-[44px] min-w-[44px] sm:min-h-0 sm:min-w-0"
                  data-testid={`queue-entry-${entry.id}-retry`}
                >
                  <IconRefresh className="w-4 h-4" />
                </button>
              )}
              {!isInFlight && (
                <>
                  <button
                    onClick={() => moveUp(idx)}
                    disabled={idx === 0}
                    aria-label="Move up"
                    className="p-2 rounded-full hover:bg-ink/5 text-ink/60 disabled:opacity-30 disabled:cursor-not-allowed min-h-[44px] min-w-[44px] sm:min-h-0 sm:min-w-0"
                    data-testid={`queue-entry-${entry.id}-up`}
                  >
                    ↑
                  </button>
                  <button
                    onClick={() => moveDown(idx)}
                    disabled={idx === entries.length - 1}
                    aria-label="Move down"
                    className="p-2 rounded-full hover:bg-ink/5 text-ink/60 disabled:opacity-30 disabled:cursor-not-allowed min-h-[44px] min-w-[44px] sm:min-h-0 sm:min-w-0"
                    data-testid={`queue-entry-${entry.id}-down`}
                  >
                    ↓
                  </button>
                  <button
                    onClick={() => onCancel(entry.id)}
                    aria-label="Cancel entry"
                    className="p-2 rounded-full hover:bg-red-50 text-ink/60 hover:text-red-700 min-h-[44px] min-w-[44px] sm:min-h-0 sm:min-w-0"
                    data-testid={`queue-entry-${entry.id}-cancel`}
                  >
                    <IconTrash className="w-4 h-4" />
                  </button>
                </>
              )}
              {isInFlight && (
                /* In-flight rows normally carry no controls (you Pause then
                   cancel). But a stuck in_progress entry — orphaned after a
                   reload, so the dispatcher neither reconciles nor re-claims it
                   — can ONLY be cleared with a force-remove. Always offer it so
                   the queue can't wedge. */
                <button
                  onClick={() => onForceRemove(entry.id)}
                  aria-label="Remove stuck entry"
                  title="Remove stuck entry"
                  className="p-2 rounded-full hover:bg-red-50 text-ink/60 hover:text-red-700 min-h-[44px] min-w-[44px] sm:min-h-0 sm:min-w-0"
                  data-testid={`queue-entry-${entry.id}-force-remove`}
                >
                  <IconTrash className="w-4 h-4" />
                </button>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/** Convenience component that wires the modal to ui-slice state — mount this
    directly in Layout instead of QueueModal so callers don't have to plumb
    open/onClose. */
export function QueueModalContainer(): JSX.Element {
  const dispatch = useAppDispatch();
  const open = useAppSelector((s) => s.ui.queueModalOpen);
  return <QueueModal open={open} onClose={() => dispatch(uiActions.closeQueueModal())} />;
}

/* Re-export from primitives for direct consumers; unused here but the
   modal's "View queue" CTA in callers may want a typed button. */
export { PrimaryButton };
