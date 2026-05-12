import { useState } from 'react';
import { IconClose, IconWaveform, IconRefresh, IconStar, IconLock, IconPlus, IconPause, IconSpinner } from '../lib/icons';
import { TTS_MODEL_OPTIONS } from '../lib/tts-models';
import type { TtsModelKey } from '../lib/types';
import { Avatar, VoiceSwatch, Pill, PrimaryButton } from '../components/primitives';
import { CHAR_COLORS } from '../lib/colors';
import type { Character, Voice, CharColor } from '../lib/types';
import { api } from '../lib/api';
import { useSamplePlayback } from '../lib/use-sample-playback';
import { resolveTtsVoiceForCharacter } from '../lib/tts-voice-mapping';
import { useAppSelector } from '../store';

interface Props {
  character: Character;
  voice: Voice | undefined;
  onClose: () => void;
  onSave: (next: Character) => void;
  onShowMatchDetail?: (id: string) => void;
  onRegenerateCharacter?: (id: string) => void;
}

export function ProfileDrawer({ character, voice, onClose, onSave, onShowMatchDetail, onRegenerateCharacter }: Props) {
  const [tone, setTone] = useState(character.tone ?? { warmth: 50, pace: 50, authority: 50, emotion: 50 });
  const [regenerating, setRegenerating] = useState(false);
  const c = CHAR_COLORS[character.color as CharColor] ?? CHAR_COLORS.narrator;
  const playback = useSamplePlayback();
  const ttsModelKey = useAppSelector(s => s.ui.ttsModelKey);
  const [sampleLoading, setSampleLoading] = useState(false);
  const [sampleError, setSampleError] = useState<string | null>(null);

  /* Sample subject: a library voice when one is matched, otherwise a
     character-derived stub so brand-new (unmatched) characters can still
     preview their attributes. Server file is namespaced `char-<id>` for
     character samples to keep them separate from library voice samples. */
  const sampleVoiceId  = voice ? voice.id : `char-${character.id}`;
  const sampleSubject = voice ?? {
    id: sampleVoiceId,
    character: character.name,
    bookTitle: '',
    bookId: '',
    attributes: character.attributes ?? [],
    gradient: ['#999999', '#666666'] as [string, string],
    usedIn: 0,
    source: 'current' as const,
    ttsVoice: resolveTtsVoiceForCharacter(character),
  };
  const sampleUrl = sampleUrlFor(sampleVoiceId, ttsModelKey);
  const isPlayingThis = playback.isPlaying && playback.currentUrl === sampleUrl;

  function regenerate() {
    setRegenerating(true);
    setTimeout(() => setRegenerating(false), 1800);
  }

  async function playSample() {
    if (isPlayingThis) { playback.stop(); return; }
    setSampleError(null);
    setSampleLoading(true);
    const evidence = (character.evidence ?? []).map(e => e.quote).filter((q): q is string => typeof q === 'string' && q.length > 0);
    const characterHint = {
      description: character.description,
      role: character.role,
      gender: (character as Character & { gender?: 'male' | 'female' | 'neutral' }).gender,
      ageRange: (character as Character & { ageRange?: 'child' | 'teen' | 'adult' | 'elderly' }).ageRange,
      tone: character.tone,
      evidence: evidence.length ? evidence : undefined,
    };
    // eslint-disable-next-line no-console
    console.log('[sample] requesting', { voiceId: sampleVoiceId, modelKey: ttsModelKey });
    try {
      const res = await api.getVoiceSample({ voiceId: sampleVoiceId, voice: sampleSubject, modelKey: ttsModelKey, characterHint });
      // eslint-disable-next-line no-console
      console.log('[sample] server returned', res);
      if (!res.url) throw new Error('Voice samples need the live server (VITE_USE_MOCKS=false).');
      await playback.play(res.url);
    } catch (err) {
      setSampleError((err as Error).message);
    } finally {
      setSampleLoading(false);
    }
  }

  return (
    <>
      <div onClick={onClose} className="fixed inset-0 bg-ink/30 z-40 fade-in"/>
      <aside className="fixed top-0 right-0 bottom-0 w-full max-w-[520px] bg-white shadow-drawer z-50 overflow-y-auto slide-in-right">
        <div className="sticky top-0 bg-white/95 backdrop-blur-md border-b border-ink/10 px-6 py-4 flex items-center gap-3">
          <Avatar name={character.name} color={character.color as CharColor} size={40}/>
          <div className="flex-1 min-w-0">
            <h3 className="text-lg font-bold text-ink leading-tight truncate">{character.name}</h3>
            <p className="text-xs text-ink/60 truncate">{character.role}</p>
          </div>
          <button onClick={onClose} className="p-2 rounded-full hover:bg-ink/5 text-ink/60"><IconClose className="w-4 h-4"/></button>
        </div>

        <div className="p-6 space-y-8">
          <p className="text-sm text-ink/70 leading-relaxed">{character.description}</p>

          <section>
            <div className="flex items-center justify-between mb-4">
              <p className="text-[11px] uppercase tracking-wider text-ink/50 font-semibold">Voice profile</p>
              <div className="flex items-center gap-3">
                {character.voiceState === 'reused'    && <Pill color="library">Reused</Pill>}
                {character.voiceState === 'generated' && <Pill color="success">Generated</Pill>}
                {character.voiceState === 'tuned'     && <Pill color="warning">Tuned</Pill>}
              </div>
            </div>

            <div className="flex items-center gap-4 p-4 rounded-2xl bg-canvas border border-ink/10">
              <div className={regenerating ? 'pulse-ring rounded-full' : ''}>
                <VoiceSwatch voice={voice} size="md" showLabel={false}/>
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-base font-bold text-ink truncate">{voice?.character}</p>
                {character.matchedFrom ? (
                  <button onClick={() => onShowMatchDetail?.(character.id)} className="mt-0.5 text-xs text-purple-deep/70 hover:text-purple-deep underline-offset-2 hover:underline text-left">
                    Matched from <span className="font-semibold">{character.matchedFrom.bookTitle}</span> · {Math.round((character.matchedFrom.confidence ?? 0) * 100)}% confidence — see why
                  </button>
                ) : (
                  <p className="text-xs text-ink/60 mt-0.5">Synthesised from {character.lines} lines of dialogue</p>
                )}
                <div className="mt-2">
                  <button
                    onClick={playSample}
                    disabled={sampleLoading}
                    className={`inline-flex items-center gap-2 px-3 py-1.5 rounded-full text-xs font-semibold transition-colors ${
                      sampleLoading
                        ? 'bg-magenta/10 text-magenta cursor-wait'
                        : isPlayingThis
                          ? 'bg-magenta text-white hover:bg-magenta/90'
                          : 'bg-magenta/10 text-magenta hover:bg-magenta/20'
                    }`}
                  >
                    {sampleLoading ? (
                      <>
                        <IconSpinner className="w-3.5 h-3.5"/>
                        <span>Generating with {ttsModelLabel(ttsModelKey)}… <span className="font-normal text-magenta/70">(5–10s)</span></span>
                      </>
                    ) : isPlayingThis ? (
                      <>
                        <IconPause className="w-3.5 h-3.5"/>
                        <span>Stop sample</span>
                      </>
                    ) : (
                      <>
                        <IconWaveform className="w-3.5 h-3.5"/>
                        <span>Play 12s sample</span>
                      </>
                    )}
                  </button>
                  {!voice && (
                    <p className="mt-1 text-[11px] text-ink/50">No library voice matched yet — sampling directly from {character.name}'s attributes.</p>
                  )}
                  {sampleError && (
                    <p className="mt-1 text-[11px] text-red-600/90 font-medium">⚠ {sampleError}</p>
                  )}
                </div>
              </div>
            </div>

            <div className="mt-3 grid grid-cols-3 gap-2">
              <button onClick={regenerate} disabled={regenerating} className="px-3 py-2 rounded-xl border border-ink/10 hover:bg-ink/[0.04] text-xs font-medium text-ink inline-flex items-center justify-center gap-1.5 disabled:opacity-50">
                <IconRefresh className={`w-3.5 h-3.5 ${regenerating ? 'animate-spin' : ''}`}/> {regenerating ? 'Regenerating…' : 'Regenerate'}
              </button>
              <button className="px-3 py-2 rounded-xl border border-ink/10 hover:bg-ink/[0.04] text-xs font-medium text-ink inline-flex items-center justify-center gap-1.5">
                <IconStar className="w-3.5 h-3.5"/> Save to library
              </button>
              <button className="px-3 py-2 rounded-xl border border-ink/10 hover:bg-ink/[0.04] text-xs font-medium text-ink inline-flex items-center justify-center gap-1.5">
                <IconLock className="w-3.5 h-3.5"/> Lock
              </button>
            </div>
            <button onClick={() => onRegenerateCharacter?.(character.id)} className="mt-3 w-full inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-2xl bg-peach/15 hover:bg-peach/25 text-magenta text-sm font-semibold transition-colors">
              <IconRefresh className="w-4 h-4"/> Regenerate {character.name.split(' ')[0]}'s lines across the book
            </button>
          </section>

          <section>
            <p className="text-[11px] uppercase tracking-wider text-ink/50 font-semibold mb-3">Evidence from the manuscript</p>
            <div className="space-y-3">
              {character.evidence?.map((ev, i) => (
                <div key={i} className="p-4 rounded-2xl bg-canvas border border-ink/10">
                  <blockquote className="font-serif italic text-sm text-ink/85 leading-relaxed border-l-2 pl-3" style={{ borderColor: c.hex }}>
                    {ev.quote}
                  </blockquote>
                  <p className="mt-2 text-xs text-ink/60 leading-relaxed">{ev.note}</p>
                </div>
              ))}
            </div>
            <button className="mt-3 text-xs font-medium text-ink/70 hover:text-ink underline-offset-4 hover:underline">+ Show more evidence</button>
          </section>

          <section>
            <p className="text-[11px] uppercase tracking-wider text-ink/50 font-semibold mb-3">Inferred attributes</p>
            <div className="flex flex-wrap gap-1.5">
              {character.attributes?.map(a => <Pill key={a}>{a}</Pill>)}
              <button className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium border border-dashed border-ink/20 text-ink/50 hover:border-peach hover:text-peach"><IconPlus className="w-3 h-3"/>Add</button>
            </div>
          </section>

          <section>
            <p className="text-[11px] uppercase tracking-wider text-ink/50 font-semibold mb-4">Tone profile</p>
            <div className="space-y-5">
              <ToneSlider label="Warmth"    value={tone.warmth ?? 50}    onChange={(v) => setTone({ ...tone, warmth: v })}    leftLabel="Cool"       rightLabel="Warm"/>
              <ToneSlider label="Pace"      value={tone.pace ?? 50}      onChange={(v) => setTone({ ...tone, pace: v })}      leftLabel="Slow"       rightLabel="Brisk"/>
              <ToneSlider label="Authority" value={tone.authority ?? 50} onChange={(v) => setTone({ ...tone, authority: v })} leftLabel="Soft"       rightLabel="Commanding"/>
              <ToneSlider label="Emotion"   value={tone.emotion ?? 50}   onChange={(v) => setTone({ ...tone, emotion: v })}   leftLabel="Restrained" rightLabel="Expressive"/>
            </div>
          </section>
        </div>

        <div className="sticky bottom-0 bg-white border-t border-ink/10 px-6 py-4 flex items-center gap-3">
          <button onClick={onClose} className="px-4 py-2 text-sm font-medium text-ink/70 hover:text-ink">Discard</button>
          <PrimaryButton variant="dark" onClick={() => onSave({ ...character, tone, voiceState: 'tuned' })}>Save changes</PrimaryButton>
        </div>
      </aside>
    </>
  );
}

