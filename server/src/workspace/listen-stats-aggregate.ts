/* fs-15/fs-16 — pure aggregation builders for the stats dashboard (fs-16) and
   continue-listening rail (fs-15). Combines completion metrics, finished status,
   and listening history summaries. */

import {
  bookListenableSeconds, secondsBeforeChapter, finalListenableChapter, parseDurationToSec,
  type DurChapter,
} from './chapter-durations';
import { sumAllSeconds, byDayTotals, type ListenStatsFile } from './listen-stats';

const NOISE_FLOOR_SEC = 5;
const FINISH_TAIL_SEC = 30;
const FINISH_TAIL_FRAC = 0.02;

export interface ResumeInput { chapterId: number; currentSec: number; updatedAt: string; }
export interface BookStatsInput {
  bookId: string; title: string; series: string | null; isStandalone: boolean;
  chapters: DurChapter[]; resume: ResumeInput | null; statsFile: ListenStatsFile | null;
}

/** Completion as consumed / total listenable. Guards divide-by-zero. */
export function completionPct(chapters: DurChapter[], resume: ResumeInput | null): number {
  if (!resume) return 0;
  const total = bookListenableSeconds(chapters);
  if (total <= 0) return 0;
  const consumed = secondsBeforeChapter(chapters, resume.chapterId) + Math.max(0, resume.currentSec);
  return Math.min(1, consumed / total);
}

/** True when in the final listenable chapter and within finish tail threshold. */
export function isFinished(chapters: DurChapter[], resume: ResumeInput | null): boolean {
  if (!resume) return false;
  const final = finalListenableChapter(chapters);
  if (!final || final.id !== resume.chapterId) return false;
  const finalSec = parseDurationToSec(final.duration);
  if (finalSec <= 0) return false;
  const tail = Math.max(FINISH_TAIL_SEC, finalSec * FINISH_TAIL_FRAC);
  return resume.currentSec >= finalSec - tail;
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
    finished: isFinished(b.chapters, b.resume),
  })).sort((a, b) => b.completionPct - a.completionPct);

  const seriesMap = new Map<string, { finishedCount: number; importedCount: number }>();
  for (const b of books) {
    if (b.isStandalone || !b.series) continue;
    const e = seriesMap.get(b.series) ?? { finishedCount: 0, importedCount: 0 };
    e.importedCount += 1;
    if (isFinished(b.chapters, b.resume)) e.finishedCount += 1;
    seriesMap.set(b.series, e);
  }

  const totals = byDayTotals(files);
  return {
    totalListenedSec: sumAllSeconds(files),
    booksFinished: perBook.filter((p) => p.finished).length,
    perBook,
    perSeries: [...seriesMap.entries()].map(([series, v]) => ({ series, ...v })),
    byDay: Object.entries(totals).map(([date, seconds]) => ({ date, seconds }))
      .sort((a, b) => (a.date < b.date ? -1 : 1)),
  };
}

export interface ContinueItem {
  bookId: string; title: string; chapterId: number; currentSec: number;
  remainingSec: number; completionPct: number; updatedAt: string;
}

/** Continue-listening list: excludes finished + <=5s noise, sorted by updatedAt desc. */
export function buildContinueListening(books: BookStatsInput[]): ContinueItem[] {
  return books
    .filter((b) => b.resume && b.resume.currentSec > NOISE_FLOOR_SEC && !isFinished(b.chapters, b.resume))
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
