/* Plan 55 — per-chapter revision history modal.

   Read-only view over the timeline entries the revisions slice records on
   every accept/reject. Displays entries reverse-chronologically with event
   kind, timestamp, and (where relevant) the character whose revision was
   processed. No rollback button in v1.3.0: plan 20's accept/reject path
   consumes the `.previous.*` chain so direct rollback of a committed
   decision is not possible without snapshot-per-entry (parked for v1.4.0).

   The modal is openable from the revision-diff player header ("History"
   button next to Close), so when the user is actively reviewing a pending
   revision they can see past decisions on the same chapter. The same
   component can later be mounted from the Listen-view per-chapter row
   (BACKLOG follow-up — Plan 55 v1.3.0 keeps the revision-diff entry
   point only). */

import { useMemo } from 'react';
import { useAppSelector } from '../store';
import { IconClose, IconCheck, IconReject, IconArrowLeft } from '../lib/icons';
import type { TimelineEntry, Character } from '../lib/types';

interface Props {
  chapterId: number | null;
  /** Title rendered in the modal header. When the modal opens from a
      specific chapter's context (e.g. revision-diff player), pass that
      chapter's title so the user knows which scope they're viewing. */
  chapterTitle?: string;
  characters: Character[];
  onClose: () => void;
}

const KIND_LABEL: Record<TimelineEntry['eventKind'], string> = {
  accepted: 'Accepted revision',
  rejected: 'Rejected revision',
  'rolled-back': 'Rolled back',
};

const KIND_TONE: Record<TimelineEntry['eventKind'], string> = {
  accepted: 'text-emerald-700 dark:text-emerald-300',
  rejected: 'text-rose-700 dark:text-rose-300',
  'rolled-back': 'text-amber-700 dark:text-amber-300',
};

function KindIcon({ kind }: { kind: TimelineEntry['eventKind'] }) {
  if (kind === 'accepted') return <IconCheck className="h-4 w-4" aria-hidden />;
  if (kind === 'rejected') return <IconReject className="h-4 w-4" aria-hidden />;
  return <IconArrowLeft className="h-4 w-4" aria-hidden />;
}

export function RevisionTimelineModal({
  chapterId,
  chapterTitle,
  characters,
  onClose,
}: Props) {
  const timeline = useAppSelector((s) => s.revisions.timeline);

  const entries = useMemo<TimelineEntry[]>(() => {
    if (chapterId == null) {
      // Cross-chapter view — flatten and sort by timestamp.
      const all: TimelineEntry[] = [];
      for (const list of Object.values(timeline)) all.push(...list);
      return all.slice().sort(byTimestampDesc);
    }
    return (timeline[chapterId] ?? []).slice().sort(byTimestampDesc);
  }, [timeline, chapterId]);

  const charById = useMemo<Map<string, Character>>(
    () => new Map(characters.map((c) => [c.id, c])),
    [characters],
  );

  return (
    <div
      className="fixed inset-0 z-60 flex items-start justify-center bg-black/40 backdrop-blur-xs"
      role="dialog"
      aria-modal="true"
      aria-label="Revision history"
      data-testid="revision-timeline-modal"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className="mt-16 max-h-[80vh] w-[min(640px,90vw)] overflow-y-auto scrollbar-thin rounded-xl bg-white p-6 shadow-2xl dark:bg-slate-900"
        style={{ ['--scrollbar-thin-radius' as string]: '12px' } as React.CSSProperties}
      >
        <header className="mb-4 flex items-start justify-between gap-4">
          <div>
            <h2 className="text-lg font-semibold text-slate-900 dark:text-slate-100">
              Revision history
            </h2>
            <p className="text-sm text-slate-600 dark:text-slate-400">
              {chapterTitle ? `Chapter — ${chapterTitle}` : 'All chapters'}
            </p>
          </div>
          <button
            type="button"
            className="rounded p-1 text-slate-500 hover:bg-slate-100 hover:text-slate-900 dark:hover:bg-slate-800 dark:hover:text-slate-100"
            onClick={onClose}
            aria-label="Close revision history"
            data-testid="revision-timeline-close"
          >
            <IconClose className="h-5 w-5" aria-hidden />
          </button>
        </header>

        {entries.length === 0 ? (
          <p
            className="rounded-md bg-slate-50 p-4 text-sm text-slate-600 dark:bg-slate-800 dark:text-slate-300"
            data-testid="revision-timeline-empty"
          >
            No accept or reject decisions recorded yet. Decisions appear here
            once you accept or reject a pending revision.
          </p>
        ) : (
          <ol className="space-y-3" data-testid="revision-timeline-list">
            {entries.map((e) => {
              const character = e.characterId ? charById.get(e.characterId) : undefined;
              const isStale = e.status === 'rolled-back-from';
              return (
                <li
                  key={`${e.chapterId}-${e.id}`}
                  className={[
                    'flex items-start gap-3 rounded-md border p-3',
                    isStale
                      ? 'border-slate-200 bg-slate-50/50 text-slate-400 line-through dark:border-slate-700 dark:bg-slate-800/50'
                      : 'border-slate-200 bg-white dark:border-slate-700 dark:bg-slate-900',
                  ].join(' ')}
                  data-testid={`revision-timeline-entry-${e.id}`}
                >
                  <span
                    className={[
                      'mt-0.5 inline-flex h-7 w-7 flex-none items-center justify-center rounded-full',
                      isStale ? 'bg-slate-200 text-slate-500 dark:bg-slate-700' : 'bg-slate-100 dark:bg-slate-800',
                      isStale ? '' : KIND_TONE[e.eventKind],
                    ].join(' ')}
                  >
                    <KindIcon kind={e.eventKind} />
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-baseline gap-x-2">
                      <span className={['text-sm font-medium', isStale ? '' : KIND_TONE[e.eventKind]].join(' ')}>
                        {KIND_LABEL[e.eventKind]}
                      </span>
                      {character && (
                        <span className="text-sm text-slate-700 dark:text-slate-300">
                          — {character.name}
                        </span>
                      )}
                      {chapterId == null && (
                        <span className="text-xs text-slate-500 dark:text-slate-400">
                          (chapter {e.chapterId})
                        </span>
                      )}
                    </div>
                    <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
                      {formatTimestamp(e.timestamp)}
                    </p>
                  </div>
                </li>
              );
            })}
          </ol>
        )}

        <footer className="mt-4 text-xs text-slate-500 dark:text-slate-400">
          Read-only in this release. Multi-step rollback ships in a later
          version — for now, decisions are committed via Accept / Reject in
          the A/B player.
        </footer>
      </div>
    </div>
  );
}

function byTimestampDesc(a: TimelineEntry, b: TimelineEntry): number {
  return b.timestamp.localeCompare(a.timestamp);
}

function formatTimestamp(iso: string): string {
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    return d.toLocaleString(undefined, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    });
  } catch {
    return iso;
  }
}
