import { useEffect, useMemo, useState } from 'react';
import {
  IconPlay, IconPause, IconHeadphones, IconWaveform, IconShare, IconShield,
  IconExternal, IconDownload, IconEye, IconRefresh, IconUpload, IconImage,
} from '../lib/icons';
import { CoverPicker } from '../modals/cover-picker';
import {
  SectionLabel, MixedHeading, PrimaryButton, Pill, ComingSoonBadge, MockedPreviewBanner,
} from '../components/primitives';
import { Waveform } from '../components/waveform';
import { ExportQueueRow } from '../components/export-queue-row';
import { ExportAudiobookModal } from '../modals/export-audiobook';
import { parseDuration, formatTime } from '../lib/time';
import { stripChapterPrefix } from '../lib/format-chapter-title';
import { SUPPORTED_APPS } from '../data/listener-apps';
import { EXPORT_QUEUE } from '../data/export-queue';
import { bookExportJobToQueueItem } from '../lib/export-queue-adapter';
import { useAppSelector } from '../store';
import type {
  Chapter, Character, Voice, ListenerApp, ExportQueueItem,
} from '../lib/types';
import type { EditableBookMeta, EditableBookMetaField } from '../store/book-meta-slice';

interface Props {
  /** Required so the Export modal can target the right book on POST.
      Plumbed through from the ListenRoute via state.ui.stage. */
  bookId: string;
  chapters: Chapter[];
  characters: Character[];
  library: Voice[];
  currentTrack: number | null;
  setCurrentTrack: (t: number | null) => void;
  onSendApp: (app: ListenerApp) => void;
  onRegenerate: (ch: Chapter) => void;
  onEnterPreview: () => void;
  /* Book-meta wiring (Listen header + metadata editor). When `bookMeta` is
     null the view has not yet hydrated for this book — render a minimal
     skeleton rather than the design fixture. */
  bookMeta: EditableBookMeta | null;
  bookCoverGradient: [string, string] | null;
  /** Server-relative URL for the cached OpenLibrary cover image when
      one exists for this book. Null falls back to the gradient. */
  bookCoverImageUrl?: string | null;
  /** Fired by the CoverPicker after a successful save/remove so the
      parent can refresh the library slice. */
  onCoverChanged?: () => Promise<void> | void;
  onEditMetaField: (field: EditableBookMetaField, value: string | null) => void;
  onCommitMeta: () => void;
  onCancelMeta: () => void;
  isMetaDirty: boolean;
}

