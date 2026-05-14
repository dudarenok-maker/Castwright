import { useState } from 'react';
import { IconClose, IconWaveform, IconRefresh, IconStar, IconLock, IconPlus, IconPause, IconSpinner } from '../lib/icons';
import { TTS_MODEL_OPTIONS, engineForModelKey } from '../lib/tts-models';
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
  /** Meta carries the conflict flag so the change-log dispatch in layout.tsx
      knows whether the save reset the library match. */
  onSave: (next: Character, meta: { hadConflict: boolean }) => void;
  onLock: (character: Character) => void;
  onShowMatchDetail?: (id: string) => void;
  onRegenerateCharacter?: (id: string) => void;
  /** Other characters in the cast that this character could be merged INTO
      (i.e. the surviving identity). When omitted or empty, the merge
      affordance hides itself. Layout passes `cast \ this`. */
  mergeCandidates?: Character[];
  /** Fold this character (source) into another (target). Surviving target
      gains `source.name` in its aliases list; all sentences source said are
      reattributed to target. Returns a promise so the UI can show progress
      / surface errors. Drawer closes on resolve. */
  onMerge?: (sourceId: string, targetId: string) => Promise<void>;
}

type CharGender   = NonNullable<Character['gender']>;
type CharAgeRange = NonNullable<Character['ageRange']>;
const GENDER_OPTIONS: Array<{ value: CharGender; label: string }> = [
  { value: 'male',    label: 'Male' },
  { value: 'female',  label: 'Female' },
  { value: 'neutral', label: 'Neutral' },
];
const AGE_OPTIONS: Array<{ value: CharAgeRange; label: string }> = [
  { value: 'child',   label: 'Child' },
  { value: 'teen',    label: 'Teen' },
  { value: 'adult',   label: 'Adult' },
  { value: 'elderly', label: 'Elderly' },
];

