import { useEffect, useState } from 'react';
import {
  IconPlay, IconPause, IconHeadphones, IconWaveform, IconShare, IconShield,
  IconExternal, IconDownload, IconEye, IconRefresh, IconUpload, IconCheckCircle,
  IconSpinner, IconWarning, IconClock, IconCopy, IconTrash,
} from '../lib/icons';
import {
  SectionLabel, MixedHeading, PrimaryButton, Pill,
} from '../components/primitives';
import { Waveform } from '../components/waveform';
import { parseDuration, formatTime } from '../lib/time';
import { SUPPORTED_APPS } from '../data/listener-apps';
import { EXPORT_QUEUE } from '../data/export-queue';
import type {
  Chapter, Character, Voice, ListenerApp, ExportQueueItem,
} from '../lib/types';

interface Props {
  chapters: Chapter[];
  characters: Character[];
  library: Voice[];
  currentTrack: number | null;
  setCurrentTrack: (t: number | null) => void;
  onSendApp: (app: ListenerApp) => void;
  onRegenerate: (ch: Chapter) => void;
  onEnterPreview: () => void;
}

export function ListenView({
  chapters, characters, currentTrack, setCurrentTrack, onSendApp, onRegenerate, onEnterPreview,
}: Props) {
  const completed = chapters.filter(c => c.state === 'done').length;
  const totalSec = chapters.reduce((s, c) => s + parseDuration(c.duration), 0);
  const findChar = (id: string) => characters.find(c => c.id === id);
  return (
    <div className="max-w-[1200px] mx-auto px-6 py-10">
      <section className="grid grid-cols-1 md:grid-cols-[320px_1fr] gap-10 items-end mb-12">
        <CoverArt title="The Northern Star"/>
        <div>
          <SectionLabel>Audiobook · ready to listen</SectionLabel>
          <h1 className="mt-4 text-4xl md:text-5xl lg:text-6xl font-bold leading-[1.05] tracking-tight font-serif">The Northern Star</h1>
          <p className="mt-3 text-ink/70">By <span className="font-semibold text-ink">Mike Dudarenok</span> · narrated by <span className="font-semibold text-ink">Anders Vale</span> with a cast of {characters.length - 1} voices</p>
          <div className="mt-5 flex flex-wrap items-center gap-x-6 gap-y-2 text-sm text-ink/60">
            <span><span className="font-semibold text-ink tabular-nums">{formatTime(totalSec)}</span> total runtime</span>
            <span>·</span><span><span className="font-semibold text-ink">{chapters.length}</span> chapters</span>
            <span>·</span><span>FLAC + MP3</span>
            <span>·</span><span><span className="font-semibold text-ink">{completed}</span> chapters voiced</span>
          </div>
          <div className="mt-7 flex flex-wrap items-center gap-3">
            <button onClick={() => setCurrentTrack(chapters[0].id)} className="inline-flex items-center gap-3 rounded-full bg-ink text-canvas hover:bg-ink-soft pl-5 pr-6 py-3 text-sm font-semibold transition-colors">
              <span className="w-8 h-8 rounded-full bg-canvas text-ink grid place-items-center"><IconPlay className="w-3.5 h-3.5 ml-0.5"/></span>
              Play from the start
            </button>
            <button className="px-4 py-3 rounded-full border border-ink/15 bg-white text-sm font-medium text-ink/80 hover:text-ink inline-flex items-center gap-2"><IconDownload className="w-4 h-4"/> Download</button>
            <button onClick={onEnterPreview} className="px-4 py-3 rounded-full border border-ink/15 bg-white text-sm font-medium text-ink/80 hover:text-ink inline-flex items-center gap-2"><IconEye className="w-4 h-4"/> Preview as listener</button>
            <button className="px-4 py-3 rounded-full border border-ink/15 bg-white text-sm font-medium text-ink/80 hover:text-ink inline-flex items-center gap-2"><IconShare className="w-4 h-4"/> Share</button>
          </div>
        </div>
      </section>

      <section className="mb-12">
        <div className="flex items-center justify-between mb-3">
          <SectionLabel>Chapters</SectionLabel>
          <span className="text-xs text-ink/50">Click any chapter to play from there</span>
        </div>
        <div className="bg-white rounded-3xl border border-ink/10 shadow-card divide-y divide-ink/5 overflow-hidden">
          {chapters.map(ch => {
            const charsIn = Object.entries(ch.characters).filter(([, st]) => st !== 'skipped').map(([id]) => findChar(id)).filter(Boolean) as Character[];
            return <ChapterListenRow key={ch.id} chapter={ch} charactersIn={charsIn} isPlaying={currentTrack === ch.id} onPlay={() => setCurrentTrack(currentTrack === ch.id ? null : ch.id)} onRegenerate={onRegenerate}/>;
          })}
        </div>
      </section>

      <ListenerApps onSend={onSendApp}/>
      <ExportQueue items={EXPORT_QUEUE}/>

      <section className="mb-12">
        <div className="flex items-center justify-between mb-3 flex-wrap gap-2">
          <SectionLabel>Or download a file</SectionLabel>
          <span className="text-xs text-ink/50">For sideloading or archival</span>
        </div>
        <div className="mt-3 grid grid-cols-1 md:grid-cols-3 gap-4">
          <DownloadCard title="Full audiobook" format="m4b chaptered" size="287 MB" description="Single file with chapter markers. Works with every app above."/>
          <DownloadCard title="MP3 by chapter" format="ZIP archive"   size="312 MB" description="One MP3 per chapter. Universal compatibility."/>
          <DownloadCard title="Streaming link" format="Shareable URL"  size="Hosted" description="Send a link to listeners. Optional password protection."/>
        </div>
      </section>

      <section>
        <div className="bg-white rounded-3xl border border-ink/10 p-8 shadow-card">
          <SectionLabel>Metadata</SectionLabel>
          <div className="mt-3 mb-6"><MixedHeading regular="Edit the" bold="audiobook details"/></div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-x-8 gap-y-5">
            <MetaField label="Title"            value="The Northern Star"/>
            <MetaField label="Author"           value="Mike Dudarenok"/>
            <MetaField label="Narrator credit"  value="Anders Vale"/>
            <MetaField label="Series"           value="Northern Coast Trilogy · Book 2"/>
            <MetaField label="Genre"            value="Literary fiction"/>
            <MetaField label="Publication date" value="9 May 2026" type="date"/>
            <div className="md:col-span-2">
              <p className="text-[11px] uppercase tracking-wider text-ink/50 font-semibold mb-2">Cover art</p>
              <div className="flex items-center gap-4">
                <div className="w-16 h-16 rounded-xl bg-gradient-cta shadow-card"/>
                <div className="flex items-center gap-2">
                  <button className="px-3 py-2 rounded-full border border-ink/15 text-xs font-medium text-ink/80 hover:text-ink inline-flex items-center gap-1.5"><IconUpload className="w-3.5 h-3.5"/> Replace</button>
                  <button className="px-3 py-2 rounded-full border border-ink/15 text-xs font-medium text-ink/80 hover:text-ink inline-flex items-center gap-1.5"><IconRefresh className="w-3.5 h-3.5"/> Regenerate</button>
                </div>
              </div>
            </div>
          </div>
          <div className="mt-8 pt-6 border-t border-ink/10 flex items-center justify-end gap-3">
            <button className="text-sm font-medium text-ink/60 hover:text-ink">Cancel</button>
            <PrimaryButton variant="dark">Save changes</PrimaryButton>
          </div>
        </div>
      </section>
    </div>
  );
}

