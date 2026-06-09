import { useEffect, useRef, useState } from 'react';
import { IconCheck, IconSpinner } from '../../lib/icons';
import {
  api,
  type AnalysisHeartbeat,
  type AnalysisLiveChapter,
  type AnalysisLiveInfo,
} from '../../lib/api';
import { MODEL_OPTIONS } from '../../lib/models';
import type { AnalysisPhase, DroppedQuotesResponse } from '../../lib/types';
import { useAppSelector } from '../../store';
import { selectAnalyzerSplitIsActive } from '../../store/account-slice';
import { PhaseModelChip, type PhaseChipState } from './phase-model-chip';
import { PhaseModelSwap } from './phase-model-swap';

export type ConnState = 'idle' | 'connecting' | 'streaming' | 'error' | 'done';

export const COMPLETED_PHASE_TAIL = 6;
export const ACTIVE_PHASE_LOG_MAX_H = 'max-h-48';
export const STALL_THRESHOLD_CLOUD_SEC = 8;
export const STALL_THRESHOLD_LOCAL_SEC = 60;

/* Compact MM:SS / H:MM:SS used in the live ticker. Different format from
   humanSeconds (which spells out "1m 14s") because the ticker updates every
   second and a colon-formatted clock is easier to read at a glance. */
function humanSecondsCompact(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

/* Live "what's running right now" indicator on the active phase header.
   Server sends a `live` payload every 500ms with every chapter currently
   in flight; we render one row per chapter so a slow chapter doesn't
   visually hide the chapters progressing alongside it. The displayed
   elapsed is advanced locally between server ticks so the seconds counter
   never visibly stalls — each row re-anchors to the server's elapsedMs on
   every update. */
function LiveChapterRow({
  chapter,
  totalChapters,
}: {
  chapter: AnalysisLiveChapter;
  totalChapters: number;
}) {
  const [displayMs, setDisplayMs] = useState(chapter.elapsedMs);
  useEffect(() => {
    const baseline = Date.now() - chapter.elapsedMs;
    setDisplayMs(Date.now() - baseline);
    const id = setInterval(() => setDisplayMs(Date.now() - baseline), 1000);
    return () => clearInterval(id);
  }, [chapter.elapsedMs, chapter.chapterIndex]);

  const overBudget = displayMs > chapter.estMs * 1.25;
  return (
    <div
      className={`inline-flex items-center gap-2 text-[11px] font-mono tabular-nums ${overBudget ? 'text-amber-700' : 'text-ink/60'}`}
    >
      <span className="font-semibold">
        Chapter {chapter.chapterIndex}/{totalChapters}
      </span>
      <span className="text-ink/30">·</span>
      <span className="truncate max-w-[220px]" title={chapter.chapterTitle}>
        {chapter.chapterTitle}
      </span>
      <span className="text-ink/30">·</span>
      <span>
        {humanSecondsCompact(displayMs)} of ~{humanSecondsCompact(chapter.estMs)}
      </span>
      {overBudget && <span className="ml-1 font-semibold">over budget</span>}
    </div>
  );
}

function LiveChapterTicker({ live }: { live: AnalysisLiveInfo }) {
  return (
    <div className="mt-2 flex flex-col gap-1">
      {live.chapters.map((ch) => (
        <LiveChapterRow key={ch.chapterIndex} chapter={ch} totalChapters={live.totalChapters} />
      ))}
    </div>
  );
}

/* Scrolling log for the active phase. Pins to the bottom on every new line
   so the user always sees the most recent updates. If the user scrolls up to
   read history, the pin temporarily releases — we re-pin on the next render
   once they scroll back near the bottom. The latest line is bolded + ink-
   coloured so the eye lands on it. */
function ActivePhaseLog({ lines }: { lines: string[] }) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const pinnedRef = useRef(true);

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    pinnedRef.current = distanceFromBottom < 24;
  };

  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !pinnedRef.current) return;
    el.scrollTop = el.scrollHeight;
  }, [lines.length]);

  return (
    <div
      ref={scrollRef}
      onScroll={onScroll}
      className={`mt-3 ${ACTIVE_PHASE_LOG_MAX_H} overflow-y-auto pr-2 -mr-2`}
    >
      <ul className="space-y-1.5 text-xs font-mono text-ink/70">
        {lines.map((s, i) => (
          <li key={i} className={i === lines.length - 1 ? 'tick-up font-semibold text-ink' : ''}>
            {s}
          </li>
        ))}
      </ul>
    </div>
  );
}

