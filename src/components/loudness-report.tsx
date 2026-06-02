/* Plan 77 — per-book EBU R128 loudness report card. Consumes the
   per-chapter `lufs` sidecar payloads (plan 71) hydrated into the
   chapters slice and surfaces:

   - A summary line: "X of Y chapters within ±2 LU of -16 LUFS"
   - A sparkline histogram of per-chapter measured integrated loudness
   - An expandable per-chapter table: title | i | drift | badge |
     measured-at relative time
   - Critical gate: chapters with `twoPass === false` are treated as
     NEUTRAL (no ground-truth measurement) — single-pass values are
     the nominal target, not real post-filter measurements. Drift
     comparison is GATED on `twoPass === true`.

   Mount point: rendered inside `ListenPlayerRegion` below the chapter
   list so it sits next to the rows it summarises. The card stays
   collapsed by default (summary + sparkline + open button); the
   per-chapter table is opt-in.

   Empty state: when no chapter has lufs data (every row is `null` or
   `undefined`), surface explanatory copy pointing at
   `AUDIO_LOUDNORM_ENABLED`. */

import { useMemo, useState } from 'react';
import { Pill, SectionLabel } from './primitives';
import { IconWaveform, IconChevD, IconChevR } from '../lib/icons';
import { stripChapterPrefix } from '../lib/format-chapter-title';
import type { Chapter } from '../lib/types';

interface LoudnessReportProps {
  chapters: Chapter[];
}

/** Threshold table — keep in lock-step with the chapter-row badge in
 *  `listen-player-region.tsx`. Drift ≤ 2 LU is "on target" (the EBU R128
 *  tolerance); 2–4 LU is "slight drift" (audible on careful listening);
 *  >4 LU is "off target" (audible to anyone). */
export type LoudnessDriftBucket = 'on-target' | 'slight' | 'off-target' | 'no-data';

export function classifyDrift(
  lufs: { i: number; target: number; twoPass: boolean } | null | undefined,
): LoudnessDriftBucket {
  /* The CRITICAL gate: single-pass values are NOT post-filter measurements.
     They're the nominal target restated. Rendering them as ground-truth
     would lie to the user. Degrade to neutral. */
  if (!lufs || lufs.twoPass !== true) return 'no-data';
  if (!Number.isFinite(lufs.i) || !Number.isFinite(lufs.target)) return 'no-data';
  const drift = Math.abs(lufs.i - lufs.target);
  if (drift <= 2) return 'on-target';
  if (drift <= 4) return 'slight';
  return 'off-target';
}

const BUCKET_COPY: Record<LoudnessDriftBucket, { label: string; pillColor: 'success' | 'warning' | 'danger' | 'neutral' }> = {
  'on-target': { label: 'On target', pillColor: 'success' },
  slight: { label: 'Slight drift', pillColor: 'warning' },
  'off-target': { label: 'Off target', pillColor: 'danger' },
  'no-data': { label: 'No measurement', pillColor: 'neutral' },
};

/** Compact "−16.0 LUFS" formatter — minus sign is the Unicode U+2212 so
 *  numeric typography lines up; no decimals beyond 1 (LUFS readings are
 *  noisy below ±0.1). */
function formatLufs(value: number): string {
  if (!Number.isFinite(value)) return '—';
  const fixed = value.toFixed(1);
  return fixed.startsWith('-') ? `−${fixed.slice(1)} LUFS` : `${fixed} LUFS`;
}

/** Render `2.3 LU above target` style copy. Used in the expandable table
 *  hover affordance. Returns `Within target` for drift ≤ 0.1 LU. */
function describeDrift(i: number, target: number): string {
  const delta = i - target;
  const mag = Math.abs(delta);
  if (mag <= 0.1) return 'Within target';
  const direction = delta > 0 ? 'above' : 'below';
  return `${mag.toFixed(1)} LU ${direction} target`;
}

/** ISO-8601 → "2h ago" / "Yesterday" / "12 May" style relative copy.
 *  Lightweight subset of the changelog formatter — keeping a local
 *  copy avoids dragging another helper into this component's blast
 *  radius. */
function formatRelative(iso: string): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return '';
  const diffMs = Date.now() - then;
  if (diffMs < 0) return 'just now';
  const m = Math.round(diffMs / 60_000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  if (d === 1) return 'yesterday';
  if (d < 14) return `${d} days ago`;
  return new Date(then).toLocaleDateString();
}

/** Sparkline — one vertical bar per chapter, height scaled by
 *  |i − target| within the [0, max(4 LU, observed max)] domain so a
 *  book whose entire spread is < 2 LU still shows differentiation. The
 *  bar colour mirrors the bucket so the visual reads at a glance. */