function CoverArt({ title }: { title: string }) {
  return (
    <div className="aspect-square rounded-3xl overflow-hidden shadow-float relative bg-gradient-cta">
      <svg viewBox="0 0 320 320" className="absolute inset-0 w-full h-full opacity-25">
        <circle cx="160" cy="160" r="140" fill="none" stroke="white" strokeWidth="0.5"/>
        <circle cx="160" cy="160" r="110" fill="none" stroke="white" strokeWidth="0.5"/>
        <circle cx="160" cy="160" r="80"  fill="none" stroke="white" strokeWidth="0.5"/>
        <circle cx="160" cy="160" r="50"  fill="none" stroke="white" strokeWidth="0.5"/>
      </svg>
      <div className="absolute top-6 left-6 right-6 flex items-center justify-between">
        <p className="text-[10px] uppercase tracking-[0.2em] text-white/70 font-semibold">Audiobook</p>
        <IconHeadphones className="w-5 h-5 text-white/70"/>
      </div>
      <div className="absolute bottom-6 left-6 right-6">
        <h2 className="font-serif text-3xl font-bold text-white leading-[1.1]">{title}</h2>
        <p className="font-serif italic text-sm text-white/80 mt-1.5">A novel</p>
        <div className="mt-4 flex items-center gap-2 text-[10px] uppercase tracking-widest text-white/60">
          <IconWaveform className="w-3 h-3"/><span>4h 38m · narrated by Anders Vale</span>
        </div>
      </div>
    </div>
  );
}

