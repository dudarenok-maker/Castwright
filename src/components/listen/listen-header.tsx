/* Listen-view header region — pure presentational lift from listen.tsx.
   Owns: cover art + title/author/narrator line + runtime/chapter/format
   stats + the primary action row (Play / Export / Preview / Restructure /
   Share) AND the bottom metadata editor (book-meta fields + cover
   Replace/Regenerate). Behaviour-neutral split — every data-testid,
   className, and child order matches the pre-refactor JSX so the
   listen.test.tsx + listen-*.spec.ts selectors keep resolving.

   The mounted-by-exactly-one-parent rule (plan 60 acceptance criterion)
   makes these dumb-render components — all state + dispatchers stay in
   listen.tsx, so per-region behaviour testing doesn't fan out across
   files. */

import {
  IconPlay,
  IconHeadphones,
  IconWaveform,
  IconShare,
  IconDownload,
  IconEye,
  IconRefresh,
  IconUpload,
  IconImage,
} from '../../lib/icons';
import { type CoverFraming, computeCoverStyle } from '../../lib/cover-framing';
import {
  SectionLabel,
  MixedHeading,
  PrimaryButton,
  ComingSoonBadge,
} from '../primitives';
import { formatTime } from '../../lib/time';
import type { EditableBookMeta, EditableBookMetaField } from '../../store/book-meta-slice';

interface CoverArtProps {
  title: string;
  gradient: [string, string] | null;
  /** Server-relative cover URL when one is on disk; null/undefined
      renders the gradient skeleton only. */
  imageUrl?: string | null;
  /** Plan 40 render-time pan + zoom. Absent → bare object-cover. */
  framing?: CoverFraming;
  /** Called when the `<img>` 404s / errors out. Parent flips to
      gradient-only render. */
  onImageError?: () => void;
  runtime: string;
  narrator: string | null;
  /** Reveals a small hover-only "Change cover" button on the cover. */
  onChangeCover?: () => void;
}
function CoverArt({
  title,
  gradient,
  imageUrl,
  framing,
  onImageError,
  runtime,
  narrator,
  onChangeCover,
}: CoverArtProps) {
  const styled = gradient
    ? { background: `linear-gradient(135deg, ${gradient[0]}, ${gradient[1]})` }
    : undefined;
  return (
    <div
      data-testid="listen-cover-art"
      className={`group aspect-square rounded-3xl overflow-hidden shadow-float relative ${gradient ? '' : 'bg-gradient-cta'}`}
      style={styled}
    >
      <svg viewBox="0 0 320 320" className="absolute inset-0 w-full h-full opacity-25">
        <circle cx="160" cy="160" r="140" fill="none" stroke="white" strokeWidth="0.5" />
        <circle cx="160" cy="160" r="110" fill="none" stroke="white" strokeWidth="0.5" />
        <circle cx="160" cy="160" r="80" fill="none" stroke="white" strokeWidth="0.5" />
        <circle cx="160" cy="160" r="50" fill="none" stroke="white" strokeWidth="0.5" />
      </svg>
      {imageUrl && (
        <img
          data-testid="listen-cover-art-image"
          src={imageUrl}
          alt=""
          className="absolute inset-0 w-full h-full object-cover"
          style={computeCoverStyle(framing)}
          onError={onImageError}
        />
      )}
      <div className="absolute top-6 left-6 right-6 flex items-center justify-between">
        <p className="text-[10px] uppercase tracking-[0.2em] text-white/70 font-semibold">
          Audiobook
        </p>
        <IconHeadphones className="w-5 h-5 text-white/70" />
      </div>
      {!imageUrl && (
        <div className="absolute bottom-6 left-6 right-6">
          <h2 className="font-serif text-3xl font-bold text-white leading-[1.1]">{title || ' '}</h2>
          <p className="font-serif italic text-sm text-white/80 mt-1.5">A novel</p>
          <div className="mt-4 flex items-center gap-2 text-[10px] uppercase tracking-widest text-white/60">
            <IconWaveform className="w-3 h-3" />
            <span>
              {runtime}
              {narrator ? ` · narrated by ${narrator}` : ''}
            </span>
          </div>
        </div>
      )}
      {onChangeCover && (
        <button
          type="button"
          onClick={onChangeCover}
          aria-label="Change cover image"
          data-testid="listen-change-cover"
          className="absolute bottom-3 right-3 inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-black/55 text-white text-[11px] font-medium opacity-0 group-hover:opacity-100 focus:opacity-100 transition-opacity"
        >
          <IconImage className="w-3.5 h-3.5" /> Change cover
        </button>
      )}
    </div>
  );
}

