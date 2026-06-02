import { useMemo, useState, type ReactNode } from 'react';
import { IconPlay, IconPause, IconSpinner } from '../lib/icons';
import { Avatar, Pill, PrimaryButton } from '../components/primitives';
import { ToneSlider } from './profile-drawer';
import { AbCompareShell } from '../components/ab-compare-shell';
import { useAbAudition, type AbSide } from '../lib/use-ab-audition';
import { engineForModelKey } from '../lib/tts-models';
import { resolveTtsVoiceForCharacter, resolveProfileForCharacter } from '../lib/tts-voice-mapping';
import { gradientForTtsVoice } from '../lib/voice-palette';
import { sampleScopeFor, sampleUrlPrefix } from '../lib/sample-scope';
import { findVoiceForCharacter } from '../lib/voice-character-link';
import { useSamplePlayback } from '../lib/use-sample-playback';
import { playSampleWithAutoLoad } from '../lib/play-sample-with-auto-load';
import { buildCharacterHint } from '../lib/build-character-hint';
import type { Character, Voice, CharColor, TtsModelKey, TtsEngine } from '../lib/types';

type CharGender = NonNullable<Character['gender']>;
type CharAgeRange = NonNullable<Character['ageRange']>;
type Tone = NonNullable<Character['tone']>;

const GENDER_OPTIONS: Array<{ value: CharGender; label: string }> = [
  { value: 'male', label: 'Male' },
  { value: 'female', label: 'Female' },
  { value: 'neutral', label: 'Neutral' },
];
const AGE_OPTIONS: Array<{ value: CharAgeRange; label: string }> = [
  { value: 'child', label: 'Child' },
  { value: 'teen', label: 'Teen' },
  { value: 'adult', label: 'Adult' },
  { value: 'elderly', label: 'Elderly' },
];

const DEFAULT_TONE: Tone = { warmth: 50, pace: 50, authority: 50, emotion: 50 };

interface Props {
  characters: [Character, Character];
  library: Voice[];
  ttsModelKey: TtsModelKey;
  /* Plan 96 — when true, render an inline hint per side noting that
     Save propagates to every book in this series where the character
     appears. The actual N is reported in the post-save toast; the
     modal stays cheap by not pre-querying the series for sibling
     counts. The Voices view passes this true; cast.tsx (single-book
     Compare) leaves it falsy so the hint is hidden. */
  propagatesAcrossSeries?: boolean;
  onSaveSide: (next: Character) => void;
  onClose: () => void;
  onOpenProfile: (id: string) => void;
}

type SideKey = 'a' | 'b';

interface SideDraft {
  gender: CharGender | '';
  ageRange: CharAgeRange | '';
  tone: Tone;
}

function draftFromCharacter(c: Character): SideDraft {
  return {
    gender: c.gender ?? '',
    ageRange: c.ageRange ?? '',
    tone: { ...DEFAULT_TONE, ...(c.tone ?? {}) },
  };
}

function mergeDraft(c: Character, d: SideDraft): Character {
  return {
    ...c,
    gender: d.gender || undefined,
    ageRange: d.ageRange || undefined,
    tone: d.tone,
  };
}

function draftToHintOverrides(
  d: SideDraft,
): Partial<Pick<Character, 'gender' | 'ageRange' | 'tone'>> {
  return {
    gender: d.gender || undefined,
    ageRange: d.ageRange || undefined,
    tone: d.tone,
  };
}

function tonesEqual(a: Tone, b: Tone): boolean {
  return (
    a.warmth === b.warmth &&
    a.pace === b.pace &&
    a.authority === b.authority &&
    a.emotion === b.emotion
  );
}

function isDirty(orig: Character, d: SideDraft): boolean {
  const o = draftFromCharacter(orig);
  return o.gender !== d.gender || o.ageRange !== d.ageRange || !tonesEqual(o.tone, d.tone);
}