export function ListenView({
  bookId,
  chapters, characters, currentTrack, setCurrentTrack, onSendApp, onRegenerate, onEnterPreview,
  bookMeta, bookCoverGradient, bookCoverImageUrl, onCoverChanged,
  onEditMetaField, onCommitMeta, onCancelMeta, isMetaDirty,
}: Props) {
  /* CoverPicker modal state, plus a local override so the new image
     paints immediately after a successful pick (the prop will catch up
     on the next library hydrate). Empty string = the user just removed
     the cover; ignore the prop until the slice refresh resolves. Same
     pattern as BookCard in book-library.tsx. */
  const [coverPickerOpen, setCoverPickerOpen] = useState(false);
  const [coverOverride, setCoverOverride] = useState<string | null>(null);
  const [coverLoadFailed, setCoverLoadFailed] = useState(false);
  const effectiveCoverUrl =
    coverOverride !== null
      ? (coverOverride || null)
      : (bookCoverImageUrl ?? null);
  /* Local modal state for the export flow. Entry points:
     - The "Export audiobook" pill in the cover-art row (download tab,
       generic two-tab UX, no appHint).
     - The PocketBook tile (download tab — LAN/QR sideload story).
     - Per-app tiles (Voice, Smart AudioBook Player, …) that pass an
       appHint matching a TILE_HINTS entry in `src/modals/export-audiobook.tsx`.
       The modal collapses the format/destination toggles and surfaces
       tile-specific copy from that entry. */
  const [exportModal, setExportModal] = useState<{
    tab: 'download' | 'sync-folder';
    appHint?: 'voice' | 'smart_audiobook' | 'bookplayer' | 'audiobookshelf';
  } | null>(null);

  /* Live job list from the store, with the visual fixtures as a fallback
     so design-system mode (VITE_USE_MOCKS=true with no live exports) keeps
     showing the demo content the prototype shipped with. */
  const liveJobs = useAppSelector(s => s.exports.byBookId[bookId] ?? []);
  const useMockFallback = import.meta.env.VITE_USE_MOCKS === 'true' && liveJobs.length === 0;
  const queueItems = useMemo<ExportQueueItem[]>(
    () => useMockFallback ? EXPORT_QUEUE : liveJobs.map(bookExportJobToQueueItem),
    [liveJobs, useMockFallback],
  );
  /* Excluded chapters (front/back-matter the user opted out of at the
     confirm-metadata stage) never get audio, so they have no business in
     the "ready to listen" rail or the runtime/chapter-count math — they'd
     surface as 00:00 rows and inflate the chapter total. The Generation
     view is the place to revisit exclusion choices. */
  const listenable = chapters.filter(c => !c.excluded);
  const completed = listenable.filter(c => c.state === 'done').length;
  const totalSec = listenable.reduce((s, c) => s + parseDuration(c.duration), 0);
  const findChar = (id: string) => characters.find(c => c.id === id);
  /* Narrator credit precedence: explicit override from bookMeta (or '' if the
     user cleared it) → the cast's narrator character → null. The header
     suppresses the "narrated by …" phrase when none of those resolve. */
  const narratorName =
    (bookMeta?.narratorCredit && bookMeta.narratorCredit.trim())
    || characters.find(c => c.id === 'narrator')?.name
    || null;
  /* `voiceCount` counts only the speaking cast (not the narrator) — matches the
     library card's "cast of N voices" copy and degrades gracefully when only
     the narrator is present. */
  const voiceCount = Math.max(0, characters.filter(c => c.id !== 'narrator').length);

  const title  = bookMeta?.title  ?? '';
  const author = bookMeta?.author ?? '';
  return (
    <div className="max-w-[1200px] mx-auto px-6 py-10">
      <section className="grid grid-cols-1 md:grid-cols-[320px_1fr] gap-10 items-end mb-12">
        <CoverArt
          title={title}
          gradient={bookCoverGradient}
          imageUrl={!coverLoadFailed ? effectiveCoverUrl : null}
          onImageError={() => setCoverLoadFailed(true)}
          runtime={formatTime(totalSec)}
          narrator={narratorName}
          onChangeCover={() => setCoverPickerOpen(true)}
        />
        <div>
          <SectionLabel>Audiobook · ready to listen</SectionLabel>
          <h1 className="mt-4 text-4xl md:text-5xl lg:text-6xl font-bold leading-[1.05] tracking-tight font-serif">
            {title || <span className="text-ink/30">Loading…</span>}
          </h1>
          <p className="mt-3 text-ink/70">
            By <span className="font-semibold text-ink">{author || '—'}</span>
            {narratorName ? <> · narrated by <span className="font-semibold text-ink">{narratorName}</span></> : null}
            {voiceCount > 0 ? <> with a cast of {voiceCount} voice{voiceCount === 1 ? '' : 's'}</> : null}
          </p>
          <div className="mt-5 flex flex-wrap items-center gap-x-6 gap-y-2 text-sm text-ink/60">
            <span><span className="font-semibold text-ink tabular-nums">{formatTime(totalSec)}</span> total runtime</span>
            <span>·</span><span><span className="font-semibold text-ink">{listenable.length}</span> chapters</span>
            <span>·</span><span>FLAC + MP3</span>
            <span>·</span><span><span className="font-semibold text-ink">{completed}</span> chapters voiced</span>
          </div>
          <div className="mt-7 flex flex-wrap items-center gap-3">
            <button onClick={() => listenable.length && setCurrentTrack(listenable[0].id)} disabled={listenable.length === 0}
                    className="inline-flex items-center gap-3 rounded-full bg-ink text-canvas hover:bg-ink-soft pl-5 pr-6 py-3 text-sm font-semibold transition-colors disabled:opacity-40 disabled:cursor-not-allowed">
              <span className="w-8 h-8 rounded-full bg-canvas text-ink grid place-items-center"><IconPlay className="w-3.5 h-3.5 ml-0.5"/></span>
              Play from the start
            </button>
            <button
              onClick={() => setExportModal({ tab: 'download' })}
              data-testid="open-export-modal"
              className="px-4 py-3 rounded-full border border-ink/15 bg-white text-sm font-medium text-ink/80 hover:text-ink inline-flex items-center gap-2"
            >
              <IconDownload className="w-4 h-4"/> Export audiobook
            </button>
            <button onClick={onEnterPreview} className="px-4 py-3 rounded-full border border-ink/15 bg-white text-sm font-medium text-ink/80 hover:text-ink inline-flex items-center gap-2"><IconEye className="w-4 h-4"/> Preview as listener</button>
            <button disabled title="Share — coming soon" className="px-4 py-3 rounded-full border border-ink/15 bg-white text-sm font-medium text-ink/40 inline-flex items-center gap-2 cursor-not-allowed"><IconShare className="w-4 h-4"/> Share <ComingSoonBadge/></button>
          </div>
        </div>
      </section>

      <section className="mb-12">
        <div className="flex items-center justify-between mb-3">
          <SectionLabel>Chapters</SectionLabel>
          <span className="text-xs text-ink/50">Click any chapter to play from there</span>
        </div>
        <div className="bg-white rounded-3xl border border-ink/10 shadow-card overflow-hidden">
          {/* Cap the list so a 59-chapter book doesn't push the rest of the
              Listen view off-screen. Inner div owns the scroll so the card's
              rounded corners stay clean; scrollbar-thin paints an inset thumb
              that clears those corners. */}
          <div data-testid="listen-chapters-scroll"
               className="max-h-[560px] overflow-y-auto scrollbar-thin divide-y divide-ink/5">
            {listenable.map(ch => {
              const charsIn = Object.entries(ch.characters).filter(([, st]) => st !== 'skipped').map(([id]) => findChar(id)).filter(Boolean) as Character[];
              return <ChapterListenRow key={ch.id} chapter={ch} charactersIn={charsIn} isPlaying={currentTrack === ch.id} onPlay={() => setCurrentTrack(currentTrack === ch.id ? null : ch.id)} onRegenerate={onRegenerate}/>;
            })}
          </div>
        </div>
      </section>

      <ListenerApps
        onSend={onSendApp}
        onOpenPocketBookExport={() => setExportModal({ tab: 'download' })}
        onOpenVoiceExport={() => setExportModal({ tab: 'sync-folder', appHint: 'voice' })}
        onOpenSmartAudiobookExport={() => setExportModal({ tab: 'sync-folder', appHint: 'smart_audiobook' })}
        onOpenBookplayerExport={() => setExportModal({ tab: 'sync-folder', appHint: 'bookplayer' })}
        onOpenAudiobookshelfExport={() => setExportModal({ tab: 'sync-folder', appHint: 'audiobookshelf' })}
      />
      <ExportQueue items={queueItems}/>

      <section className="mb-12">
        <div className="flex items-center justify-between mb-3 flex-wrap gap-2">
          <SectionLabel>Or download a file</SectionLabel>
          <span className="text-xs text-ink/50">For sideloading or archival</span>
        </div>
        <div className="mt-3 grid grid-cols-1 md:grid-cols-2 gap-4">
          <DownloadCard title="Full audiobook" format="m4b chaptered" size="—" description="Single file with embedded chapter markers. Coming in Phase B."/>
          <DownloadCard title="Streaming link" format="Shareable URL"  size="Hosted" description="Send a link to listeners. Optional password protection."/>
        </div>
      </section>

      <section>
        <MetadataEditor bookMeta={bookMeta}
                        onEditField={onEditMetaField}
                        onCommit={onCommitMeta}
                        onCancel={onCancelMeta}
                        isDirty={isMetaDirty}/>
      </section>

      <ExportAudiobookModal
        open={exportModal != null}
        bookId={bookId}
        initialTab={exportModal?.tab ?? 'download'}
        prefill={exportModal?.appHint === 'voice'
          ? { format: 'm4b', destination: 'sync-folder', appHint: 'voice' }
          : exportModal?.appHint === 'smart_audiobook'
            ? { format: 'mp3-folder', destination: 'sync-folder', appHint: 'smart_audiobook' }
            : exportModal?.appHint === 'bookplayer'
              ? { format: 'mp3-folder', destination: 'sync-folder', appHint: 'bookplayer' }
              : exportModal?.appHint === 'audiobookshelf'
                ? { format: 'mp3-folder', destination: 'sync-folder', appHint: 'audiobookshelf' }
                : undefined}
        onClose={() => setExportModal(null)}
      />

      <CoverPicker
        open={coverPickerOpen}
        bookId={bookId}
        bookTitle={title}
        bookAuthor={author}
        currentCoverUrl={effectiveCoverUrl ?? undefined}
        onClose={() => setCoverPickerOpen(false)}
        onPicked={(newUrl) => {
          setCoverLoadFailed(false);
          /* Empty string from a "Remove cover" pick — shadow the slice
             with an empty override until the parent refresh hydrates. */
          setCoverOverride(newUrl ? `${newUrl}?t=${Date.now()}` : '');
          void onCoverChanged?.();
        }}
      />
    </div>
  );
}

