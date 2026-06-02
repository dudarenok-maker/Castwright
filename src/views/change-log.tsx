import { useEffect, useMemo, useRef, useState } from 'react';
import { IconHistory, IconClock } from '../lib/icons';
import { SectionLabel, MixedHeading } from '../components/primitives';
import { LOG_TYPES } from '../data/log-types';
import { withRecomputedDisplay } from '../lib/change-log';
import type { ChangeLogEvent, ChangeLogType, WorkspaceChangeLogCategoryCounts } from '../lib/types';

type FilterKey = 'all' | 'voice' | 'generation' | 'manuscript' | 'cast';

const FILTER_MAP: Record<Exclude<FilterKey, 'all'>, ChangeLogType[]> = {
  voice: ['voice_tune', 'voice_reuse', 'voice_lock', 'library_add'],
  generation: [
    'regenerate',
    'generation_run_complete',
    'chapter_complete',
    'chapter_failed',
    'generation_started',
  ],
  manuscript: ['boundary_move', 'import', 'reparse'],
  cast: ['cast_confirm', 'name_change', 'analysis_complete'],
};

const DATE_LABEL: Record<ChangeLogEvent['date'], string> = {
  today: 'Today',
  yesterday: 'Yesterday',
  earlier: 'Earlier',
};

/* Approximate height of one (compact) ChangeLogEntry row × 10 rows.
   Compact rows run ~55–70px depending on whether they show a bookTitle
   subtitle or a CH footer; 640px keeps the cap "about 10 rows" without
   thrashing the layout when rows trend tall. Beyond this point the
   section scrolls internally so a runaway "Today" bucket (200+
   chapter_complete events on a long generate) doesn't push
   Yesterday/Earlier sections off-screen. */
const SECTION_MAX_HEIGHT_PX = 640;

interface Props {
  events: ChangeLogEvent[];
  title?: string | null;
  /** Server-side total over the FULL set (all pages). When present, drives
      the "All (N)" pill label so the count stays honest while the user is
      mid-scroll through a paginated workspace. Omit for the per-book view
      where every event is already loaded and the in-memory count is real. */
  totalCount?: number;
  /** Server-side per-category totals over the full set. Same rationale as
      totalCount — keeps the pill labels truthful under pagination. */
  categoryCounts?: WorkspaceChangeLogCategoryCounts;
  /** Fired when the user scrolls within reach of the list tail. Trigger
      a `before=<nextCursor>` fetch; mount the sentinel only when `hasMore`
      is true so the observer doesn't keep firing once the tail is loaded. */
  onLoadMore?: () => void;
  hasMore?: boolean;
  loadingMore?: boolean;
}

