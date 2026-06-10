import { useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { IconUpload, IconSpinner } from '../lib/icons';
import { SectionLabel, MixedHeading, PrimaryButton } from '../components/primitives';
import { api } from '../lib/api';
import type { UploadArgs } from '../lib/api';
import { TAGLINE_SHORT } from '../lib/brand';
import { SAMPLE_MANUSCRIPT_MD } from '../mocks/canned-data';
import { AnalysisModelPicker } from '../components/analysis-model-picker';
import { useAppDispatch, useAppSelector } from '../store';
import { uiActions } from '../store/ui-slice';
import { manuscriptActions } from '../store/manuscript-slice';
import { chaptersActions } from '../store/chapters-slice';
import { useLocalAnalyzerGuard } from '../hooks/use-local-analyzer-guard';
import { ManuscriptDiffModal } from '../components/manuscript-diff';
import {
  diffSentenceArrays,
  splitIntoSentences,
} from '../lib/manuscript-diff';
import {
  detectOverrideConflicts,
  scanCandidateChapters,
} from '../lib/chapter-override-conflict';
import type { Sentence } from '../lib/types';

const TEXT_EXT_RE = /\.(md|markdown|txt|text)$/i;
const BINARY_EXT_RE = /\.(pdf|epub|mobi|azw3)$/i;

export function UploadView() {
  const dispatch = useAppDispatch();
  const navigate = useNavigate();
  const selectedModel = useAppSelector((s) => s.ui.selectedModel);
  /* Plan 74 — re-upload mode is signalled by ui-slice.reuploadingBookId.
     When set, we route the import through the diff modal instead of
     ConfirmMetadata + a fresh analysis run. */
  const reuploadingBookId = useAppSelector((s) => s.ui.reuploadingBookId);
  const manuscript = useAppSelector((s) => s.manuscript);
  const library = useAppSelector((s) => s.library.books);
  /* Plan 84 — current chapters with their `titleOverridden` flags. Used
     to detect renamed-chapter conflicts on re-upload (plan 78 × plan 74
     interaction). */
  const currentChapters = useAppSelector((s) => s.chapters.chapters);
  const reuploadBook = useMemo(
    () =>
      reuploadingBookId != null
        ? (library.find((b) => b.bookId === reuploadingBookId) ?? null)
        : null,
    [library, reuploadingBookId],
  );
  const isReuploading = reuploadingBookId != null;
  const [dragOver, setDragOver] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pasteOpen, setPasteOpen] = useState(false);
  const [pastedText, setPastedText] = useState('');
  const fileInputRef = useRef<HTMLInputElement>(null);

  /* When an audio generation run is alive elsewhere AND the user has
     picked a local analyzer (Ollama), guard the import behind a
     "pause-and-analyse?" confirm. Gemini/Gemma engines pass through
     unguarded — they don't touch the local GPU. */
  const { guard, modal: guardModal } = useLocalAnalyzerGuard();

  async function processUpload(args: UploadArgs) {
    setError(null);
    setBusy(true);
    try {
      const res = await api.importManuscript(args);
      if (isReuploading && reuploadingBookId) {
        /* Plan 74 — re-upload branch. Skip ConfirmMetadata; build a
           lightweight sentence array from the candidate sourceText
           via the client splitter (the server's authoritative splitter
           runs at analyse time, not here — for the diff display we
           only need rough boundaries the user can recognise). The
           sentences are stamped into chapterId=0 because the diff
           modal indexes by position, not chapter — the analyser will
           re-chapter on Apply. */
        const candidateText = res.candidate.sourceText ?? '';
        const sentenceTexts = splitIntoSentences(candidateText);
        const newSentences: Sentence[] = sentenceTexts.map((text, i) => ({
          id: i + 1,
          chapterId: 0,
          text,
          characterId: 'narrator',
        }));
        dispatch(
          manuscriptActions.previewReuploadDiff({
            bookId: reuploadingBookId,
            newSourceText: candidateText,
            newSentences,
            newWordCount: res.candidate.wordCount ?? 0,
            newTitle: res.candidate.title ?? null,
            newFormat: res.candidate.format ?? null,
          }),
        );
        setBusy(false);
        return;
      }
      dispatch(manuscriptActions.setImportCandidate({ tempId: res.tempId, ...res.candidate }));
    } catch (e) {
      setError((e as Error)?.message || 'Import failed.');
      setBusy(false);
    }
  }

  /* Plan 74 — diff modal Apply path: commit the new manuscript into
     the slice, clear the re-upload flag, then navigate back to the
     book's listen view. Re-analysis routing is intentionally left to
     a follow-up (the existing reanalyse confirm flow handles that
     when the user wants to re-run the analyzer). The slice update is
     sufficient for the v1 acceptance criteria — surface what changed,
     commit on confirm. */
  function handleDiffApply() {
    /* Plan 84 — drop the titleOverridden flag on any chapter that the
       new manuscript's parse will no longer match. The override flag
       is keyed by numeric id; if the re-uploaded manuscript shifts
       content at that id, the rename silently mis-attributes. We
       conservatively clear the conflicting overrides so the new
       parse's titles win. Users who want to re-apply a rename can do
       so from the chapter list after the re-upload commits. */
    if (overrideConflicts.length > 0) {
      dispatch(
        chaptersActions.clearOverrides({
          chapterIds: overrideConflicts.map((c) => c.oldChapterId),
        }),
      );
    }
    dispatch(manuscriptActions.applyReupload());
    if (reuploadingBookId) {
      dispatch(uiActions.clearReupload());
      navigate(`/books/${encodeURIComponent(reuploadingBookId)}/listen`);
    } else {
      dispatch(uiActions.clearReupload());
    }
  }

  function handleDiffDiscard() {
    dispatch(manuscriptActions.discardReupload());
    if (reuploadingBookId) {
      dispatch(uiActions.clearReupload());
      navigate(`/books/${encodeURIComponent(reuploadingBookId)}/listen`);
    } else {
      dispatch(uiActions.clearReupload());
    }
  }

  /* Memo the diff result so the modal doesn't recompute on every
     re-render. The diff input is stable across renders once
     pendingReupload is set — capture both sides and run LCS once. */
  const diffEntries = useMemo(() => {
    if (!manuscript.pendingReupload) return [];
    const oldSentenceTexts = manuscript.pendingReupload.oldSnapshot.sentences.map((s) => s.text);
    const newSentenceTexts = manuscript.pendingReupload.newCandidate.sentences.map((s) => s.text);
    return diffSentenceArrays(oldSentenceTexts, newSentenceTexts);
  }, [manuscript.pendingReupload]);

  /* Plan 84 — compute override conflicts. Old chapters come from the
     chapters slice (carries the titleOverridden flag from plan 78);
     new chapter headings are heuristically scanned out of the candidate
     source text because the server's authoritative chapter parse only
     runs at analyse time. */
  const overrideConflicts = useMemo(() => {
    if (!manuscript.pendingReupload) return [];
    const newChapters = scanCandidateChapters(
      manuscript.pendingReupload.newCandidate.sourceText,
    );
    return detectOverrideConflicts(currentChapters, newChapters);
  }, [manuscript.pendingReupload, currentChapters]);

  /* Wrap processUpload in the guard. If the user cancels at the prompt,
     `busy` never flips and the upload screen stays interactive. */
  function guardedUpload(args: UploadArgs) {
    guard(() => {
      void processUpload(args);
    });
  }

  async function handleFile(file?: File | null) {
    if (!file) return;
    if (TEXT_EXT_RE.test(file.name)) {
      const text = await file.text();
      guardedUpload({ text, fileName: file.name });
      return;
    }
    if (BINARY_EXT_RE.test(file.name)) {
      guardedUpload({ file, fileName: file.name });
      return;
    }
    setError(
      `${file.name.split('.').pop()?.toUpperCase()} files aren't supported. Try .md, .txt, .pdf, .epub, .mobi, or .azw3.`,
    );
  }

  function handleSample() {
    guardedUpload({
      text: SAMPLE_MANUSCRIPT_MD,
      fileName: 'the-northern-star.md',
      format: 'markdown',
    });
  }

  return (
    <div className="relative min-h-[calc(100vh-64px)] flex items-center justify-center px-4 sm:px-6 py-8 sm:py-16">
      <div className="absolute inset-0 bg-gradient-hero-wash opacity-90 pointer-events-none" />
      <div className="relative max-w-3xl w-full">
        <div className="text-center mb-8 sm:mb-10">
          <SectionLabel>
            {isReuploading ? 'Replace manuscript' : 'Start a new project'}
          </SectionLabel>
          <div className="mt-5">
            {isReuploading ? (
              <MixedHeading
                level="h1"
                regular="Drop the revised manuscript to"
                bold="see what changed"
              />
            ) : (
              <MixedHeading level="h1" regular="Drop your manuscript to" bold="meet the cast" />
            )}
          </div>
          {!isReuploading && (
            <p className="mt-3 text-sm text-ink/60">{TAGLINE_SHORT}</p>
          )}
          <p className="mt-4 text-lg text-ink/70">
            {isReuploading ? (
              <>
                We'll diff the new text against the existing manuscript
                {reuploadBook?.title ? (
                  <>
                    {' '}
                    for{' '}
                    <span className="font-semibold text-ink" data-testid="reupload-book-title">
                      {reuploadBook.title}
                    </span>
                  </>
                ) : null}{' '}
                — review changes before applying.
              </>
            ) : (
              <>
                We'll read the book, find every speaking character, and synthesise a voice
                profile for each one — generated from the prose, not picked from a list.
              </>
            )}
          </p>
          {isReuploading && (
            <button
              type="button"
              onClick={() => {
                dispatch(uiActions.clearReupload());
                if (reuploadingBookId) {
                  navigate(`/books/${encodeURIComponent(reuploadingBookId)}/listen`);
                }
              }}
              data-testid="reupload-cancel"
              className="mt-4 inline-flex items-center justify-center min-h-[44px] px-3 text-xs text-ink/60 hover:text-ink underline"
            >
              Cancel re-upload
            </button>
          )}
        </div>

        {/* Stacks vertically on phone (≤sm) — the picker trigger otherwise
            wraps mid-row and the label drifts above; explicit `flex-col
            sm:flex-row` keeps both stable. The picker owns its own
            `min-h-[44px]` touch-target rule. */}
        <div className="mb-5 flex flex-col sm:flex-row items-stretch sm:items-center justify-center gap-2 sm:gap-3 text-sm">
          <label htmlFor="model-select" className="text-ink/60 text-center sm:text-left">
            Analysis model
          </label>
          <AnalysisModelPicker
            selectedModel={selectedModel}
            onChange={(id) => dispatch(uiActions.setSelectedModel(id))}
            disabled={busy}
          />
        </div>

        <div
          onDragEnter={(e) => {
            e.preventDefault();
            setDragOver(true);
          }}
          onDragLeave={() => setDragOver(false)}
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => {
            e.preventDefault();
            setDragOver(false);
            handleFile(e.dataTransfer.files?.[0]);
          }}
          className={`relative w-full bg-white rounded-3xl border-2 border-dashed transition-all min-h-[140px] p-6 sm:p-12 text-center cursor-pointer ${busy ? 'opacity-60 cursor-wait' : ''} ${dragOver ? 'border-peach bg-peach/5 scale-[1.01]' : 'border-ink/15 hover:border-ink/30'}`}
          onClick={() => !busy && fileInputRef.current?.click()}
          data-testid="dropzone"
          role="button"
          tabIndex={0}
        >
          <input
            ref={fileInputRef}
            type="file"
            hidden
            accept=".md,.markdown,.txt,.text,.pdf,.epub,.mobi,.azw3"
            onChange={(e) => handleFile(e.target.files?.[0])}
          />
          <div className="w-12 h-12 sm:w-16 sm:h-16 mx-auto rounded-full bg-canvas grid place-items-center mb-3 sm:mb-5">
            {busy ? (
              <IconSpinner className="w-6 h-6 sm:w-7 sm:h-7 text-magenta" />
            ) : (
              <IconUpload className="w-6 h-6 sm:w-7 sm:h-7 text-ink" />
            )}
          </div>
          <p className="text-base sm:text-lg font-semibold text-ink">
            {busy ? 'Reading manuscript…' : 'Drop a manuscript here'}
          </p>
          <p className="text-sm text-ink/60 mt-1">
            {busy ? 'Hashing and registering with the server.' : 'or tap to browse files'}
          </p>
          {/* Format list wraps to multiple lines on phone so the dropzone height
              doesn't blow out; bullet separators kept for desktop consistency. */}
          <div className="mt-4 sm:mt-6 flex flex-wrap items-center justify-center gap-x-3 gap-y-1 text-xs text-ink/50">
            <span>Markdown</span>
            <span className="hidden sm:inline">·</span>
            <span>Plain text</span>
            <span className="hidden sm:inline">·</span>
            <span>EPUB</span>
            <span className="hidden sm:inline">·</span>
            <span>PDF</span>
            <span className="hidden sm:inline">·</span>
            <span>MOBI</span>
            <span className="hidden sm:inline">·</span>
            <span>AZW3</span>
          </div>
        </div>

        {error && (
          <div className="mt-4 px-4 py-3 rounded-2xl bg-rose-50 border border-rose-200 text-sm text-rose-900">
            {error}
          </div>
        )}

        {/* Action chips: stack column-of-two on phone (full-width buttons,
            ≥44px tap target), revert to inline row on sm and up. */}
        <div className="mt-5 flex flex-col sm:flex-row items-stretch sm:items-center justify-center gap-2 sm:gap-3 text-sm">
          <button
            disabled={busy}
            onClick={handleSample}
            className="w-full sm:w-auto min-h-[44px] px-4 py-2 rounded-full bg-white border border-ink/15 text-ink/80 hover:border-ink/30 hover:text-ink disabled:opacity-50"
          >
            Use sample manuscript
          </button>
          <button
            disabled={busy}
            onClick={() => setPasteOpen((v) => !v)}
            className="w-full sm:w-auto min-h-[44px] px-4 py-2 rounded-full bg-white border border-ink/15 text-ink/80 hover:border-ink/30 hover:text-ink disabled:opacity-50"
          >
            {pasteOpen ? 'Hide paste' : 'Paste text'}
          </button>
        </div>

        {pasteOpen && (
          <div className="mt-4 bg-white rounded-3xl border border-ink/10 p-4 sm:p-5">
            <textarea
              value={pastedText}
              onChange={(e) => setPastedText(e.target.value)}
              placeholder="# Chapter 1&#10;&#10;Paste your manuscript here…"
              className="w-full h-44 rounded-xl border border-ink/10 px-3 sm:px-4 py-3 text-sm font-mono text-ink/80 focus:outline-hidden focus:border-peach"
            />
            {/* Right-aligned on all viewports — PrimaryButton doesn't take
                className so a full-width phone variant would require touching
                primitives.tsx. The button is naturally tappable (min-h coming
                from pl-5 pr-1.5 py-1.5 + icon row = ~40px); align-self stays
                end on phone too so it stays predictable. */}
            <div className="mt-3 flex justify-end">
              <PrimaryButton
                variant="dark"
                onClick={() =>
                  !busy &&
                  pastedText.trim() &&
                  guardedUpload({ text: pastedText, fileName: 'pasted.md', format: 'markdown' })
                }
              >
                Upload pasted text
              </PrimaryButton>
            </div>
          </div>
        )}

        <p className="text-center text-xs text-ink/40 mt-6 sm:mt-8 px-2">
          Working on a series? Voices from previous books are available in your library — we'll
          match characters automatically.
        </p>
      </div>
      {guardModal}
      {/* Plan 74 — diff modal mounted whenever the slice carries a
         pending re-upload, regardless of how this view was reached.
         Discard restores the OLD manuscript state (snapshot); Apply
         promotes the new candidate into the live slice fields. */}
      <ManuscriptDiffModal
        open={manuscript.pendingReupload != null}
        bookTitle={reuploadBook?.title ?? manuscript.title}
        diff={diffEntries}
        overrideConflicts={overrideConflicts}
        onApply={handleDiffApply}
        onDiscard={handleDiffDiscard}
      />
    </div>
  );
}