interface ListenHeaderProps {
  title: string;
  author: string;
  narratorName: string | null;
  voiceCount: number;
  totalSec: number;
  chapterCount: number;
  completedCount: number;
  hasListenable: boolean;
  firstListenableId: number | null;
  bookCoverGradient: [string, string] | null;
  effectiveCoverUrl: string | null;
  effectiveFraming?: CoverFraming;
  coverLoadFailed: boolean;
  onCoverLoadFailed: () => void;
  onChangeCover: () => void;
  onPlayFromStart: (id: number) => void;
  onOpenExportModal: () => void;
  onEnterPreview: () => void;
  onOpenRestructure: () => void;
}

export function ListenHeader({
  title,
  author,
  narratorName,
  voiceCount,
  totalSec,
  chapterCount,
  completedCount,
  hasListenable,
  firstListenableId,
  bookCoverGradient,
  effectiveCoverUrl,
  effectiveFraming,
  coverLoadFailed,
  onCoverLoadFailed,
  onChangeCover,
  onPlayFromStart,
  onOpenExportModal,
  onEnterPreview,
  onOpenRestructure,
}: ListenHeaderProps) {
  return (
    <section className="grid grid-cols-1 md:grid-cols-[320px_1fr] gap-10 items-end mb-12">
      <CoverArt
        title={title}
        gradient={bookCoverGradient}
        imageUrl={!coverLoadFailed ? effectiveCoverUrl : null}
        framing={effectiveFraming}
        onImageError={onCoverLoadFailed}
        runtime={formatTime(totalSec)}
        narrator={narratorName}
        onChangeCover={onChangeCover}
      />
      <div>
        <SectionLabel>Audiobook · ready to listen</SectionLabel>
        <h1 className="mt-4 text-4xl md:text-5xl lg:text-6xl font-bold leading-[1.05] tracking-tight font-serif">
          {title || <span className="text-ink/30">Loading…</span>}
        </h1>
        <p className="mt-3 text-ink/70">
          By <span className="font-semibold text-ink">{author || '—'}</span>
          {narratorName ? (
            <>
              {' '}
              · narrated by <span className="font-semibold text-ink">{narratorName}</span>
            </>
          ) : null}
          {voiceCount > 0 ? (
            <>
              {' '}
              with a cast of {voiceCount} voice{voiceCount === 1 ? '' : 's'}
            </>
          ) : null}
        </p>
        <div className="mt-5 flex flex-wrap items-center gap-x-6 gap-y-2 text-sm text-ink/60">
          <span>
            <span className="font-semibold text-ink tabular-nums">{formatTime(totalSec)}</span>{' '}
            total runtime
          </span>
          <span>·</span>
          <span>
            <span className="font-semibold text-ink">{chapterCount}</span> chapters
          </span>
          <span>·</span>
          <span>FLAC + MP3</span>
          <span>·</span>
          <span>
            <span className="font-semibold text-ink">{completedCount}</span> chapters voiced
          </span>
        </div>
        <div className="mt-7 flex flex-wrap items-center gap-3">
          <button
            onClick={() => {
              if (hasListenable && firstListenableId != null) onPlayFromStart(firstListenableId);
            }}
            disabled={!hasListenable}
            className="inline-flex items-center gap-3 rounded-full bg-ink text-canvas hover:bg-ink-soft pl-5 pr-6 py-3 text-sm font-semibold transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
          >
            <span className="w-8 h-8 rounded-full bg-canvas text-ink grid place-items-center">
              <IconPlay className="w-3.5 h-3.5 ml-0.5" />
            </span>
            Play from the start
          </button>
          <button
            onClick={onOpenExportModal}
            data-testid="open-export-modal"
            className="px-4 py-3 rounded-full border border-ink/15 bg-white text-sm font-medium text-ink/80 hover:text-ink inline-flex items-center gap-2"
          >
            <IconDownload className="w-4 h-4" /> Export audiobook
          </button>
          <button
            onClick={onEnterPreview}
            className="px-4 py-3 rounded-full border border-ink/15 bg-white text-sm font-medium text-ink/80 hover:text-ink inline-flex items-center gap-2"
          >
            <IconEye className="w-4 h-4" /> Preview as listener
          </button>
          <button
            onClick={onOpenRestructure}
            data-testid="open-restructure"
            className="px-4 py-3 rounded-full border border-ink/15 bg-white text-sm font-medium text-ink/80 hover:text-ink inline-flex items-center gap-2"
          >
            <IconWaveform className="w-4 h-4" /> Restructure chapters
          </button>
          <button
            disabled
            title="Share — coming soon"
            className="px-4 py-3 rounded-full border border-ink/15 bg-white text-sm font-medium text-ink/40 inline-flex items-center gap-2 cursor-not-allowed"
          >
            <IconShare className="w-4 h-4" /> Share <ComingSoonBadge />
          </button>
        </div>
      </div>
    </section>
  );
}