interface CoverArtProps {
  title: string;
  gradient: [string, string] | null;
  /** Server-relative cover URL when one is on disk; null/undefined
      renders the gradient skeleton only. */
  imageUrl?: string | null;
  /** Called when the `<img>` 404s / errors out. Parent flips to
      gradient-only render. */
  onImageError?: () => void;
  runtime: string;
  narrator: string | null;
  /** Reveals a small hover-only "Change cover" button on the cover. */
  onChangeCover?: () => void;
}
function CoverArt({ title, gradient, imageUrl, onImageError, runtime, narrator, onChangeCover }: CoverArtProps) {
  const styled = gradient
    ? { background: `linear-gradient(135deg, ${gradient[0]}, ${gradient[1]})` }
    : undefined;
  return (
    <div data-testid="listen-cover-art"
         className={`group aspect-square rounded-3xl overflow-hidden shadow-float relative ${gradient ? '' : 'bg-gradient-cta'}`}
         style={styled}>
      <svg viewBox="0 0 320 320" className="absolute inset-0 w-full h-full opacity-25">
        <circle cx="160" cy="160" r="140" fill="none" stroke="white" strokeWidth="0.5"/>
        <circle cx="160" cy="160" r="110" fill="none" stroke="white" strokeWidth="0.5"/>
        <circle cx="160" cy="160" r="80"  fill="none" stroke="white" strokeWidth="0.5"/>
        <circle cx="160" cy="160" r="50"  fill="none" stroke="white" strokeWidth="0.5"/>
      </svg>
      {imageUrl && (
        <img
          data-testid="listen-cover-art-image"
          src={imageUrl}
          alt=""
          className="absolute inset-0 w-full h-full object-cover"
          onError={onImageError}
        />
      )}
      <div className="absolute top-6 left-6 right-6 flex items-center justify-between">
        <p className="text-[10px] uppercase tracking-[0.2em] text-white/70 font-semibold">Audiobook</p>
        <IconHeadphones className="w-5 h-5 text-white/70"/>
      </div>
      {!imageUrl && <div className="absolute bottom-6 left-6 right-6">
        <h2 className="font-serif text-3xl font-bold text-white leading-[1.1]">{title || ' '}</h2>
        <p className="font-serif italic text-sm text-white/80 mt-1.5">A novel</p>
        <div className="mt-4 flex items-center gap-2 text-[10px] uppercase tracking-widest text-white/60">
          <IconWaveform className="w-3 h-3"/>
          <span>{runtime}{narrator ? ` · narrated by ${narrator}` : ''}</span>
        </div>
      </div>}
      {onChangeCover && (
        <button
          type="button"
          onClick={onChangeCover}
          aria-label="Change cover image"
          data-testid="listen-change-cover"
          className="absolute bottom-3 right-3 inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-black/55 text-white text-[11px] font-medium opacity-0 group-hover:opacity-100 focus:opacity-100 transition-opacity"
        >
          <IconImage className="w-3.5 h-3.5"/> Change cover
        </button>
      )}
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
        <span className="block font-semibold text-ink truncate">{stripChapterPrefix(chapter.title)}</span>
        <span className="block text-xs text-ink/50 truncate mt-0.5">With {charactersIn.slice(0, 4).map(c => c.name).join(', ')}</span>
      </span>
      <Waveform progress={isPlaying ? progress : 0} active={isPlaying}/>
      <span className="text-sm tabular-nums text-ink/60 text-right">
        {isPlaying ? <span className="text-ink font-semibold">{formatTime(elapsedSec)} / {chapter.duration}</span> : chapter.duration}
      </span>
      <span className="flex items-center gap-1 justify-end">
        <button onClick={() => onRegenerate(chapter)} title="Regenerate" className="text-ink/40 hover:text-magenta grid place-items-center w-8 h-8 rounded-full hover:bg-ink/[0.04]"><IconRefresh className="w-4 h-4"/></button>
        <button disabled title="Download — coming soon" className="text-ink/30 grid place-items-center w-8 h-8 rounded-full cursor-not-allowed"><IconDownload className="w-4 h-4"/></button>
      </span>
    </div>
  );
}

