/* Confirm-metadata screen. Sits between the file picker (UploadView) and
   analysis. Pre-fills the author / series / position / title fields from
   what the parser was able to extract (EPUB OPF metadata, filename pattern,
   markdown H1 fallback). On confirm, POSTs /api/books which writes the
   manuscript into the workspace and creates `.audiobook/state.json`. */

import { useState, useMemo } from 'react';
import { useAppDispatch, useAppSelector } from '../store';
import { uiActions } from '../store/ui-slice';
import { manuscriptActions } from '../store/manuscript-slice';
import { libraryActions } from '../store/library-slice';
import { api, SlugCollisionError } from '../lib/api';
import { SectionLabel, MixedHeading, PrimaryButton } from '../components/primitives';
import { ChapterExclusionList } from '../components/chapter-exclusion-list';
import { IconSpinner } from '../lib/icons';
import type { ConfirmBookResponse, LibraryBook } from '../lib/types';
import { chapterSlug } from '../lib/chapter-heuristics';

export function ConfirmMetadataView() {
  const dispatch = useAppDispatch();
  const candidate = useAppSelector((s) => s.manuscript.importCandidate);

  const [author, setAuthor] = useState(candidate?.author ?? '');
  const [isStandalone, setIsStandalone] = useState<boolean>(
    candidate?.series == null && candidate?.seriesPosition == null,
  );
  const [series, setSeries] = useState(candidate?.series ?? '');
  const [seriesPosition, setSeriesPosition] = useState<string>(
    candidate?.seriesPosition != null ? String(candidate.seriesPosition) : '',
  );
  const [title, setTitle] = useState(candidate?.title ?? '');
  /* fs-41/fs-50 — language seeded from server detection (language/languageSupported/
     supportedLanguages). Tracked-touched so the "auto-detected" chip clears once
     the user confirms or overrides. Unsupported detection → default to English. */
  const options = candidate?.supportedLanguages ?? [{ code: 'en', label: 'English' }];
  const detectedSupported = candidate?.languageSupported !== false;
  const [language, setLanguage] = useState<string>(
    () => (detectedSupported ? (candidate?.language ?? 'en') : 'en'),
  );
  const [languageTouched, setLanguageTouched] = useState(false);
  const detectedLabel =
    options.find((o) => o.code === candidate?.language)?.label ?? candidate?.language ?? '';
  const unsupportedLabel = candidate?.languageSupported === false
    ? (() => {
        const code = candidate?.language ?? '';
        try {
          return new Intl.DisplayNames(['en'], { type: 'language' }).of(code) ?? code.toUpperCase();
        } catch {
          return code.toUpperCase();
        }
      })()
    : null;
  /* Bug B: server marks series/seriesPosition as title-extracted when it
     fell back to the parenthetical heuristic. Surface a small chip so the
     user knows the value is a guess; clear the flag on any edit so the
     chip disappears once the user confirms or corrects the value. */
  const [seriesFromTitle, setSeriesFromTitle] = useState<boolean>(
    candidate?.seriesFromTitle ?? false,
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /* Auto-suggest front/back-matter exclusion. Pre-tick the chapter's
     checkbox as "include" by default; we then *un-tick* any chapter
     whose title or length matches the heuristic. Stored as a Set of
     server-derived slugs because that's the wire format /api/books
     accepts. Computed once from the candidate so navigating back +
     forward doesn't lose the user's overrides — but if they pick a
     different file the candidate ref changes and we recompute fresh. */
  const initialExcludedSlugs = useMemo(() => {
    if (!candidate) return new Set<string>();
    const out = new Set<string>();
    for (const ch of candidate.chapters) {
      if (ch.isLikelyFrontMatter) {
        out.add(chapterSlug(ch.id, ch.title));
      }
    }
    return out;
  }, [candidate]);
  const [excludedSlugs, setExcludedSlugs] = useState<Set<string>>(initialExcludedSlugs);
  const [showChapterList, setShowChapterList] = useState<boolean>(false);

  const autoDetected = useMemo(() => {
    if (!candidate) return false;
    return Boolean(candidate.author || candidate.series || candidate.seriesPosition);
  }, [candidate]);

  if (!candidate) {
    return null; // App.tsx only renders us when a candidate exists.
  }

  const libraryBooks = useAppSelector((s) => s.library.books);

  const trimmedAuthor = author.trim();
  const trimmedTitle = title.trim();
  const trimmedSeries = series.trim();
  const seriesPosNum = seriesPosition.trim() ? parseFloat(seriesPosition.trim()) : NaN;
  const canSubmit =
    !busy &&
    trimmedAuthor.length > 0 &&
    trimmedTitle.length > 0 &&
    (isStandalone || (trimmedSeries.length > 0 && Number.isFinite(seriesPosNum)));

  /* Heads-up if a different book in the same series already claims this number.
     Match on case-insensitive series + numeric equality; don't block save —
     the user may legitimately be re-importing or correcting an existing entry. */
  const duplicatePositionBook = useMemo(() => {
    if (isStandalone || !trimmedSeries || !Number.isFinite(seriesPosNum)) return null;
    const seriesKey = trimmedSeries.toLowerCase();
    return (
      libraryBooks.find(
        (b) =>
          !b.isStandalone &&
          b.series?.trim().toLowerCase() === seriesKey &&
          typeof b.seriesPosition === 'number' &&
          b.seriesPosition === seriesPosNum,
      ) ?? null
    );
  }, [isStandalone, trimmedSeries, seriesPosNum, libraryBooks]);

  async function handleSubmit(): Promise<void> {
    if (!candidate || !canSubmit) return;
    setError(null);
    setBusy(true);
    try {
      const res: ConfirmBookResponse = await api.confirmBook({
        tempId: candidate.tempId,
        author: trimmedAuthor,
        series: isStandalone ? 'Standalones' : trimmedSeries,
        seriesPosition: isStandalone ? null : seriesPosNum,
        title: trimmedTitle,
        isStandalone,
        language,
        excludedSlugs: excludedSlugs.size > 0 ? [...excludedSlugs] : undefined,
      });
      dispatch(manuscriptActions.uploadComplete(res));
      // Optimistically add to library so the books view reflects it immediately.
      const optimistic: LibraryBook = {
        bookId: res.bookId,
        title: res.title,
        author: res.author,
        series: res.series,
        seriesPosition: res.seriesPosition,
        isStandalone: res.isStandalone,
        status: 'analysing',
        manuscriptId: res.manuscriptId,
        chapterCount: candidate.chapters.length - excludedSlugs.size,
        completedChapters: 0,
        characterCount: 0,
        voiceCount: 0,
        lastWorkedOn: 'Just now',
        coverGradient: ['#3C194F', '#0F0E0D'],
        tags: [],
        language,
      };
      dispatch(libraryActions.addBook(optimistic));
      dispatch(
        uiActions.manuscriptUploaded({
          bookId: res.bookId,
          manuscriptId: res.manuscriptId,
        }),
      );
    } catch (e) {
      if (e instanceof SlugCollisionError) {
        setTitle(e.suggestedTitle);
        setError(`A book with that title already exists. We've suggested "${e.suggestedTitle}".`);
      } else {
        setError((e as Error)?.message || 'Failed to save book.');
      }
      setBusy(false);
    }
  }

  function handleBack(): void {
    dispatch(manuscriptActions.setImportCandidate(null));
  }

  return (
    <div className="relative min-h-[calc(100vh-64px)] flex items-center justify-center px-6 py-16">
      <div className="absolute inset-0 bg-gradient-hero-wash opacity-90 pointer-events-none" />
      <div className="relative max-w-2xl w-full">
        <div className="text-center mb-8">
          <SectionLabel>Confirm book details</SectionLabel>
          <div className="mt-5">
            <MixedHeading level="h1" regular="A few details before we" bold="meet the cast" />
          </div>
          <p className="mt-4 text-base text-ink/70">
            We'll save this book to your workspace under{' '}
            <code className="px-1.5 py-0.5 rounded bg-ink/5 text-[12px]">
              books/{trimmedAuthor || '…'}/{isStandalone ? 'Standalones' : trimmedSeries || '…'}/
              {trimmedTitle || '…'}/
            </code>
            .
          </p>
          {!autoDetected && (
            <p className="mt-3 text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-full inline-block px-4 py-1.5">
              We couldn't auto-detect this — please fill it in below.
            </p>
          )}
        </div>

        <div className="bg-white rounded-3xl border border-ink/10 shadow-card p-7 space-y-5">
          <Field label="Author" required>
            <input
              value={author}
              disabled={busy}
              onChange={(e) => setAuthor(e.target.value)}
              placeholder="e.g. Ursula K. Le Guin"
              className="w-full rounded-xl border border-ink/15 bg-white text-ink px-4 py-2.5 text-sm focus:outline-hidden focus:border-peach disabled:opacity-50"
            />
          </Field>

          <div className="flex items-center gap-3 pt-1">
            <input
              id="standalone"
              type="checkbox"
              checked={isStandalone}
              onChange={(e) => setIsStandalone(e.target.checked)}
              disabled={busy}
              className="rounded border-ink/20"
            />
            <label htmlFor="standalone" className="text-sm text-ink/80 select-none">
              This is a standalone (not part of a series)
            </label>
          </div>

          {!isStandalone && (
            <>
              <div className="grid grid-cols-[1fr_120px] gap-3">
                <Field label="Series" required>
                  <input
                    value={series}
                    disabled={busy}
                    onChange={(e) => {
                      setSeries(e.target.value);
                      setSeriesFromTitle(false);
                    }}
                    placeholder="e.g. Earthsea"
                    className="w-full rounded-xl border border-ink/15 bg-white text-ink px-4 py-2.5 text-sm focus:outline-hidden focus:border-peach disabled:opacity-50"
                  />
                </Field>
                <Field label="Book #" required>
                  <input
                    value={seriesPosition}
                    disabled={busy}
                    inputMode="decimal"
                    onChange={(e) => {
                      /* Keep digits + the first dot only — supports novella positions like 1.5. */
                      let v = e.target.value.replace(/[^0-9.]/g, '');
                      const dot = v.indexOf('.');
                      if (dot !== -1) v = v.slice(0, dot + 1) + v.slice(dot + 1).replace(/\./g, '');
                      setSeriesPosition(v);
                      setSeriesFromTitle(false);
                    }}
                    placeholder="1"
                    className="w-full rounded-xl border border-ink/15 bg-white text-ink px-4 py-2.5 text-sm focus:outline-hidden focus:border-peach disabled:opacity-50 tabular-nums"
                  />
                </Field>
              </div>
              {seriesFromTitle && (
                <p className="-mt-2">
                  <span className="inline-block text-[10px] uppercase tracking-widest font-semibold text-magenta bg-magenta/10 border border-magenta/20 rounded-full px-2.5 py-0.5">
                    Auto-extracted from title — verify
                  </span>
                </p>
              )}
            </>
          )}

          {duplicatePositionBook && (
            <div className="-mt-2 px-4 py-2.5 rounded-2xl bg-amber-50 border border-amber-200 text-xs text-amber-900">
              <span className="font-semibold">Heads-up:</span> "{duplicatePositionBook.title}" is
              already saved as {duplicatePositionBook.series} #
              {duplicatePositionBook.seriesPosition}. Saving will create a separate entry — change
              the number if that's not what you want.
            </div>
          )}

          <Field label="Title" required>
            <input
              value={title}
              disabled={busy}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="e.g. A Wizard of Earthsea"
              className="w-full rounded-xl border border-ink/15 bg-white text-ink px-4 py-2.5 text-sm focus:outline-hidden focus:border-peach disabled:opacity-50"
            />
          </Field>

          <Field label="Language" required>
            <select
              value={language}
              disabled={busy}
              data-testid="confirm-language"
              onChange={(e) => {
                setLanguage(e.target.value);
                setLanguageTouched(true);
              }}
              className="w-full rounded-xl border border-ink/15 bg-white text-ink px-4 py-2.5 text-sm focus:outline-hidden focus:border-peach disabled:opacity-50"
            >
              {options.map((o) => (
                <option key={o.code} value={o.code}>{o.label}</option>
              ))}
            </select>
            {!languageTouched && detectedSupported && candidate?.language && candidate.language !== 'en' && (
              <p className="mt-1.5">
                <span className="inline-block text-[10px] uppercase tracking-widest font-semibold text-magenta bg-magenta/10 border border-magenta/20 rounded-full px-2.5 py-0.5">
                  Auto-detected {detectedLabel} — verify
                </span>
              </p>
            )}
            {language !== 'en' && (
              <p className="mt-1.5 text-[11px] text-ink/55">
                {detectedLabel || 'Non-English'} books narrate with designed Qwen voices — you'll design a
                voice for the narrator and each speaking character in the cast view.
              </p>
            )}
            {unsupportedLabel && (
              <p className="mt-1.5 text-[11px] text-magenta">
                We detected {unsupportedLabel}, which is not supported yet — pick a supported language below,
                or this book can't be generated.
              </p>
            )}
          </Field>

          <div className="pt-2 grid grid-cols-3 gap-3 text-[11px] text-ink/55">
            <Stat label="Format" value={candidate.format} />
            <Stat label="Word count" value={candidate.wordCount.toLocaleString()} />
            <Stat
              label={
                excludedSlugs.size > 0
                  ? `Chapters (${candidate.chapters.length - excludedSlugs.size} of ${candidate.chapters.length})`
                  : 'Chapters detected'
              }
              value={
                excludedSlugs.size > 0
                  ? `${candidate.chapters.length - excludedSlugs.size}`
                  : String(candidate.chapters.length)
              }
            />
          </div>

          <ChapterExclusionList
            chapters={candidate.chapters}
            excludedSlugs={excludedSlugs}
            onToggle={(slug, include) => {
              setExcludedSlugs((prev) => {
                const next = new Set(prev);
                if (include) next.delete(slug);
                else next.add(slug);
                return next;
              });
            }}
            onSelectAll={() => setExcludedSlugs(new Set())}
            onResetSuggestions={() => setExcludedSlugs(new Set(initialExcludedSlugs))}
            expanded={showChapterList}
            onToggleExpanded={() => setShowChapterList((v) => !v)}
            disabled={busy}
          />

          {error && (
            <div className="px-4 py-3 rounded-2xl bg-rose-50 border border-rose-200 text-sm text-rose-900">
              {error}
            </div>
          )}

          <div className="flex items-center justify-between pt-2">
            <button
              onClick={handleBack}
              disabled={busy}
              className="text-sm text-ink/60 hover:text-ink disabled:opacity-50"
            >
              ← Pick a different file
            </button>
            <PrimaryButton variant="dark" onClick={handleSubmit} disabled={!canSubmit}>
              <span className="inline-flex items-center gap-2">
                {busy && <IconSpinner className="w-4 h-4" />}
                {busy ? 'Saving…' : 'Save book and start analysis'}
              </span>
            </PrimaryButton>
          </div>
        </div>
      </div>
    </div>
  );
}

function Field({
  label,
  required,
  children,
}: {
  label: string;
  required?: boolean;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span className="text-xs uppercase tracking-[0.12em] font-semibold text-ink/55">
        {label}
        {required && <span className="text-magenta ml-1">*</span>}
      </span>
      <div className="mt-1.5">{children}</div>
    </label>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl bg-canvas px-3 py-2.5">
      <p className="text-[10px] uppercase tracking-[0.12em] text-ink/45 font-medium">{label}</p>
      <p className="mt-0.5 text-[13px] font-semibold text-ink tabular-nums">{value}</p>
    </div>
  );
}