interface ChapterListenRowProps {
  chapter: Chapter;
  charactersIn: Character[];
  isPlaying: boolean;
  onPlay: () => void;
  onRegenerate: (ch: Chapter) => void;
}

function ChapterListenRow({ chapter, charactersIn, isPlaying, onPlay, onRegenerate }: ChapterListenRowProps) {
  const [progress, setProgress] = useState(0);
  useEffect(() => {
    if (!isPlaying) return;
    setProgress(0);
    const t = setInterval(() => setProgress(p => p >= 1 ? p : Math.min(1, p + 0.012)), 800);
    return () => clearInterval(t);
  }, [isPlaying]);
  const totalSec = parseDuration(chapter.duration);
  const elapsedSec = Math.floor(totalSec * progress);
  return (
    <div className={`grid grid-cols-[40px_60px_1fr_220px_100px_60px] items-center gap-4 px-5 py-4 transition-colors ${isPlaying ? 'bg-peach/[0.06]' : 'hover:bg-ink/[0.02]'}`}>
      <button onClick={onPlay} className={`w-9 h-9 rounded-full grid place-items-center transition-all ${isPlaying ? 'bg-ink text-canvas' : 'bg-canvas border border-ink/15 text-ink hover:bg-ink hover:text-canvas'}`}>
        {isPlaying ? <IconPause className="w-3.5 h-3.5"/> : <IconPlay className="w-3.5 h-3.5 ml-0.5"/>}
      </button>
      <span className="text-sm font-bold text-ink/50 tabular-nums">CH {String(chapter.id).padStart(2, '0')}</span>
      <span className="min-w-0">
        <span className="block font-semibold text-ink truncate">{chapter.title}</span>
        <span className="block text-xs text-ink/50 truncate mt-0.5">With {charactersIn.slice(0, 4).map(c => c.name).join(', ')}</span>
      </span>
      <Waveform progress={isPlaying ? progress : 0} active={isPlaying}/>
      <span className="text-sm tabular-nums text-ink/60 text-right">
        {isPlaying ? <span className="text-ink font-semibold">{formatTime(elapsedSec)} / {chapter.duration}</span> : chapter.duration}
      </span>
      <span className="flex items-center gap-1 justify-end">
        <button onClick={() => onRegenerate(chapter)} title="Regenerate" className="text-ink/40 hover:text-magenta grid place-items-center w-8 h-8 rounded-full hover:bg-ink/[0.04]"><IconRefresh className="w-4 h-4"/></button>
        <button title="Download" className="text-ink/40 hover:text-ink grid place-items-center w-8 h-8 rounded-full hover:bg-ink/[0.04]"><IconDownload className="w-4 h-4"/></button>
      </span>
    </div>
  );
}

function DownloadCard({ title, format, size, description, primary }: { title: string; format: string; size: string; description: string; primary?: boolean }) {
  return (
    <div className={`rounded-3xl border p-6 transition-all ${primary ? 'bg-ink text-canvas border-ink shadow-float' : 'bg-white border-ink/10 shadow-card'}`}>
      <div className="flex items-start justify-between mb-3">
        <p className={`text-[11px] uppercase tracking-wider font-semibold ${primary ? 'text-canvas/60' : 'text-ink/50'}`}>{format}</p>
        <span className={`text-xs tabular-nums ${primary ? 'text-canvas/70' : 'text-ink/60'}`}>{size}</span>
      </div>
      <h3 className={`text-lg font-bold mb-2 ${primary ? 'text-canvas' : 'text-ink'}`}>{title}</h3>
      <p className={`text-xs leading-relaxed mb-5 ${primary ? 'text-canvas/70' : 'text-ink/60'}`}>{description}</p>
      <button className={`w-full inline-flex items-center justify-center gap-2 rounded-full px-4 py-2 text-sm font-semibold transition-colors ${primary ? 'bg-canvas text-ink hover:bg-white' : 'bg-ink/[0.04] text-ink hover:bg-ink/[0.08]'}`}>
        <IconDownload className="w-4 h-4"/> Download
      </button>
    </div>
  );
}