export function ChangeLogView({
  events,
  title,
  totalCount,
  categoryCounts: serverCategoryCounts,
  onLoadMore,
  hasMore,
  loadingMore,
}: Props) {
  const [filter, setFilter] = useState<FilterKey>('all');
  /* Recompute relative timestamps / date buckets so persisted entries age
     correctly across reloads. Fixture entries (no `at` field) pass through
     untouched, keeping their hand-authored copy. */
  const displayEvents = useMemo(() => withRecomputedDisplay(events), [events]);
  /* Per-category counts over the loaded set, used only as the fallback when
     the caller didn't supply server-side totals (per-book view). The
     workspace view passes `categoryCounts` from the server so the pills
     stay truthful even when only one page is in memory. */
  const loadedCategoryCounts = useMemo(() => {
    const counts: Record<Exclude<FilterKey, 'all'>, number> = {
      voice: 0,
      generation: 0,
      manuscript: 0,
      cast: 0,
    };
    for (const e of displayEvents) {
      for (const key of Object.keys(FILTER_MAP) as Array<Exclude<FilterKey, 'all'>>) {
        if (FILTER_MAP[key].includes(e.type)) counts[key] += 1;
      }
    }
    return counts;
  }, [displayEvents]);
  const effectiveCategoryCounts = serverCategoryCounts ?? loadedCategoryCounts;
  const effectiveTotal = totalCount ?? displayEvents.length;
  const visible =
    filter === 'all'
      ? displayEvents
      : displayEvents.filter((e) => FILTER_MAP[filter].includes(e.type));
  const groups = visible.reduce<Record<string, ChangeLogEvent[]>>((acc, e) => {
    (acc[e.date] ??= []).push(e);
    return acc;
  }, {});

  const filterButtons: Array<{ id: FilterKey; label: string; count: number }> = [
    { id: 'all', label: 'All', count: effectiveTotal },
    { id: 'voice', label: 'Voice', count: effectiveCategoryCounts.voice },
    { id: 'generation', label: 'Generation', count: effectiveCategoryCounts.generation },
    { id: 'manuscript', label: 'Manuscript', count: effectiveCategoryCounts.manuscript },
    { id: 'cast', label: 'Cast', count: effectiveCategoryCounts.cast },
  ];

  /* Infinite-scroll sentinel: when the trailing div intersects, ask the
     caller for the next page. We only mount the observer when there's
     something to load (hasMore) and a callback was supplied (workspace
     view); the per-book view passes neither and the sentinel never
     renders. */
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!onLoadMore || !hasMore) return;
    const node = sentinelRef.current;
    if (!node) return;
    const obs = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) onLoadMore();
        }
      },
      { rootMargin: '200px' },
    );
    obs.observe(node);
    return () => obs.disconnect();
  }, [onLoadMore, hasMore]);

  /* Distinct copy for the two empty states:
       - Nothing logged yet (filter=all, displayEvents=[]) — onboarding-style
         message that explains what the activity feed is for.
       - Filter excluded everything in a non-empty log — names the active
         category so the user knows the click registered (clicking a 0-count
         pill used to render a tiny grey "No events match this filter"
         that was easy to miss). */
  const isActivityEmpty = displayEvents.length === 0;
  const activeFilterLabel = filterButtons.find((f) => f.id === filter)?.label ?? 'this filter';

  return (
    <div className="max-w-[1100px] mx-auto px-6 py-10">
      <div className="mb-6">
        <SectionLabel>Activity</SectionLabel>
        <div className="mt-4">
          <MixedHeading
            regular="Everything that's happened"
            bold={title ? `to ${title}` : 'across your library'}
            level="h1"
          />
        </div>
        <p className="mt-3 text-ink/60 max-w-xl">
          Every regeneration, voice change, and boundary move — recorded so you can audit what
          changed.
        </p>
      </div>

      <div className="flex items-center gap-1 mb-6 flex-wrap">
        {filterButtons.map((f) => {
          const isActive = filter === f.id;
          /* Mute the pill (lower opacity + no hover lift) when its bucket
             is empty so the user can see at a glance that clicking it will
             land on the empty state. Still clickable — disabling buttons
             would hide the "0" count and remove the visible confirmation
             that the filter is wired up. */
          const isEmpty = f.count === 0 && !isActive;
          return (
            <button
              key={f.id}
              onClick={() => setFilter(f.id)}
              className={`px-4 py-2 rounded-full text-sm font-medium transition-colors ${
                isActive
                  ? 'bg-ink text-canvas'
                  : isEmpty
                    ? 'text-ink/30 hover:text-ink/55 hover:bg-ink/2'
                    : 'text-ink/60 hover:text-ink hover:bg-ink/4'
              }`}
            >
              {f.label} <span className="tabular-nums">({f.count})</span>
            </button>
          );
        })}
      </div>

      <div className="space-y-6">
        {Object.entries(groups).map(([date, items]) => (
          <div key={date}>
            <div className="flex items-center gap-3 mb-3">
              <h2 className="text-sm font-bold text-ink uppercase tracking-wider">
                {DATE_LABEL[date as ChangeLogEvent['date']] || date}
              </h2>
              <span className="flex-1 h-px bg-ink/10" />
              <span className="text-xs text-ink/50 tabular-nums">{items.length} events</span>
            </div>
            {/* Inner scroller keeps the card's rounded corners clean and
                paints a thin inset thumb that clears those corners (same
                trick the Listen view uses for its chapter list). Without
                the cap, a 200-event "Today" bucket from a long generate
                run pushes Yesterday/Earlier sections off-screen. */}
            <div className="bg-white rounded-3xl border border-ink/10 shadow-card overflow-hidden">
              <div
                data-testid={`changelog-section-scroll-${date}`}
                className="divide-y divide-ink/5 overflow-y-auto scrollbar-thin"
                style={{ maxHeight: SECTION_MAX_HEIGHT_PX }}
              >
                {items.map((e) => (
                  <ChangeLogEntry key={e.id} event={e} />
                ))}
              </div>
            </div>
          </div>
        ))}
        {visible.length === 0 && (
          <div className="bg-white rounded-3xl border border-ink/10 shadow-card px-8 py-12 text-center">
            <span className="inline-flex w-12 h-12 rounded-full bg-ink/4 text-ink/40 items-center justify-center mb-4">
              <IconHistory className="w-5 h-5" />
            </span>
            {isActivityEmpty ? (
              <>
                <h3 className="text-base font-bold text-ink">No activity yet</h3>
                <p className="mt-2 text-sm text-ink/60 max-w-md mx-auto">
                  Regenerations, voice tunes, cast confirms, and boundary edits will appear here as
                  you work — newest first.
                </p>
              </>
            ) : (
              <>
                <h3 className="text-base font-bold text-ink">
                  No {activeFilterLabel.toLowerCase()} events yet
                </h3>
                <p className="mt-2 text-sm text-ink/60 max-w-md mx-auto">
                  Nothing in this category has been logged so far. Switch back to{' '}
                  <button
                    onClick={() => setFilter('all')}
                    className="font-semibold text-ink underline-offset-2 hover:underline"
                  >
                    All
                  </button>{' '}
                  to see everything that has happened.
                </p>
              </>
            )}
          </div>
        )}
        {/* Infinite-scroll sentinel. Only renders for paginated callers
            (workspace view): omitted when hasMore is false or no onLoadMore
            was supplied. The "Loading more…" hint lives inside so the user
            sees an explicit beat rather than just a stalled scroll. */}
        {onLoadMore && hasMore && (
          <div
            ref={sentinelRef}
            data-testid="changelog-load-more-sentinel"
            className="py-4 text-center text-xs text-ink/45"
          >
            {loadingMore ? 'Loading more…' : ' '}
          </div>
        )}
      </div>
    </div>
  );
}

