/* fs-16 F3 — the real #/stats listening-stats dashboard. "Reading column"
   (Option A from the brainstorm mockup): a calm, single-column narrative
   where the headline figures live INSIDE sentences rather than KPI tiles.
   Numbers come from api.getLibraryStats(); the streak / last-7-days math is
   the pure, timezone-correct logic in lib/listen-stats-math, computed against
   an injectable `today` (PL2) so the render is deterministic in tests.

   Brand: Lora (font-serif) for the lede + headline figures; General Sans
   (default) for labels / %s / captions. ONE magenta accent — reserved for the
   peak sparkbar day. Bars/hairlines use the faint --line / ink-alpha tokens;
   all actual text stays on AA-contrast ink tokens. Zero hex literals — every
   colour is a design token. */

import { useEffect, useState } from 'react';
import { SectionLabel, MixedHeading } from '../components/primitives';
import { api } from '../lib/api';
import type { components } from '../lib/api-types';
import { formatHours } from '../lib/time';
import { currentStreak, longestStreak, last7Days } from '../lib/listen-stats-math';

type LibraryStats = components['schemas']['LibraryStats'];

export interface StatsViewProps {
  /* Injectable so the streak / last-7-days render is deterministic in tests
     (PL2). Defaults to the viewer's local calendar day in YYYY-MM-DD. */
  today?: string;
}

/* Single-letter weekday initial for a YYYY-MM-DD date, in the viewer's locale.
   Parsed at UTC midnight (matching listen-stats-math) so the label can't drift
   a day across timezones. */
function dayInitial(date: string): string {
  const d = new Date(date + 'T00:00:00Z');
  return d.toLocaleDateString('en-US', { weekday: 'narrow', timeZone: 'UTC' });
}