function MetaField({ label, value, type = 'text' }: { label: string; value: string; type?: string }) {
  return (
    <label className="block">
      <span className="text-[11px] uppercase tracking-wider text-ink/50 font-semibold">{label}</span>
      <input type={type} defaultValue={value} className="mt-1 w-full px-3 py-2 rounded-xl bg-canvas border border-ink/10 text-sm text-ink focus:outline-none focus:border-ink/30"/>
    </label>
  );
}

function ListenerApps({ onSend }: { onSend: (app: ListenerApp) => void }) {
  return (
    <section className="mb-12">
      <div className="flex items-center justify-between mb-3 flex-wrap gap-2">
        <SectionLabel>Listen on your favourite app</SectionLabel>
        <span className="text-xs text-ink/50 inline-flex items-center gap-1.5"><IconShield className="w-3.5 h-3.5"/> Open-format export · DRM-free</span>
      </div>
      <div className="mt-3 grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {SUPPORTED_APPS.map(a => <ListenerAppCard key={a.id} app={a} onSend={onSend}/>)}
      </div>
      <p className="mt-4 text-xs text-ink/50 text-center">Don't see your app? Any player that supports M4B with chapter markers will work — use the manual download below.</p>
    </section>
  );
}

function ListenerAppCard({ app, onSend }: { app: ListenerApp; onSend: (a: ListenerApp) => void }) {
  const [from, to] = app.gradient;
  return (
    <article className="bg-white rounded-3xl border border-ink/10 shadow-card p-5 flex flex-col">
      <div className="flex items-start gap-3 mb-3">
        <span className="w-12 h-12 rounded-2xl shadow-card grid place-items-center text-white font-bold text-sm shrink-0" style={{ background: `linear-gradient(135deg, ${from}, ${to})` }}>
          {app.glyph}
        </span>
        <div className="flex-1 min-w-0">
          <h3 className="font-bold text-ink leading-tight">{app.name}</h3>
          <p className="text-xs text-ink/55 mt-0.5">{app.tagline}</p>
        </div>
      </div>
      <div className="flex flex-wrap gap-1 mb-3">
        {app.platforms.map(p => <Pill key={p}>{p}</Pill>)}
      </div>
      <p className="text-xs text-ink/65 leading-relaxed mb-5 flex-1">{app.description}</p>
      <button onClick={() => onSend(app)}
              className="w-full inline-flex items-center justify-center gap-2 rounded-full px-4 py-2 text-sm font-semibold transition-colors bg-ink/[0.04] text-ink hover:bg-ink hover:text-canvas">
        <IconExternal className="w-4 h-4"/> {app.sendVerb}
      </button>
    </article>
  );
}

type QueueFilter = 'all' | 'done' | 'in_progress' | 'failed';

function ExportQueue({ items }: { items: ExportQueueItem[] }) {
  const [filter, setFilter] = useState<QueueFilter>('all');
  const visible = items.filter(it => filter === 'all' || it.status === filter);
  const counts = {
    all: items.length,
    done: items.filter(it => it.status === 'done').length,
    in_progress: items.filter(it => it.status === 'in_progress').length,
    failed: items.filter(it => it.status === 'failed').length,
  };
  const filters: Array<{ id: QueueFilter; label: string }> = [
    { id: 'all',         label: `All (${counts.all})` },
    { id: 'done',        label: `Done (${counts.done})` },
    { id: 'in_progress', label: `Running (${counts.in_progress})` },
    { id: 'failed',      label: `Failed (${counts.failed})` },
  ];
  return (
    <section className="mb-12">
      <div className="flex items-center justify-between mb-3 flex-wrap gap-2">
        <SectionLabel>Export queue</SectionLabel>
        <div className="flex items-center gap-1 bg-ink/[0.04] rounded-full p-0.5 text-xs">
          {filters.map(f => (
            <button key={f.id} onClick={() => setFilter(f.id)} className={`px-3 py-1 rounded-full font-medium transition-colors ${filter === f.id ? 'bg-white text-ink shadow-card' : 'text-ink/60'}`}>{f.label}</button>
          ))}
        </div>
      </div>
      <div className="bg-white rounded-3xl border border-ink/10 shadow-card overflow-hidden divide-y divide-ink/5">
        {visible.length === 0 && <p className="px-6 py-8 text-sm text-ink/50 text-center">No exports match this filter.</p>}
        {visible.map(it => <ExportQueueRow key={it.id} item={it}/>)}
      </div>
    </section>
  );
}

