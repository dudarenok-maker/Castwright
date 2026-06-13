/* fs-16 — wall-clock listening accumulator for one player session. Rate- and
   seek-independent: it sums real elapsed time between play and pause/checkpoint
   using a clock, never the media currentTime. Buckets seconds by the injected
   local-date string, attributing to the active book; switching books flushes
   the prior book's tally. See spec D2/C5. */

export interface DrainedDays {
  date: string;
  seconds: number;
}

type Clock = () => number;     // ms epoch
type LocalDate = () => string; // 'YYYY-MM-DD' in the viewer's local tz

export class StatsAccumulator {
  private byDate = new Map<string, number>();
  private playing = false;
  private lastCheckpoint = 0;

  constructor(private bookId: string, private now: Clock, private localDate: LocalDate) {}

  private addElapsed(): void {
    if (!this.playing) return;
    const t = this.now();
    const secs = Math.max(0, (t - this.lastCheckpoint) / 1000);
    const date = this.localDate();
    this.byDate.set(date, (this.byDate.get(date) ?? 0) + secs);
    this.lastCheckpoint = t;
  }

  onPlay(): void {
    if (this.playing) return;
    this.playing = true;
    this.lastCheckpoint = this.now();
  }

  onPause(): void {
    this.addElapsed();
    this.playing = false;
  }

  tick(): void {
    this.addElapsed();
  }

  /** Snapshot the accumulated days (rounded to whole seconds) without clearing. */
  drain(): { sessionPresent: boolean; days: DrainedDays[] } {
    this.addElapsed();
    return {
      sessionPresent: this.byDate.size > 0 || this.playing,
      days: [...this.byDate.entries()]
        .map(([date, s]) => ({
          date,
          seconds: Math.round(s),
        }))
        .filter(({ seconds }) => seconds > 0),
    };
  }

  /** Flush current book's tally and re-target. Returns prior book's days. */
  switchBook(nextBookId: string): { bookId: string; days: DrainedDays[] } {
    this.addElapsed();
    const prior = {
      bookId: this.bookId,
      days: [...this.byDate.entries()]
        .map(([date, s]) => ({
          date,
          seconds: Math.round(s),
        }))
        .filter(({ seconds }) => seconds > 0),
    };
    this.byDate = new Map();
    this.bookId = nextBookId;
    if (this.playing) this.lastCheckpoint = this.now();
    return prior;
  }
}
