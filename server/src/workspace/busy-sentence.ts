/* The sentence for a 409 `book_busy` refusal, by job kind and action. A LEAF (imports only the job
   kind type), so `routes/analysis.ts` can use it without an import cycle through `routes/book-state.ts`,
   which re-exports it for every other caller. */
import type { BookJobKind } from './book-op-lock.js';

/* #3711 — the sentence for a `BookBusyError`, by job kind. Analysis alone keeps
   the verbatim #2165 sentence; every other mix names what is running. */
const BUSY_PHRASE: Record<BookJobKind, string> = {
  render: 'rendering audio',
  'audio-fix': 'fixing audio',
  scoring: 'scoring audio',
  analysis: 'analysing',
  design: 'designing voices',
  'script-review': 'reviewing the script',
  export: 'exporting',
  'unaddressed-sweep': 'a startup check of this folder',
};

export function busySentence(
  kinds: BookJobKind[],
  action: 'rename' | 'delete' | 'reparse' | 'replace' | 'restructure' | 'exclude' | 'include' | 'render' | 'analyse' | 'restore' | 'cast-save' | 'manuscript-save',
): string {
  if (action === 'rename' && kinds.every((k) => k === 'analysis')) {
    return 'Analysis is running for this book. Wait for it to finish before renaming it — a rename mid-analysis would split the book across two folders.';
  }
  const what = [...new Set(kinds.map((k) => BUSY_PHRASE[k]))].join(', ');
  if (action === 'rename') {
    return `This book is busy (${what}). Wait for it to finish before renaming it — a rename now would split the book across two folders.`;
  }
  if (action === 'delete') {
    return `This book is busy (${what}). Stop it or wait for it to finish, then delete it.`;
  }
  /* #3774 — chapter restructure / exclude rewrite or delete chapter audio under
     a job that may still be writing it (a render finalizing a take to a stale
     slug, or resurrecting audio that was just excluded). */
  if (action === 'restructure') {
    return `This book is busy (${what}). Stop it or wait for it to finish, then change the chapters.`;
  }
  if (action === 'exclude') {
    return `This book is busy (${what}). Stop it or wait for it to finish, then exclude chapters.`;
  }
  /* #3436 — an include is refused while an analysis runs: it rewrites state.json and the live
     ManuscriptRecord.chapterHints the run reads. */
  if (action === 'include') {
    return `This book is busy (${what}). Chapters cannot be added back while it is analysing, so this chapter was not included. Wait for the analysis to finish, then include it.`;
  }
  /* #3436 -- generation / chapter splice / audio-QA repair rebuild the analysis cache mid-run, so
     they are refused while an analysis runs. */
  if (action === 'render') {
    return `This book is busy (${what}). Rendering audio is refused while it is analysing, so this was not started. Wait for the analysis to finish, then try again.`;
  }
  /* #3436 -- the other direction: an analysis start is refused while the book renders (generation,
     splice, QA repair), so render and analysis on one book are mutually exclusive. */
  if (action === 'analyse') {
    return `This book is busy (${what}). Analysis is refused while it is rendering audio, so it was not started. Wait for the render to finish, then try again.`;
  }
  /* PR #3966 review pass 2 -- a backup restore rewrites state.json and can clear
     the analysis cache under a job that may still be saving it. */
  if (action === 'restore') {
    return `This book is busy (${what}). Stop it or wait for it to finish, then restore the backup.`;
  }
  /* #4031 — a whole-slice cast PUT is refused while an analysis runs. */
  if (action === 'cast-save') {
    return `This book is busy (${what}). Its cast is read-only until the analysis finishes, so this change was not saved.`;
  }
  /* #4098 — a manuscript PUT is refused while an analysis runs: the job rewrites manuscript-edits.json wholesale at its persist. */
  if (action === 'manuscript-save') {
    return `This book is busy (${what}). Its manuscript is read-only until the analysis finishes, so this change was not saved.`;
  }
  /* #3717 — reparse / replace-manuscript are refused like the movers: both
     delete cast.json and the audio/ directory under a job still writing them. */
  return action === 'reparse'
    ? `This book is busy (${what}). Stop it or wait for it to finish, then re-parse it.`
    : `This book is busy (${what}). Stop it or wait for it to finish, then replace its manuscript.`;
}
