import { useEffect, useState } from 'react';
import {
  IconArrowLeft,
  IconAB,
  IconClose,
  IconClock,
  IconPlay,
  IconPause,
  IconChecks,
  IconReject,
  IconCheck,
  IconSpinner,
} from '../lib/icons';
import { SectionLabel, PrimaryButton, Pill } from '../components/primitives';
import { Waveform } from '../components/waveform';
import { CHAR_COLORS, type CharColorEntry } from '../lib/colors';
import { stripChapterPrefix } from '../lib/format-chapter-title';
import { useAbPlayback, type AbVersion } from '../lib/use-ab-playback';
import { api } from '../lib/api';
import type { Revision, Chapter, Character, CharColor, ChapterAudio } from '../lib/types';

interface Props {
  revision: Revision;
  /** Book context — needed to fetch a/b audio URLs from the workspace
      audio routes. */
  bookId: string;
  chapter: Chapter | undefined;
  character: Character | undefined;
  onClose: () => void;
  onAccept: (selection: Record<number, 'A' | 'B'>) => void;
  onReject: () => void;
  /** Plan 55 — opens the revision-history modal scoped to this chapter.
      Optional so existing callers / tests don't need to pass it (the button
      simply doesn't render when undefined). */
  onOpenHistory?: () => void;
  /** `'preview'` (plan 114 profile-regen preview gate) reframes the footer:
      Accept fans the remaining chapters out, Reject reverts + re-adjusts.
      Defaults to `'review'` (the standalone A/B accept flow). */
  mode?: 'preview' | 'review';
}

