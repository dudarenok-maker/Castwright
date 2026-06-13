/* fs-16 — pure helpers for completion math. A chapter is "listenable" when it
   is not excluded, not held, and has a duration string (i.e. has rendered
   audio). Unrendered chapters contribute nothing — see spec S1 / mid-gen caveat. */
export interface DurChapter { id: number; duration?: string; excluded?: boolean; held?: boolean; }

export function parseDurationToSec(d: string | undefined): number {
  if (!d) return 0;
  const parts = d.split(':').map((p) => Number(p));
  if (parts.some((n) => !Number.isFinite(n))) return 0;
  return parts.reduce((acc, n) => acc * 60 + n, 0);
}

function isListenable(c: DurChapter): boolean {
  return !c.excluded && !c.held && !!c.duration && parseDurationToSec(c.duration) > 0;
}

export function bookListenableSeconds(chapters: DurChapter[]): number {
  return chapters.filter(isListenable).reduce((n, c) => n + parseDurationToSec(c.duration!), 0);
}

export function secondsBeforeChapter(chapters: DurChapter[], resumeChapterId: number): number {
  let total = 0;
  for (const c of chapters) {
    if (c.id === resumeChapterId) break;
    if (isListenable(c)) total += parseDurationToSec(c.duration!);
  }
  return total;
}

export function finalListenableChapter(chapters: DurChapter[]): DurChapter | null {
  for (let i = chapters.length - 1; i >= 0; i--) if (isListenable(chapters[i])) return chapters[i];
  return null;
}
