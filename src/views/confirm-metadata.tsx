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
import { IconSpinner } from '../lib/icons';
import type { ConfirmBookResponse, LibraryBook } from '../lib/types';

export function ConfirmMetadataView() {
  const dispatch = useAppDispatch();
  const candidate = useAppSelector(s => s.manuscript.importCandidate);

  const [author, setAuthor]                 = useState(candidate?.author ?? '');
  const [isStandalone, setIsStandalone]     = useState<boolean>(candidate?.series == null && candidate?.seriesPosition == null);
  const [series, setSeries]                 = useState(candidate?.series ?? '');
  const [seriesPosition, setSeriesPosition] = useState<string>(
    candidate?.seriesPosition != null ? String(candidate.seriesPosition) : '',
  );
  const [title, setTitle] = useState(candidate?.title ?? '');
  const [busy, setBusy]   = useState(false);
  const [error, setError] = useState<string | null>(null);

  const autoDetected = useMemo(() => {
    if (!candidate) return false;
    return Boolean(candidate.author || candidate.series || candidate.seriesPosition);
  }, [candidate]);

  if (!candidate) {
    return null; // App.tsx only renders us when a candidate exists.
  }

  const trimmedAuthor = author.trim();
  const trimmedTitle  = title.trim();
  const trimmedSeries = series.trim();
  const seriesPosNum  = seriesPosition.trim() ? parseInt(seriesPosition.trim(), 10) : NaN;
  const canSubmit =
    !busy &&
    trimmedAuthor.length > 0 &&
    trimmedTitle.length > 0 &&
    (isStandalone || (trimmedSeries.length > 0 && !Number.isNaN(seriesPosNum)));

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
        chapterCount: candidate.chapters.length,
        completedChapters: 0,
        characterCount: 0,
        voiceCount: 0,
        lastWorkedOn: 'Just now',
        coverGradient: ['#3C194F', '#0F0E0D'],
      };
      dispatch(libraryActions.addBook(optimistic));
      dispatch(uiActions.manuscriptUploaded({
        bookId: res.bookId,
        manuscriptId: res.manuscriptId,
      }));
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
      <div className="absolute inset-0 bg-gradient-hero-wash opacity-90 pointer-events-none"/>
      <div className="relative max-w-2xl w-full">
        <div className="text-center mb-8">
          <SectionLabel>Confirm book details</SectionLabel>
          <div className="mt-5">
            <MixedHeading level="h1" regular="A few details before we" bold="meet the cast"/>
          </div>
          <p className="mt-4 text-base text-ink/70">
            We'll save this book to your workspace under <code className="px-1.5 py-0.5 rounded bg-ink/5 text-[12px]">books/{trimmedAuthor || '…'}/{isStandalone ? 'Standalones' : (trimmedSeries || '…')}/{trimmedTitle || '…'}/</code>.
          </p>
          {!autoDetected && (
            <p className="mt-3 text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-full inline-block px-4 py-1.5">
              We couldn't auto-detect this — please fill it in below.
            </p>
          )}
        </div>

        <div className="bg-white rounded-3xl border border-ink/10 shadow-card p-7 space-y-5">
          <Field label="Author" required>
            <input value={author} disabled={busy}
                   onChange={(e) => setAuthor(e.target.value)}
                   placeholder="e.g. Ursula K. Le Guin"
                   className="w-full rounded-xl border border-ink/15 px-4 py-2.5 text-sm focus:outline-none focus:border-peach disabled:opacity-50"/>
          </Field>

          <div className="flex items-center gap-3 pt-1">
            <input id="standalone" type="checkbox"
                   checked={isStandalone}
                   onChange={(e) => setIsStandalone(e.target.checked)}
                   disabled={busy}
                   className="rounded border-ink/20"/>
            <label htmlFor="standalone" className="text-sm text-ink/80 select-none">
              This is a standalone (not part of a series)
            </label>
          </div>

          {!isStandalone && (
            <div className="grid grid-cols-[1fr_120px] gap-3">
              <Field label="Series" required>
                <input value={series} disabled={busy}
                       onChange={(e) => setSeries(e.target.value)}
                       placeholder="e.g. Earthsea"
                       className="w-full rounded-xl border border-ink/15 px-4 py-2.5 text-sm focus:outline-none focus:border-peach disabled:opacity-50"/>
              </Field>
              <Field label="Book #" required>
                <input value={seriesPosition} disabled={busy} inputMode="numeric"
                       onChange={(e) => setSeriesPosition(e.target.value.replace(/[^0-9]/g, ''))}
                       placeholder="1"
                       className="w-full rounded-xl border border-ink/15 px-4 py-2.5 text-sm focus:outline-none focus:border-peach disabled:opacity-50 tabular-nums"/>
              </Field>
            </div>
          )}

          <Field label="Title" required>
            <input value={title} disabled={busy}
                   onChange={(e) => setTitle(e.target.value)}
                   placeholder="e.g. A Wizard of Earthsea"
                   className="w-full rounded-xl border border-ink/15 px-4 py-2.5 text-sm focus:outline-none focus:border-peach disabled:opacity-50"/>
          </Field>

          <div className="pt-2 grid grid-cols-3 gap-3 text-[11px] text-ink/55">
            <Stat label="Format" value={candidate.format}/>
            <Stat label="Word count" value={candidate.wordCount.toLocaleString()}/>
            <Stat label="Chapters detected" value={String(candidate.chapters.length)}/>
          </div>

          {error && (
            <div className="px-4 py-3 rounded-2xl bg-rose-50 border border-rose-200 text-sm text-rose-900">
              {error}
            </div>
          )}

          <div className="flex items-center justify-between pt-2">
            <button onClick={handleBack} disabled={busy}
                    className="text-sm text-ink/60 hover:text-ink disabled:opacity-50">
              ← Pick a different file
            </button>
            <PrimaryButton variant="dark" onClick={handleSubmit}>
              <span className="inline-flex items-center gap-2">
                {busy && <IconSpinner className="w-4 h-4"/>}
                {busy ? 'Saving…' : 'Save book and start analysis'}
              </span>
            </PrimaryButton>
          </div>
        </div>
      </div>
    </div>
  );
}

function Field({ label, required, children }: { label: string; required?: boolean; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="text-xs uppercase tracking-[0.12em] font-semibold text-ink/55">
        {label}{required && <span className="text-magenta ml-1">*</span>}
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