/* Live cast preview rendered under Phase 0 — fills in chapter-by-chapter
   as cast-update events arrive. */
function LiveCastPreview() {
  const characters = useAppSelector((s) => s.cast.characters);
  if (characters.length === 0) return null;
  return (
    <div className="mt-3 text-[11px] text-ink/60">
      <div className="font-semibold text-ink/80">
        Cast so far · {characters.length} character{characters.length === 1 ? '' : 's'}
      </div>
      <div className="mt-1 flex flex-wrap gap-x-2 gap-y-1">
        {characters.map((c) => (
          <span
            key={c.id}
            className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-ink/4 text-ink/70"
          >
            {c.name}
          </span>
        ))}
      </div>
    </div>
  );
}

/* Series-cast carry-over pill (C3). Tells the user the analyzer has been
   pre-seeded with N characters from prior books in the same series. */
function SeriesPriorPill() {
  const seriesPrior = useAppSelector(
    (s) =>
      (s as { analysis?: { activeStream?: { seriesPrior?: { count: number; names: string[] } } } })
        .analysis?.activeStream?.seriesPrior,
  );
  if (!seriesPrior || seriesPrior.count === 0) return null;
  const { count, names } = seriesPrior;
  const sample = names.slice(0, 3).join(', ');
  const more = count > names.length ? ` +${count - names.length}` : '';
  return (
    <div className="mt-3 text-[11px] text-ink/60" data-testid="series-prior-pill">
      <div className="font-semibold text-ink/80">
        Carried in from prior books in this series · {count} character{count === 1 ? '' : 's'}
      </div>
      <div className="mt-1 text-ink/60">
        {sample}
        {more}
      </div>
    </div>
  );
}

/* Read-only ledger of evidence quotes the analyser's verifier rejected for
   not matching the source text. */
function DroppedQuotesPanel({
  bookId,
  refreshKey,
}: {
  bookId: string | null | undefined;
  refreshKey: number;
}) {
  const [file, setFile] = useState<DroppedQuotesResponse | null>(null);
  useEffect(() => {
    if (!bookId) return;
    let cancelled = false;
    api
      .getDroppedQuotes(bookId)
      .then((f) => {
        if (!cancelled) setFile(f);
      })
      .catch((err) => {
        console.warn('[analysing] dropped-quotes fetch skipped:', err.message);
      });
    return () => {
      cancelled = true;
    };
  }, [bookId, refreshKey]);
  const latest = file?.batches.length ? file.batches[file.batches.length - 1] : null;
  if (!latest || latest.entries.length === 0) return null;
  const grouped = new Map<string, typeof latest.entries>();
  for (const e of latest.entries) {
    const list = grouped.get(e.characterName);
    if (list) list.push(e);
    else grouped.set(e.characterName, [e]);
  }
  const groups = Array.from(grouped.entries());
  return (
    <details className="mt-3 text-[11px] text-ink/60">
      <summary className="cursor-pointer select-none font-semibold text-ink/80">
        Verifier dropped {latest.totalDropped} quote{latest.totalDropped === 1 ? '' : 's'} across{' '}
        {latest.affectedCharacters} character{latest.affectedCharacters === 1 ? '' : 's'}
        <span className="ml-2 font-normal text-ink/50">· latest batch</span>
      </summary>
      <ul className="mt-2 space-y-2">
        {groups.map(([name, entries]) => (
          <li key={name} className="rounded-2xl border border-ink/8 bg-white/60 px-3 py-2">
            <div className="font-semibold text-ink/80">{name}</div>
            <ul className="mt-1 space-y-1.5">
              {entries.map((e, i) => (
                <li key={i} className="border-l-2 border-amber-300/70 pl-2">
                  <div className="font-mono text-ink/70 italic wrap-break-word">
                    "{e.quote}"
                    {e.truncated && <span className="ml-1 text-ink/40">[truncated]</span>}
                  </div>
                  <div className="mt-0.5 flex flex-wrap gap-x-2 text-[10px] text-ink/40">
                    <span>
                      {e.reason === 'not_in_source' ? 'not in source' : 'empty after normalisation'}
                    </span>
                    {e.note && <span>· note: {e.note}</span>}
                  </div>
                </li>
              ))}
            </ul>
          </li>
        ))}
      </ul>
    </details>
  );
}