function DownloadCard({ title, format, size, description }: { title: string; format: string; size: string; description: string }) {
  return (
    <div className="rounded-3xl border p-6 transition-all bg-white border-ink/10 shadow-card relative">
      <div className="flex items-start justify-between mb-3">
        <p className="text-[11px] uppercase tracking-wider font-semibold text-ink/50">{format}</p>
        <ComingSoonBadge/>
      </div>
      <div className="flex items-baseline justify-between gap-3 mb-2">
        <h3 className="text-lg font-bold text-ink">{title}</h3>
        <span className="text-xs tabular-nums text-ink/60">{size}</span>
      </div>
      <p className="text-xs leading-relaxed mb-5 text-ink/60">{description}</p>
      <button disabled title="Download — coming soon"
              className="w-full inline-flex items-center justify-center gap-2 rounded-full px-4 py-2 text-sm font-semibold transition-colors bg-ink/[0.03] text-ink/40 cursor-not-allowed">
        <IconDownload className="w-4 h-4"/> Download
      </button>
    </div>
  );
}

interface MetadataEditorProps {
  bookMeta: EditableBookMeta | null;
  onEditField: (field: EditableBookMetaField, value: string | null) => void;
  onCommit: () => void;
  onCancel: () => void;
  isDirty: boolean;
}

