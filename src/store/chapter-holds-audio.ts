import type { ChaptersState } from './chapters-slice';

/* #3435 — does this chapter have audio whose text a re-run must leave alone?
   Only audio evidence counts: a finished or in-flight render, a render stamp,
   or a render map on disk. A queued chapter has none, and neither does one
   that failed before it ever rendered (hydrate reports it as 'failed'). */
export function chapterHoldsAudio(
  c: Pick<ChaptersState, 'chapters' | 'renderedTextByChapter' | 'renderedSpeakersByChapter'>,
  chapterId: number,
): boolean {
  const ch = c.chapters.find((x) => x.id === chapterId);
  return (
    (!!ch && (ch.state === 'done' || ch.state === 'in_progress' || !!ch.audioRenderedAt)) ||
    chapterId in c.renderedTextByChapter ||
    chapterId in c.renderedSpeakersByChapter
  );
}