export function StatsView({ today = new Date().toLocaleDateString('en-CA') }: StatsViewProps = {}) {
  const [stats, setStats] = useState<LibraryStats | null>(null);

  useEffect(() => {
    let cancelled = false;
    api
      .getLibraryStats()
      .then((s) => {
        if (!cancelled) setStats(s);
      })
      .catch(() => {
        /* non-fatal — the loading state stays until a payload lands */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="max-w-[960px] mx-auto px-4 sm:px-6 py-10">
      <div className="mb-8">
        <SectionLabel>Listening</SectionLabel>
        <div className="mt-4">
          <MixedHeading regular="Your" bold="listening" level="h1" />
        </div>
      </div>

      {stats === null ? (
        <p className="text-sm text-ink/60">Loading your listening stats…</p>
      ) : (
        <StatsBody stats={stats} today={today} />
      )}
    </div>
  );
}

function StatsBody({ stats, today }: { stats: LibraryStats; today: string }) {
  const booksStarted = stats.perBook.filter((p) => p.completionPct > 0).length;
  const week = last7Days(stats.byDay, today);
  const cur = currentStreak(stats.byDay, today);
  const longest = longestStreak(stats.byDay);

  /* First-run / empty: nothing listened and nothing in the library yet. */
  const isEmpty =
    stats.totalListenedSec <= 0 && booksStarted === 0 && stats.booksFinished === 0;
  if (isEmpty) {
    return (
      <div data-testid="stats-empty" className="max-w-prose space-y-3">
        <p className="font-serif text-xl text-ink">No listening yet.</p>
        <p className="text-ink/70">
          Generate a book and press play — your hours, streaks, and per-book progress will start
          collecting here.
        </p>
      </div>
    );
  }

  const inProgress = stats.perBook
    .filter((p) => p.completionPct > 0)
    .sort((a, b) => b.completionPct - a.completionPct);

  /* The single accent area: the focal in-progress row is the first
     not-yet-finished book (highest completion). Finished rows read in ink. */
  const focalId = inProgress.find((p) => !p.finished)?.bookId ?? null;

  /* Peak sparkbar day for the accent + the caption. Ties resolve to the most
     recent day (later index wins on >=). */
  const peakSeconds = Math.max(0, ...week.map((d) => d.seconds));
  let peakIndex = -1;
  week.forEach((d, i) => {
    if (peakSeconds > 0 && d.seconds >= peakSeconds) peakIndex = i;
  });

  return (
    <div className="max-w-prose space-y-7">
      {/* Lede — headline figures inside a Lora sentence. */}
      <p data-testid="stats-lede" className="font-serif text-xl leading-relaxed text-ink">
        You&rsquo;ve listened for <b className="font-semibold">{formatHours(Math.round(stats.totalListenedSec / 60))}</b>{' '}
        across <b className="font-semibold">{booksStarted} {booksStarted === 1 ? 'book' : 'books'}</b>
        {stats.booksFinished > 0 ? (
          <>
            , finishing <b className="font-semibold text-magenta">{stats.booksFinished}</b>.
          </>
        ) : (
          <>.</>
        )}
      </p>

      {/* Streak sentence. */}
      <p data-testid="stats-streak" className="text-ink/70">
        {cur > 0 ? (
          <>
            On a <b className="font-semibold text-ink">{cur}-day</b> streak
            {longest > cur ? (
              <> — your longest yet was <b className="font-semibold text-ink">{longest} days</b>.</>
            ) : (
              <> — your longest yet.</>
            )}
          </>
        ) : (
          <>No active streak yet — listen today to start one.</>
        )}
      </p>

      {/* Last 7 days — thin sparkbars, peak day in the magenta accent. */}
      <div>
        <div className="flex items-end gap-1.5 h-14" role="img" aria-label="Listening over the last 7 days">
          {week.map((d, i) => {
            const heightPct = peakSeconds > 0 ? Math.max(2, (d.seconds / peakSeconds) * 100) : 2;
            const isPeak = i === peakIndex;
            return (
              <div key={d.date} className="flex-1 flex flex-col items-center justify-end gap-1">
                <span
                  data-testid="stats-sparkbar"
                  className={`w-full rounded-t-sm ${isPeak ? 'bg-magenta' : 'bg-ink/15'}`}
                  style={{ height: `${heightPct}%` }}
                />
                <small className="text-[10px] text-ink/55 tabular-nums">{dayInitial(d.date)}</small>
              </div>
            );
          })}
        </div>
        <p className="mt-1.5 text-xs text-ink/55">
          Last 7 days
          {peakSeconds > 0 && (
            <> · {formatHours(Math.round(peakSeconds / 60))} on {fullWeekday(week[peakIndex].date)}</>
          )}
        </p>
      </div>

      {/* Books in progress. */}
      {inProgress.length > 0 && (
        <div className="border-t border-line pt-5">
          <p className="text-[11px] font-medium uppercase tracking-wider text-ink/50 mb-2">
            Books in progress
          </p>
          <div className="space-y-1">
            {inProgress.map((p) => {
              const pct = Math.round(p.completionPct * 100);
              const isFocal = p.bookId === focalId;
              return (
                <div
                  key={p.bookId}
                  data-testid="stats-progress-row"
                  className="grid grid-cols-[1fr_90px_42px] items-center gap-3 py-0.5 text-sm text-ink"
                >
                  <span className="truncate">{p.title}</span>
                  <span className="h-1.5 rounded-full bg-line overflow-hidden">
                    <span
                      className={`block h-full rounded-full ${isFocal ? 'bg-magenta' : 'bg-ink/30'}`}
                      style={{ width: `${pct}%` }}
                    />
                  </span>
                  <span className="text-right tabular-nums text-xs text-ink/70">{pct}%</span>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* By series. */}
      {stats.perSeries.length > 0 && (
        <div className="border-t border-line pt-5">
          <p className="text-[11px] font-medium uppercase tracking-wider text-ink/50 mb-2">
            By series
          </p>
          <div className="space-y-1">
            {stats.perSeries.map((s) => (
              <div
                key={s.series}
                data-testid="stats-series-row"
                className="flex items-baseline justify-between gap-3 py-0.5 text-sm"
              >
                <span className="text-ink truncate">{s.series}</span>
                <span className="tabular-nums text-ink/70 shrink-0">
                  {s.finishedCount} of {s.importedCount} finished
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

/* Full weekday name for the peak-day caption (e.g. "Saturday"). UTC-parsed to
   match the sparkbar initials and the streak math. */
function fullWeekday(date: string): string {
  return new Date(date + 'T00:00:00Z').toLocaleDateString('en-US', {
    weekday: 'long',
    timeZone: 'UTC',
  });
}