/* Live indicator that the analyzer's LLM call is actively returning bytes. */
function HeartbeatRow({
  hb,
  receivedAt,
  stallThresholdSec,
}: {
  hb: AnalysisHeartbeat;
  receivedAt: number;
  stallThresholdSec: number;
}) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  const sinceLast = Math.max(hb.sinceLastChunkMs, now - receivedAt);
  const sinceLastSec = Math.round(sinceLast / 1000);
  const sizeKb = hb.receivedBytes / 1024;
  const sizeText = sizeKb >= 10 ? `${Math.round(sizeKb)} KB` : `${sizeKb.toFixed(1)} KB`;
  const stalled = sinceLastSec > stallThresholdSec;
  return (
    <div
      className={`mt-2 inline-flex items-center gap-2 text-[11px] font-mono tabular-nums ${stalled ? 'text-amber-700' : 'text-emerald-700'}`}
    >
      <span
        className={`w-1.5 h-1.5 rounded-full ${stalled ? 'bg-amber-500' : 'bg-emerald-500 animate-pulse'}`}
      />
      <span className="font-semibold">{stalled ? 'Stalled' : 'Receiving response'}</span>
      <span className="text-ink/30">·</span>
      <span>{sizeText}</span>
      {hb.charsPerSec > 0 && (
        <>
          <span className="text-ink/30">·</span>
          <span>{hb.charsPerSec.toLocaleString()} chars/s</span>
        </>
      )}
      <span className="text-ink/30">·</span>
      <span>last chunk {sinceLastSec}s ago</span>
    </div>
  );
}

/* Live pill that replaces the "Receiving response" heartbeat while the
   server-side limiter is sleeping. */
function ThrottleRow({
  until,
  model,
  reason,
}: {
  until: number;
  model: string;
  reason: 'rpm' | 'tpm' | 'rpd' | 'retry-after';
}) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(id);
  }, []);
  const remainingSec = Math.max(0, Math.ceil((until - now) / 1000));
  const modelLabel = MODEL_OPTIONS.find((m) => m.id === model)?.label ?? model;
  const reasonText = (() => {
    switch (reason) {
      case 'rpm':
        return 'requests-per-minute cap';
      case 'tpm':
        return 'tokens-per-minute cap';
      case 'rpd':
        return 'daily request cap';
      case 'retry-after':
        return 'upstream retry-delay';
      default:
        return 'rate limit';
    }
  })();
  return (
    <div className="mt-2 inline-flex items-center gap-2 text-[11px] font-mono tabular-nums text-amber-700">
      <span className="w-1.5 h-1.5 rounded-full bg-amber-500 animate-pulse" />
      <span className="font-semibold">Throttling {modelLabel}</span>
      <span className="text-ink/30">·</span>
      <span>resuming in {remainingSec}s</span>
      <span className="text-ink/30">·</span>
      <span className="text-ink/50">{reasonText}</span>
    </div>
  );
}

interface PhaseCardProps {
  phase: AnalysisPhase;
  activePhaseId: number;
  phaseProgress: number;
  phaseLogs: string[];
  live: AnalysisLiveInfo | null;
  heartbeat?: { hb: AnalysisHeartbeat; receivedAt: number };
  throttle?: { until: number; model: string; reason: 'rpm' | 'tpm' | 'rpd' | 'retry-after' };
  isLocalAnalyzer: boolean;
  analysisStarted: boolean;
  conn: ConnState;
  bookId: string | null | undefined;
  droppedQuotesRefreshKey: number;
}

/* One row inside the analysing-stage phase list. Phase 0 (cast detection),
   1 (sentence attribution), and 2 (library match) all render through this
   component — the phase-0-only panels (SeriesPriorPill, LiveCastPreview,
   DroppedQuotesPanel) gate themselves internally on `phase.id === 0`. */