export function CompareCastModal({
  characters,
  library,
  ttsModelKey,
  propagatesAcrossSeries = false,
  onSaveSide,
  onClose,
  onOpenProfile,
}: Props) {
  const [a, b] = characters;
  const ttsEngine = engineForModelKey(ttsModelKey);
  const playback = useSamplePlayback();

  const [draftA, setDraftA] = useState<SideDraft>(() => draftFromCharacter(a));
  const [draftB, setDraftB] = useState<SideDraft>(() => draftFromCharacter(b));

  const sideA = useMemo(
    () => buildSideContext(a, draftA, library, ttsEngine, ttsModelKey),
    [a, draftA, library, ttsEngine, ttsModelKey],
  );
  const sideB = useMemo(
    () => buildSideContext(b, draftB, library, ttsEngine, ttsModelKey),
    [b, draftB, library, ttsEngine, ttsModelKey],
  );

  const dirtyA = isDirty(a, draftA);
  const dirtyB = isDirty(b, draftB);

  /* Each side plays a server voice sample for its (possibly edited) identity;
     the shared A/B hook owns the loading/error rows + the Auto A → B sequence
     (prefix-match because the sample URL carries a cache hash we don't know
     client-side). */
  const sides: Record<SideKey, AbSide> = {
    a: {
      matchUrl: sideA.samplePrefix,
      matchMode: 'prefix',
      play: async () => {
        await playSampleWithAutoLoad({
          args: {
            voiceId: sideA.sampleVoiceId,
            voice: sideA.subject,
            modelKey: ttsModelKey,
            characterHint: buildCharacterHint(a, draftToHintOverrides(draftA)),
          },
          playback,
        });
      },
    },
    b: {
      matchUrl: sideB.samplePrefix,
      matchMode: 'prefix',
      play: async () => {
        await playSampleWithAutoLoad({
          args: {
            voiceId: sideB.sampleVoiceId,
            voice: sideB.subject,
            modelKey: ttsModelKey,
            characterHint: buildCharacterHint(b, draftToHintOverrides(draftB)),
          },
          playback,
        });
      },
    },
  };

  const { rowState, autoRunning, footerError, playSide, runAuto, stopAndCancel } = useAbAudition({
    sides,
    playback,
  });

  function handleClose() {
    stopAndCancel();
    onClose();
  }

  function saveSide(side: SideKey) {
    if (side === 'a') {
      if (!dirtyA) return;
      onSaveSide(mergeDraft(a, draftA));
    } else {
      if (!dirtyB) return;
      onSaveSide(mergeDraft(b, draftB));
    }
  }

  function resetSide(side: SideKey) {
    if (side === 'a') setDraftA(draftFromCharacter(a));
    else setDraftB(draftFromCharacter(b));
  }

  return (
    <AbCompareShell
      title="Compare cast members"
      subtitle="Tune fields on either side and re-sample to hear the difference before saving."
      ariaLabel="Compare cast members"
      autoRunning={autoRunning}
      autoDisabled={!autoRunning && !!(rowState.a?.loading || rowState.b?.loading)}
      footerError={footerError}
      onRunAuto={runAuto}
      onClose={handleClose}
      sideA={
        <SidePanel
          side="a"
          character={a}
          draft={draftA}
          setDraft={setDraftA}
          ctx={sideA}
          otherCharacter={b}
          otherDraft={draftB}
          otherCtx={sideB}
          rowState={rowState.a}
          dirty={dirtyA}
          disabled={autoRunning && (rowState.b?.loading ?? false)}
          propagatesAcrossSeries={propagatesAcrossSeries}
          onPlay={() => playSide('a')}
          onSave={() => saveSide('a')}
          onReset={() => resetSide('a')}
          onOpenProfile={() => {
            onOpenProfile(a.id);
            handleClose();
          }}
          playbackUrl={playback.currentUrl}
          playbackPlaying={playback.isPlaying}
        />
      }
      sideB={
        <SidePanel
          side="b"
          character={b}
          draft={draftB}
          setDraft={setDraftB}
          ctx={sideB}
          otherCharacter={a}
          otherDraft={draftA}
          otherCtx={sideA}
          rowState={rowState.b}
          dirty={dirtyB}
          disabled={autoRunning && (rowState.a?.loading ?? false)}
          propagatesAcrossSeries={propagatesAcrossSeries}
          onPlay={() => playSide('b')}
          onSave={() => saveSide('b')}
          onReset={() => resetSide('b')}
          onOpenProfile={() => {
            onOpenProfile(b.id);
            handleClose();
          }}
          playbackUrl={playback.currentUrl}
          playbackPlaying={playback.isPlaying}
        />
      }
      footerEnd={
        <button
          onClick={handleClose}
          className="px-4 py-2 rounded-full border border-ink/10 bg-white text-sm font-medium text-ink/70 hover:text-ink"
        >
          Done
        </button>
      }
    />
  );
}