function ExportQueueRow({ item }: { item: ExportQueueItem }) {
  const formatBadge = ({
    m4b:  { color: '#A43C6C', label: 'M4B'  },
    m4a:  { color: '#F79A83', label: 'M4A'  },
    mp3:  { color: '#6B6663', label: 'MP3'  },
    zip:  { color: '#7C5C8C', label: 'ZIP'  },
    link: { color: '#3C194F', label: 'URL'  },
  } as Record<string, { color: string; label: string }>)[item.format] || { color: '#6B6663', label: item.format.toUpperCase() };

  const statusUI = {
    done:        <span className="inline-flex items-center gap-1.5 text-emerald-700"><IconCheckCircle className="w-3.5 h-3.5"/> Done</span>,
    in_progress: <span className="inline-flex items-center gap-1.5 text-magenta"><IconSpinner className="w-3.5 h-3.5"/> Running…</span>,
    failed:      <span className="inline-flex items-center gap-1.5 text-rose-600"><IconWarning className="w-3.5 h-3.5"/> Failed</span>,
  }[item.status];

  return (
    <div className="grid grid-cols-[44px_1fr_120px_120px_140px_120px] items-center gap-4 px-5 py-3.5 text-sm hover:bg-ink/[0.02] transition-colors">
      <span className="w-10 h-10 rounded-xl grid place-items-center text-white font-bold text-[10px] tracking-wider" style={{ background: formatBadge.color }}>
        {formatBadge.label}
      </span>
      <span className="min-w-0">
        <span className="block font-semibold text-ink truncate">{item.filename}</span>
        {item.errorReason ? (
          <span className="block text-[11px] text-rose-600 truncate mt-0.5">{item.errorReason}</span>
        ) : (
          <span className="block text-[11px] text-ink/55 truncate mt-0.5">{item.destination}</span>
        )}
        {item.status === 'in_progress' && (
          <div className="mt-1.5 h-1 rounded-full bg-ink/[0.06] overflow-hidden max-w-[280px] relative">
            <div className="h-full rounded-full bg-gradient-progress pulse-bar" style={{ width: `${(item.progress || 0) * 100}%` }}>
              <div className="absolute inset-0 stripe-travel"/>
            </div>
          </div>
        )}
      </span>
      <span className="text-xs tabular-nums text-ink/60">{item.size}</span>
      <span className="text-xs text-ink/55 inline-flex items-center gap-1.5"><IconClock className="w-3 h-3"/>{item.timestamp}</span>
      <span className="text-xs">{statusUI}</span>
      <span className="flex items-center justify-end gap-1">
        {item.status === 'done' && (
          item.url ? (
            <button title="Copy link" className="p-1.5 rounded-full hover:bg-ink/[0.06] text-ink/60 hover:text-ink"><IconCopy className="w-4 h-4"/></button>
          ) : (
            <button title="Download" className="p-1.5 rounded-full hover:bg-ink/[0.06] text-ink/60 hover:text-ink"><IconDownload className="w-4 h-4"/></button>
          )
        )}
        {item.status === 'failed' && (
          <button title="Retry" className="p-1.5 rounded-full hover:bg-ink/[0.06] text-ink/60 hover:text-ink"><IconRefresh className="w-4 h-4"/></button>
        )}
        <button title="Remove" className="p-1.5 rounded-full hover:bg-ink/[0.06] text-ink/40 hover:text-rose-600"><IconTrash className="w-4 h-4"/></button>
      </span>
    </div>
  );
}