export function RevisionDiffPlayer({
  revision,
  bookId,
  chapter,
  character,
  onClose,
  onAccept,
  onReject,
  onOpenHistory,
  mode = 'review',
}: Props) {
  const isPreview = mode === 'preview';
  const [selected, setSelected] = useState<Record<number, 'A' | 'B'>>(() => {
    const m: Record<number, 'A' | 'B'> = {};
    revision.segments.forEach((s) => {
      if (s.id != null) m[s.id] = s.changed ? 'B' : 'A';
    });
    return m;
  });
  const [autoCompare, setAutoCompare] = useState(false);

  /* Audio URL fetch — A (preserved/previous) and B (live/new). Stays in
     a single effect keyed on bookId+chapterId so navigation between
     pending revisions reuses the latest pair. `hasPreviousAudio === false`
     on the revision flips the A card to "Original audio not preserved"
     without firing the previous fetch (saves a 404 round-trip). */
  const [audioA, setAudioA] = useState<ChapterAudio | null>(null);
  const [audioB, setAudioB] = useState<ChapterAudio | null>(null);
  const [audioBError, setAudioBError] = useState<string | null>(null);
  const hasPreviousAudio = revision.hasPreviousAudio !== false;
  const playable = revision.playable !== false;

  useEffect(() => {
    if (!chapter) return;
    let cancelled = false;
    if (hasPreviousAudio) {
      api
        .getChapterAudioPrevious({ bookId, chapterId: chapter.id, duration: chapter.duration })
        .then((res) => {
          if (!cancelled) setAudioA(res);
        })
        .catch((err) => {
          console.warn('[revision-diff] previous audio fetch failed:', err);
        });
    }
    if (playable) {
      api
        .getChapterAudio({ bookId, chapterId: chapter.id, duration: chapter.duration })
        .then((res) => {
          if (!cancelled) setAudioB(res);
        })
        .catch((err) => {
          if (!cancelled) setAudioBError((err as Error).message);
        });
    }
    return () => {
      cancelled = true;
    };
  }, [bookId, chapter, hasPreviousAudio, playable]);

  const ab = useAbPlayback({
    urlA: audioA?.url ?? null,
    urlB: audioB?.url ?? null,
  });

  /* Auto-compare: walk changed segments, playing A then B for each.
     Aborts on stop / unmount / next segment. */
  useEffect(() => {
    if (!autoCompare) return;
    let cancelled = false;
    const changedSegments = revision.segments.filter((s) => s.changed && s.id != null);
    (async () => {
      for (const seg of changedSegments) {
        if (cancelled) return;
        const start = audioA?.segments?.find((s) => s.sentenceId === seg.id)?.start;
        const end = audioA?.segments?.find((s) => s.sentenceId === seg.id)?.end;
        try {
          await ab.playA({ segmentId: seg.id ?? undefined, start, end });
        } catch {
          /* ignore */
        }
        await waitForVersionEnd();
        if (cancelled) return;
        const startB = audioB?.segments?.find((s) => s.sentenceId === seg.id)?.start;
        const endB = audioB?.segments?.find((s) => s.sentenceId === seg.id)?.end;
        try {
          await ab.playB({ segmentId: seg.id ?? undefined, start: startB, end: endB });
        } catch {
          /* ignore */
        }
        await waitForVersionEnd();
      }
      if (!cancelled) setAutoCompare(false);
    })();
    /* The end-of-segment signal is the hook's `playing` going back to
       null. Poll because the hook is built around event-driven state
       internally; a 50ms tick is plenty for sentence-length audio. */
    function waitForVersionEnd(): Promise<void> {
      return new Promise((resolve) => {
        const start = Date.now();
        const tick = () => {
          if (cancelled) return resolve();
          if (ab.playing === null) return resolve();
          if (Date.now() - start > 30_000) return resolve();
          setTimeout(tick, 100);
        };
        setTimeout(tick, 100);
      });
    }
    return () => {
      cancelled = true;
      ab.pause();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoCompare]);

  if (!revision || !chapter) return null;

  const c = CHAR_COLORS[(character?.color as CharColor) || 'narrator'];
  const totalChanged = revision.segments.filter((s) => s.changed).length;
  const acceptedNew = revision.segments.filter(
    (s) => s.changed && s.id != null && selected[s.id] === 'B',
  ).length;

  const acceptAllNew = () =>
    setSelected(
      Object.fromEntries(
        revision.segments.flatMap((s) => (s.id != null ? [[s.id, s.changed ? 'B' : 'A']] : [])),
      ),
    );
  const rejectAll = () =>
    setSelected(
      Object.fromEntries(revision.segments.flatMap((s) => (s.id != null ? [[s.id, 'A']] : []))),
    );

  function handlePlay(
    version: AbVersion,
    opts: { segmentId?: number; start?: number; end?: number } = {},
  ) {
    if (ab.playing === version && ab.segmentId === (opts.segmentId ?? null)) {
      ab.pause();
      return;
    }
    /* Disable B when not playable; disable A when not preserved. */
    if (version === 'A' && !hasPreviousAudio) return;
    if (version === 'B' && !playable) return;
    const fn = version === 'A' ? ab.playA : ab.playB;
    fn(opts).catch((err) => {
      console.warn('[revision-diff] play failed:', err);
    });
  }

  return (
    <div className="fixed inset-0 z-50 bg-canvas overflow-y-auto fade-in">
      <header className="sticky top-0 z-10 bg-canvas/90 backdrop-blur-md border-b border-ink/10">
        <div className="max-w-[1400px] mx-auto px-6 h-16 flex items-center gap-4">
          <button onClick={onClose} className="p-2 rounded-full hover:bg-ink/5 text-ink/60">
            <IconArrowLeft className="w-4 h-4" />
          </button>
          <span className="w-8 h-8 rounded-full bg-peach/20 grid place-items-center text-magenta">
            <IconAB className="w-4 h-4" />
          </span>
          <div className="flex-1 min-w-0">
            <p className="text-[11px] uppercase tracking-wider text-ink/50 font-semibold">
              {isPreview ? 'Voice preview · A/B' : 'Revision review · A/B'}
            </p>
            <h1 className="text-base font-bold text-ink leading-tight truncate">
              CH {String(chapter.id).padStart(2, '0')} · {stripChapterPrefix(chapter.title)}
              {character ? ` · ${character.name}` : ''}
            </h1>
          </div>
          <span className="text-xs text-ink/55 hidden md:inline-flex items-center gap-1.5">
            <IconClock className="w-3.5 h-3.5" />
            Triggered {revision.triggeredAgo}
          </span>
          {onOpenHistory && (
            <button
              type="button"
              onClick={onOpenHistory}
              className="px-3 py-1.5 rounded-full text-xs font-semibold border border-ink/15 text-ink/70 hover:bg-ink/5"
              data-testid="revision-diff-open-history"
              aria-label="View revision history"
            >
              History
            </button>
          )}
          <button onClick={onClose} className="p-2 rounded-full hover:bg-ink/5 text-ink/60">
            <IconClose className="w-4 h-4" />
          </button>
        </div>
      </header>

      <div className="max-w-[1400px] mx-auto px-6 py-8 grid grid-cols-1 lg:grid-cols-[1fr_360px] gap-8">
        <main>
          <section className="grid grid-cols-2 gap-4 mb-6">
            <ABCard
              label="A · Current"
              sub={
                hasPreviousAudio
                  ? 'Already in your audiobook'
                  : 'Original audio not preserved — review by metadata only'
              }
              duration={revision.oldDuration}
              variant="current"
              available={hasPreviousAudio}
              isPlaying={ab.playing === 'A' && ab.segmentId === null}
              onPlay={() => handlePlay('A')}
            />
            <ABCard
              label="B · New draft"
              sub={playable ? (revision.triggeredBy ?? '') : 'Rendering new take…'}
              duration={revision.newDuration}
              variant="new"
              character={character}
              available={playable}
              error={audioBError ?? undefined}
              isPlaying={ab.playing === 'B' && ab.segmentId === null}
              onPlay={() => handlePlay('B')}
            />
          </section>

          <section className="mb-6 flex items-center justify-between gap-3 p-4 rounded-2xl bg-white border border-ink/10">
            <div className="flex items-center gap-3">
              <span className="w-9 h-9 rounded-full bg-ink text-canvas grid place-items-center">
                <IconAB className="w-4 h-4" />
              </span>
              <div>
                <p className="text-sm font-bold text-ink">Auto-compare</p>
                <p className="text-xs text-ink/55">
                  Plays each changed segment A then B in sequence.
                </p>
              </div>
            </div>
            <button
              onClick={() => setAutoCompare(!autoCompare)}
              disabled={!playable || !hasPreviousAudio || totalChanged === 0}
              className={`px-4 py-2 rounded-full text-sm font-semibold transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${autoCompare ? 'bg-peach text-ink' : 'bg-ink/[0.04] text-ink hover:bg-ink/[0.08]'}`}
            >
              {autoCompare ? (
                <>
                  <IconPause className="w-3.5 h-3.5 inline mr-1" /> Stop
                </>
              ) : (
                <>
                  <IconPlay className="w-3.5 h-3.5 inline mr-1" /> Listen back-to-back
                </>
              )}
            </button>
          </section>

          {revision.segments.length > 0 && (
            <section>
              <div className="flex items-center justify-between mb-3">
                <SectionLabel>Per-segment review</SectionLabel>
                <span className="text-xs text-ink/50">
                  {totalChanged} segments changed · {acceptedNew} taking B
                </span>
              </div>
              <div className="space-y-2">
                {revision.segments.map((seg) => {
                  const segMetaA =
                    seg.id != null
                      ? audioA?.segments?.find((s) => s.sentenceId === seg.id)
                      : undefined;
                  const segMetaB =
                    seg.id != null
                      ? audioB?.segments?.find((s) => s.sentenceId === seg.id)
                      : undefined;
                  return (
                    <SegmentDiffRow
                      key={seg.id}
                      seg={seg}
                      charColor={c}
                      selectedVersion={seg.id != null ? selected[seg.id] : 'A'}
                      onSelect={(v) => seg.id != null && setSelected({ ...selected, [seg.id]: v })}
                      isPlayingA={ab.playing === 'A' && ab.segmentId === seg.id}
                      isPlayingB={ab.playing === 'B' && ab.segmentId === seg.id}
                      aDisabled={!hasPreviousAudio}
                      bDisabled={!playable}
                      onPlayA={() =>
                        handlePlay('A', {
                          segmentId: seg.id ?? undefined,
                          start: segMetaA?.start,
                          end: segMetaA?.end,
                        })
                      }
                      onPlayB={() =>
                        handlePlay('B', {
                          segmentId: seg.id ?? undefined,
                          start: segMetaB?.start,
                          end: segMetaB?.end,
                        })
                      }
                    />
                  );
                })}
              </div>
            </section>
          )}
        </main>

        <aside className="self-start sticky top-24 space-y-4">
          <div className="bg-white rounded-3xl border border-ink/10 p-5 shadow-card">
            <p className="text-[11px] uppercase tracking-wider text-ink/50 font-semibold mb-2">
              Confidence
            </p>
            <p className="text-4xl font-bold text-ink tabular-nums leading-none">
              {Math.round((revision.confidence ?? 0) * 100)}
              <span className="text-xl text-ink/50">%</span>
            </p>
            <p className="mt-2 text-xs text-ink/60 leading-relaxed">
              The new take aligns closely with {character?.name}'s voice profile. No anomalies
              detected.
            </p>

            <hr className="my-4 border-ink/10" />
            <dl className="space-y-2 text-sm">
              <div className="flex items-center justify-between">
                <dt className="text-ink/55 text-xs">Old duration</dt>
                <dd className="font-bold text-ink tabular-nums">{revision.oldDuration}</dd>
              </div>
              <div className="flex items-center justify-between">
                <dt className="text-ink/55 text-xs">New duration</dt>
                <dd className="font-bold text-ink tabular-nums">{revision.newDuration}</dd>
              </div>
              <div className="flex items-center justify-between">
                <dt className="text-ink/55 text-xs">Segments changed</dt>
                <dd className="font-bold text-ink tabular-nums">
                  {totalChanged} of {revision.segments.length}
                </dd>
              </div>
            </dl>
          </div>

          <div className="bg-white rounded-3xl border border-ink/10 p-5 shadow-card space-y-2">
            <button
              onClick={acceptAllNew}
              className="w-full inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-full bg-emerald-50 hover:bg-emerald-100 text-emerald-700 text-sm font-semibold transition-colors"
            >
              <IconChecks className="w-4 h-4" /> Accept all changes
            </button>
            <button
              onClick={rejectAll}
              className="w-full inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-full bg-rose-50 hover:bg-rose-100 text-rose-700 text-sm font-semibold transition-colors"
            >
              <IconReject className="w-4 h-4" /> Reject all changes
            </button>
          </div>
        </aside>
      </div>

      <footer className="sticky bottom-0 bg-white border-t border-ink/10">
        <div className="max-w-[1400px] mx-auto px-6 py-4 flex items-center gap-3">
          <span className="text-sm">
            {isPreview ? (
              <span className="text-ink/60">
                Listen to both takes on this chapter, then approve to regenerate the rest — or reject
                and re-adjust the voice.
              </span>
            ) : (
              <>
                <span className="font-bold text-ink tabular-nums">{acceptedNew}</span>{' '}
                <span className="text-ink/60">
                  of <span className="tabular-nums">{totalChanged}</span> changed segments taking the
                  new take
                </span>
              </>
            )}
          </span>
          <span className="ml-auto flex items-center gap-3">
            <button
              onClick={onReject}
              className="px-4 py-2.5 text-sm font-medium text-ink/70 hover:text-ink"
            >
              {isPreview ? 'Reject & re-adjust' : 'Reject draft'}
            </button>
            <PrimaryButton variant="dark" onClick={() => onAccept(selected)}>
              {isPreview ? 'Approve — regenerate the rest' : 'Commit selection'}
            </PrimaryButton>
          </span>
        </div>
      </footer>
    </div>
  );
}

interface ABCardProps {
  label: string;
  sub: string;
  duration?: string;
  variant: 'current' | 'new';
  character?: Character;
  available: boolean;
  isPlaying: boolean;
  error?: string;
  onPlay: () => void;
}
function ABCard({
  label,
  sub,
  duration,
  variant,
  character,
  available,
  isPlaying,
  error,
  onPlay,
}: ABCardProps) {
  const isNew = variant === 'new';
  const c = character ? CHAR_COLORS[character.color as CharColor] : null;
  return (
    <div
      className={`rounded-3xl border p-5 transition-all ${isNew ? 'border-peach bg-peach/[0.06]' : 'border-ink/10 bg-white'} shadow-card`}
    >
      <div className="flex items-center justify-between mb-3">
        <p
          className={`text-[11px] uppercase tracking-wider font-bold ${isNew ? 'text-magenta' : 'text-ink/55'}`}
        >
          {label}
        </p>
        {isNew && <Pill color="peach">Draft</Pill>}
      </div>
      <p className="text-xs text-ink/60 leading-relaxed mb-4">{sub}</p>
      <div className="flex items-center gap-3 mb-3">
        <button
          onClick={onPlay}
          disabled={!available}
          aria-label={isPlaying ? `Pause ${label}` : `Play ${label}`}
          className={`w-12 h-12 rounded-full grid place-items-center transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${isNew ? 'bg-ink text-canvas hover:bg-ink-soft' : 'bg-canvas border border-ink/15 text-ink hover:bg-ink hover:text-canvas'}`}
        >
          {!available && isNew ? (
            <IconSpinner className="w-5 h-5 animate-spin" />
          ) : isPlaying ? (
            <IconPause className="w-5 h-5" />
          ) : (
            <IconPlay className="w-5 h-5 ml-0.5" />
          )}
        </button>
        <Waveform progress={0} active={isPlaying} />
        <span className="text-sm tabular-nums text-ink/70 ml-auto">{duration}</span>
      </div>
      {error && <p className="mt-1 text-[11px] text-red-600/90 font-medium">⚠ {error}</p>}
      {c && isNew && character && (
        <p className="text-[11px] text-magenta font-semibold inline-flex items-center gap-1.5">
          <span className="w-2 h-2 rounded-full" style={{ background: c.hex }} />
          Voice: {character.name}
        </p>
      )}
    </div>
  );
}

type Segment = Revision['segments'][number];
interface SegmentRowProps {
  seg: Segment;
  charColor: CharColorEntry;
  selectedVersion: 'A' | 'B' | undefined;
  onSelect: (v: 'A' | 'B') => void;
  isPlayingA: boolean;
  isPlayingB: boolean;
  aDisabled: boolean;
  bDisabled: boolean;
  onPlayA: () => void;
  onPlayB: () => void;
}

function SegmentDiffRow({
  seg,
  charColor,
  selectedVersion,
  onSelect,
  isPlayingA,
  isPlayingB,
  aDisabled,
  bDisabled,
  onPlayA,
  onPlayB,
}: SegmentRowProps) {
  const isSelectedB = selectedVersion === 'B';
  return (
    <div
      className={`p-4 rounded-2xl border transition-all ${seg.changed ? (isSelectedB ? 'border-peach bg-peach/[0.04]' : 'border-ink/10 bg-white') : 'border-ink/5 bg-canvas/60'}`}
    >
      <div className="flex items-start gap-3">
        <span
          className="mt-1.5 w-1 h-6 rounded-full shrink-0"
          style={{ background: seg.narratorOnly ? CHAR_COLORS.narrator.hex : charColor.hex }}
        />
        <div className="flex-1 min-w-0">
          <p className="font-serif text-[15px] text-ink/90 leading-relaxed mb-3">{seg.text}</p>

          {seg.narratorOnly ? (
            <Pill>Narrator-only · unchanged</Pill>
          ) : seg.changed ? (
            <div className="grid grid-cols-2 gap-2">
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  onSelect('A');
                  onPlayA();
                }}
                disabled={aDisabled}
                className={`group flex items-center gap-2 p-2 rounded-xl transition-all border text-left disabled:opacity-40 disabled:cursor-not-allowed ${selectedVersion === 'A' ? 'border-ink bg-ink/[0.04]' : 'border-ink/10 hover:border-ink/20'}`}
              >
                <span
                  className={`w-7 h-7 rounded-full grid place-items-center transition-colors ${isPlayingA ? 'bg-ink text-canvas' : 'bg-white border border-ink/15 text-ink/60 group-hover:text-ink'}`}
                >
                  {isPlayingA ? (
                    <IconPause className="w-3 h-3" />
                  ) : (
                    <IconPlay className="w-3 h-3 ml-0.5" />
                  )}
                </span>
                <span className="flex-1 min-w-0">
                  <span className="block text-[11px] uppercase tracking-wider font-bold text-ink/50">
                    A · current
                  </span>
                  <span className="block text-[11px] tabular-nums text-ink/60">
                    {seg.oldDuration}
                  </span>
                </span>
                {selectedVersion === 'A' && (
                  <span className="w-3.5 h-3.5 rounded-full bg-ink text-canvas grid place-items-center">
                    <IconCheck className="w-2 h-2" />
                  </span>
                )}
              </button>

              <button
                onClick={(e) => {
                  e.stopPropagation();
                  onSelect('B');
                  onPlayB();
                }}
                disabled={bDisabled}
                className={`group flex items-center gap-2 p-2 rounded-xl transition-all border text-left disabled:opacity-40 disabled:cursor-not-allowed ${selectedVersion === 'B' ? 'border-peach bg-peach/[0.10]' : 'border-ink/10 hover:border-ink/20'}`}
              >
                <span
                  className={`w-7 h-7 rounded-full grid place-items-center transition-colors ${isPlayingB ? 'bg-magenta text-white' : 'bg-white border border-ink/15 text-ink/60 group-hover:text-magenta'}`}
                >
                  {isPlayingB ? (
                    <IconPause className="w-3 h-3" />
                  ) : (
                    <IconPlay className="w-3 h-3 ml-0.5" />
                  )}
                </span>
                <span className="flex-1 min-w-0">
                  <span className="block text-[11px] uppercase tracking-wider font-bold text-magenta">
                    B · new
                  </span>
                  <span className="block text-[11px] tabular-nums text-ink/60">
                    {seg.newDuration}
                  </span>
                </span>
                {selectedVersion === 'B' && (
                  <span className="w-3.5 h-3.5 rounded-full bg-peach text-ink grid place-items-center">
                    <IconCheck className="w-2 h-2" />
                  </span>
                )}
              </button>
            </div>
          ) : (
            <Pill>Unchanged</Pill>
          )}
        </div>
      </div>
    </div>
  );
}