function MetadataEditor({ bookMeta, onEditField, onCommit, onCancel, isDirty }: MetadataEditorProps) {
  if (!bookMeta) {
    return (
      <div className="bg-white rounded-3xl border border-ink/10 p-8 shadow-card">
        <SectionLabel>Metadata</SectionLabel>
        <p className="mt-4 text-sm text-ink/50">Loading metadata…</p>
      </div>
    );
  }
  return (
    <div className="bg-white rounded-3xl border border-ink/10 p-8 shadow-card">
      <SectionLabel>Metadata</SectionLabel>
      <div className="mt-3 mb-6"><MixedHeading regular="Edit the" bold="audiobook details"/></div>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-x-8 gap-y-5">
        <MetaField label="Title"            value={bookMeta.title}
                   onChange={(v) => onEditField('title', v)}/>
        <MetaField label="Author"           value={bookMeta.author}
                   onChange={(v) => onEditField('author', v)}/>
        <MetaField label="Narrator credit"  value={bookMeta.narratorCredit ?? ''}
                   onChange={(v) => onEditField('narratorCredit', v || null)}/>
        <MetaField label="Series"           value={bookMeta.series}
                   onChange={(v) => onEditField('series', v)}/>
        <MetaField label="Genre"            value={bookMeta.genre ?? ''}
                   onChange={(v) => onEditField('genre', v || null)}/>
        <MetaField label="Publication date" value={bookMeta.publicationDate ?? ''}
                   onChange={(v) => onEditField('publicationDate', v || null)} type="date"/>
        <div className="md:col-span-2">
          <p className="text-[11px] uppercase tracking-wider text-ink/50 font-semibold mb-2">Cover art</p>
          <div className="flex items-center gap-4">
            <div className="w-16 h-16 rounded-xl bg-gradient-cta shadow-card"/>
            <div className="flex items-center gap-2">
              <button disabled title="Replace cover — coming soon" className="px-3 py-2 rounded-full border border-ink/15 text-xs font-medium text-ink/40 inline-flex items-center gap-1.5 cursor-not-allowed"><IconUpload className="w-3.5 h-3.5"/> Replace <ComingSoonBadge/></button>
              <button disabled title="Regenerate cover — coming soon" className="px-3 py-2 rounded-full border border-ink/15 text-xs font-medium text-ink/40 inline-flex items-center gap-1.5 cursor-not-allowed"><IconRefresh className="w-3.5 h-3.5"/> Regenerate <ComingSoonBadge/></button>
            </div>
          </div>
        </div>
      </div>
      <div className="mt-8 pt-6 border-t border-ink/10 flex items-center justify-end gap-3">
        <button onClick={onCancel} disabled={!isDirty}
                className="text-sm font-medium text-ink/60 hover:text-ink disabled:opacity-40 disabled:cursor-not-allowed"
                data-testid="meta-cancel">
          Cancel
        </button>
        <PrimaryButton variant="dark" onClick={onCommit} disabled={!isDirty}>
          Save changes
        </PrimaryButton>
      </div>
    </div>
  );
}