/* The server names cached sample files deterministically as
   /audio/voices/{voiceId}-{modelKey}.wav (see server/src/routes/voice-sample.ts).
   We mirror that here so the drawer knows whether the global audio singleton
   is currently playing *this* voice's sample without round-tripping to the
   server first. */
function sampleUrlFor(voiceId: string, modelKey: string): string {
  return `/audio/voices/${encodeURIComponent(voiceId)}-${modelKey}.wav`;
}

function ttsModelLabel(key: TtsModelKey): string {
  return TTS_MODEL_OPTIONS.find(o => o.id === key)?.label ?? key;
}

interface ToneSliderProps { label: string; value: number; onChange: (v: number) => void; leftLabel: string; rightLabel: string; }
export function ToneSlider({ label, value, onChange, leftLabel, rightLabel }: ToneSliderProps) {
  return (
    <div>
      <div className="flex items-center justify-between mb-2">
        <span className="text-sm font-medium text-ink">{label}</span>
        <span className="text-xs text-ink/50 tabular-nums">{value}</span>
      </div>
      <div className="relative h-1.5 rounded-full bg-ink/10">
        <div className="absolute left-0 top-0 bottom-0 rounded-full bg-gradient-cta-horizontal" style={{ width: `${value}%` }}/>
        <input type="range" min={0} max={100} value={value} onChange={(e) => onChange(Number(e.target.value))} className="absolute inset-0 w-full opacity-0 cursor-pointer"/>
        <span className="absolute top-1/2 -translate-y-1/2 -translate-x-1/2 w-4 h-4 rounded-full bg-white border border-ink/30 shadow pointer-events-none" style={{ left: `${value}%` }}/>
      </div>
      <div className="flex items-center justify-between mt-1.5 text-[11px] text-ink/40">
        <span>{leftLabel}</span><span>{rightLabel}</span>
      </div>
    </div>
  );
}
