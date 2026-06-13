/* Continue-listening rail — horizontal shelf of in-progress books.
 *
 * Purely presentational: receives items and an `onOpen` callback from the
 * parent view. The parent (E2) is responsible for fetching and dispatching
 * into the continueListening slice. This component only renders.
 *
 * Renders nothing when items is empty so the parent can mount it
 * unconditionally without needing its own guard. */

import { IconPlay } from '../../lib/icons';
import { formatDuration } from '../../lib/time';
import type { ContinueItem } from '../../store/continue-listening-slice';

interface Props {
  items: ContinueItem[];
  onOpen: (bookId: string, chapterId: number) => void;
}

export function ContinueListeningRail({ items, onOpen }: Props) {
  if (items.length === 0) return null;

  return (
    <section aria-label="Continue listening">
      <h2 className="font-serif text-xl font-bold text-ink mb-4">Continue listening</h2>
      {/* Horizontal scrollable row; snap-x for a native feel on touch */}
      <div className="flex gap-4 overflow-x-auto pb-2 snap-x snap-mandatory">
        {items.map((item) => (
          <ContinueCard key={item.bookId} item={item} onOpen={onOpen} />
        ))}
      </div>
    </section>
  );
}

function ContinueCard({
  item,
  onOpen,
}: {
  item: ContinueItem;
  onOpen: (bookId: string, chapterId: number) => void;
}) {
  const pct = Math.min(1, Math.max(0, item.completionPct));
  const remaining = formatDuration(item.remainingSec);

  return (
    <button
      type="button"
      onClick={() => onOpen(item.bookId, item.chapterId)}
      aria-label={`Continue listening to ${item.title}`}
      className="group flex-shrink-0 w-48 snap-start rounded-2xl border border-ink/10 bg-white shadow-card hover:shadow-float hover:border-ink/20 transition-all text-left overflow-hidden min-h-[44px] sm:min-h-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-peach"
    >
      {/* Cover area — gradient placeholder matching BookCard's visual language */}
      <div className="aspect-16/10 relative bg-gradient-to-br from-peach/60 to-magenta/40 overflow-hidden">
        {/* Decorative rings, same motif as BookCard */}
        <svg viewBox="0 0 192 120" className="absolute inset-0 w-full h-full opacity-20">
          <circle cx="40" cy="60" r="55" fill="none" stroke="white" strokeWidth="0.5" />
          <circle cx="40" cy="60" r="38" fill="none" stroke="white" strokeWidth="0.5" />
          <circle cx="40" cy="60" r="22" fill="none" stroke="white" strokeWidth="0.5" />
        </svg>

        {/* Play badge */}
        <span className="absolute bottom-2 right-2 w-7 h-7 rounded-full bg-white/20 group-hover:bg-white/35 transition-colors grid place-items-center">
          <IconPlay className="w-3.5 h-3.5 text-white" />
        </span>
      </div>

      {/* Text + progress */}
      <div className="p-3">
        <p className="text-[13px] font-semibold text-ink leading-snug line-clamp-2 mb-1">
          {item.title}
        </p>
        <p className="text-[11px] text-ink/55 mb-2">
          Ch {item.chapterId} · {remaining} left
        </p>

        {/* Thin progress bar */}
        <div className="h-1 rounded-full bg-ink/10 overflow-hidden">
          <div
            className="h-full bg-peach rounded-full"
            style={{ width: `${pct * 100}%` }}
          />
        </div>
      </div>
    </button>
  );
}