interface SideContext {
  sampleVoiceId: string;
  samplePrefix: string;
  subject: Voice;
  ttsVoiceName: string;
  ttsVoiceDescription: string;
  profile: string;
  voiceLibraryName: string | null;
}

function buildSideContext(
  c: Character,
  draft: SideDraft,
  library: Voice[],
  engine: TtsEngine,
  modelKey: TtsModelKey,
): SideContext {
  /* Compute the resolved voice off the dirty draft so the labels update
     live as the user edits. Sample requests use the same dirty hint via
     buildCharacterHint(character, draft). */
  const merged = mergeDraft(c, draft);
  const matched = findVoiceForCharacter(c, library);
  const sampleVoiceId = sampleScopeFor(c);
  const ttsVoice = matched?.ttsVoice ?? resolveTtsVoiceForCharacter(merged, engine);
  const subject: Voice = matched ?? {
    id: sampleVoiceId,
    character: c.name,
    bookTitle: '',
    bookId: '',
    attributes: c.attributes ?? [],
    gradient: gradientForTtsVoice(ttsVoice.name, sampleVoiceId),
    usedIn: 0,
    source: 'current',
    ttsVoice,
  };
  return {
    sampleVoiceId,
    samplePrefix: sampleUrlPrefix(sampleVoiceId, modelKey),
    subject,
    ttsVoiceName: ttsVoice.name,
    ttsVoiceDescription: ttsVoice.description,
    profile: resolveProfileForCharacter(merged),
    voiceLibraryName: matched?.character ?? null,
  };
}

interface SidePanelProps {
  side: SideKey;
  character: Character;
  draft: SideDraft;
  setDraft: (next: SideDraft) => void;
  ctx: SideContext;
  otherCharacter: Character;
  otherDraft: SideDraft;
  otherCtx: SideContext;
  rowState: { loading?: boolean; error?: string };
  dirty: boolean;
  disabled: boolean;
  propagatesAcrossSeries: boolean;
  onPlay: () => void;
  onSave: () => void;
  onReset: () => void;
  onOpenProfile: () => void;
  playbackUrl: string | null;
  playbackPlaying: boolean;
}