function ChangeLogEntry({ event }: { event: ChangeLogEvent }) {
  const t = LOG_TYPES[event.type] || {
    icon: <IconHistory className="w-3 h-3" />,
    color: '#6B6663',
    label: event.type,
  };
  return (
    <div className="grid grid-cols-[auto_1fr_auto] gap-3 px-4 py-2.5 hover:bg-ink/2 transition-colors">
      <span
        className="w-7 h-7 rounded-full grid place-items-center text-white shrink-0 mt-0.5"
        style={{ background: t.color }}
      >
        {t.icon}
      </span>
      <div className="min-w-0">
        <div className="flex items-baseline gap-2 mb-0.5 flex-wrap">
          <h3 className="text-sm font-bold text-ink leading-tight">{event.title}</h3>
          <span className="text-[10px] uppercase tracking-wider text-ink/50 font-semibold">
            {t.label}
          </span>
          {event.actor === 'system' && (
            <span className="text-[10px] uppercase tracking-wider text-purple-deep/70 font-semibold">
              · auto
            </span>
          )}
          {/* bookTitle is only populated by GET /api/workspace/changelog;
              the per-book Log tab skips this subtitle. Inlined into the
              header row in compact mode so it doesn't claim its own line. */}
          {event.bookTitle && (
            <span className="text-[10px] uppercase tracking-wider text-ink/45 font-semibold">
              · {event.bookTitle}
            </span>
          )}
          {event.chapterId && (
            <span className="text-[10px] text-ink/45 font-mono">
              · CH {String(event.chapterId).padStart(2, '0')}
            </span>
          )}
        </div>
        <p className="text-xs text-ink/65 leading-snug">{event.note}</p>
      </div>
      <div className="flex flex-col items-end gap-1 shrink-0 text-right">
        <span className="text-xs text-ink/55 inline-flex items-center gap-1.5">
          <IconClock className="w-3 h-3" />
          {event.ts}
        </span>
      </div>
    </div>
  );
}
