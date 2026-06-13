/* Continue-listening rail — horizontal shelf of in-progress books.
 *
 * Purely presentational: receives items, a cover lookup, and callbacks from the
 * parent view (book-library.tsx). The parent fetches + dispatches into the
 * continueListening slice and owns the finish/hide side effects; this component
 * only renders and signals intent.
 *
 * Renders nothing when items is empty so the parent can mount it
 * unconditionally without needing its own guard. */

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { IconPlay, IconMore, IconCheck, IconClose } from '../../lib/icons';
import { formatDuration } from '../../lib/time';
import type { ContinueItem } from '../../store/continue-listening-slice';

interface Props {
  items: ContinueItem[];
  onOpen: (bookId: string, chapterId: number) => void;
  /** bookId → cover image URL (from the library slice). Missing ⇒ gradient. */
  covers?: Record<string, string | undefined>;
  /** fs-15 — "Mark as finished" (sticky, counts in stats). */
  onFinish: (bookId: string) => void;
  /** fs-15 — "Hide from shelf" (un-hides on next resume). */
  onHide: (bookId: string) => void;
}

export function ContinueListeningRail({ items, onOpen, covers, onFinish, onHide }: Props) {
  if (items.length === 0) return null;

  return (
    <section aria-label="Continue listening">
      <h2 className="font-serif text-xl font-bold text-ink mb-4">Continue listening</h2>
      {/* Horizontal scrollable row; snap-x for a native feel on touch. The
          theme-aware .scrollbar-thin replaces the default OS scrollbar; we
          neutralise its rounded clip-path (meant for in-card scroll regions)
          so it can't clip the cards' hover shadow / focus ring. */}
      <div
        className="flex gap-4 overflow-x-auto pb-2 snap-x snap-mandatory scrollbar-thin"
        style={
          {
            ['--scrollbar-thin-radius']: '0px',
            clipPath: 'none',
          } as React.CSSProperties
        }
      >
        {items.map((item) => (
          <ContinueCard
            key={item.bookId}
            item={item}
            cover={covers?.[item.bookId]}
            onOpen={onOpen}
            onFinish={onFinish}
            onHide={onHide}
          />
        ))}
      </div>
    </section>
  );
}

function ContinueCard({
  item,
  cover,
  onOpen,
  onFinish,
  onHide,
}: {
  item: ContinueItem;
  cover?: string;
  onOpen: (bookId: string, chapterId: number) => void;
  onFinish: (bookId: string) => void;
  onHide: (bookId: string) => void;
}) {
  const pct = Math.min(1, Math.max(0, item.completionPct));
  const remaining = formatDuration(item.remainingSec);
  const [imgError, setImgError] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const menuBtnRef = useRef<HTMLButtonElement>(null);
  const showCover = !!cover && !imgError;

  return (
    <div className="group relative flex-shrink-0 w-48 snap-start">
      <button
        type="button"
        onClick={() => onOpen(item.bookId, item.chapterId)}
        aria-label={`Continue listening to ${item.title}`}
        className="block w-full rounded-2xl border border-ink/10 bg-white shadow-card hover:shadow-float hover:border-ink/20 transition-all text-left overflow-hidden focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-peach"
      >
        {/* Cover area — real cover when available, else the gradient placeholder
            matching BookCard's visual language. */}
        <div className="aspect-16/10 relative bg-gradient-to-br from-peach/60 to-magenta/40 overflow-hidden">
          {showCover ? (
            <img
              src={cover}
              alt=""
              loading="lazy"
              onError={() => setImgError(true)}
              className="absolute inset-0 w-full h-full object-cover"
            />
          ) : (
            /* Decorative rings, same motif as BookCard */
            <svg viewBox="0 0 192 120" className="absolute inset-0 w-full h-full opacity-20">
              <circle cx="40" cy="60" r="55" fill="none" stroke="white" strokeWidth="0.5" />
              <circle cx="40" cy="60" r="38" fill="none" stroke="white" strokeWidth="0.5" />
              <circle cx="40" cy="60" r="22" fill="none" stroke="white" strokeWidth="0.5" />
            </svg>
          )}

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
            <div className="h-full bg-peach rounded-full" style={{ width: `${pct * 100}%` }} />
          </div>
        </div>
      </button>

      {/* Overflow menu — sibling of the main button (not nested) so it isn't
          clipped by the card's overflow-hidden, and so we don't nest buttons.
          Faintly visible on touch; revealed on hover/focus on pointer devices. */}
      <button
        ref={menuBtnRef}
        type="button"
        aria-label="Continue-listening options"
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        onClick={(e) => {
          e.stopPropagation();
          setMenuOpen((o) => !o);
        }}
        className="absolute top-1.5 right-1.5 grid place-items-center min-h-[44px] min-w-[44px] sm:min-h-[32px] sm:min-w-[32px] rounded-full bg-ink/40 hover:bg-ink/60 text-white opacity-0 group-hover:opacity-100 coarse-pointer:opacity-70 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-peach transition-opacity"
      >
        <IconMore className="w-4 h-4" />
      </button>

      {menuOpen && (
        <CardMenu
          anchorRef={menuBtnRef}
          title={item.title}
          onClose={() => setMenuOpen(false)}
          onFinish={() => {
            onFinish(item.bookId);
            setMenuOpen(false);
          }}
          onHide={() => {
            onHide(item.bookId);
            setMenuOpen(false);
          }}
        />
      )}
    </div>
  );
}