interface SparklineProps {
  /** One entry per chapter in book order; entries with `bucket: 'no-data'`
   *  render an empty placeholder column so the sparkline always lines up
   *  with the chapter list. */
  series: Array<{ chapterId: number; drift: number; bucket: LoudnessDriftBucket }>;
}

function Sparkline({ series }: SparklineProps) {
  if (series.length === 0) return null;
  const visibleDrifts = series.filter((s) => s.bucket !== 'no-data').map((s) => s.drift);
  const maxDrift = visibleDrifts.length === 0 ? 4 : Math.max(4, ...visibleDrifts);
  const bucketBar: Record<LoudnessDriftBucket, string> = {
    'on-target': 'bg-emerald-400',
    slight: 'bg-amber-400',
    'off-target': 'bg-rose-400',
    'no-data': 'bg-ink/10',
  };
  return (
    <div
      data-testid="loudness-report-sparkline"
      className="flex items-end gap-[2px] h-12 px-1"
      aria-hidden
    >
      {series.map((s) => {
        const heightPct =
          s.bucket === 'no-data' ? 12 : Math.max(8, Math.min(100, (s.drift / maxDrift) * 100));
        return (
          <span
            key={s.chapterId}
            className={`flex-1 min-w-[3px] rounded-t-sm ${bucketBar[s.bucket]}`}
            style={{ height: `${heightPct}%` }}
            data-testid={`loudness-report-spark-${s.chapterId}`}
            data-bucket={s.bucket}
          />
        );
      })}
    </div>
  );
}