export function ProfileDrawer({ character, voice, onClose, onSave, onLock, onShowMatchDetail, onRegenerateCharacter, mergeCandidates, onMerge }: Props) {
  const [tone, setTone] = useState(character.tone ?? { warmth: 50, pace: 50, authority: 50, emotion: 50 });
  /* Editable identity. The analyzer's guess (or the absence of one) seeds
     these; saving the drawer persists them onto the character. They drive
     the voice picker server-side, so a wrong inference can be corrected
     manually without retriggering analysis. */
  const [gender, setGender]     = useState<CharGender | ''>(character.gender ?? '');
  const [ageRange, setAgeRange] = useState<CharAgeRange | ''>(character.ageRange ?? '');
  const [regenerating, setRegenerating] = useState(false);
  const c = CHAR_COLORS[character.color as CharColor] ?? CHAR_COLORS.narrator;
  const playback = useSamplePlayback();
  const ttsModelKey = useAppSelector(s => s.ui.ttsModelKey);
  const ttsEngine = engineForModelKey(ttsModelKey);
  const [sampleLoading, setSampleLoading] = useState(false);
  const [sampleError, setSampleError] = useState<string | null>(null);
  /* The analyzer ships ≥3 evidence quotes sorted longest-first
     (server/src/routes/analysis.ts sortEvidence). The drawer shows the
     first 3 by default — index 0 is also the voice-cloning sample, so
     showing it on initial render lets the user verify the sample text
     without expanding. "Show more evidence" reveals any quotes beyond
     3 and is hidden when there's nothing extra. */
  const [showAllEvidence, setShowAllEvidence] = useState(false);
  const EVIDENCE_PREVIEW_LIMIT = 3;
  /* Merge UI state. The picker is collapsed by default — opening it reveals
     the list of candidates; selecting one shows a confirm row. */
  const [mergeTargetId, setMergeTargetId] = useState<string | ''>('');
  const [mergeBusy, setMergeBusy] = useState(false);
  const [mergeError, setMergeError] = useState<string | null>(null);
  const [showMergePicker, setShowMergePicker] = useState(false);

  /* Sample subject: a library voice when one is matched, otherwise a
     character-derived stub so brand-new (unmatched) characters can still
     preview their attributes. Server file is namespaced `char-<id>` for
     character samples to keep them separate from library voice samples. */
  const sampleVoiceId  = voice ? voice.id : `char-${character.id}`;
  /* Recompute against the *edited* identity so the displayed TTS voice
     updates live as the user changes the dropdowns. Saving the drawer
     persists these values; until then the recompute is local-only. */
  const editedCharacter: Character = {
    ...character,
    gender: gender || undefined,
    ageRange: ageRange || undefined,
  };
  const sampleSubject = voice ?? {
    id: sampleVoiceId,
    character: character.name,
    bookTitle: '',
    bookId: '',
    attributes: character.attributes ?? [],
    gradient: ['#999999', '#666666'] as [string, string],
    usedIn: 0,
    source: 'current' as const,
    ttsVoice: resolveTtsVoiceForCharacter(editedCharacter, ttsEngine),
  };
  const samplePrefix = sampleUrlPrefixFor(sampleVoiceId, ttsModelKey);
  const isPlayingThis = playback.isPlaying && !!playback.currentUrl?.startsWith(samplePrefix);

  /* Conflict detection: a matched library voice carries its own gender +
     age attributes. When the user's edits disagree, keeping the match
     would produce "UI says female teen, audio sounds male adult".
     Saving in this state automatically clears the library voiceId so the
     engine re-picks an appropriate prebuilt voice for the new identity.

     Gender: hard binary; a Female edit on a Male voice has no recovery
       short of swapping voices.
     Age:   bucket comparison via the same coarse age tags the library
       voice carries (e.g. "12", "60s"). A Teen edit on an Elderly voice
       falls into a different register slot, so the picker would have
       chosen differently. Tone sliders can nudge but can't bridge a
       child↔adult-or-deeper gap. */
  const voiceGender = voiceGenderFromAttributes(voice?.attributes);
  const voiceAge    = voiceAgeFromAttributes(voice?.attributes);
  const editedGender = (gender || character.gender) as CharGender | undefined;
  const editedAge    = (ageRange || character.ageRange) as CharAgeRange | undefined;
  const hasGenderConflict = !!voice
    && !!voiceGender
    && !!editedGender
    && editedGender !== 'neutral'
    && editedGender !== voiceGender;
  const hasAgeConflict = !!voice
    && !!voiceAge
    && !!editedAge
    && editedAge !== voiceAge;
  const hasConflict = hasGenderConflict || hasAgeConflict;

  function regenerate() {
    setRegenerating(true);
    setTimeout(() => setRegenerating(false), 1800);
  }

  async function playSample() {
    if (isPlayingThis) { playback.stop(); return; }
    setSampleError(null);
    setSampleLoading(true);
    const evidence = (character.evidence ?? []).map(e => e.quote).filter((q): q is string => typeof q === 'string' && q.length > 0);
    /* Live edits — read from drawer state, not the (stale) character prop,
       so the user can preview an attribute change before committing it
       with Save. Server hashes (text, voiceName) into the cache filename,
       so a different (gender, age, tone) really does produce new audio. */
    const characterHint = {
      description: character.description,
      role: character.role,
      gender: (gender || character.gender) as 'male' | 'female' | 'neutral' | undefined,
      ageRange: (ageRange || character.ageRange) as 'child' | 'teen' | 'adult' | 'elderly' | undefined,
      tone,
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
                <p className="text-base font-bold text-ink truncate">{voice?.character ?? character.name}</p>
                {character.matchedFrom ? (
                  <button onClick={() => onShowMatchDetail?.(character.id)} className="mt-0.5 text-xs text-purple-deep/70 hover:text-purple-deep underline-offset-2 hover:underline text-left">
                    Matched from <span className="font-semibold">{character.matchedFrom.bookTitle}</span> · {Math.round((character.matchedFrom.confidence ?? 0) * 100)}% confidence — see why
                  </button>
                ) : (
                  <p className="text-xs text-ink/60 mt-0.5">Synthesised from {character.lines} lines of dialogue</p>
                )}
                {/* Engine-aware TTS voice assignment — what the user will
                    actually hear when they click Play. Mirrors the cast
                    view's TtsVoiceLine so the drawer stays in sync. */}
                <p
                  className="mt-1 text-[11px] truncate"
                  title={`${capitalise(sampleSubject.ttsVoice.provider)} voice — ${sampleSubject.ttsVoice.description}`}
                >
                  <span className="text-ink/40">{capitalise(sampleSubject.ttsVoice.provider)} · </span>
                  <span className="font-semibold text-ink/70">{sampleSubject.ttsVoice.name}</span>
                  <span className="text-ink/40"> · {sampleSubject.ttsVoice.description}</span>
                </p>
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

            {hasConflict && (
              <div className="mt-3 rounded-2xl border border-amber-200 bg-amber-50/70 px-3 py-2.5 text-xs text-amber-900">
                <p className="font-semibold">⚠ Library voice / identity mismatch</p>
                <p className="mt-1 leading-relaxed">
                  <span className="font-semibold">{voice?.character}</span> is {[
                    voiceGender ? capitalise(voiceGender) : null,
                    voiceAge ? capitalise(voiceAge) : null,
                  ].filter(Boolean).join(' · ')}, but you've set this character to {[
                    hasGenderConflict && editedGender ? capitalise(editedGender) : null,
                    hasAgeConflict && editedAge ? capitalise(editedAge) : null,
                  ].filter(Boolean).join(' · ')}.
                  {' '}
                  Saving will clear the library match and re-synthesise from {character.name}'s attributes — the prebuilt voice picker will pick the right slot for the new identity.
                </p>
              </div>
            )}

            <div className="mt-3 grid grid-cols-3 gap-2">
              <button onClick={regenerate} disabled={regenerating} className="px-3 py-2 rounded-xl border border-ink/10 hover:bg-ink/[0.04] text-xs font-medium text-ink inline-flex items-center justify-center gap-1.5 disabled:opacity-50">
                <IconRefresh className={`w-3.5 h-3.5 ${regenerating ? 'animate-spin' : ''}`}/> {regenerating ? 'Regenerating…' : 'Regenerate'}
              </button>
              <button className="px-3 py-2 rounded-xl border border-ink/10 hover:bg-ink/[0.04] text-xs font-medium text-ink inline-flex items-center justify-center gap-1.5">
                <IconStar className="w-3.5 h-3.5"/> Save to library
              </button>
              <button
                onClick={() => onLock(character)}
                className={`px-3 py-2 rounded-xl border text-xs font-medium inline-flex items-center justify-center gap-1.5 ${character.voiceState === 'locked' ? 'border-ink/30 bg-ink/[0.06] text-ink' : 'border-ink/10 hover:bg-ink/[0.04] text-ink'}`}
              >
                <IconLock className="w-3.5 h-3.5"/> {character.voiceState === 'locked' ? 'Locked' : 'Lock'}
              </button>
            </div>
            <button onClick={() => onRegenerateCharacter?.(character.id)} className="mt-3 w-full inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-2xl bg-peach/15 hover:bg-peach/25 text-magenta text-sm font-semibold transition-colors">
              <IconRefresh className="w-4 h-4"/> Regenerate {character.name.split(' ')[0]}'s lines across the book
            </button>
          </section>

          <section>
            <p className="text-[11px] uppercase tracking-wider text-ink/50 font-semibold mb-3">Evidence from the manuscript</p>
            <div className="space-y-3">
              {(showAllEvidence
                ? character.evidence
                : character.evidence?.slice(0, EVIDENCE_PREVIEW_LIMIT)
              )?.map((ev, i) => (
                <div key={i} className="p-4 rounded-2xl bg-canvas border border-ink/10">
                  <blockquote className="font-serif italic text-sm text-ink/85 leading-relaxed border-l-2 pl-3" style={{ borderColor: c.hex }}>
                    {ev.quote}
                  </blockquote>
                  <p className="mt-2 text-xs text-ink/60 leading-relaxed">{ev.note}</p>
                </div>
              ))}
            </div>
            {character.evidence && character.evidence.length > EVIDENCE_PREVIEW_LIMIT && (
              <button
                onClick={() => setShowAllEvidence(v => !v)}
                className="mt-3 text-xs font-medium text-ink/70 hover:text-ink underline-offset-4 hover:underline"
              >
                {showAllEvidence
                  ? '− Show fewer'
                  : `+ Show ${character.evidence.length - EVIDENCE_PREVIEW_LIMIT} more`}
              </button>
            )}
          </section>

          <section>
            <p className="text-[11px] uppercase tracking-wider text-ink/50 font-semibold mb-3">Identity</p>
            <div className="grid grid-cols-2 gap-3">
              <label className="flex flex-col gap-1.5">
                <span className="text-[11px] text-ink/60 font-medium">Gender</span>
                <select
                  value={gender}
                  onChange={(e) => setGender(e.target.value as CharGender | '')}
                  className="px-3 py-2 rounded-xl border border-ink/15 bg-white text-sm text-ink focus:outline-none focus:ring-2 focus:ring-magenta/30"
                >
                  <option value="">— unset —</option>
                  {GENDER_OPTIONS.map(o => (
                    <option key={o.value} value={o.value}>{o.label}</option>
                  ))}
                </select>
              </label>
              <label className="flex flex-col gap-1.5">
                <span className="text-[11px] text-ink/60 font-medium">Age range</span>
                <select
                  value={ageRange}
                  onChange={(e) => setAgeRange(e.target.value as CharAgeRange | '')}
                  className="px-3 py-2 rounded-xl border border-ink/15 bg-white text-sm text-ink focus:outline-none focus:ring-2 focus:ring-magenta/30"
                >
                  <option value="">— unset —</option>
                  {AGE_OPTIONS.map(o => (
                    <option key={o.value} value={o.value}>{o.label}</option>
                  ))}
                </select>
              </label>
            </div>
            <p className="mt-2 text-[11px] text-ink/50">
              Drives the gender + register slot in the voice picker. If the engine picked the wrong voice for this character, correct these and Save — the TTS voice line above updates immediately.
            </p>
          </section>

          <section>
            <p className="text-[11px] uppercase tracking-wider text-ink/50 font-semibold mb-3">Inferred attributes</p>
            <div className="flex flex-wrap gap-1.5">
              {character.attributes?.map(a => <Pill key={a}>{a}</Pill>)}
              <button className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium border border-dashed border-ink/20 text-ink/50 hover:border-peach hover:text-peach"><IconPlus className="w-3 h-3"/>Add</button>
            </div>
          </section>

          <section>
            <p className="text-[11px] uppercase tracking-wider text-ink/50 font-semibold mb-3">Cast roster</p>
            {character.aliases && character.aliases.length > 0 && (
              <div className="mb-3">
                <p className="text-xs text-ink/55 mb-1.5">Also known as</p>
                <div className="flex flex-wrap gap-1.5">
                  {character.aliases.map(a => <Pill key={a} color="library">{a}</Pill>)}
                </div>
              </div>
            )}
            {!onMerge || !mergeCandidates || mergeCandidates.length === 0 ? (
              <p className="text-[11px] text-ink/50">
                {character.aliases?.length
                  ? 'These names were merged into this character. The voice matcher will use them when later books in the series detect the same person.'
                  : 'Once another character is detected as the same person, you can merge them here — their name joins this character\'s aliases and the matcher learns the link for later books.'}
              </p>
            ) : !showMergePicker ? (
              <button
                onClick={() => { setShowMergePicker(true); setMergeError(null); }}
                className="w-full px-3 py-2 rounded-xl border border-dashed border-ink/20 hover:border-peach hover:text-peach text-xs font-medium text-ink/65 inline-flex items-center justify-center gap-1.5"
              >
                Merge {character.name.split(' ')[0]} into another character…
              </button>
            ) : (
              <div className="rounded-2xl bg-canvas border border-ink/10 p-3">
                <label className="block text-[11px] text-ink/60 font-medium mb-1.5" htmlFor="profile-merge-target">
                  Keep which character as the survivor?
                </label>
                <select
                  id="profile-merge-target"
                  aria-label="Merge target"
                  value={mergeTargetId}
                  disabled={mergeBusy}
                  onChange={(e) => { setMergeTargetId(e.target.value); setMergeError(null); }}
                  className="w-full px-3 py-2 rounded-xl border border-ink/15 bg-white text-sm text-ink focus:outline-none focus:ring-2 focus:ring-magenta/30"
                >
                  <option value="">— pick a character —</option>
                  {mergeCandidates.map(c => (
                    <option key={c.id} value={c.id}>{c.name}</option>
                  ))}
                </select>
                {mergeTargetId && (
                  <p className="mt-2 text-[11px] text-ink/65 leading-relaxed">
                    <span className="font-semibold text-ink">{character.name}</span> will be folded into{' '}
                    <span className="font-semibold text-ink">{mergeCandidates.find(c => c.id === mergeTargetId)?.name}</span>.
                    Their name joins the survivor's aliases and every sentence they spoke is reattributed.
                  </p>
                )}
                {mergeError && (
                  <p className="mt-2 text-[11px] text-red-600/90 font-medium">⚠ {mergeError}</p>
                )}
                <div className="mt-3 flex items-center justify-end gap-2">
                  <button
                    disabled={mergeBusy}
                    onClick={() => { setShowMergePicker(false); setMergeTargetId(''); setMergeError(null); }}
                    className="px-3 py-1.5 text-xs font-medium text-ink/65 hover:text-ink"
                  >Cancel</button>
                  <button
                    disabled={!mergeTargetId || mergeBusy}
                    onClick={async () => {
                      if (!mergeTargetId || !onMerge) return;
                      setMergeBusy(true);
                      setMergeError(null);
                      try {
                        await onMerge(character.id, mergeTargetId);
                        /* Drawer is closed by the layout's onMerge — but
                           reset our local state defensively in case the
                           caller chose not to close. */
                        setShowMergePicker(false);
                        setMergeTargetId('');
                      } catch (e) {
                        setMergeError((e as Error).message || 'Merge failed.');
                      } finally {
                        setMergeBusy(false);
                      }
                    }}
                    className={`px-3 py-1.5 rounded-full text-xs font-semibold ${
                      mergeBusy
                        ? 'bg-magenta/20 text-magenta cursor-wait'
                        : 'bg-magenta text-white hover:bg-magenta/90 disabled:bg-ink/20 disabled:text-ink/50 disabled:cursor-not-allowed'
                    }`}
                  >
                    {mergeBusy ? 'Merging…' : 'Merge'}
                  </button>
                </div>
              </div>
            )}
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
          <PrimaryButton
            variant="dark"
            onClick={() => {
              const next: Character = {
                ...character,
                tone,
                gender: gender || undefined,
                ageRange: ageRange || undefined,
                voiceState: 'tuned',
              };
              /* Conflict reset: drop the library voiceId + matchedFrom so the
                 cast view falls back to the engine's prebuilt-voice pick. The
                 ttsVoice line in the drawer already previewed what that will
                 sound like for the new identity. Fires on either a gender or
                 an age-bucket mismatch. */
              if (hasConflict) {
                next.voiceId = undefined;
                next.matchedFrom = undefined;
              }
              onSave(next, { hadConflict: hasConflict });
            }}
          >Save changes</PrimaryButton>
        </div>
      </aside>
    </>
  );
}

