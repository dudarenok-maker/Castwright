import { useState } from 'react';
import { IconCheckCircle, IconClose } from '../lib/icons';
import { Avatar, VoiceSwatch, PrimaryButton } from '../components/primitives';
import { SYNC_AUTO_THRESHOLD } from '../views/confirm-cast';
import type { Character, Voice } from '../lib/types';
import { useAppSelector } from '../store';
import { pausedControlProps, useCastReadOnly } from '../components/cast-edits-paused-banner';
import { useSamplePlayback } from '../lib/use-sample-playback';
import { playSampleWithAutoLoad } from '../lib/play-sample-with-auto-load';
import { buildCharacterHint } from '../lib/build-character-hint';
import { engineForModelKey, modelKeyForEngineChoice } from '../lib/tts-models';

interface Props {
  character: Character | null;
  voice: Voice | null | undefined;
  onClose: () => void;
  onConfirm: () => void;
  onDecline: () => void;
  /* The matched character's name in the matched book, when the series roster
     resolves it; the voice's own `character` is frozen on whichever book the scan
     reached first, so it is not used here. */
  matchedCharacterName?: string;
}

export function MatchDetailDrawer({
  character,
  voice,
  onClose,
  onConfirm,
  onDecline,
  matchedCharacterName,
}: Props) {
  const playback = useSamplePlayback();
  const ttsModelKey = useAppSelector((s) => s.ui.ttsModelKey);
  /* Plan 291 (#4031) — decline writes the cast slice, so it waits for a re-analysis. */
  const readOnly = useCastReadOnly();
  const [sampleBusy, setSampleBusy] = useState(false);
  const [sampleError, setSampleError] = useState<string | null>(null);
  if (!character || !voice) return null;
  /* Real factors from the voice-match response (cast-slice stores them as
     matchFactors); mock mode feeds the design fixtures through the same field.
     A manual link or a decline clears them. */
  const factors = character.matchFactors ?? [];
  const overall = character.matchedFrom?.confidence;
  async function playSample() {
    if (!voice || !character) return;
    setSampleError(null);
    setSampleBusy(true);
    /* Audition in THIS character's own effective engine, not the book's
       default (#1839) — mirrors cast.tsx's effectiveEngineFor / profile-
       drawer.tsx's currentEngine: the character's own ttsEngine override
       wins, else the session default. */
    const effectiveEngine = character.ttsEngine ?? engineForModelKey(ttsModelKey);
    try {
      await playSampleWithAutoLoad({
        args: {
          voiceId: voice.id,
          voice,
          modelKey: modelKeyForEngineChoice(effectiveEngine, ttsModelKey),
          characterHint: buildCharacterHint(character),
        },
        playback,
      });
    } catch (err) {
      setSampleError((err as Error).message);
    } finally {
      setSampleBusy(false);
    }
  }
  return (
    <>
      <div onClick={onClose} className="fixed inset-0 bg-ink/30 z-60 fade-in" />
      <aside
        className="fixed top-0 right-0 bottom-0 w-full max-w-[560px] bg-white shadow-drawer z-70 overflow-y-auto scrollbar-thin slide-in-right"
        style={{ ['--scrollbar-thin-radius' as string]: '0px' } as React.CSSProperties}
      >
        <div className="sticky top-0 bg-white/95 backdrop-blur-md border-b border-ink/10 px-6 py-4 flex items-center gap-3">
          <span className="w-9 h-9 rounded-full bg-purple-deep/6 grid place-items-center text-purple-deep">
            <IconCheckCircle className="w-5 h-5" />
          </span>
          <div className="flex-1 min-w-0">
            <p className="text-[11px] uppercase tracking-wider text-ink/50 font-semibold">
              Match detail
            </p>
            <h3 className="text-base font-bold text-ink leading-tight truncate">
              Why we matched {character.name}
            </h3>
          </div>
          <button onClick={onClose} className="p-2 rounded-full hover:bg-ink/5 text-ink/60">
            <IconClose className="w-4 h-4" />
          </button>
        </div>

        <div className="p-6 space-y-7">
          {overall != null && (
            <section className="text-center">
              <p className="text-[11px] uppercase tracking-wider text-ink/50 font-semibold mb-2">
                Overall confidence
              </p>
              <p className="text-5xl font-bold text-ink tabular-nums leading-none">
                {Math.round(overall * 100)}
                <span className="text-2xl text-ink/50">%</span>
              </p>
              <p className="mt-2 text-xs text-ink/60">
                {overall >= SYNC_AUTO_THRESHOLD
                  ? 'Strong match — voice continuity recommended.'
                  : 'Lower-confidence match — listen to the voice before you reuse it.'}
              </p>
            </section>
          )}

          <section className="grid grid-cols-2 gap-3">
            <div className="p-4 rounded-2xl bg-canvas border border-ink/10 text-center">
              <p className="text-[11px] uppercase tracking-wider text-ink/50 font-semibold mb-3">
                In this book
              </p>
              <div className="grid place-items-center">
                <Avatar name={character.name} color={character.color as never} size={56} />
              </div>
              <p className="mt-3 font-bold text-ink truncate">{character.name}</p>
              <p className="text-xs text-ink/60 mt-0.5 truncate">{character.role}</p>
            </div>
            <div className="p-4 rounded-2xl bg-purple-deep/4 border border-purple-deep/15 text-center">
              <p className="text-[11px] uppercase tracking-wider text-purple-deep/70 font-semibold mb-3">
                From your library
              </p>
              <div className="grid place-items-center">
                <VoiceSwatch
                  voice={voice}
                  size="md"
                  showLabel={false}
                  onSelect={() => {
                    void playSample();
                  }}
                  loading={sampleBusy}
                />
              </div>
              {(character.matchedFrom ? matchedCharacterName : voice.character) && (
                <p className="mt-3 font-bold text-ink truncate">
                  {character.matchedFrom ? matchedCharacterName : voice.character}
                </p>
              )}
              <p className="text-xs text-purple-deep/70 mt-0.5 truncate">
                {character.matchedFrom?.bookTitle ?? voice.bookTitle}
              </p>
              {sampleError && (
                <p className="mt-2 text-[11px] text-red-600/90 font-medium">⚠ {sampleError}</p>
              )}
            </div>
          </section>

          {factors.length > 0 && (
            <section>
              <p className="text-[11px] uppercase tracking-wider text-ink/50 font-semibold mb-3">
                Match factors
              </p>
              <div className="space-y-3">
                {factors.map((f) => (
                  <div key={f.id} className="p-3 rounded-2xl bg-canvas border border-ink/5">
                    <div className="flex items-center justify-between mb-2 gap-3">
                      <span className="text-sm font-semibold text-ink">{f.label}</span>
                      <span className="text-xs font-bold text-ink tabular-nums">
                        {Math.round(f.score * 100)}%
                      </span>
                    </div>
                    <div className="h-1 rounded-full bg-ink/6 overflow-hidden mb-2">
                      <div
                        className="h-full rounded-full bg-gradient-progress"
                        style={{ width: `${f.score * 100}%` }}
                      />
                    </div>
                    <p className="text-xs text-ink/60 leading-relaxed">{f.detail}</p>
                  </div>
                ))}
              </div>
            </section>
          )}

          <section>
            <p className="text-[11px] uppercase tracking-wider text-ink/50 font-semibold mb-3">
              Evidence that tipped the match
            </p>
            <div className="space-y-3">
              {character.evidence?.slice(0, 2).map((ev, i) => (
                <blockquote key={i} className="p-3 rounded-2xl bg-canvas border border-ink/5">
                  <p className="font-serif italic text-sm text-ink/85 leading-relaxed">
                    "{ev.quote}"
                  </p>
                  <p className="mt-2 text-xs text-ink/55">{ev.note}</p>
                </blockquote>
              ))}
            </div>
          </section>
        </div>

        <div className="sticky bottom-0 bg-white border-t border-ink/10 px-6 py-4 flex items-center gap-3">
          <button
            onClick={() => {
              if (readOnly) return;
              onDecline();
            }}
            {...pausedControlProps(readOnly)}
            className={`px-4 py-2 text-sm font-medium text-ink/70 hover:text-ink ${readOnly ? 'opacity-40 cursor-not-allowed' : ''}`}
          >
            Don't reuse
          </button>
          <PrimaryButton variant="dark" onClick={onConfirm}>
            Confirm match
          </PrimaryButton>
        </div>
      </aside>
    </>
  );
}