interface MetaFieldProps {
  label: string;
  value: string;
  onChange: (value: string) => void;
  type?: string;
}
function MetaField({ label, value, onChange, type = 'text' }: MetaFieldProps) {
  return (
    <label className="block">
      <span className="text-[11px] uppercase tracking-wider text-ink/50 font-semibold">{label}</span>
      <input type={type} value={value} onChange={(e) => onChange(e.target.value)} aria-label={label}
             className="mt-1 w-full px-3 py-2 rounded-xl bg-canvas border border-ink/10 text-sm text-ink focus:outline-none focus:border-ink/30"/>
    </label>
  );
}

interface ListenerAppsProps {
  onSend: (app: ListenerApp) => void;
  /** PocketBook is live: clicking its tile opens the export modal on the
      Download-to-phone tab. */
  onOpenPocketBookExport: () => void;
  /** Voice is live: clicking its tile opens the export modal pre-set to
      M4B + sync-folder with appHint='voice' so the format and destination
      toggles are hidden. */
  onOpenVoiceExport: () => void;
  /** Smart AudioBook Player is live (plan 34 B2): mp3-folder + sync-folder
      with appHint='smart_audiobook'. */
  onOpenSmartAudiobookExport: () => void;
  /** BookPlayer is live (plan 34 B3): mp3-folder + sync-folder with
      appHint='bookplayer'. iOS via Files import or AirDrop from a Mac. */
  onOpenBookplayerExport: () => void;
  /** Audiobookshelf is live (plan 34 B4): mp3-folder + sync-folder with
      appHint='audiobookshelf'. Self-hosted server scans the library
      root for folders. */
  onOpenAudiobookshelfExport: () => void;
}
function ListenerApps({
  onSend, onOpenPocketBookExport, onOpenVoiceExport, onOpenSmartAudiobookExport,
  onOpenBookplayerExport, onOpenAudiobookshelfExport,
}: ListenerAppsProps) {
  /* Per-app live handlers. Tiles not in this map render as disabled
     coming-soon placeholders. */
  const liveHandlers: Record<string, () => void> = {
    pocketbook:      onOpenPocketBookExport,
    voice:           onOpenVoiceExport,
    smart_audiobook: onOpenSmartAudiobookExport,
    bookplayer:      onOpenBookplayerExport,
    audiobookshelf:  onOpenAudiobookshelfExport,
  };
  return (
    <section className="mb-12">
      <div className="flex items-center justify-between mb-3 flex-wrap gap-2">
        <SectionLabel>Listen on your favourite app</SectionLabel>
        <span className="text-xs text-ink/50 inline-flex items-center gap-1.5"><IconShield className="w-3.5 h-3.5"/> Open-format export · DRM-free</span>
      </div>
      <MockedPreviewBanner>direct handoff to other apps is coming soon. PocketBook, Voice, Smart AudioBook Player, BookPlayer, and Audiobookshelf are live — click any to sideload.</MockedPreviewBanner>
      <div className="mt-3 grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {SUPPORTED_APPS.map(a => (
          <ListenerAppCard
            key={a.id}
            app={a}
            onSend={onSend}
            onOpenLiveExport={liveHandlers[a.id]}
          />
        ))}
      </div>
      <p className="mt-4 text-xs text-ink/50 text-center">Don't see your app? Any player that supports MP3.ZIP or M4B with chapter markers will work — use the manual download below.</p>
    </section>
  );
}