/* The server names cached sample files as
   /audio/voices/{voiceId}-{modelKey}-{paramHash}.mp3 (see
   server/src/routes/voice-sample.ts). We don't know the hash client-side,
   so detect "this voice's sample is currently playing" by prefix match —
   that's stable across attribute edits and the cache-busting hash. */
function sampleUrlPrefixFor(voiceId: string, modelKey: string): string {
  return `/audio/voices/${encodeURIComponent(voiceId)}-${modelKey}`;
}

function ttsModelLabel(key: TtsModelKey): string {
  return TTS_MODEL_OPTIONS.find(o => o.id === key)?.label ?? key;
}

function capitalise(s: string): string {
  return s.length === 0 ? s : s[0].toUpperCase() + s.slice(1);
}

/* Lift the gender out of a library voice's attribute tags. Library voices
   carry "Male" / "Female" as the first attribute by convention (see the
   workspace voices route + mock fixtures). Returns null when neither tag
   is present, in which case we can't usefully flag a conflict. */
function voiceGenderFromAttributes(attrs: string[] | undefined): CharGender | null {
  if (!attrs) return null;
  for (const raw of attrs) {
    const lc = raw.toLowerCase();
    if (lc === 'male')   return 'male';
    if (lc === 'female') return 'female';
    if (lc === 'neutral') return 'neutral';
  }
  return null;
}

/* Map a library voice's age attribute to the same coarse bucket the
   Character.ageRange uses. Attribute tags vary across fixtures — common
   forms are explicit ("Teen", "Adult"), numeric decades ("60s", "70s"),
   or a single age like "12". Returns null when no recognisable age tag is
   present so the conflict check stays silent (false-positive avoidance). */
function voiceAgeFromAttributes(attrs: string[] | undefined): CharAgeRange | null {
  if (!attrs) return null;
  for (const raw of attrs) {
    const lc = raw.toLowerCase().trim();
    if (lc === 'child')   return 'child';
    if (lc === 'teen')    return 'teen';
    if (lc === 'adult')   return 'adult';
    if (lc === 'elderly') return 'elderly';
    /* "60s", "70s", "12", "12yo" — pull leading digits and bucket. */
    const m = lc.match(/^(\d{1,3})/);
    if (m) {
      const age = Number(m[1]);
      if (age <= 12) return 'child';
      if (age <= 19) return 'teen';
      if (age <= 59) return 'adult';
      return 'elderly';
    }
  }
  return null;
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