function SidePanel({
  side,
  character,
  draft,
  setDraft,
  ctx,
  otherCharacter,
  otherDraft,
  otherCtx,
  rowState,
  dirty,
  disabled,
  propagatesAcrossSeries,
  onPlay,
  onSave,
  onReset,
  onOpenProfile,
  playbackUrl,
  playbackPlaying,
}: SidePanelProps) {
  const isPlayingThis = playbackPlaying && !!playbackUrl?.startsWith(ctx.samplePrefix);
  /* Diff is computed against the *other side's draft* so editing live
     updates which fields show the ≠ marker — mirrors how the user thinks
     about the comparison. We don't diff against the saved Character. */
  const thisGender = draft.gender || character.gender || '';
  const otherGender = otherDraft.gender || otherCharacter.gender || '';
  const thisAge = draft.ageRange || character.ageRange || '';
  const otherAge = otherDraft.ageRange || otherCharacter.ageRange || '';
  const differsGender = thisGender !== otherGender;
  const differsAge = thisAge !== otherAge;
  const differsTone = !tonesEqual(draft.tone, otherDraft.tone);
  const differsVoice = ctx.ttsVoiceName !== otherCtx.ttsVoiceName;
  const differsProfile = ctx.profile !== otherCtx.profile;
  const otherAttrs = new Set(otherCharacter.attributes ?? []);
  const onlyInThis = (character.attributes ?? []).filter((x) => !otherAttrs.has(x));

  const profileLabel = ctx.profile.replace('-', ' · ');

  return (
    <section
      aria-label={`Side ${side.toUpperCase()}: ${character.name}`}
      className="bg-white rounded-2xl border border-ink/10 p-5 space-y-4"
    >
      <header className="flex items-center gap-3 min-w-0">
        <Avatar name={character.name} color={character.color as CharColor} size={40} />
        <div className="min-w-0">
          <p className="font-bold text-ink truncate">{character.name}</p>
          <p className="text-xs text-ink/60 truncate">{character.role}</p>
        </div>
        <span className="ml-auto text-[10px] uppercase tracking-wider font-semibold text-ink/40">
          Side {side.toUpperCase()}
        </span>
      </header>

      {propagatesAcrossSeries && (
        <p
          role="note"
          className="text-[11px] text-ink/60 leading-snug bg-ink/3 border border-ink/10 rounded-lg px-3 py-2"
          title="The server propagates this save to every book in the same series whose cast contains a matching character (name or alias)."
        >
          Saves propagate to every book in this series where this character appears.
        </p>
      )}

      <div className="space-y-2 text-sm">
        <DiffRow label="Resolved voice" value={ctx.ttsVoiceName} differs={differsVoice} />
        <DiffRow label="Profile bucket" value={profileLabel} differs={differsProfile} />
        {ctx.voiceLibraryName && (
          <DiffRow label="Library voice" value={ctx.voiceLibraryName} differs={false} />
        )}
      </div>

      <div className="border-t border-ink/10 pt-3 space-y-3">
        <EditorRow label="Gender" differs={differsGender}>
          <select
            value={draft.gender}
            onChange={(e) => setDraft({ ...draft, gender: e.target.value as CharGender | '' })}
            className="text-sm rounded-lg border border-ink/15 bg-white px-2.5 py-1.5 focus:outline-hidden focus:border-ink/40"
            aria-label={`Gender for ${character.name}`}
          >
            <option value="">—</option>
            {GENDER_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </EditorRow>
        <EditorRow label="Age range" differs={differsAge}>
          <select
            value={draft.ageRange}
            onChange={(e) => setDraft({ ...draft, ageRange: e.target.value as CharAgeRange | '' })}
            className="text-sm rounded-lg border border-ink/15 bg-white px-2.5 py-1.5 focus:outline-hidden focus:border-ink/40"
            aria-label={`Age range for ${character.name}`}
          >
            <option value="">—</option>
            {AGE_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </EditorRow>
      </div>

      <div className="border-t border-ink/10 pt-3 space-y-3">
        <div className="flex items-center justify-between">
          <span className="text-xs uppercase tracking-wider font-semibold text-ink/50">Tone</span>
          {differsTone && <Pill color="library">≠ differs</Pill>}
        </div>
        <ToneSlider
          label="Warmth"
          value={draft.tone.warmth ?? 50}
          onChange={(v) => setDraft({ ...draft, tone: { ...draft.tone, warmth: v } })}
          leftLabel="Cool"
          rightLabel="Warm"
        />
        <ToneSlider
          label="Pace"
          value={draft.tone.pace ?? 50}
          onChange={(v) => setDraft({ ...draft, tone: { ...draft.tone, pace: v } })}
          leftLabel="Slow"
          rightLabel="Quick"
        />
        <ToneSlider
          label="Authority"
          value={draft.tone.authority ?? 50}
          onChange={(v) => setDraft({ ...draft, tone: { ...draft.tone, authority: v } })}
          leftLabel="Gentle"
          rightLabel="Commanding"
        />
        <ToneSlider
          label="Emotion"
          value={draft.tone.emotion ?? 50}
          onChange={(v) => setDraft({ ...draft, tone: { ...draft.tone, emotion: v } })}
          leftLabel="Reserved"
          rightLabel="Expressive"
        />
      </div>

      {onlyInThis.length > 0 && (
        <div className="border-t border-ink/10 pt-3">
          <p className="text-xs uppercase tracking-wider font-semibold text-ink/50 mb-2">
            Attributes only on this side
          </p>
          <div className="flex flex-wrap gap-1">
            {onlyInThis.map((x) => (
              <span
                key={x}
                className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-magenta/10 text-magenta text-[11px] font-semibold"
              >
                ≠ {x}
              </span>
            ))}
          </div>
        </div>
      )}

      <div className="border-t border-ink/10 pt-3 flex items-center gap-2">
        <button
          onClick={onPlay}
          disabled={disabled || rowState.loading}
          aria-label={
            isPlayingThis
              ? `Stop sample for ${character.name}`
              : `Play sample for ${character.name}`
          }
          className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-semibold transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${
            rowState.loading
              ? 'bg-magenta/10 text-magenta cursor-wait'
              : isPlayingThis
                ? 'bg-magenta text-white hover:bg-magenta/90'
                : 'bg-ink/6 text-ink/80 hover:bg-magenta/15 hover:text-magenta'
          }`}
        >
          {rowState.loading ? (
            <IconSpinner className="w-3 h-3" />
          ) : isPlayingThis ? (
            <IconPause className="w-3 h-3" />
          ) : (
            <IconPlay className="w-3 h-3" />
          )}
          <span>{rowState.loading ? 'Generating…' : isPlayingThis ? 'Stop' : 'Play 12s'}</span>
        </button>
        {dirty && (
          <button
            onClick={onReset}
            className="text-[11px] text-ink/50 hover:text-ink underline-offset-2 hover:underline"
            aria-label={`Reset edits for ${character.name}`}
          >
            Reset
          </button>
        )}
        <div className="ml-auto flex items-center gap-2">
          <PrimaryButton onClick={onSave} disabled={!dirty} variant="dark" size="md" icon={false}>
            Save
          </PrimaryButton>
        </div>
      </div>

      {rowState.error && (
        <p className="text-[11px] text-red-600/80" role="alert">
          ⚠ {rowState.error}
        </p>
      )}

      <button
        onClick={onOpenProfile}
        className="block text-[11px] text-ink/50 hover:text-ink underline-offset-2 hover:underline"
      >
        Open full profile (for engine-specific voice overrides)
      </button>
    </section>
  );
}

interface DiffRowProps {
  label: string;
  value: string;
  differs: boolean;
}
function DiffRow({ label, value, differs }: DiffRowProps) {
  return (
    <div className="flex items-center justify-between gap-2">
      <span className="text-xs text-ink/50">{label}</span>
      <span className="flex items-center gap-1.5 min-w-0">
        {differs && (
          <span
            className="inline-flex items-center px-1.5 py-0.5 rounded-full bg-magenta/15 text-magenta text-[10px] font-bold"
            aria-label="differs"
          >
            ≠
          </span>
        )}
        <span className="text-sm font-medium text-ink truncate" title={value}>
          {value}
        </span>
      </span>
    </div>
  );
}

interface EditorRowProps {
  label: string;
  differs: boolean;
  children: ReactNode;
}
function EditorRow({ label, differs, children }: EditorRowProps) {
  return (
    <div className="flex items-center justify-between gap-2">
      <span className="flex items-center gap-1.5 text-sm text-ink">
        {label}
        {differs && (
          <span
            className="inline-flex items-center px-1.5 py-0.5 rounded-full bg-magenta/15 text-magenta text-[10px] font-bold"
            aria-label="differs"
          >
            ≠
          </span>
        )}
      </span>
      {children}
    </div>
  );
}