export function LoudnessReport({ chapters }: LoudnessReportProps) {
  const [open, setOpen] = useState(false);
  /* Filter out excluded chapters — they don't render in the listen view's
     chapter list (see `listen.tsx` `listenable`) so they don't belong in
     the loudness summary either. Front-matter has no narrated audio to
     measure. */
  const listenable = useMemo(() => chapters.filter((c) => !c.excluded), [chapters]);

  /* Per-chapter classification + drift magnitudes. We compute the bucket
     ONCE here so the summary, sparkline, and table all read from the same
     truth table. */
  const classified = useMemo(
    () =>
      listenable.map((c) => {
        const lufs = c.lufs ?? null;
        const bucket = classifyDrift(lufs);
        const drift =
          lufs && lufs.twoPass === true && Number.isFinite(lufs.i) && Number.isFinite(lufs.target)
            ? Math.abs(lufs.i - lufs.target)
            : 0;
        return { chapter: c, lufs, bucket, drift };
      }),
    [listenable],
  );

  const measuredCount = classified.filter((c) => c.bucket !== 'no-data').length;
  const onTargetCount = classified.filter((c) => c.bucket === 'on-target').length;
  const slightCount = classified.filter((c) => c.bucket === 'slight').length;
  const offTargetCount = classified.filter((c) => c.bucket === 'off-target').length;
  /* Target value comes from the FIRST chapter with two-pass data — every
     chapter normalised by the same encoder run shares one target, so the
     value is consistent across rows. Fallback `-16` matches plan 71's
     default if no measured chapters exist yet (the empty state hides this
     line anyway, so the fallback is decorative). */
  const target =
    classified.find((c) => c.lufs?.twoPass === true)?.lufs?.target ?? -16;

  /* Empty state: every chapter is "no-data". Either the book was
     generated before plan 71, AUDIO_LOUDNORM_ENABLED=false at encode
     time, or every chapter is single-pass-only (rare). */
  const isEmpty = measuredCount === 0;

  return (
    <section data-testid="loudness-report" className="mb-12">
      <div className="flex items-center justify-between mb-3">
        <SectionLabel>Audio loudness report</SectionLabel>
        {!isEmpty && (
          <span className="text-xs text-ink/50" data-testid="loudness-report-summary">
            {onTargetCount} of {measuredCount} chapter
            {measuredCount === 1 ? '' : 's'} within ±2 LU of {formatLufs(target)}
          </span>
        )}
      </div>
      <div className="bg-white rounded-3xl border border-ink/10 shadow-card p-5">
        {isEmpty ? (
          <EmptyState />
        ) : (
          <>
            <div className="flex items-start gap-4 mb-4">
              <div className="grid place-items-center w-9 h-9 rounded-full bg-emerald-50 text-emerald-700 shrink-0">
                <IconWaveform className="w-4 h-4" />
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-sm text-ink/80 leading-snug">
                  EBU R128 normalisation aims for one perceived volume across the
                  whole book. Chapters within {'±'}2 LU of {formatLufs(target)}{' '}
                  are on target.
                </p>
                <div className="flex flex-wrap items-center gap-2 mt-2">
                  <Pill color="success">{onTargetCount} on target</Pill>
                  <Pill color="warning">{slightCount} slight drift</Pill>
                  <Pill color="danger">{offTargetCount} off target</Pill>
                  {classified.length - measuredCount > 0 && (
                    <Pill color="neutral">
                      {classified.length - measuredCount} no measurement
                    </Pill>
                  )}
                </div>
              </div>
            </div>

            <Sparkline
              series={classified.map((c) => ({
                chapterId: c.chapter.id,
                drift: c.drift,
                bucket: c.bucket,
              }))}
            />

            <button
              type="button"
              onClick={() => setOpen((v) => !v)}
              data-testid="loudness-report-toggle"
              aria-expanded={open}
              className="mt-4 inline-flex items-center gap-1.5 text-xs font-medium text-ink/70 hover:text-ink"
            >
              {open ? <IconChevD className="w-3.5 h-3.5" /> : <IconChevR className="w-3.5 h-3.5" />}
              <span>{open ? 'Hide per-chapter table' : 'Show per-chapter table'}</span>
            </button>

            {open && (
              <div
                data-testid="loudness-report-table"
                className="mt-3 border-t border-ink/10 pt-3"
              >
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-left text-[11px] uppercase tracking-wider text-ink/50">
                      <th className="py-2 pr-3 font-semibold">Chapter</th>
                      <th className="py-2 px-3 font-semibold tabular-nums">Measured</th>
                      <th className="py-2 px-3 font-semibold tabular-nums">Drift</th>
                      <th className="py-2 px-3 font-semibold">Status</th>
                      <th className="py-2 pl-3 font-semibold text-right">Measured</th>
                    </tr>
                  </thead>
                  <tbody>
                    {classified.map(({ chapter, lufs, bucket }) => {
                      const copy = BUCKET_COPY[bucket];
                      return (
                        <tr
                          key={chapter.id}
                          data-testid={`loudness-report-row-${chapter.id}`}
                          data-bucket={bucket}
                          className="border-t border-ink/5"
                        >
                          <td className="py-2 pr-3">
                            <span className="text-ink/50 tabular-nums mr-2">
                              CH {String(chapter.id).padStart(2, '0')}
                            </span>
                            <span className="text-ink">
                              {stripChapterPrefix(chapter.title)}
                            </span>
                          </td>
                          <td className="py-2 px-3 tabular-nums text-ink/80">
                            {lufs && lufs.twoPass === true ? formatLufs(lufs.i) : '—'}
                          </td>
                          <td className="py-2 px-3 tabular-nums text-ink/80">
                            {lufs && lufs.twoPass === true
                              ? describeDrift(lufs.i, lufs.target)
                              : '—'}
                          </td>
                          <td className="py-2 px-3">
                            <Pill color={copy.pillColor}>{copy.label}</Pill>
                          </td>
                          <td
                            className="py-2 pl-3 text-right text-ink/50 text-xs"
                            title={lufs?.measuredAt ?? ''}
                          >
                            {lufs?.measuredAt ? formatRelative(lufs.measuredAt) : '—'}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
                <p className="text-[11px] text-ink/50 mt-3 leading-relaxed">
                  Drift is measured against the target integrated loudness using
                  the EBU R128 two-pass algorithm. Single-pass renders surface
                  as "No measurement" because the value reported is the nominal
                  target, not a post-filter measurement. Re-render a chapter to
                  refresh its measurement.
                </p>
              </div>
            )}
          </>
        )}
      </div>
    </section>
  );
}

function EmptyState() {
  return (
    <div data-testid="loudness-report-empty" className="flex items-start gap-4">
      <div className="grid place-items-center w-9 h-9 rounded-full bg-ink/4 text-ink/60 shrink-0">
        <IconWaveform className="w-4 h-4" />
      </div>
      <div className="flex-1 min-w-0">
        <p className="text-sm font-semibold text-ink">No loudness data yet</p>
        <p className="text-xs text-ink/60 leading-relaxed mt-1">
          EBU R128 measurements are captured when chapters generate with{' '}
          <code className="text-[11px] bg-ink/4 px-1 py-0.5 rounded">
            AUDIO_LOUDNORM_ENABLED
          </code>{' '}
          (default on). Re-render older chapters to capture per-chapter loudness
          for the report card.
        </p>
      </div>
    </div>
  );
}