export function PhaseCard({
  phase: p,
  activePhaseId,
  phaseProgress,
  phaseLogs,
  live,
  heartbeat,
  throttle,
  isLocalAnalyzer,
  analysisStarted,
  conn,
  bookId,
  droppedQuotesRefreshKey,
}: PhaseCardProps) {
  const isActive = activePhaseId === p.id;
  const isDone = activePhaseId > p.id;
  const throttleActive = throttle && throttle.until > Date.now();
  /* The "warms up after ch. N" handoff only happens when the two-model split
     is engaged — then Phase 1 dispatches `minLag` chapters behind Phase 0
     (the pipelined watermark). With the split OFF, both phases run the same
     model and Phase 1 just waits for all of Phase 0, so Phase 1 stays
     'pending' rather than falsely promising a handoff (plan 118). */
  const splitActive = useAppSelector((s) => selectAnalyzerSplitIsActive(s.account));
  /* Chip state derived from activePhaseId. Phase 2 returns null from
     PhaseModelChip (no model selection), so the state value is ignored there. */
  const chipState: PhaseChipState = isDone
    ? 'done'
    : isActive
      ? 'streaming'
      : p.id === 1 && activePhaseId === 0 && splitActive
        ? 'warming'
        : 'pending';
  const hasModelControls = p.id === 0 || p.id === 1;
  return (
    <div className="px-6 py-4 flex items-start gap-4">
      <div className="mt-1 shrink-0">
        {isDone && (
          <span className="w-7 h-7 rounded-full bg-emerald-100 grid place-items-center">
            <IconCheck className="w-4 h-4 text-emerald-700" />
          </span>
        )}
        {isActive && (
          <span className="w-7 h-7 rounded-full bg-peach/20 grid place-items-center">
            <IconSpinner className="w-4 h-4 text-magenta" />
          </span>
        )}
        {!isDone && !isActive && (
          <span className="w-7 h-7 rounded-full border border-ink/15" />
        )}
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-start justify-between gap-3 flex-wrap">
          <p
            className={`font-semibold min-w-0 flex-1 ${isDone || isActive ? 'text-ink' : 'text-ink/40'}`}
          >
            {p.label}
          </p>
          {hasModelControls && (
            <div className="flex items-center gap-2 flex-wrap shrink-0">
              <PhaseModelChip phaseId={p.id as 0 | 1} state={chipState} />
              <PhaseModelSwap phaseId={p.id as 0 | 1} isActive={isActive} />
            </div>
          )}
        </div>
        {/* Detail spans the full card width rather than the narrow column
            beneath the label — keeping the model chip/dropdown out of its
            flow so it never wraps into a cramped two- or three-line block. */}
        <p className={`text-sm mt-0.5 ${isDone || isActive ? 'text-ink/60' : 'text-ink/30'}`}>
          {p.detail}
        </p>
        {isActive && (
          <>
            <div className="mt-3 h-1 rounded-full bg-ink/6 overflow-hidden">
              <div
                className="h-full bg-gradient-progress rounded-full"
                style={{ width: `${phaseProgress * 100}%` }}
              />
            </div>
            {/* Bridging status while the SSE is open but no log lines have
                arrived yet. On a fresh server the first ~2-3s after clicking
                Start is spent in getOrHydrateManuscript re-parsing the EPUB —
                silence during that window made the screen look frozen. */}
            {p.id === 0 && phaseLogs.length === 0 && analysisStarted && conn === 'connecting' && (
              <p className="mt-3 text-xs font-mono text-ink/50 italic">
                Reading the manuscript (parsing chapters)…
              </p>
            )}
            {throttleActive && throttle ? (
              <ThrottleRow until={throttle.until} model={throttle.model} reason={throttle.reason} />
            ) : (
              heartbeat && (
                <HeartbeatRow
                  hb={heartbeat.hb}
                  receivedAt={heartbeat.receivedAt}
                  stallThresholdSec={
                    isLocalAnalyzer ? STALL_THRESHOLD_LOCAL_SEC : STALL_THRESHOLD_CLOUD_SEC
                  }
                />
              )
            )}
            {live && live.chapters.length > 0 && <LiveChapterTicker live={live} />}
          </>
        )}
        {/* Cast roster is Phase 0's outcome — keep it visible after Phase 0
            completes (or is skipped via a cached resume after a model
            switch) so the user doesn't lose the detected cast just because
            the active phase advanced. */}
        {p.id === 0 && <SeriesPriorPill />}
        {p.id === 0 && <LiveCastPreview />}
        {p.id === 0 && <DroppedQuotesPanel bookId={bookId} refreshKey={droppedQuotesRefreshKey} />}
        {phaseLogs.length > 0 &&
          (isActive ? (
            <ActivePhaseLog lines={phaseLogs} />
          ) : (
            <ul className="mt-3 space-y-1.5 text-xs font-mono text-ink/50">
              {phaseLogs.slice(-COMPLETED_PHASE_TAIL).map((s, i) => (
                <li key={i}>{s}</li>
              ))}
            </ul>
          ))}
      </div>
    </div>
  );
}
