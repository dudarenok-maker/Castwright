/* fs-15/fs-16 — pure aggregation builders for the stats dashboard (fs-16) and
   continue-listening rail (fs-15). Combines completion metrics, finished status,
   and listening history summaries. */

import {
  bookListenableSeconds, secondsBeforeChapter, finalListenableChapter, parseDurationToSec,
  type DurChapter,
} from './chapter-durations.js';
import { sumAllSeconds, byDayTotals, type ListenStatsFile } from './listen-stats.js';

const NOISE_FLOOR_SEC = 5;
const FINISH_TAIL_SEC = 30;
const FINISH_TAIL_FRAC = 0.02;

export interface ResumeInput { chapterId: number; currentSec: number; updatedAt: string; }
export interface BookStatsInput {
  bookId: string; title: string; series: string | null; isStandalone: boolean;
  chapters: DurChapter[]; resume: ResumeInput | null; statsFile: ListenStatsFile | null;
  /* fs-15 shelf controls — explicit per-book flags read from listen-progress.json.
     `finished` (sticky, user "Mark as finished") counts toward booksFinished and
     drops the book off the rail; `hidden` (user "Hide from shelf", cleared on the
     next resume) only drops it off the rail. */
  finished?: boolean;
  hidden?: boolean;
}

/** Completion as consumed / total listenable. Guards divide-by-zero. */
export function completionPct(chapters: DurChapter[], resume: ResumeInput | null): number {
  if (!resume) return 0;
  const total = bookListenableSeconds(chapters);
  if (total <= 0) return 0;
  const consumed = secondsBeforeChapter(chapters, resume.chapterId) + Math.max(0, resume.currentSec);
  return Math.min(1, consumed / total);
}

/** True when the user has consumed within FINISH_TAIL_SEC of the whole book's
    listenable end. Catches the "0:00 left" case where the resume bookmark sits
    in a non-listenable trailing chapter (excluded/held/no-duration) but every
    listenable second is already behind the bookmark, so the narrow
    final-chapter-tail check below would miss it. Requires real listenable
    audio (total > 0) — a book with no durations is "no audio", not "finished". */
export function isEffectivelyComplete(chapters: DurChapter[], resume: ResumeInput | null): boolean {
  if (!resume) return false;
  const total = bookListenableSeconds(chapters);
  if (total <= 0) return false;
  const consumed = secondsBeforeChapter(chapters, resume.chapterId) + Math.max(0, resume.currentSec);
  return total - consumed <= FINISH_TAIL_SEC;
}

/** True when the book is finished: an explicit user "Mark as finished" flag,
    OR the resume bookmark sits in the final listenable chapter within its tail,
    OR the listenable audio is effectively all consumed. */
export function isFinished(
  chapters: DurChapter[],
  resume: ResumeInput | null,
  explicitFinished = false,
): boolean {
  if (explicitFinished) return true;
  if (!resume) return false;
  const final = finalListenableChapter(chapters);
  if (final && final.id === resume.chapterId) {
    const finalSec = parseDurationToSec(final.duration);
    if (finalSec > 0) {
      const tail = Math.max(FINISH_TAIL_SEC, finalSec * FINISH_TAIL_FRAC);
      if (resume.currentSec >= finalSec - tail) return true;
    }
  }
  return isEffectivelyComplete(chapters, resume);
}

export interface LibraryStats {
  totalListenedSec: number;
  booksFinished: number;
  perBook: { bookId: string; title: string; completionPct: number; finished: boolean }[];
  perSeries: { series: string; finishedCount: number; importedCount: number }[];
  byDay: { date: string; seconds: number }[];
}

/** Aggregates library-wide stats: total listened, finished count, per-book completions,
    per-series summaries, and daily listening totals. */
export function buildLibraryStats(books: BookStatsInput[]): LibraryStats {
  const files = books.map((b) => b.statsFile).filter((f): f is ListenStatsFile => !!f);
  const perBook = books.map((b) => ({
    bookId: b.bookId, title: b.title,
    completionPct: completionPct(b.chapters, b.resume),
    finished: isFinished(b.chapters, b.resume, b.finished),
  })).sort((a, b) => b.completionPct - a.completionPct);

  const seriesMap = new Map<string, { finishedCount: number; importedCount: number }>();
  for (const b of books) {
    if (b.isStandalone || !b.series) continue;
    const e = seriesMap.get(b.series) ?? { finishedCount: 0, importedCount: 0 };
    e.importedCount += 1;
    if (isFinished(b.chapters, b.resume, b.finished)) e.finishedCount += 1;
    seriesMap.set(b.series, e);
  }

  const totals = byDayTotals(files);
  return {
    totalListenedSec: sumAllSeconds(files),
    booksFinished: perBook.filter((p) => p.finished).length,
    perBook,
    perSeries: [...seriesMap.entries()].map(([series, v]) => ({ series, ...v })),
    byDay: Object.entries(totals).map(([date, seconds]) => ({ date, seconds: seconds as number }))
      .sort((a, b) => (a.date < b.date ? -1 : 1)),
  };
}

export interface ContinueItem {
  bookId: string; title: string; chapterId: number; currentSec: number;
  remainingSec: number; completionPct: number; updatedAt: string;
}

/** Continue-listening list: excludes finished (explicit or effectively-complete),
    hidden, books with no listenable audio, and <=5s noise; sorted by updatedAt desc. */
export function buildContinueListening(books: BookStatsInput[]): ContinueItem[] {
  return books
    .filter(
      (b) =>
        b.resume &&
        b.resume.currentSec > NOISE_FLOOR_SEC &&
        !b.hidden &&
        !isFinished(b.chapters, b.resume, b.finished) &&
        bookListenableSeconds(b.chapters) > 0,
    )
    .map((b) => {
      const total = bookListenableSeconds(b.chapters);
      const consumed = secondsBeforeChapter(b.chapters, b.resume!.chapterId) + b.resume!.currentSec;
      return {
        bookId: b.bookId, title: b.title,
        chapterId: b.resume!.chapterId, currentSec: b.resume!.currentSec,
        remainingSec: Math.max(0, total - consumed),
        completionPct: completionPct(b.chapters, b.resume),
        updatedAt: b.resume!.updatedAt,
      };
    })
    .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
}
