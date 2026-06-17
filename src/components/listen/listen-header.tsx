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

import { useState } from 'react';
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
  IconChevD,
  IconChevR,
} from '../../lib/icons';
import { type CoverFraming, computeCoverStyle } from '../../lib/cover-framing';
import { safeImageSrc } from '../../lib/safe-url';
import {
  SectionLabel,
  MixedHeading,
  PrimaryButton,
  ComingSoonBadge,
} from '../primitives';
import { RestructureChaptersButton } from '../restructure-chapters-button';
import { formatTime } from '../../lib/time';
import type { EditableBookMeta, EditableBookMetaField } from '../../store/book-meta-slice';

/* fs-2 — human label for a BCP-47 book language badge. */
function languageLabel(language: string): string {
  if (language.toLowerCase().startsWith('ru')) return 'Russian';
  if (language.toLowerCase().startsWith('en')) return 'English';
  return language.toUpperCase();
}

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
          src={safeImageSrc(imageUrl)}
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
        /* Hover-only on devices that can hover (desktop); always
           visible on touch devices so phone users can still pick a
           cover. `(hover: none)` media query via Tailwind's `[@media...]`
           arbitrary-variant escape. */
        <button
          type="button"
          onClick={onChangeCover}
          aria-label="Change cover image"
          data-testid="listen-change-cover"
          className="absolute bottom-3 right-3 inline-flex items-center gap-1.5 min-h-[36px] px-3 py-2 rounded-full bg-black/55 text-white text-[11px] font-medium transition-opacity md:opacity-0 md:group-hover:opacity-100 md:focus:opacity-100 [@media(hover:none)]:opacity-100"
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
  /** Plan 74 — re-upload entry point. Click flips ui-slice into
      re-upload mode and navigates to the upload view; the diff modal
      mounts when the import resolves. Optional so existing test
      harnesses that don't pass it keep compiling — when absent the
      button is hidden. */
  onReplaceManuscript?: () => void;
  /** Plan 67 — per-book editorial notes (markdown plain text). null /
      empty string suppresses the collapsible card. Markdown line breaks
      render via whitespace-pre-wrap (no markdown parsing). */
  notes: string | null;
  /** fs-2 — BCP-47 book language. A badge is shown only for non-English books
      (English is the unmarked default, so the existing library gets no new
      chrome). Optional so test harnesses that omit it keep compiling. */
  language?: string;
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
  onReplaceManuscript,
  notes,
  language,
}: ListenHeaderProps) {
  /* Plan 67 — collapsible Notes card. Default collapsed so the header
     stays compact; expands inline when the user clicks the affordance.
     Local-only state — Notes is read-only here; edits flow through the
     metadata editor at the bottom of the view. */
  const [notesExpanded, setNotesExpanded] = useState(false);
  const trimmedNotes = (notes ?? '').trim();
  const hasNotes = trimmedNotes.length > 0;
  return (
    <>
    <section className="grid grid-cols-1 md:grid-cols-[260px_1fr] lg:grid-cols-[320px_1fr] gap-6 md:gap-8 lg:gap-10 items-end mb-8 md:mb-12">
      {/* On <md viewports the cover is constrained + centred so a 375 px
          phone doesn't get a full-width 350+ px tile that crowds the
          title. md+ honours the grid track width and removes the cap. */}
      <div className="w-full max-w-[260px] sm:max-w-[300px] mx-auto md:mx-0 md:max-w-none">
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
      </div>
      <div>
        <SectionLabel>Audiobook · ready to listen</SectionLabel>
        <h1 className="mt-4 text-3xl sm:text-4xl md:text-5xl lg:text-6xl font-bold leading-[1.05] tracking-tight font-serif">
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
        <p className="mt-2 text-xs text-ink/50">Full-cast audiobook · made with Castwright</p>
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
          {language && language !== 'en' && (
            <>
              <span>·</span>
              <span
                data-testid="listen-language-badge"
                className="inline-block text-[11px] font-semibold uppercase tracking-[0.08em] text-magenta bg-magenta/10 border border-magenta/20 rounded-full px-2.5 py-0.5"
              >
                {languageLabel(language)}
              </span>
            </>
          )}
          <span>·</span>
          <span>
            <span className="font-semibold text-ink">{completedCount}</span> chapters voiced
          </span>
        </div>
        {/* min-h-[44px] on every action button keeps WCAG 2.5.5 touch
            targets honoured on phone without inflating desktop chrome. */}
        <div className="mt-6 md:mt-7 flex flex-wrap items-center gap-2 md:gap-3">
          <button
            onClick={() => {
              if (hasListenable && firstListenableId != null) onPlayFromStart(firstListenableId);
            }}
            disabled={!hasListenable}
            className="min-h-[44px] inline-flex items-center gap-3 rounded-full bg-ink text-canvas hover:bg-ink-soft pl-5 pr-6 py-3 text-sm font-semibold transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
          >
            <span className="w-8 h-8 rounded-full bg-canvas text-ink grid place-items-center">
              <IconPlay className="w-3.5 h-3.5 ml-0.5" />
            </span>
            Play from the start
          </button>
          <button
            onClick={onOpenExportModal}
            data-testid="open-export-modal"
            className="min-h-[44px] px-4 py-3 rounded-full border border-ink/15 bg-white text-sm font-medium text-ink/80 hover:text-ink inline-flex items-center gap-2"
          >
            <IconDownload className="w-4 h-4" /> Export audiobook
          </button>
          <button
            onClick={onEnterPreview}
            className="min-h-[44px] px-4 py-3 rounded-full border border-ink/15 bg-white text-sm font-medium text-ink/80 hover:text-ink inline-flex items-center gap-2"
          >
            <IconEye className="w-4 h-4" /> Preview as listener
          </button>
          <RestructureChaptersButton onClick={onOpenRestructure} />
          {onReplaceManuscript && (
            <button
              onClick={onReplaceManuscript}
              data-testid="listen-replace-manuscript"
              title="Re-upload manuscript to diff against the current text"
              className="min-h-[44px] px-4 py-3 rounded-full border border-ink/15 bg-white text-sm font-medium text-ink/80 hover:text-ink inline-flex items-center gap-2"
            >
              <IconUpload className="w-4 h-4" /> Replace manuscript
            </button>
          )}
          <button
            disabled
            title="Share — coming soon"
            className="min-h-[44px] px-4 py-3 rounded-full border border-ink/15 bg-white text-sm font-medium text-ink/40 inline-flex items-center gap-2 cursor-not-allowed"
          >
            <IconShare className="w-4 h-4" /> Share <ComingSoonBadge />
          </button>
        </div>
      </div>
    </section>
    {hasNotes && (
      <section className="mb-8 md:mb-12" data-testid="listen-notes-card">
        <button
          type="button"
          onClick={() => setNotesExpanded((v) => !v)}
          aria-expanded={notesExpanded}
          aria-controls="listen-notes-body"
          data-testid="listen-notes-toggle"
          className="min-h-[44px] w-full bg-white rounded-3xl border border-ink/10 px-4 sm:px-6 py-4 shadow-card flex items-center gap-3 text-left hover:border-ink/20 transition-colors"
        >
          {notesExpanded ? (
            <IconChevD className="w-4 h-4 text-ink/60" />
          ) : (
            <IconChevR className="w-4 h-4 text-ink/60" />
          )}
          <div className="flex-1 min-w-0">
            <p className="text-[10px] uppercase tracking-widest text-ink/50 font-semibold">
              Notes
            </p>
            <p className="text-sm text-ink/70 truncate">
              {notesExpanded ? 'Editorial notes for this book' : trimmedNotes.split('\n')[0]}
            </p>
          </div>
        </button>
        {notesExpanded && (
          <div
            id="listen-notes-body"
            data-testid="listen-notes-body"
            className="mt-2 bg-white rounded-3xl border border-ink/10 p-4 sm:p-6 shadow-card"
          >
            {/* whitespace-pre-wrap preserves the user's markdown line
                breaks verbatim without a markdown renderer (full markdown
                parsing is a follow-up). */}
            <p className="text-sm text-ink/80 whitespace-pre-wrap leading-relaxed">
              {trimmedNotes}
            </p>
          </div>
        )}
      </section>
    )}
    </>
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
        <div className="bg-white rounded-3xl border border-ink/10 p-5 sm:p-8 shadow-card">
          <SectionLabel>Metadata</SectionLabel>
          <p className="mt-4 text-sm text-ink/50">Loading metadata…</p>
        </div>
      </section>
    );
  }
  return (
    <section>
      <div className="bg-white rounded-3xl border border-ink/10 p-5 sm:p-8 shadow-card">
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
                className="mt-1.5 w-full px-3 py-2 rounded-xl border border-ink/15 bg-white text-sm text-ink placeholder:text-ink/30 focus:outline-hidden focus:ring-2 focus:ring-magenta/30 resize-y"
              />
            </label>
          </div>
          <div className="md:col-span-2">
            <label className="block">
              <span className="text-[11px] uppercase tracking-wider text-ink/50 font-semibold">
                Notes
              </span>
              {/* Plan 67 — workspace-internal editorial scratchpad
                  (never exported). Preserves line breaks verbatim via
                  whitespace-pre-wrap on the read side; no markdown
                  toolbar / parsing in v1. Trim-empty round-trips to
                  null so the cleared-value flow is unambiguous. */}
              <textarea
                value={bookMeta.notes ?? ''}
                onChange={(e) =>
                  onEditField('notes', e.target.value.trim() === '' ? null : e.target.value)
                }
                placeholder="Editorial notes — source attribution, license, narration intent. Workspace-internal (never exported)."
                rows={4}
                data-testid="meta-notes"
                className="mt-1.5 w-full px-3 py-2 rounded-xl border border-ink/15 bg-white text-sm text-ink placeholder:text-ink/30 focus:outline-hidden focus:ring-2 focus:ring-magenta/30 resize-y"
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
                  className="min-h-[44px] px-3 py-2 rounded-full border border-ink/15 text-xs font-medium text-ink/80 hover:text-ink hover:bg-ink/4 inline-flex items-center gap-1.5 transition-colors"
                >
                  <IconUpload className="w-3.5 h-3.5" /> Replace
                </button>
                <button
                  type="button"
                  onClick={onRegenerateCover}
                  title="Search OpenLibrary for a fresh cover candidate"
                  data-testid="meta-cover-regenerate"
                  className="min-h-[44px] px-3 py-2 rounded-full border border-ink/15 text-xs font-medium text-ink/80 hover:text-ink hover:bg-ink/4 inline-flex items-center gap-1.5 transition-colors"
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
        className="mt-1 w-full px-3 py-2 rounded-xl bg-canvas border border-ink/10 text-sm text-ink focus:outline-hidden focus:border-ink/30"
      />
    </label>
  );
}