interface ListenerAppCardProps {
  app: ListenerApp;
  onSend: (a: ListenerApp) => void;
  /** Present only for live tiles (PocketBook, Voice, Smart AudioBook
      Player). When set, turns the
      disabled-placeholder pill into a real button. */
  onOpenLiveExport?: () => void;
}
function ListenerAppCard({ app, onSend: _onSend, onOpenLiveExport }: ListenerAppCardProps) {
  const [from, to] = app.gradient;
  /* onSend is intentionally not wired while non-live integrations are
     mocked. Keep the prop for forward-compat so flipping each card to live
     only touches the tile, not the route. */
  void _onSend;
  const isLive = onOpenLiveExport != null;
  return (
    <article data-testid={`listener-app-${app.id}`}
             className="bg-white rounded-3xl border border-ink/10 shadow-card p-5 flex flex-col">
      <div className="flex items-start gap-3 mb-3">
        <span className="w-12 h-12 rounded-2xl shadow-card grid place-items-center text-white font-bold text-sm shrink-0" style={{ background: `linear-gradient(135deg, ${from}, ${to})` }}>
          {app.glyph}
        </span>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <h3 className="font-bold text-ink leading-tight">{app.name}</h3>
            {isLive ? null : <ComingSoonBadge/>}
          </div>
          <p className="text-xs text-ink/55 mt-0.5">{app.tagline}</p>
        </div>
      </div>
      <div className="flex flex-wrap gap-1 mb-3">
        {app.platforms.map(p => <Pill key={p}>{p}</Pill>)}
      </div>
      <p className="text-xs text-ink/65 leading-relaxed mb-5 flex-1">{app.description}</p>
      {isLive ? (
        <button onClick={onOpenLiveExport}
                data-testid={`listener-app-action-${app.id}`}
                className="w-full inline-flex items-center justify-center gap-2 rounded-full px-4 py-2 text-sm font-semibold transition-colors bg-ink text-canvas hover:bg-ink-soft">
          <IconExternal className="w-4 h-4"/> {app.sendVerb}
        </button>
      ) : (
        <button disabled title={`${app.sendVerb} — coming soon`}
                data-testid={`listener-app-action-${app.id}`}
                className="w-full inline-flex items-center justify-center gap-2 rounded-full px-4 py-2 text-sm font-semibold transition-colors bg-ink/[0.03] text-ink/40 cursor-not-allowed">
          <IconExternal className="w-4 h-4"/> {app.sendVerb}
        </button>
      )}
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
        {visible.map(it => (
          <ExportQueueRow
            key={it.id}
            item={it}
            onDownload={it.url
              ? (clicked) => { if (clicked.url) window.location.assign(clicked.url); }
              : undefined}
          />
        ))}
      </div>
    </section>
  );
}