interface ListenMetadataEditorProps {
  bookMeta: EditableBookMeta | null;
  onEditField: (field: EditableBookMetaField, value: string | null) => void;
  onCommit: () => void;
  onCancel: () => void;
  isDirty: boolean;
  onReplaceCover: () => void;
  onRegenerateCover: () => void;
}

/* Bottom-of-listen-view book-meta editor. Holds the cover Replace /
   Regenerate affordances that share the cover-picker modal mounted on
   the parent. */
export function ListenMetadataEditor({
  bookMeta,
  onEditField,
  onCommit,
  onCancel,
  isDirty,
  onReplaceCover,
  onRegenerateCover,
}: ListenMetadataEditorProps) {
  if (!bookMeta) {
    return (
      <section>
        <div className="bg-white rounded-3xl border border-ink/10 p-8 shadow-card">
          <SectionLabel>Metadata</SectionLabel>
          <p className="mt-4 text-sm text-ink/50">Loading metadata…</p>
        </div>
      </section>
    );
  }
  return (
    <section>
      <div className="bg-white rounded-3xl border border-ink/10 p-8 shadow-card">
        <SectionLabel>Metadata</SectionLabel>
        <div className="mt-3 mb-6">
          <MixedHeading regular="Edit the" bold="audiobook details" />
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-x-8 gap-y-5">
          <MetaField label="Title" value={bookMeta.title} onChange={(v) => onEditField('title', v)} />
          <MetaField
            label="Author"
            value={bookMeta.author}
            onChange={(v) => onEditField('author', v)}
          />
          <MetaField
            label="Narrator credit"
            value={bookMeta.narratorCredit ?? ''}
            onChange={(v) => onEditField('narratorCredit', v || null)}
          />
          <MetaField
            label="Series"
            value={bookMeta.series}
            onChange={(v) => onEditField('series', v)}
          />
          <MetaField
            label="Genre"
            value={bookMeta.genre ?? ''}
            onChange={(v) => onEditField('genre', v || null)}
          />
          <MetaField
            label="Publication date"
            value={bookMeta.publicationDate ?? ''}
            onChange={(v) => onEditField('publicationDate', v || null)}
            type="date"
          />
          <div className="md:col-span-2">
            <label className="block">
              <span className="text-[11px] uppercase tracking-wider text-ink/50 font-semibold">
                Description
              </span>
              <textarea
                value={bookMeta.description ?? ''}
                onChange={(e) => onEditField('description', e.target.value || null)}
                placeholder="About this audiobook — travels into M4B desc/ldes atoms on export."
                rows={4}
                data-testid="meta-description"
                className="mt-1.5 w-full px-3 py-2 rounded-xl border border-ink/15 bg-white text-sm text-ink placeholder:text-ink/30 focus:outline-none focus:ring-2 focus:ring-magenta/30 resize-y"
              />
            </label>
          </div>
          <div className="md:col-span-2">
            <p className="text-[11px] uppercase tracking-wider text-ink/50 font-semibold mb-2">
              Cover art
            </p>
            <div className="flex items-center gap-4">
              <div className="w-16 h-16 rounded-xl bg-gradient-cta shadow-card" />
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={onReplaceCover}
                  title="Upload a new cover from disk"
                  data-testid="meta-cover-replace"
                  className="px-3 py-2 rounded-full border border-ink/15 text-xs font-medium text-ink/80 hover:text-ink hover:bg-ink/[0.04] inline-flex items-center gap-1.5 transition-colors"
                >
                  <IconUpload className="w-3.5 h-3.5" /> Replace
                </button>
                <button
                  type="button"
                  onClick={onRegenerateCover}
                  title="Search OpenLibrary for a fresh cover candidate"
                  data-testid="meta-cover-regenerate"
                  className="px-3 py-2 rounded-full border border-ink/15 text-xs font-medium text-ink/80 hover:text-ink hover:bg-ink/[0.04] inline-flex items-center gap-1.5 transition-colors"
                >
                  <IconRefresh className="w-3.5 h-3.5" /> Regenerate
                </button>
              </div>
            </div>
          </div>
        </div>
        <div className="mt-8 pt-6 border-t border-ink/10 flex items-center justify-end gap-3">
          <button
            onClick={onCancel}
            disabled={!isDirty}
            className="text-sm font-medium text-ink/60 hover:text-ink disabled:opacity-40 disabled:cursor-not-allowed"
            data-testid="meta-cancel"
          >
            Cancel
          </button>
          <PrimaryButton variant="dark" onClick={onCommit} disabled={!isDirty}>
            Save changes
          </PrimaryButton>
        </div>
      </div>
    </section>
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
      <span className="text-[11px] uppercase tracking-wider text-ink/50 font-semibold">
        {label}
      </span>
      <input
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        aria-label={label}
        className="mt-1 w-full px-3 py-2 rounded-xl bg-canvas border border-ink/10 text-sm text-ink focus:outline-none focus:border-ink/30"
      />
    </label>
  );
}
