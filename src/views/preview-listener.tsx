import { IconEye, IconArrowLeft, IconPlay, IconPause, IconLock, IconShare } from '../lib/icons';
import { SectionLabel, PrimaryButton, Pill } from '../components/primitives';
import { Waveform } from '../components/waveform';
import { parseDuration, formatTime } from '../lib/time';
import { stripChapterPrefix } from '../lib/format-chapter-title';
import type { Chapter, Character } from '../lib/types';

interface Props {
  chapters: Chapter[];
  characters: Character[];
  onExit: () => void;
  currentTrack: number | null;
  setCurrentTrack: (t: number | null) => void;
}

export function PreviewListenerView({
  chapters,
  characters,
  onExit,
  currentTrack,
  setCurrentTrack,
}: Props) {
  const totalSec = chapters.reduce((s, c) => s + parseDuration(c.duration), 0);
  const findChar = (id: string) => characters.find((c) => c.id === id);
  return (
    <div className="min-h-screen">
      <div className="bg-ink text-canvas border-b border-canvas/10 px-6 py-2.5 flex items-center justify-center gap-3 text-xs">
        <span className="inline-flex items-center gap-2 px-2.5 py-1 rounded-full bg-peach/20 text-peach font-semibold">
          <IconEye className="w-3.5 h-3.5" /> Listener preview
        </span>
        <span className="text-canvas/60">This is what people see when you share the link.</span>
        <button
          onClick={onExit}
          className="ml-2 inline-flex items-center gap-1.5 text-canvas/80 hover:text-canvas font-medium"
        >
          <IconArrowLeft className="w-3.5 h-3.5" /> Exit preview
        </button>
      </div>

      <section className="relative overflow-hidden">
        <div className="absolute inset-0 bg-gradient-cta opacity-95 pointer-events-none" />
        <div className="relative max-w-4xl mx-auto px-6 pt-16 pb-20 text-center">
          <p className="text-[11px] uppercase tracking-[0.2em] text-white/70 font-semibold mb-6">
            An audiobook by Marin Vale
          </p>
          <h1 className="font-serif text-5xl md:text-7xl font-bold text-white leading-[1.05]">
            The Northern Star
          </h1>
          <p className="font-serif italic text-white/80 mt-3 text-lg">
            A novel · Northern Coast Trilogy · Book Two
          </p>
          <div className="mt-7 inline-flex items-center gap-2 text-sm text-white/80">
            <span>Narrated by Anders Vale &amp; cast of {characters.length - 1}</span>
            <span>·</span>
            <span className="tabular-nums">{formatTime(totalSec)}</span>
            <span>·</span>
            <span>{chapters.length} chapters</span>
          </div>
          <div className="mt-10 flex flex-wrap items-center justify-center gap-3">
            <button
              onClick={() => setCurrentTrack(chapters[0].id)}
              className="inline-flex items-center gap-3 rounded-full bg-canvas text-ink hover:bg-white pl-5 pr-7 py-3 text-sm font-bold transition-colors shadow-float"
            >
              <span className="w-9 h-9 rounded-full bg-ink text-canvas grid place-items-center">
                <IconPlay className="w-4 h-4 ml-0.5" />
              </span>
              Listen to chapter one
            </button>
            <button className="px-5 py-3 rounded-full bg-white/10 backdrop-blur-xs text-white hover:bg-white/20 text-sm font-medium inline-flex items-center gap-2 border border-white/20">
              <IconShare className="w-4 h-4" /> Copy link
            </button>
          </div>
        </div>
      </section>

      <section className="max-w-4xl mx-auto px-6 py-12">
        <div className="flex items-center justify-between mb-3">
          <SectionLabel>Chapters</SectionLabel>
          <span className="text-xs text-ink/50">
            First three chapters available · sign in for the rest
          </span>
        </div>
        <div className="bg-white rounded-3xl border border-ink/10 shadow-card divide-y divide-ink/5 overflow-hidden">
          {chapters.map((ch, i) => {
            const free = i < 3;
            const charsIn = Object.entries(ch.characters)
              .filter(([, st]) => st !== 'skipped')
              .map(([id]) => findChar(id))
              .filter(Boolean) as Character[];
            const isPlaying = currentTrack === ch.id && free;
            return (
              <div
                key={ch.id}
                className={`grid grid-cols-[40px_60px_1fr_180px_100px] items-center gap-4 px-5 py-4 ${free ? 'hover:bg-ink/2' : 'opacity-60'}`}
              >
                <button
                  onClick={() => {
                    if (free) setCurrentTrack(currentTrack === ch.id ? null : ch.id);
                  }}
                  disabled={!free}
                  className={`w-9 h-9 rounded-full grid place-items-center transition-all ${isPlaying ? 'bg-ink text-canvas' : free ? 'bg-canvas border border-ink/15 text-ink hover:bg-ink hover:text-canvas' : 'bg-canvas border border-ink/10 text-ink/40 cursor-not-allowed'}`}
                >
                  {free ? (
                    isPlaying ? (
                      <IconPause className="w-3.5 h-3.5" />
                    ) : (
                      <IconPlay className="w-3.5 h-3.5 ml-0.5" />
                    )
                  ) : (
                    <IconLock className="w-3.5 h-3.5" />
                  )}
                </button>
                <span className="text-sm font-bold text-ink/50 tabular-nums">
                  CH {String(ch.id).padStart(2, '0')}
                </span>
                <span className="min-w-0">
                  <span className="block font-semibold text-ink truncate">
                    {stripChapterPrefix(ch.title)}
                  </span>
                  <span className="block text-xs text-ink/50 truncate mt-0.5">
                    With{' '}
                    {charsIn
                      .slice(0, 4)
                      .map((c) => c.name)
                      .join(', ')}
                  </span>
                </span>
                <Waveform progress={isPlaying ? 0.3 : 0} active={isPlaying} />
                <span className="text-sm tabular-nums text-ink/60 text-right">
                  {free ? ch.duration : <Pill>Locked</Pill>}
                </span>
              </div>
            );
          })}
        </div>
      </section>

      <section className="max-w-4xl mx-auto px-6 pb-20">
        <div className="rounded-3xl bg-ink text-canvas px-8 py-10 text-center">
          <p className="text-[10px] uppercase tracking-widest text-canvas/60 font-semibold mb-4">
            Created with
          </p>
          <p className="font-bold text-3xl tracking-tight">
            audiobook<span className="text-peach">.</span>
          </p>
          <p className="text-canvas/70 mt-3 max-w-md mx-auto leading-relaxed">
            Turn your manuscript into a multi-voice audiobook in an afternoon. Voices generated from
            the prose, narrators reused across a series.
          </p>
          <div className="mt-6">
            <PrimaryButton variant="light">Start a project</PrimaryButton>
          </div>
        </div>
        <p className="text-center text-xs text-ink/40 mt-6">
          © 2026 Marin Vale. Listening preview generated 9 May 2026.
        </p>
      </section>
    </div>
  );
}