const MENU_WIDTH = 184;
const MENU_HEIGHT = 96;
const VIEWPORT_MARGIN = 8;

/* Portal-anchored menu. The rail lives in an `overflow-x-auto` strip and each
   card is `overflow-hidden`, so an in-flow dropdown would be clipped twice over
   — mirror the status-popover / searchable-picker pattern: portal to
   document.body, position via the anchor's getBoundingClientRect, track
   scroll/resize, dismiss on Escape / outside-click. */
function CardMenu({
  anchorRef,
  title,
  onClose,
  onFinish,
  onHide,
}: {
  anchorRef: React.RefObject<HTMLButtonElement | null>;
  title: string;
  onClose: () => void;
  onFinish: () => void;
  onHide: () => void;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);

  useLayoutEffect(() => {
    function compute() {
      const el = anchorRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      const spillsBelow = rect.bottom + MENU_HEIGHT > window.innerHeight - VIEWPORT_MARGIN;
      const top = spillsBelow
        ? Math.max(VIEWPORT_MARGIN, rect.top - MENU_HEIGHT - 4)
        : rect.bottom + 4;
      let left = rect.right - MENU_WIDTH; // right-align to the ⋯ button
      left = Math.min(Math.max(VIEWPORT_MARGIN, left), window.innerWidth - MENU_WIDTH - VIEWPORT_MARGIN);
      setPos({ top, left });
    }
    compute();
    window.addEventListener('scroll', compute, true);
    window.addEventListener('resize', compute);
    return () => {
      window.removeEventListener('scroll', compute, true);
      window.removeEventListener('resize', compute);
    };
  }, [anchorRef]);

  useEffect(() => {
    function onDown(e: MouseEvent) {
      const t = e.target as Node;
      if (panelRef.current?.contains(t)) return;
      if (anchorRef.current?.contains(t)) return; // let the ⋯ button toggle
      onClose();
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [anchorRef, onClose]);

  if (typeof document === 'undefined') return null;

  return createPortal(
    <div
      ref={panelRef}
      role="menu"
      tabIndex={-1}
      aria-label={`Options for ${title}`}
      className="fixed z-50 bg-white border border-ink/15 rounded-xl shadow-float py-1 fade-in"
      style={{
        top: pos?.top ?? 0,
        left: pos?.left ?? 0,
        width: MENU_WIDTH,
        visibility: pos ? 'visible' : 'hidden',
      }}
      onMouseDown={(e) => e.stopPropagation()}
    >
      <button
        type="button"
        role="menuitem"
        onClick={onFinish}
        className="flex w-full items-center gap-2 px-3 py-2 min-h-[44px] sm:min-h-0 text-left text-sm text-ink hover:bg-ink/5 focus-visible:outline-none focus-visible:bg-ink/5"
      >
        <IconCheck className="w-4 h-4 text-ink/60" />
        Mark as finished
      </button>
      <button
        type="button"
        role="menuitem"
        onClick={onHide}
        className="flex w-full items-center gap-2 px-3 py-2 min-h-[44px] sm:min-h-0 text-left text-sm text-ink hover:bg-ink/5 focus-visible:outline-none focus-visible:bg-ink/5"
      >
        <IconClose className="w-4 h-4 text-ink/60" />
        Hide from shelf
      </button>
    </div>,
    document.body,
  );
}
