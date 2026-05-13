import { useMemo, useState } from 'react';
import { IconHistory, IconClock, IconUndo } from '../lib/icons';
import { SectionLabel, MixedHeading } from '../components/primitives';
import { LOG_TYPES } from '../data/log-types';
import { withRecomputedDisplay } from '../lib/change-log';
import type { ChangeLogEvent, ChangeLogType } from '../lib/types';

type FilterKey = 'all' | 'voice' | 'generation' | 'manuscript' | 'cast';

const FILTER_MAP: Record<Exclude<FilterKey, 'all'>, ChangeLogType[]> = {
  voice:      ['voice_tune', 'voice_reuse', 'voice_lock', 'library_add'],
  generation: ['regenerate', 'chapter_complete', 'chapter_failed', 'generation_started'],
  manuscript: ['boundary_move', 'import', 'reparse'],
  cast:       ['cast_confirm', 'analysis_complete'],
};

const DATE_LABEL: Record<ChangeLogEvent['date'], string> = {
  today: 'Today', yesterday: 'Yesterday', earlier: 'Earlier',
};

interface Props { events: ChangeLogEvent[]; title?: string | null; }

export function ChangeLogView({ events, title }: Props) {
  const [filter, setFilter] = useState<FilterKey>('all');
  /* Recompute relative timestamps / date buckets so persisted entries age
     correctly across reloads. Fixture entries (no `at` field) pass through
     untouched, keeping their hand-authored copy. */
  const displayEvents = useMemo(() => withRecomputedDisplay(events), [events]);
  const visible = filter === 'all' ? displayEvents : displayEvents.filter(e => FILTER_MAP[filter].includes(e.type));
  const groups = visible.reduce<Record<string, ChangeLogEvent[]>>((acc, e) => {
    (acc[e.date] ??= []).push(e);
    return acc;
  }, {});

  const filterButtons: Array<{ id: FilterKey; label: string }> = [
    { id: 'all',        label: `All (${events.length})` },
    { id: 'voice',      label: 'Voice' },
    { id: 'generation', label: 'Generation' },
    { id: 'manuscript', label: 'Manuscript' },
    { id: 'cast',       label: 'Cast' },
  ];

  return (
    <div className="max-w-[1100px] mx-auto px-6 py-10">
      <div className="mb-8 flex items-end justify-between gap-6 flex-wrap">
        <div>
          <SectionLabel>Activity</SectionLabel>
          <div className="mt-4">
            <MixedHeading regular="Everything that's happened" bold={title ? `to ${title}` : 'across your library'} level="h1"/>
          </div>
          <p className="mt-3 text-ink/60 max-w-xl">Every regeneration, voice change, and boundary move — recorded so you can audit what changed and roll back if something doesn't sound right.</p>
        </div>
        <button className="px-4 py-2.5 rounded-full border border-ink/10 bg-white text-sm font-medium text-ink/70 hover:text-ink inline-flex items-center gap-2"><IconHistory className="w-4 h-4"/>Export log</button>
      </div>

      <div className="flex items-center gap-1 mb-8">
        {filterButtons.map(f => (
          <button key={f.id} onClick={() => setFilter(f.id)} className={`px-4 py-2 rounded-full text-sm font-medium transition-colors ${filter === f.id ? 'bg-ink text-canvas' : 'text-ink/60 hover:text-ink hover:bg-ink/[0.04]'}`}>{f.label}</button>
        ))}
      </div>

      <div className="space-y-10">
        {Object.entries(groups).map(([date, items]) => (
          <div key={date}>
            <div className="flex items-center gap-3 mb-4">
              <h2 className="text-sm font-bold text-ink uppercase tracking-wider">{DATE_LABEL[date as ChangeLogEvent['date']] || date}</h2>
              <span className="flex-1 h-px bg-ink/10"/>
              <span className="text-xs text-ink/50 tabular-nums">{items.length} events</span>
            </div>
            <div className="bg-white rounded-3xl border border-ink/10 shadow-card divide-y divide-ink/5 overflow-hidden">
              {items.map(e => <ChangeLogEntry key={e.id} event={e}/>)}
            </div>
          </div>
        ))}
        {visible.length === 0 && (
          <p className="text-center text-sm text-ink/50 py-12">No events match this filter.</p>
        )}
      </div>
    </div>
  );
}

function ChangeLogEntry({ event }: { event: ChangeLogEvent }) {
  const t = LOG_TYPES[event.type] || { icon: <IconHistory className="w-3.5 h-3.5"/>, color: '#6B6663', label: event.type };
  return (
    <div className="grid grid-cols-[auto_1fr_auto] gap-4 px-5 py-4 hover:bg-ink/[0.02] transition-colors">
      <span className="w-8 h-8 rounded-full grid place-items-center text-white shrink-0 mt-0.5" style={{ background: t.color }}>
        {t.icon}
      </span>
      <div className="min-w-0">
        <div className="flex items-center gap-2 mb-1 flex-wrap">
          <h3 className="text-sm font-bold text-ink">{event.title}</h3>
          <span className="text-[10px] uppercase tracking-wider text-ink/50 font-semibold">{t.label}</span>
          {event.actor === 'system' && <span className="text-[10px] uppercase tracking-wider text-purple-deep/70 font-semibold">· auto</span>}
        </div>
        {event.bookTitle && (
          /* Only populated by GET /api/workspace/changelog. The per-book Log
             tab shows raw events and skips this subtitle. */
          <p className="text-[11px] uppercase tracking-wider text-ink/45 font-semibold mb-1">{event.bookTitle}</p>
        )}
        <p className="text-xs text-ink/65 leading-relaxed">{event.note}</p>
        {event.chapterId && (
          <p className="mt-1.5 text-[11px] text-ink/45 font-mono">CH {String(event.chapterId).padStart(2, '0')}</p>
        )}
      </div>
      <div className="flex flex-col items-end gap-2 shrink-0 text-right">
        <span className="text-xs text-ink/55 inline-flex items-center gap-1.5"><IconClock className="w-3 h-3"/>{event.ts}</span>
        {event.revertible && (
          <button className="text-xs font-medium text-ink/60 hover:text-ink inline-flex items-center gap-1.5">
            <IconUndo className="w-3 h-3"/> Revert
          </button>
        )}
      </div>
    </div>
  );
}
