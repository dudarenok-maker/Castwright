import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  IconClose,
  IconWaveform,
  IconRefresh,
  IconStar,
  IconLock,
  IconPlus,
  IconPause,
  IconSpinner,
  IconChevD,
} from '../lib/icons';
import type { SeriesRosterEntry } from '../lib/api';
import { TTS_MODEL_OPTIONS, engineForModelKey } from '../lib/tts-models';
import type { BaseVoice, TtsEngine, TtsModelKey } from '../lib/types';
import {
  Avatar,
  VoiceSwatch,
  Pill,
  PrimaryButton,
  ReusedBadge,
  VariantsBadge,
} from '../components/primitives';
import { resolveVoiceStatus } from '../lib/voice-status';
import { CHAR_COLORS } from '../lib/colors';
import { sampleScopeFor } from '../lib/sample-scope';
import type { Character, Voice, CharColor } from '../lib/types';
import { useSamplePlayback } from '../lib/use-sample-playback';
import { playSampleWithAutoLoad, type SampleStatus } from '../lib/play-sample-with-auto-load';
import { resolveTtsVoiceForCharacter, sampleModelKeyForEngine } from '../lib/tts-voice-mapping';
import { gradientForTtsVoice } from '../lib/voice-palette';
import { useAppDispatch, useAppSelector } from '../store';
import { voicesActions } from '../store/voices-slice';
import { api } from '../lib/api';
import { buildCharacterHint } from '../lib/build-character-hint';
import { VoicePreviewButton } from '../components/voice-preview-button';
import { VoiceOverridePicker } from '../components/voice-override-picker';
import { VoiceEnginePicker, type EngineChoice } from '../components/voice-engine-picker';
import { EmotionVariantDesigner } from '../components/emotion-variant-designer';
import { VoiceCompareModal } from './voice-compare-modal';
import { CharacterSearchPicker } from '../components/character-search-picker';
import { castActions } from '../store/cast-slice';
import { castDesignActions } from '../store/cast-design-slice';

/* Default preview line. Pangram + a short follow-on so the user can
   hear consonant + vowel coverage AND a held sentence at typical
   reading pace. Persisted across drawer opens via localStorage so the
   user only customises it once per session. */
const DEFAULT_PREVIEW_TEXT =
  'The quick brown fox jumps over the lazy dog. The sun shone over the field.';
/* fs-2 — Russian preview pangram (covers the alphabet) so a Russian book's
   voice preview/calibration default speaks Russian, not the English fox. */
const RU_PREVIEW_TEXT = 'Съешь же ещё этих мягких французских булок да выпей чаю.';
const PREVIEW_TEXT_STORAGE_KEY = 'voice-preview-sample-text';

/** fs-2 — the default preview text is keyed on the book language so a Russian
    book doesn't show the English pangram. A user's stored override still wins
    (their explicit choice). */
function defaultPreviewTextForLanguage(language?: string): string {
  return language && language !== 'en' && language.toLowerCase().startsWith('ru')
    ? RU_PREVIEW_TEXT
    : DEFAULT_PREVIEW_TEXT;
}

function loadInitialPreviewText(language?: string): string {
  const fallback = defaultPreviewTextForLanguage(language);
  if (typeof window === 'undefined') return fallback;
  try {
    const stored = window.localStorage.getItem(PREVIEW_TEXT_STORAGE_KEY);
    if (stored && stored.trim()) return stored;
  } catch {
    /* Private-browsing / storage-disabled — fall through to default. */
  }
  return fallback;
}

interface Props {
  character: Character;
  voice: Voice | undefined;
  /** Current book id — required for the plan-108 per-character Qwen flow
      (voice-style generate, design-voice, series-scoped override). When
      absent (no book context), the engine picker still renders but the
      Qwen design sub-flow is unavailable. */
  bookId?: string;
  onClose: () => void;
  /** Meta carries the conflict flag so the change-log dispatch in layout.tsx
      knows whether the save reset the library match. */
  onSave: (next: Character, meta: { hadConflict: boolean }) => void;
  onLock: (character: Character) => void;
  onShowMatchDetail?: (id: string) => void;
  onRegenerateCharacter?: (id: string) => void;
  /** fs-26 — open the per-character "Fix audio" modal (loudness boost /
      re-record + splice) for this character. Omitted = button hidden. */
  onFixAudio?: (id: string) => void;
  /** Other characters in the cast that this character could be merged INTO
      (i.e. the surviving identity). When omitted or empty, the merge
      affordance hides itself. Layout passes `cast \ this`. */
  mergeCandidates?: Character[];
  /** Characters from prior books in the same series — rendered as a
      separate optgroup under the in-book candidates so the user can
      manually link a duplicate ("Hartwell Brennan Vale") to its canonical
      form ("Hart" from book 1) when the auto-matcher's name-score floor
      missed the connection. Each entry carries the prior bookId so the
      link-prior endpoint can address it. */
  mergeCandidatesPrior?: PriorMergeCandidate[];
  /** Fold this character (source) into another (target). Surviving target
      gains `source.name` in its aliases list; all sentences source said are
      reattributed to target. Returns a promise so the UI can show progress
      / surface errors. Drawer closes on resolve. */
  onMerge?: (sourceId: string, targetId: string) => Promise<void>;
  /** Manual continuity link — declares "this character (source) is the
      same person as that one (target) from a prior book in the same
      series." Server appends source.name to target's aliases on disk and
      returns a matchedFrom payload the parent uses to seed the
      "Continuity preserved" footer. */
  onLinkPrior?: (
    sourceId: string,
    targetBookId: string,
    targetCharacterId: string,
  ) => Promise<void>;
  /** Split an alias chip back into its own standalone cast member. The
      auto-fold step (server/src/analyzer/fold-minor-cast.ts) and the
      manual merge route are append-only; this is the only reverse path.
      Layout's handler fires the unlink-alias endpoint, dispatches the
      delta reducer, and opens the Reattribute Lines modal seeded with
      the server-returned impacted chapters so the user can move the
      right sentences to the new character. */
  onUnlinkAlias?: (sourceCharacterId: string, aliasName: string) => Promise<void>;
  /** Append a typed name to this character's aliases array. No sentence
      movement — this is for stitching in a name the analyzer missed.
      Used by the Profile Drawer's "+ Add alias" affordance. */
  onAddAlias?: (characterId: string, aliasName: string) => Promise<void>;
  /** Set this character's primary display name. Powers the header rename
      affordance (free-text) and the per-alias-chip "Make primary" promote.
      The old name is always demoted into aliases so a rename never loses a
      name. Dispatch-only (no API call) — the cast-slice persistence rule
      round-trips it to cast.json. When omitted, both affordances hide. */
  onRename?: (characterId: string, name: string) => void;
  /** Plan 101 follow-up (fe-8) — an auto-detected cross-book duplicate
      candidate for THIS character (same base voice, same series, name dedup
      hit, not already linked/variant-marked). When present the Voice-profile
      header renders a "⚠ Possible duplicate of …" chip; clicking it fires
      `onReviewDuplicate`. Omitted → no chip. */
  duplicateOther?: { name: string; bookTitle: string } | null;
  /** Open the duplicate-review modal for this character's candidate. Layout
      wires this to mount `DuplicateReviewModal` pre-populated with the pair. */
  onReviewDuplicate?: () => void;
  /** Plan 130 follow-up (fe-16) — the engine this character ACTUALLY rendered
      in last generation when it differs from its configured engine. `'kokoro'`
      surfaces the "Fallback (Kokoro)" status pill. Threaded into
      `resolveVoiceStatus` as the 4th arg. */
  renderedFallbackEngine?: string | null;
}

export interface PriorMergeCandidate {
  id: string;
  name: string;
  bookId: string;
  bookTitle: string;
}

type CharGender = NonNullable<Character['gender']>;
type CharAgeRange = NonNullable<Character['ageRange']>;

/* Standing background buckets the analyser's fold step creates and the
   cast-merge route auto-synthesises on first downgrade. Keep in sync with
   server/src/analyzer/fold-minor-cast.ts's MALE_BUCKET_ID /
   FEMALE_BUCKET_ID. */
const UNKNOWN_MALE_ID = 'unknown-male';
const UNKNOWN_FEMALE_ID = 'unknown-female';
const NARRATOR_ID = 'narrator';
/* Discriminator for prior-book options in the merge dropdown so the
   change handler can distinguish "fold into another in-book character"
   from "link to a prior series character" without parsing bookIds
   (which contain `__` separators). Option value is
   `${PRIOR_PREFIX}${index}` for priors; the index resolves back to the
   PriorMergeCandidate via the priorByKey Map at render time. */
const PRIOR_PREFIX = 'prior:';
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

export function ProfileDrawer({
  character,
  voice,
  bookId,
  onClose,
  onSave,
  onLock,
  onShowMatchDetail,
  onRegenerateCharacter,
  onFixAudio,
  mergeCandidates,
  mergeCandidatesPrior,
  onMerge,
  onLinkPrior,
  onUnlinkAlias,
  onAddAlias,
  onRename,
  duplicateOther,
  onReviewDuplicate,
  renderedFallbackEngine,
}: Props) {
  const [tone, setTone] = useState(
    character.tone ?? { warmth: 50, pace: 50, authority: 50, emotion: 50 },
  );
  /* Editable identity. The analyzer's guess (or the absence of one) seeds
     these; saving the drawer persists them onto the character. They drive
     the voice picker server-side, so a wrong inference can be corrected
     manually without retriggering analysis. */
  const [gender, setGender] = useState<CharGender | ''>(character.gender ?? '');
  const [ageRange, setAgeRange] = useState<CharAgeRange | ''>(character.ageRange ?? '');
  const c = CHAR_COLORS[character.color as CharColor] ?? CHAR_COLORS.narrator;
  const playback = useSamplePlayback();
  const dispatch = useAppDispatch();
  const ttsModelKey = useAppSelector((s) => s.ui.ttsModelKey);
  const ttsEngine = engineForModelKey(ttsModelKey);
  /* fs-2 — the open book's language, so the preview/calibration default speaks
     the right language (Russian pangram for a Russian book). */
  const bookLanguage = useAppSelector(
    (s) => s.library?.books?.find((b) => b.bookId === bookId)?.language ?? 'en',
  );
  const baseVoices = useAppSelector((s) => s.voices.baseVoices);
  const baseVoicesLoaded = useAppSelector((s) => s.voices.baseVoicesLoaded);
  /* "Design full cast" — lock the single-design button while a bulk run owns
     this book's designs (the server also 409s; this stops a doomed click). */
  const bulkDesignActive = useAppSelector(
    (s) =>
      s.castDesign.active?.kind === 'bulk' &&
      s.castDesign.active.state === 'running' &&
      s.castDesign.active.bookId === bookId,
  );
  /* This character's live single-design snapshot (background job, plan
     single-voice-design-background). Non-null only while a single design for
     THIS character is in flight (or staged ready-to-compare) — so reopening the
     drawer mid-design shows live progress and a completed re-design opens the
     A/B compare. Drives the engine picker's progress + the compare effect. */
  const singleDesign = useAppSelector((s) =>
    s.castDesign.active?.kind === 'single' && s.castDesign.active.characterId === character.id
      ? s.castDesign.active
      : null,
  );
  const sliceDesigning = singleDesign?.state === 'running';
  const slicePhase: 'designing' | 'rendering' = singleDesign?.phase ?? 'designing';
  const [overrideError, setOverrideError] = useState<string | null>(null);
  const [sampleStatus, setSampleStatus] = useState<SampleStatus | 'idle'>('idle');
  const [sampleError, setSampleError] = useState<string | null>(null);
  /* Surfaces the auto-evict banner inline above the sample row when the
     JIT model-load path actually unloaded the analyzer. Stays visible
     through synth and the brief moment after playback starts so the
     user has time to read it. Cleared on the next click. */
  const [evictionBanner, setEvictionBanner] = useState<string | null>(null);
  const sampleLoading = sampleStatus !== 'idle';

  /* ── Plan 108 per-character engine + bespoke-voice state ──────────────
     `engineChoice` mirrors Character.ttsEngine ('default' = use the
     project default; a real engine = per-character override). `persona`
     is the editable Character.voiceStyle. The design flow caches a
     bespoke Qwen embedding server-side and returns an audition the drawer
     plays; on Save we pin the designed voiceId series-scoped. The
     narrator usually stays default — no character to design a voice for. */
  /* fs-2 — a non-English book hard-locks every character to Qwen (Kokoro is
     English-only). Default the choice to 'qwen' regardless of any stale/reused
     ttsEngine on disk, matching the server's force-Qwen gate. */
  const lockedToQwen = bookLanguage !== 'en';
  const [engineChoice, setEngineChoice] = useState<EngineChoice>(
    lockedToQwen ? 'qwen' : (character.ttsEngine ?? 'default'),
  );
  const [persona, setPersona] = useState<string>(character.voiceStyle ?? '');
  const [personaBusy, setPersonaBusy] = useState(false);
  const [engineError, setEngineError] = useState<string | null>(null);
  /* Designed voiceId staged this session — set by Design & preview, read
     by Save to write overrideTtsVoices.qwen.name. Seeds from the existing
     assignment so a re-open of an already-Qwen character can Save without
     re-designing. A REUSED character carries its Qwen voice on the matched
     library `voice` (the reuse path leaves the character's own `ttsEngine`/
     `overrideTtsVoices` empty), so fall back to the matched voice — otherwise
     the drawer reads "No voice designed yet" and blocks the sample while the
     cast row correctly shows the reused Qwen voice. */
  const [designedVoiceId, setDesignedVoiceId] = useState<string | null>(
    character.overrideTtsVoices?.qwen?.name ??
      voice?.overrideTtsVoices?.qwen?.name ??
      (voice?.ttsVoice?.provider === 'qwen' ? voice.ttsVoice.name : null) ??
      null,
  );
  /* URL of the most-recent audition preview. Now a stable cached-sample URL
     (the design route writes the audition into the voice-sample cache), so
     there's no blob to revoke — the ref only feeds `designPlaying` below. */
  const designPreviewUrlRef = useRef<string | null>(null);
  const designPlaying =
    playback.isPlaying &&
    !!playback.currentUrl &&
    playback.currentUrl === designPreviewUrlRef.current;
  /* Plan 161 — when set, the A/B "current vs proposed" compare modal is open
     with this freshly-staged preview design. Set by `designVoice` after a
     successful preview design; cleared on approve (stages the promoted voice)
     or cancel (discards the preview). */
  const [voiceCompareInitial, setVoiceCompareInitial] = useState<{
    voiceId: string;
    previewUrl: string;
    persona: string;
  } | null>(null);
  /* The analyzer ships ≥3 evidence quotes sorted longest-first
     (server/src/routes/analysis.ts sortEvidence). The drawer shows the
     first 3 by default — index 0 is also the voice-cloning sample, so
     showing it on initial render lets the user verify the sample text
     without expanding. "Show more evidence" reveals any quotes beyond
     3 and is hidden when there's nothing extra. */
  const [showAllEvidence, setShowAllEvidence] = useState(false);
  const EVIDENCE_PREVIEW_LIMIT = 3;
  /* Preview-sample text — persists across drawer opens via localStorage
     so the user customises the line once and re-uses it across every
     character they audition. Default is a pangram + a short follow-on
     (see DEFAULT_PREVIEW_TEXT). The list of per-candidate preview rows
     is collapsed by default to keep the drawer tidy on first open. */
  const [previewText, setPreviewText] = useState<string>(() =>
    loadInitialPreviewText(bookLanguage),
  );
  const [showPreviewCandidates, setShowPreviewCandidates] = useState(false);
  useEffect(() => {
    if (typeof window === 'undefined') return;
    try {
      window.localStorage.setItem(PREVIEW_TEXT_STORAGE_KEY, previewText);
    } catch {
      /* Private-browsing / storage-disabled — drop the persist silently;
         in-memory state still drives the rest of this session. */
    }
  }, [previewText]);
  /* Merge UI state. The picker is collapsed by default — opening it reveals
     the list of candidates; selecting one shows a confirm row. The same
     busy/error pair backs the direct downgrade buttons below so two clicks
     can't fire concurrently. */
  const [mergeTargetId, setMergeTargetId] = useState<string | ''>('');
  const [mergeBusy, setMergeBusy] = useState(false);
  const [mergeError, setMergeError] = useState<string | null>(null);
  const [showMergePicker, setShowMergePicker] = useState(false);
  /* Controls the SearchablePicker popover above the merge-target trigger.
     Separate from `showMergePicker` (which gates the entire merge card)
     so the popover can close on row pick while the confirm row stays. */
  const [mergeTargetPickerOpen, setMergeTargetPickerOpen] = useState(false);
  const mergeTargetTriggerRef = useRef<HTMLButtonElement>(null);
  const isBucket = character.id === UNKNOWN_MALE_ID || character.id === UNKNOWN_FEMALE_ID;
  const isNarrator = character.id === NARRATOR_ID;
  /* "Downgrade" — fold this character into a standing background bucket.
     Reuses the merge transport: server auto-synthesises the bucket if the
     book hasn't accumulated one yet. Disabled when the source character is
     itself a bucket or the narrator — neither downgrade makes sense. */
  async function runMergeTo(targetId: string) {
    if (!onMerge) return;
    setMergeBusy(true);
    setMergeError(null);
    try {
      await onMerge(character.id, targetId);
      setShowMergePicker(false);
      setMergeTargetId('');
    } catch (e) {
      setMergeError((e as Error).message || 'Merge failed.');
    } finally {
      setMergeBusy(false);
    }
  }

  /* Alias chip management. `aliasBusy` gates both the X-on-chip click
     and the +Add alias submit so a fast double-click can't double-fire.
     `aliasError` surfaces server errors (e.g. self-alias-rejected) under
     the chip row without an interruptive modal. `addAliasInput` /
     `showAddAlias` back the inline "+ Add alias" text input.
     Imperative focus on input mount mirrors edit-chapter-title.tsx —
     JSX `autoFocus` would trip jsx-a11y/no-autofocus. */
  const [aliasBusy, setAliasBusy] = useState(false);
  const [aliasError, setAliasError] = useState<string | null>(null);
  const [showAddAlias, setShowAddAlias] = useState(false);
  const [addAliasInput, setAddAliasInput] = useState('');
  const addAliasInputRef = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    if (showAddAlias) addAliasInputRef.current?.focus();
  }, [showAddAlias]);

  /* Header rename. `editingName` toggles the inline input; `nameDraft` seeds
     from the current name on each open; `nameError` surfaces the empty guard.
     Imperative focus on mount mirrors the +Add alias input above. The reducer
     is the source of truth for the swap semantics — runRename only validates
     and hands the trimmed value to onRename. */
  const [editingName, setEditingName] = useState(false);
  const [nameDraft, setNameDraft] = useState('');
  const [nameError, setNameError] = useState<string | null>(null);
  const nameInputRef = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    if (editingName) nameInputRef.current?.focus();
  }, [editingName]);

  function beginRename() {
    setNameDraft(character.name);
    setNameError(null);
    setEditingName(true);
  }

  function runRename(value: string) {
    if (!onRename) return;
    const trimmed = value.trim();
    if (!trimmed) {
      setNameError('Name cannot be empty.');
      return;
    }
    /* No-op fast path — the reducer also guards this, but skipping the
       dispatch avoids a needless persist PUT. */
    if (trimmed.toLowerCase() !== character.name.trim().toLowerCase()) {
      onRename(character.id, trimmed);
    }
    setEditingName(false);
    setNameError(null);
  }

  async function runUnlinkAlias(aliasName: string) {
    if (!onUnlinkAlias || aliasBusy) return;
    setAliasBusy(true);
    setAliasError(null);
    try {
      await onUnlinkAlias(character.id, aliasName);
    } catch (e) {
      setAliasError((e as Error).message || 'Unlink failed.');
    } finally {
      setAliasBusy(false);
    }
  }

  async function runAddAlias() {
    if (!onAddAlias || aliasBusy) return;
    const trimmed = addAliasInput.trim();
    if (!trimmed) {
      setAliasError('Alias name cannot be empty.');
      return;
    }
    setAliasBusy(true);
    setAliasError(null);
    try {
      await onAddAlias(character.id, trimmed);
      setAddAliasInput('');
      setShowAddAlias(false);
    } catch (e) {
      setAliasError((e as Error).message || 'Add alias failed.');
    } finally {
      setAliasBusy(false);
    }
  }

  /* Manual continuity link — picker variant when the user selected a
     prior-book character (option value carries the PRIOR_PREFIX
     discriminator). Hits the link-prior callback instead of the in-book
     merge; on success the drawer closes and the parent's
     applyManualMatch lights up the "Continuity preserved" footer. */
  async function runLinkPriorTo(targetBookId: string, targetCharacterId: string) {
    if (!onLinkPrior) return;
    setMergeBusy(true);
    setMergeError(null);
    try {
      await onLinkPrior(character.id, targetBookId, targetCharacterId);
      setShowMergePicker(false);
      setMergeTargetId('');
    } catch (e) {
      setMergeError((e as Error).message || 'Link failed.');
    } finally {
      setMergeBusy(false);
    }
  }

  /* Sample subject: a library voice when one is matched, otherwise a
     character-derived stub so brand-new (unmatched) characters can still
     preview their attributes. Server file is namespaced `char-<id>` for
     character samples to keep them separate from library voice samples. */
  const sampleVoiceId = sampleScopeFor(character);
  /* Recompute against the *edited* identity so the displayed TTS voice
     updates live as the user changes the dropdowns. Saving the drawer
     persists these values; until then the recompute is local-only. */
  const editedCharacter: Character = {
    ...character,
    gender: gender || undefined,
    ageRange: ageRange || undefined,
    /* Stage the effective Qwen voice (designed this session OR inherited from
       a reused match) onto the character so `resolveTtsVoiceForCharacter(…,
       'qwen')` resolves it for the card line + sample, instead of reading the
       character's own (empty-when-reused) override and reporting "No voice
       designed yet". */
    overrideTtsVoices: designedVoiceId
      ? {
          ...(character.overrideTtsVoices ?? {}),
          /* Spread the existing qwen slot so designed emotion `variants`
             (fs-25/fs-34) survive — overwriting it with a bare `{ name }`
             dropped them, which on Save erased them from cast.json. */
          qwen: { ...(character.overrideTtsVoices?.qwen ?? {}), name: designedVoiceId },
        }
      : character.overrideTtsVoices,
  };
  const stubTtsVoice = resolveTtsVoiceForCharacter(editedCharacter, ttsEngine);
  const sampleSubject = voice ?? {
    id: sampleVoiceId,
    character: character.name,
    bookTitle: '',
    bookId: '',
    attributes: character.attributes ?? [],
    gradient: gradientForTtsVoice(stubTtsVoice.name, sampleVoiceId),
    usedIn: 0,
    source: 'current' as const,
    ttsVoice: stubTtsVoice,
  };
  /* Effective engine = this character's per-character override (live
     `engineChoice`) when set, else the project default. Qwen is the only
     override that diverges from the project model key, so a Qwen sample must
     route to the Qwen model key. And a Qwen voice can only synth once it's
     been designed (`designedVoiceId`); without one the server's
     pickVoiceForEngine returns '' and the sidecar 400s, so we gate the
     Play button instead of firing a request we know will fail. */
  const effectiveEngine: TtsEngine = engineChoice === 'default' ? ttsEngine : engineChoice;
  const effectiveSampleModelKey = sampleModelKeyForEngine(effectiveEngine, ttsModelKey);
  const qwenSampleBlocked = effectiveEngine === 'qwen' && !designedVoiceId;
  const samplePrefix = sampleUrlPrefixFor(sampleVoiceId, effectiveSampleModelKey);
  const isPlayingThis = playback.isPlaying && !!playback.currentUrl?.startsWith(samplePrefix);

  /* Plan 161 — "current voice" for the A/B compare = how the character sounds
     RIGHT NOW, resolved against its PERSISTED engine (not the edited Qwen
     selection), so Side A is the genuine pre-design voice in both the
     first-design (Kokoro/default) and re-design (existing Qwen) cases. */
  const currentEngine: TtsEngine = character.ttsEngine ?? ttsEngine;
  const currentModelKey = sampleModelKeyForEngine(currentEngine, ttsModelKey);
  const currentTtsVoice = resolveTtsVoiceForCharacter(character, currentEngine);
  const currentSubject: Voice = voice ?? {
    id: sampleVoiceId,
    character: character.name,
    bookTitle: '',
    bookId: '',
    attributes: character.attributes ?? [],
    gradient: gradientForTtsVoice(currentTtsVoice.name, sampleVoiceId),
    usedIn: 0,
    source: 'current' as const,
    ttsVoice: currentTtsVoice,
  };

  /* Card-line voice descriptor — resolved against the CHARACTER's engine
     (live `engineChoice`, falling back to the project default) rather than
     the project engine, so switching this character to Qwen updates the
     card immediately. For a Qwen character the preset descriptor
     ("Kokoro · am_erio · …") doesn't apply — `resolveTtsVoiceForCharacter`
     returns the bespoke "Qwen · Designed voice" / "No voice designed yet"
     line and we use it even when a library voice is matched (Qwen overrides
     any preset). Preset engines keep the matched library voice's own
     descriptor, exactly as before. (`effectiveEngine` is derived above.) */
  const cardTtsVoice =
    effectiveEngine === 'qwen'
      ? resolveTtsVoiceForCharacter(editedCharacter, 'qwen')
      : sampleSubject.ttsVoice;

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
  const voiceAge = voiceAgeFromAttributes(voice?.attributes);
  const editedGender = (gender || character.gender) as CharGender | undefined;
  const editedAge = (ageRange || character.ageRange) as CharAgeRange | undefined;
  const hasGenderConflict =
    !!voice &&
    !!voiceGender &&
    !!editedGender &&
    editedGender !== 'neutral' &&
    editedGender !== voiceGender;
  const hasAgeConflict = !!voice && !!voiceAge && !!editedAge && editedAge !== voiceAge;
  const hasConflict = hasGenderConflict || hasAgeConflict;

  async function playSample() {
    if (isPlayingThis) {
      playback.stop();
      return;
    }
    /* No designed Qwen voice → nothing to synth. The button is already
       disabled in this state; this guards the swatch click path too. */
    if (qwenSampleBlocked) return;
    setSampleError(null);
    setEvictionBanner(null);
    /* `synthesizing` is the most common starting status — for a warm model
       the helper jumps straight to it. Set it eagerly so the button label
       flips on click; the onStatus callback below upgrades it to
       `evicting` / `loading-tts` when those phases actually fire. */
    setSampleStatus('synthesizing');
    /* Live edits — read from drawer state, not the (stale) character prop,
       so the user can preview an attribute change before committing it
       with Save. Server hashes (text, voiceName) into the cache filename,
       so a different (gender, age, tone) really does produce new audio. */
    const characterHint = buildCharacterHint(character, {
      gender: gender || character.gender,
      ageRange: ageRange || character.ageRange,
      tone,
    });

    /* For a designed Qwen voice, the bespoke voiceId lives in
       `designedVoiceId` (live this session, pre-Save), not in the
       sample subject. Inject it into overrideTtsVoices.qwen so the server's
       pickVoiceForEngine('qwen', …) resolves it; preserve any other-engine
       slots already on the subject. Non-qwen engines pass through unchanged. */
    const requestSubject =
      effectiveEngine === 'qwen' && designedVoiceId
        ? {
            ...sampleSubject,
            overrideTtsVoices: {
              ...(voice?.overrideTtsVoices ?? {}),
              qwen: { name: designedVoiceId },
            },
          }
        : sampleSubject;

    console.log('[sample] requesting', {
      voiceId: sampleVoiceId,
      modelKey: effectiveSampleModelKey,
    });
    try {
      await playSampleWithAutoLoad({
        args: {
          voiceId: sampleVoiceId,
          voice: requestSubject,
          modelKey: effectiveSampleModelKey,
          characterHint,
        },
        playback,
        onStatus: (status, { analyzerEvicted }) => {
          setSampleStatus(status);
          if (analyzerEvicted && !evictionBanner) {
            setEvictionBanner('Analyzer unloaded to free VRAM for TTS.');
          }
        },
      });
      /* Optimistically advance the Qwen lifecycle pill Designed → Sampled —
         the drawer header reads the same resolveVoiceStatus as the cast row.
         Keyed on the store voice id (matching the cast-view dispatch). */
      if (effectiveEngine === 'qwen') {
        dispatch(
          voicesActions.markSampled({
            voiceId: voice?.id ?? character.voiceId ?? character.id,
          }),
        );
      }
    } catch (err) {
      setSampleError((err as Error).message);
    } finally {
      setSampleStatus('idle');
    }
  }

  /* Auto-generate the persona on first switch to Qwen when the character
     has none yet. Mirrors the server's per-character generator, then
     mirrors the result into redux (setVoiceStyle) so a later cast
     re-hydrate keeps it. No-ops without a bookId. */
  async function generatePersona() {
    if (!bookId || personaBusy) return;
    setPersonaBusy(true);
    setEngineError(null);
    try {
      const { voiceStyle } = await api.generateVoiceStyle(bookId, character.id);
      setPersona(voiceStyle);
      dispatch(castActions.setVoiceStyle({ characterId: character.id, voiceStyle }));
    } catch (e) {
      setEngineError((e as Error).message || 'Voice-style generation failed.');
    } finally {
      setPersonaBusy(false);
    }
  }

  /* Plan 149 — seed the persona textarea from the DESIGNED voice's sidecar
     when the character has a designed Qwen voice (`designedVoiceId`) but no
     persisted `voiceStyle`. Historically the persona was saved only on the
     voice sidecar (`instruct`), never mirrored onto the character, and reuse
     copies the override but not the persona — so reused/origin characters
     showed a blank textarea and couldn't re-design (the design route 400s on
     an empty persona). Fetches lazily, mirrors into redux like generatePersona,
     and never clobbers a persona the user has started typing. */
  useEffect(() => {
    if (!bookId || !designedVoiceId) return;
    if ((character.voiceStyle ?? '').trim()) return;
    let cancelled = false;
    void (async () => {
      try {
        const { instruct } = await api.fetchDesignedPersona(bookId, character.id);
        if (cancelled || !instruct.trim()) return;
        let seeded = false;
        setPersona((prev) => {
          if (prev.trim()) return prev;
          seeded = true;
          return instruct;
        });
        if (seeded) {
          dispatch(castActions.setVoiceStyle({ characterId: character.id, voiceStyle: instruct }));
        }
      } catch {
        /* benign — leave the textarea empty exactly as before */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [bookId, character.id, character.voiceStyle, designedVoiceId, dispatch]);

  /* First-design completion while the drawer is open: the middleware persisted
     the override + mirrored it into the cast slice. Reflect the designed
     voiceId into local state so the card flips to "designed" and the sample
     unblocks. (v1 does NOT auto-play the audition — the user clicks "Play 12s
     sample".) Ignore `-preview` names (those belong to a staged re-design that
     the A/B compare resolves). */
  const qwenOverrideName = useAppSelector(
    (s) =>
      s.cast.characters.find((c) => c.id === character.id)?.overrideTtsVoices?.qwen?.name ?? null,
  );
  useEffect(() => {
    if (
      qwenOverrideName &&
      qwenOverrideName !== designedVoiceId &&
      !qwenOverrideName.endsWith('-preview')
    ) {
      setDesignedVoiceId(qwenOverrideName);
    }
  }, [qwenOverrideName, designedVoiceId]);

  /* Re-design completion: when the slice flips to `ready-to-compare` for this
     character, open the A/B compare seeded from the staged preview. */
  useEffect(() => {
    if (singleDesign?.state === 'ready-to-compare' && singleDesign.preview && !voiceCompareInitial) {
      setVoiceCompareInitial({
        voiceId: singleDesign.preview.previewVoiceId,
        previewUrl: singleDesign.preview.previewUrl,
        persona: singleDesign.preview.persona,
      });
    }
  }, [singleDesign, voiceCompareInitial]);

  function onSelectEngine(next: EngineChoice) {
    setEngineChoice(next);
    setEngineError(null);
    /* First switch to Qwen with no persona → auto-compose one so the
       textarea isn't empty (the user can then edit / regenerate). */
    if (next === 'qwen' && !persona.trim() && bookId && !personaBusy) {
      void generatePersona();
    }
  }

  function designVoice() {
    if (designPlaying) {
      playback.stop();
      return;
    }
    if (!bookId || sliceDesigning) return;
    const trimmed = persona.trim();
    if (!trimmed) {
      setEngineError('Add a persona before designing a voice.');
      return;
    }
    setEngineError(null);
    /* The A/B "current vs proposed" compare is only meaningful when the
       character ALREADY has a designed bespoke voice to put on Side A. On a
       FIRST design there is nothing to compare against. `designedVoiceId` is
       non-null iff a bespoke voice already exists for this character. */
    const isRedesign = designedVoiceId !== null;
    /* DISPATCH a background single design instead of awaiting the API: the job
       survives closing the drawer / a reload (the middleware owns the SSE,
       persists a first design, and stages a re-design's preview). The drawer
       drives its progress UI off `singleDesign` and opens the A/B compare when
       the slice reports `ready-to-compare`. */
    dispatch(
      castDesignActions.designSingleRequested({
        bookId,
        characterId: character.id,
        name: character.name,
        persona: trimmed,
        sampleVoiceId,
        modelKey: effectiveSampleModelKey,
        mode: isRedesign ? 'redesign' : 'first',
      }),
    );
  }

  return (
    <>
      {/* Plan (status-popover) — the backdrop + drawer start BELOW the 64px
          top-bar header (top-16) so the drawer tucks under the bar rather than
          covering it. This keeps the top bar (Status pill, queue chip, theme,
          avatar) interactive while the drawer is open — clicking/hovering the
          Status pill no longer lands on this backdrop and dismisses the drawer.
          Clicking the dimmed area below the header still closes it. */}
      <div onClick={onClose} className="fixed inset-x-0 top-16 bottom-0 bg-ink/30 z-40 fade-in" />
      <aside
        data-tour-id="profile-drawer"
        className="fixed top-16 right-0 bottom-0 w-full max-w-[520px] bg-white shadow-drawer z-50 overflow-y-auto scrollbar-thin slide-in-right"
        style={{ ['--scrollbar-thin-radius' as string]: '0px' } as React.CSSProperties}
      >
        <div className="sticky top-0 bg-white/95 backdrop-haze-md border-b border-ink/10 px-6 py-4 flex items-center gap-3">
          <Avatar name={character.name} color={character.color as CharColor} size={40} />
          <div className="flex-1 min-w-0">
            {editingName ? (
              <div className="flex items-center gap-1.5 min-w-0">
                <input
                  ref={nameInputRef}
                  aria-label="Character name"
                  value={nameDraft}
                  onChange={(e) => {
                    setNameDraft(e.target.value);
                    if (nameError) setNameError(null);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      runRename(nameDraft);
                    }
                    if (e.key === 'Escape') {
                      e.preventDefault();
                      setEditingName(false);
                      setNameError(null);
                    }
                  }}
                  className="flex-1 min-w-0 px-2 py-1 rounded-lg border border-ink/20 bg-white text-base font-bold text-ink focus:outline-hidden focus:ring-2 focus:ring-magenta/30 min-h-[44px] sm:min-h-0"
                />
                <button
                  aria-label="Save name"
                  disabled={!nameDraft.trim()}
                  onClick={() => runRename(nameDraft)}
                  className="shrink-0 px-2.5 py-1 rounded-lg text-xs font-semibold bg-magenta text-white hover:bg-magenta/90 disabled:bg-ink/15 disabled:text-ink/40 disabled:cursor-not-allowed min-h-[44px] sm:min-h-0"
                >
                  Save
                </button>
              </div>
            ) : (
              <div className="flex items-center gap-1.5 min-w-0">
                <h3 className="text-lg font-bold text-ink leading-tight truncate min-w-0">
                  {character.name}
                </h3>
                {onRename && !isBucket && (
                  <button
                    aria-label="Rename character"
                    onClick={beginRename}
                    className="shrink-0 text-[11px] font-medium text-ink/45 hover:text-magenta underline-offset-2 hover:underline"
                  >
                    Rename
                  </button>
                )}
              </div>
            )}
            {nameError && (
              <p className="mt-1 text-[11px] text-red-600/90 font-medium">⚠ {nameError}</p>
            )}
            <p className="text-xs text-ink/60 truncate">{character.role}</p>
          </div>
          <button onClick={onClose} className="p-2 rounded-full hover:bg-ink/5 text-ink/60">
            <IconClose className="w-4 h-4" />
          </button>
        </div>

        <div className="p-6 space-y-8">
          <p className="text-sm text-ink/70 leading-relaxed">{character.description}</p>

          <section>
            <div className="flex items-center justify-between mb-4">
              <p className="text-[11px] uppercase tracking-wider text-ink/50 font-semibold">
                Voice profile
              </p>
              <div className="flex items-center gap-2">
                {/* Lifecycle pill + Reused badge, resolved the same way as the
                    cast view's Status column so the two surfaces agree (a
                    reused Qwen voice shows "Designed/Generated · Reused"). The
                    4th arg (fe-16) surfaces "Fallback (Kokoro)" when this
                    character actually rendered in Kokoro last generation. */}
                {(() => {
                  const { lifecycle, reused, hasEmotionVariants, variantCount } =
                    resolveVoiceStatus(character, voice, effectiveEngine, renderedFallbackEngine);
                  return (
                    <>
                      {lifecycle && <Pill color={lifecycle.color}>{lifecycle.label}</Pill>}
                      {reused && <ReusedBadge />}
                      {hasEmotionVariants && <VariantsBadge count={variantCount} />}
                    </>
                  );
                })()}
              </div>
            </div>

            {/* fe-8 — cross-book "Possible duplicate of …" chip. Surfaces when
                the voices-view duplicate detector flags THIS character as a
                likely same-person match in a series-mate book. Click opens the
                DuplicateReviewModal (mounted by layout) pre-populated with the
                pair so the user can link or mark-as-variant without leaving
                the drawer. 44px tap target on phone. */}
            {duplicateOther && onReviewDuplicate && (
              <button
                type="button"
                onClick={onReviewDuplicate}
                title={`"${character.name}" and "${duplicateOther.name}" (${duplicateOther.bookTitle}) share this base voice across books in the same series — review and link, or mark as an intentional variant.`}
                className="mb-4 inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-amber-100 text-amber-800 text-xs font-semibold hover:bg-amber-200 transition-colors min-h-[44px] sm:min-h-0"
              >
                ⚠ Possible duplicate of &ldquo;{duplicateOther.name}&rdquo; ({duplicateOther.bookTitle}) →
              </button>
            )}

            <div className="flex items-center gap-4 p-4 rounded-2xl bg-canvas border border-ink/10">
              <div>
                <VoiceSwatch
                  voice={voice}
                  size="md"
                  showLabel={false}
                  onSelect={() => {
                    void playSample();
                  }}
                  loading={sampleLoading}
                />
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-base font-bold text-ink truncate">
                  {voice?.character ?? character.name}
                </p>
                {character.matchedFrom ? (
                  <button
                    onClick={() => onShowMatchDetail?.(character.id)}
                    className="mt-0.5 text-xs text-purple-deep/70 hover:text-purple-deep underline-offset-2 hover:underline text-left"
                  >
                    Matched from{' '}
                    <span className="font-semibold">{character.matchedFrom.bookTitle}</span> ·{' '}
                    {Math.round((character.matchedFrom.confidence ?? 0) * 100)}% confidence — see
                    why
                  </button>
                ) : (
                  <p className="text-xs text-ink/60 mt-0.5">
                    Synthesised from {character.lines} lines of dialogue
                  </p>
                )}
                {/* Engine-aware TTS voice assignment — what the user will
                    actually hear when they click Play. Mirrors the cast
                    view's TtsVoiceLine so the drawer stays in sync. */}
                <p
                  className="mt-1 text-[11px] truncate"
                  title={`${capitalise(cardTtsVoice.provider)} voice — ${cardTtsVoice.description}`}
                >
                  <span className="text-ink/40">{capitalise(cardTtsVoice.provider)} · </span>
                  {cardTtsVoice.name && (
                    <span className="font-semibold text-ink/70">{cardTtsVoice.name}</span>
                  )}
                  <span className="text-ink/40">
                    {cardTtsVoice.name ? ' · ' : ''}
                    {cardTtsVoice.description}
                  </span>
                </p>
                <div className="mt-2">
                  <button
                    onClick={playSample}
                    disabled={sampleLoading || qwenSampleBlocked}
                    className={`inline-flex items-center gap-2 px-3 py-1.5 rounded-full text-xs font-semibold transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${
                      sampleLoading
                        ? 'bg-magenta/10 text-magenta cursor-wait'
                        : isPlayingThis
                          ? 'bg-magenta text-white hover:bg-magenta/90'
                          : 'bg-magenta/10 text-magenta hover:bg-magenta/20'
                    }`}
                  >
                    {sampleLoading ? (
                      <>
                        <IconSpinner className="w-3.5 h-3.5" />
                        <span>{sampleLoadingLabel(sampleStatus, effectiveSampleModelKey)}</span>
                      </>
                    ) : isPlayingThis ? (
                      <>
                        <IconPause className="w-3.5 h-3.5" />
                        <span>Stop sample</span>
                      </>
                    ) : (
                      <>
                        <IconWaveform className="w-3.5 h-3.5" />
                        <span>Play 12s sample</span>
                      </>
                    )}
                  </button>
                  {qwenSampleBlocked && (
                    <p className="mt-1 text-[11px] text-ink/50">
                      Design a Qwen voice below before sampling.
                    </p>
                  )}
                  {!voice && !qwenSampleBlocked && (
                    <p className="mt-1 text-[11px] text-ink/50">
                      No library voice matched yet — sampling directly from {character.name}'s
                      attributes.
                    </p>
                  )}
                  {evictionBanner && (
                    <p className="mt-1 inline-flex items-center gap-1.5 text-[11px] text-emerald-700">
                      <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" />
                      {evictionBanner}
                    </p>
                  )}
                  {sampleError && (
                    <p className="mt-1 text-[11px] text-red-600/90 font-medium">⚠ {sampleError}</p>
                  )}
                </div>
              </div>
            </div>

            <VoiceEnginePicker
              value={engineChoice}
              onChange={onSelectEngine}
              installedEngines={['kokoro', 'qwen']}
              defaultEngineLabel={capitalise(ttsEngine)}
              lockedToQwen={lockedToQwen}
              persona={persona}
              onPersonaChange={setPersona}
              onRegeneratePersona={() => void generatePersona()}
              personaBusy={personaBusy}
              onDesignVoice={() => designVoice()}
              designBusy={sliceDesigning || bulkDesignActive}
              designPhase={slicePhase}
              designPlaying={designPlaying}
              designedVoiceId={designedVoiceId}
              error={engineError}
            />

            {/* fs-25 — Qwen-only emotion variant design (gated on the base voice
                existing, handled inside the component). */}
            {effectiveEngine === 'qwen' && bookId && (
              <EmotionVariantDesigner
                bookId={bookId}
                character={character}
                sampleVoiceId={sampleVoiceId}
                modelKey={effectiveSampleModelKey}
                baseDesigned={!!designedVoiceId}
                variants={character.overrideTtsVoices?.qwen?.variants}
              />
            )}

            {/* Portaled to document.body: the drawer aside carries
                `scrollbar-thin`, whose `clip-path` clips ALL descendants —
                including `position: fixed` ones — so a nested full-screen A/B
                compare overlay renders clipped to the ~520px drawer column.
                Portaling out (the app's convention for top-bar/tour/picker
                overlays) lets it cover the viewport. */}
            {voiceCompareInitial &&
              bookId &&
              typeof document !== 'undefined' &&
              createPortal(
                <VoiceCompareModal
                  bookId={bookId}
                  character={character}
                  currentSubject={currentSubject}
                  currentSampleVoiceId={sampleVoiceId}
                  currentModelKey={currentModelKey}
                  designModelKey={effectiveSampleModelKey}
                  sampleVoiceId={sampleVoiceId}
                  initial={voiceCompareInitial}
                  onApprove={({ voiceId, persona: approvedPersona, previewUrl }) => {
                    /* Stage the PROMOTED (stable) voice into the drawer; Save
                       persists it series-scoped exactly as before. */
                    setPersona(approvedPersona);
                    setDesignedVoiceId(voiceId);
                    designPreviewUrlRef.current = previewUrl;
                    dispatch(
                      castActions.setVoiceStyle({
                        characterId: character.id,
                        voiceStyle: approvedPersona,
                      }),
                    );
                    setVoiceCompareInitial(null);
                    /* Resolving the compare ends the single-design lifecycle —
                       clear the slice so the Design pill / ready-to-compare state
                       reset (otherwise the effect would re-open the modal). */
                    dispatch(castDesignActions.clear());
                  }}
                  onClose={() => {
                    setVoiceCompareInitial(null);
                    dispatch(castDesignActions.clear());
                  }}
                />,
                document.body,
              )}

            {/* Preset (Coqui/Kokoro/Gemini) speaker picker — shown only when
                this character will actually synthesise with a PRESET engine.
                Gate on the EFFECTIVE engine, not the live `engineChoice`: a
                default-engine character on a Qwen project resolves to Qwen, so
                its preset slots are inert and the picker would contradict the
                "Active engine: Qwen" header. `effectiveEngine` already folds
                the per-character override over the project default. */}
            {effectiveEngine !== 'qwen' && (
              <ModelVoiceOverridePicker
                voiceId={voice?.id ?? character.voiceId ?? character.id}
                currentOverrides={mapOverridesToBaseVoiceMap(
                  voice?.overrideTtsVoices ?? null,
                  voice?.overrideTtsVoice ?? null,
                )}
                autoVoiceName={sampleSubject.ttsVoice.name}
                autoVoiceEngine={sampleSubject.ttsVoice.provider as TtsEngine}
                activeEngine={ttsEngine}
                baseVoices={baseVoices}
                baseVoicesLoaded={baseVoicesLoaded}
                error={overrideError}
                previewText={previewText}
                onPreviewTextChange={setPreviewText}
                previewExpanded={showPreviewCandidates}
                onPreviewExpandedChange={setShowPreviewCandidates}
                previewModelKey={ttsModelKey}
                onChange={async (next) => {
                  setOverrideError(null);
                  const voiceIdForApi = voice?.id ?? character.voiceId ?? character.id;
                  /* Optimistic local update — slice mutation only takes effect
                   when the targeted Voice exists in the library payload. For
                   unmatched characters (no library Voice yet) the reducer
                   no-ops and the next hydrate picks up the persisted value. */
                  if (voice?.id) {
                    dispatch(voicesActions.setOverride({ voiceId: voiceIdForApi, override: next }));
                  }
                  try {
                    await api.setVoiceOverride(voiceIdForApi, next);
                  } catch (err) {
                    setOverrideError((err as Error).message);
                    /* On failure, revert by re-dispatching the prior state.
                     For per-engine overrides this is a coarse revert — we
                     restore the full prior map. The next hydrate corrects
                     any drift. */
                    if (voice?.id) {
                      const prior = voice.overrideTtsVoices ?? null;
                      if (prior) {
                        for (const [engine, slot] of Object.entries(prior)) {
                          if (slot?.name) {
                            dispatch(
                              voicesActions.setOverride({
                                voiceId: voiceIdForApi,
                                override: { engine: engine as TtsEngine, name: slot.name },
                              }),
                            );
                          }
                        }
                      } else {
                        dispatch(
                          voicesActions.setOverride({ voiceId: voiceIdForApi, override: null }),
                        );
                      }
                    }
                  }
                }}
              />
            )}

            {hasConflict && (
              <div className="mt-3 rounded-2xl border border-amber-200 bg-amber-50/70 px-3 py-2.5 text-xs text-amber-900">
                <p className="font-semibold">⚠ Library voice / identity mismatch</p>
                <p className="mt-1 leading-relaxed">
                  <span className="font-semibold">{voice?.character}</span> is{' '}
                  {[
                    voiceGender ? capitalise(voiceGender) : null,
                    voiceAge ? capitalise(voiceAge) : null,
                  ]
                    .filter(Boolean)
                    .join(' · ')}
                  , but you've set this character to{' '}
                  {[
                    hasGenderConflict && editedGender ? capitalise(editedGender) : null,
                    hasAgeConflict && editedAge ? capitalise(editedAge) : null,
                  ]
                    .filter(Boolean)
                    .join(' · ')}
                  . Saving will clear the library match and re-synthesise from {character.name}'s
                  attributes — the prebuilt voice picker will pick the right slot for the new
                  identity.
                </p>
              </div>
            )}

            <div className="mt-3 grid grid-cols-2 gap-2">
              <button className="px-3 py-2 rounded-xl border border-ink/10 hover:bg-ink/4 text-xs font-medium text-ink inline-flex items-center justify-center gap-1.5">
                <IconStar className="w-3.5 h-3.5" /> Save to library
              </button>
              <button
                onClick={() => onLock(character)}
                className={`px-3 py-2 rounded-xl border text-xs font-medium inline-flex items-center justify-center gap-1.5 ${character.voiceState === 'locked' ? 'border-ink/30 bg-ink/6 text-ink' : 'border-ink/10 hover:bg-ink/4 text-ink'}`}
              >
                <IconLock className="w-3.5 h-3.5" />{' '}
                {character.voiceState === 'locked' ? 'Locked' : 'Lock'}
              </button>
            </div>
            <button
              onClick={() => onRegenerateCharacter?.(character.id)}
              className="mt-3 w-full inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-2xl bg-peach/15 hover:bg-peach/25 text-magenta text-sm font-semibold transition-colors"
            >
              <IconRefresh className="w-4 h-4" /> Regenerate {character.name.split(' ')[0]}'s lines
              across the book
            </button>
            {onFixAudio && (
              <button
                onClick={() => onFixAudio(character.id)}
                className="mt-2 w-full inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-2xl border border-ink/10 hover:bg-ink/4 text-ink text-sm font-semibold transition-colors min-h-[44px]"
              >
                <IconRefresh className="w-4 h-4" /> Fix {character.name.split(' ')[0]}'s audio
                (loudness / re-record)
              </button>
            )}
          </section>

          <section>
            <p className="text-[11px] uppercase tracking-wider text-ink/50 font-semibold mb-3">
              Evidence from the manuscript
            </p>
            <div className="space-y-3">
              {(showAllEvidence
                ? character.evidence
                : character.evidence?.slice(0, EVIDENCE_PREVIEW_LIMIT)
              )?.map((ev, i) => (
                <div key={i} className="p-4 rounded-2xl bg-canvas border border-ink/10">
                  <blockquote
                    className="font-serif italic text-sm text-ink/85 leading-relaxed border-l-2 pl-3"
                    style={{ borderColor: c.hex }}
                  >
                    {ev.quote}
                  </blockquote>
                  <p className="mt-2 text-xs text-ink/60 leading-relaxed">{ev.note}</p>
                </div>
              ))}
            </div>
            {character.evidence && character.evidence.length > EVIDENCE_PREVIEW_LIMIT && (
              <button
                onClick={() => setShowAllEvidence((v) => !v)}
                className="mt-3 text-xs font-medium text-ink/70 hover:text-ink underline-offset-4 hover:underline"
              >
                {showAllEvidence
                  ? '− Show fewer'
                  : `+ Show ${character.evidence.length - EVIDENCE_PREVIEW_LIMIT} more`}
              </button>
            )}
          </section>

          <section>
            <p className="text-[11px] uppercase tracking-wider text-ink/50 font-semibold mb-3">
              Identity
            </p>
            <div className="grid grid-cols-2 gap-3">
              <label className="flex flex-col gap-1.5">
                <span className="text-[11px] text-ink/60 font-medium">Gender</span>
                <select
                  value={gender}
                  onChange={(e) => setGender(e.target.value as CharGender | '')}
                  className="px-3 py-2 rounded-xl border border-ink/15 bg-white text-sm text-ink focus:outline-hidden focus:ring-2 focus:ring-magenta/30"
                >
                  <option value="">— unset —</option>
                  {GENDER_OPTIONS.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </select>
              </label>
              <label className="flex flex-col gap-1.5">
                <span className="text-[11px] text-ink/60 font-medium">Age range</span>
                <select
                  value={ageRange}
                  onChange={(e) => setAgeRange(e.target.value as CharAgeRange | '')}
                  className="px-3 py-2 rounded-xl border border-ink/15 bg-white text-sm text-ink focus:outline-hidden focus:ring-2 focus:ring-magenta/30"
                >
                  <option value="">— unset —</option>
                  {AGE_OPTIONS.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <p className="mt-2 text-[11px] text-ink/50">
              Drives the gender + register slot in the voice picker. If the engine picked the wrong
              voice for this character, correct these and Save — the voice line above updates
              immediately.
            </p>
          </section>

          <section>
            <p className="text-[11px] uppercase tracking-wider text-ink/50 font-semibold mb-3">
              Inferred attributes
            </p>
            <div className="flex flex-wrap gap-1.5">
              {character.attributes?.map((a) => (
                <Pill key={a}>{a}</Pill>
              ))}
              <button className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium border border-dashed border-ink/20 text-ink/50 hover:border-peach hover:text-peach">
                <IconPlus className="w-3 h-3" />
                Add
              </button>
            </div>
          </section>

          <section>
            <p className="text-[11px] uppercase tracking-wider text-ink/50 font-semibold mb-3">
              Cast roster
            </p>
            {(character.aliases && character.aliases.length > 0) || onAddAlias ? (
              <div className="mb-3">
                <p className="text-xs text-ink/55 mb-1.5">Also known as</p>
                <div className="flex flex-wrap items-center gap-1.5">
                  {(character.aliases ?? []).map((a) => (
                    <span
                      key={a}
                      className="inline-flex items-center gap-1 pl-2 pr-1 py-0.5 rounded-full text-[11px] font-medium bg-magenta/12 text-ink min-h-[28px] sm:min-h-0"
                    >
                      <span>{a}</span>
                      {onRename && !isBucket && (
                        <button
                          aria-label={`Make ${a} the primary name`}
                          onClick={() => onRename(character.id, a)}
                          className="inline-flex items-center justify-center w-5 h-5 rounded-full text-ink/55 hover:bg-magenta/15 hover:text-magenta coarse-pointer:opacity-100"
                        >
                          <IconStar className="w-3 h-3" />
                        </button>
                      )}
                      {onUnlinkAlias && (
                        <button
                          aria-label={`Unlink ${a}`}
                          disabled={aliasBusy}
                          onClick={() => void runUnlinkAlias(a)}
                          className="inline-flex items-center justify-center w-5 h-5 rounded-full text-ink/55 hover:bg-ink/10 hover:text-ink disabled:opacity-50 disabled:cursor-wait coarse-pointer:opacity-100"
                        >
                          <IconClose className="w-3 h-3" />
                        </button>
                      )}
                    </span>
                  ))}
                  {onAddAlias &&
                    (showAddAlias ? (
                      <span className="inline-flex items-center gap-1">
                        <input
                          ref={addAliasInputRef}
                          aria-label="New alias name"
                          value={addAliasInput}
                          disabled={aliasBusy}
                          onChange={(e) => {
                            setAddAliasInput(e.target.value);
                            if (aliasError) setAliasError(null);
                          }}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') {
                              e.preventDefault();
                              void runAddAlias();
                            }
                            if (e.key === 'Escape') {
                              e.preventDefault();
                              setShowAddAlias(false);
                              setAddAliasInput('');
                              setAliasError(null);
                            }
                          }}
                          placeholder="alias name"
                          className="px-2 py-0.5 rounded-full border border-ink/20 bg-white text-[11px] text-ink focus:outline-hidden focus:ring-2 focus:ring-magenta/30 min-h-[28px] sm:min-h-0"
                        />
                        <button
                          aria-label="Save alias"
                          disabled={aliasBusy || !addAliasInput.trim()}
                          onClick={() => void runAddAlias()}
                          className="px-2 py-0.5 rounded-full text-[11px] font-semibold bg-magenta text-white hover:bg-magenta/90 disabled:bg-ink/15 disabled:text-ink/40 disabled:cursor-not-allowed"
                        >
                          Save
                        </button>
                      </span>
                    ) : (
                      <button
                        aria-label="Add alias"
                        onClick={() => {
                          setShowAddAlias(true);
                          setAliasError(null);
                        }}
                        className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium border border-dashed border-ink/20 text-ink/55 hover:border-peach hover:text-peach min-h-[28px] sm:min-h-0"
                      >
                        <IconPlus className="w-3 h-3" />
                        Add alias
                      </button>
                    ))}
                </div>
                {aliasError && (
                  <p className="mt-1.5 text-[11px] text-red-600/90 font-medium">⚠ {aliasError}</p>
                )}
              </div>
            ) : null}
            {(() => {
              const inBookCount = onMerge && mergeCandidates?.length ? mergeCandidates.length : 0;
              const priorCount =
                onLinkPrior && mergeCandidatesPrior?.length ? mergeCandidatesPrior.length : 0;
              const totalCount = inBookCount + priorCount;
              if (totalCount === 0) {
                return (
                  <p className="text-[11px] text-ink/50">
                    {character.aliases?.length
                      ? 'These names were merged into this character. The voice matcher will use them when later books in the series detect the same person.'
                      : "Once another character is detected as the same person, you can merge them here — their name joins this character's aliases and the matcher learns the link for later books."}
                  </p>
                );
              }
              if (!showMergePicker) {
                return (
                  <button
                    onClick={() => {
                      setShowMergePicker(true);
                      setMergeError(null);
                    }}
                    className="w-full px-3 py-2 rounded-xl border border-dashed border-ink/20 hover:border-peach hover:text-peach text-xs font-medium text-ink/65 inline-flex items-center justify-center gap-1.5"
                  >
                    Merge {character.name.split(' ')[0]} into another character…
                  </button>
                );
              }
              /* Discriminator: an option for a current-book character
                 carries the character's id verbatim; an option for a
                 prior-book character carries `${PRIOR_PREFIX}${index}`
                 so we can look the entry up without parsing bookIds
                 (some of which contain `__` separators that would
                 complicate a flat string scheme). */
              const inBookCandidates = inBookCount > 0 ? mergeCandidates! : [];
              const priorCandidates = priorCount > 0 ? mergeCandidatesPrior! : [];
              const priorByKey = new Map<string, PriorMergeCandidate>(
                priorCandidates.map((p, i) => [`${PRIOR_PREFIX}${i}`, p]),
              );
              const selectedPrior = priorByKey.get(mergeTargetId);
              const selectedInBook = !selectedPrior
                ? inBookCandidates.find((c) => c.id === mergeTargetId)
                : undefined;
              /* PriorMergeCandidate → SeriesRosterEntry adapter. The
                 character picker accepts the roster shape; merge candidates
                 omit aliases / voiceId, which are optional in the roster
                 entry type, so an undefined-fill is safe. The roster
                 picker keys rows by `${bookId}_${id}`, which makes the
                 PRIOR_PREFIX index lookup deterministic on pick. */
              const priorRoster: SeriesRosterEntry[] = priorCandidates.map((p) => ({
                id: p.id,
                name: p.name,
                bookId: p.bookId,
                bookTitle: p.bookTitle,
                voiceId: '',
              }));
              /* Trigger button label: the resolved survivor name, or the
                 placeholder when nothing's picked yet. */
              const triggerLabel = selectedInBook
                ? selectedInBook.name
                : selectedPrior
                  ? `${selectedPrior.name} — ${selectedPrior.bookTitle}`
                  : '— pick a character —';
              return (
                <div className="rounded-2xl bg-canvas border border-ink/10 p-3">
                  <label
                    className="block text-[11px] text-ink/60 font-medium mb-1.5"
                    htmlFor="profile-merge-target"
                  >
                    Keep which character as the survivor?
                  </label>
                  <button
                    id="profile-merge-target"
                    ref={mergeTargetTriggerRef}
                    type="button"
                    aria-label="Merge target"
                    aria-haspopup="listbox"
                    aria-expanded={mergeTargetPickerOpen}
                    disabled={mergeBusy}
                    onClick={() => setMergeTargetPickerOpen((v) => !v)}
                    className="w-full inline-flex items-center justify-between gap-2 px-3 py-2 rounded-xl border border-ink/15 bg-white text-sm text-ink hover:border-ink/30 focus:outline-hidden focus:ring-2 focus:ring-magenta/30 disabled:opacity-60 disabled:cursor-not-allowed min-h-[44px] sm:min-h-0"
                  >
                    <span
                      className={`truncate text-left flex-1 ${mergeTargetId ? '' : 'text-ink/50'}`}
                    >
                      {triggerLabel}
                    </span>
                    <IconChevD className="w-3.5 h-3.5 text-ink/50 shrink-0" />
                  </button>
                  {mergeTargetPickerOpen && (
                    <CharacterSearchPicker
                      characters={inBookCandidates}
                      priorRoster={priorRoster.length > 0 ? priorRoster : undefined}
                      currentCharacterId=""
                      onPick={(id) => {
                        setMergeTargetId(id);
                        setMergeError(null);
                        setMergeTargetPickerOpen(false);
                      }}
                      onPickRosterEntry={(entry) => {
                        /* Resolve the PRIOR_PREFIX${idx} encoding so the
                           submit handler's selectedPrior branch reaches
                           the right PriorMergeCandidate. */
                        const idx = priorCandidates.findIndex(
                          (p) => p.id === entry.id && p.bookId === entry.bookId,
                        );
                        if (idx >= 0) {
                          setMergeTargetId(`${PRIOR_PREFIX}${idx}`);
                          setMergeError(null);
                        }
                        setMergeTargetPickerOpen(false);
                      }}
                      onClose={() => setMergeTargetPickerOpen(false)}
                      anchorRef={mergeTargetTriggerRef}
                      placement="bottom-start"
                      minWidth={320}
                    />
                  )}
                  {selectedInBook && (
                    <p className="mt-2 text-[11px] text-ink/65 leading-relaxed">
                      <span className="font-semibold text-ink">{character.name}</span> will be
                      folded into{' '}
                      <span className="font-semibold text-ink">{selectedInBook.name}</span>. Their
                      name joins the survivor's aliases and every sentence they spoke is
                      reattributed.
                    </p>
                  )}
                  {selectedPrior && (
                    <p className="mt-2 text-[11px] text-ink/65 leading-relaxed">
                      <span className="font-semibold text-ink">{character.name}</span> will be
                      linked as the same person as{' '}
                      <span className="font-semibold text-ink">{selectedPrior.name}</span> from{' '}
                      <span className="font-semibold text-ink">{selectedPrior.bookTitle}</span>. The
                      matcher learns this link for future books in the series; you can then sync
                      profiles from the cast card.
                    </p>
                  )}
                  {mergeError && (
                    <p className="mt-2 text-[11px] text-red-600/90 font-medium">⚠ {mergeError}</p>
                  )}
                  <div className="mt-3 flex items-center justify-end gap-2">
                    <button
                      disabled={mergeBusy}
                      onClick={() => {
                        setShowMergePicker(false);
                        setMergeTargetId('');
                        setMergeError(null);
                      }}
                      className="px-3 py-1.5 text-xs font-medium text-ink/65 hover:text-ink"
                    >
                      Cancel
                    </button>
                    <button
                      disabled={!mergeTargetId || mergeBusy}
                      onClick={() => {
                        if (!mergeTargetId) return;
                        if (selectedPrior)
                          void runLinkPriorTo(selectedPrior.bookId, selectedPrior.id);
                        else void runMergeTo(mergeTargetId);
                      }}
                      className={`px-3 py-1.5 rounded-full text-xs font-semibold ${
                        mergeBusy
                          ? 'bg-magenta/20 text-magenta cursor-wait'
                          : 'bg-magenta text-white hover:bg-magenta/90 disabled:bg-ink/20 disabled:text-ink/50 disabled:cursor-not-allowed'
                      }`}
                    >
                      {mergeBusy
                        ? selectedPrior
                          ? 'Linking…'
                          : 'Merging…'
                        : selectedPrior
                          ? 'Link'
                          : 'Merge'}
                    </button>
                  </div>
                </div>
              );
            })()}

            {/* Downgrade affordance — fold a descriptor-named or otherwise
                minor character into the standing background bucket so the
                cast roster doesn't have to carry its own voice slot. Works
                even when no other characters exist in the cast (server
                synthesises the bucket on the fly). Hidden for the narrator
                and for buckets themselves. */}
            {onMerge && !isBucket && !isNarrator && (
              <div className="mt-3">
                <p className="text-xs text-ink/55 mb-1.5">Downgrade to a background voice</p>
                <div className="grid grid-cols-2 gap-2">
                  <button
                    aria-label="Downgrade to Unknown male"
                    disabled={mergeBusy}
                    onClick={() => void runMergeTo(UNKNOWN_MALE_ID)}
                    className="px-3 py-2 rounded-xl border border-ink/15 hover:border-ink/30 hover:bg-ink/4 text-xs font-medium text-ink/70 disabled:opacity-50 disabled:cursor-wait"
                  >
                    Unknown male
                  </button>
                  <button
                    aria-label="Downgrade to Unknown female"
                    disabled={mergeBusy}
                    onClick={() => void runMergeTo(UNKNOWN_FEMALE_ID)}
                    className="px-3 py-2 rounded-xl border border-ink/15 hover:border-ink/30 hover:bg-ink/4 text-xs font-medium text-ink/70 disabled:opacity-50 disabled:cursor-wait"
                  >
                    Unknown female
                  </button>
                </div>
                <p className="mt-2 text-[11px] text-ink/50 leading-relaxed">
                  Folds {character.name.split(' ')[0]} into the matching background bucket — every
                  line they speak shares one generic voice with other one-off bystanders.
                </p>
                {mergeError && !showMergePicker && (
                  <p className="mt-2 text-[11px] text-red-600/90 font-medium">⚠ {mergeError}</p>
                )}
              </div>
            )}
          </section>

          <section>
            <p className="text-[11px] uppercase tracking-wider text-ink/50 font-semibold mb-4">
              Tone profile
            </p>
            <div className="space-y-5">
              <ToneSlider
                label="Warmth"
                value={tone.warmth ?? 50}
                onChange={(v) => setTone({ ...tone, warmth: v })}
                leftLabel="Cool"
                rightLabel="Warm"
              />
              <ToneSlider
                label="Pace"
                value={tone.pace ?? 50}
                onChange={(v) => setTone({ ...tone, pace: v })}
                leftLabel="Slow"
                rightLabel="Brisk"
              />
              <ToneSlider
                label="Authority"
                value={tone.authority ?? 50}
                onChange={(v) => setTone({ ...tone, authority: v })}
                leftLabel="Soft"
                rightLabel="Commanding"
              />
              <ToneSlider
                label="Emotion"
                value={tone.emotion ?? 50}
                onChange={(v) => setTone({ ...tone, emotion: v })}
                leftLabel="Restrained"
                rightLabel="Expressive"
              />
            </div>
          </section>
        </div>

        <div className="sticky bottom-0 bg-white border-t border-ink/10 px-6 py-4 flex items-center gap-3">
          <button
            onClick={onClose}
            className="px-4 py-2 text-sm font-medium text-ink/70 hover:text-ink"
          >
            Discard
          </button>
          <PrimaryButton
            variant="dark"
            onClick={() => {
              /* Per-character engine (plan 108): 'default' clears the
                 field (use the project default); a real engine pins it. */
              const nextEngine = engineChoice === 'default' ? undefined : engineChoice;
              const personaTrimmed = persona.trim();
              const next: Character = {
                ...character,
                tone,
                gender: gender || undefined,
                ageRange: ageRange || undefined,
                voiceState: 'tuned',
                ttsEngine: nextEngine ?? null,
                voiceStyle: personaTrimmed || character.voiceStyle,
              };
              /* When Qwen is selected with a designed voice, pin it into
                 the character's per-engine override map so the cast view +
                 synth resolve it. The series-scoped write below propagates
                 it to disk across the series. */
              const qwenVoiceId =
                engineChoice === 'qwen' ? (designedVoiceId ?? undefined) : undefined;
              if (engineChoice === 'qwen' && qwenVoiceId) {
                next.overrideTtsVoices = {
                  ...(character.overrideTtsVoices ?? {}),
                  /* Preserve the existing qwen slot (esp. designed emotion
                     `variants`, fs-25/fs-34) when re-pinning the base name —
                     a bare `{ name: qwenVoiceId }` dropped variants, and the
                     onSave → setCharacters persist then erased them from
                     cast.json (the server-written variant clobbered on Save). */
                  qwen: { ...(character.overrideTtsVoices?.qwen ?? {}), name: qwenVoiceId },
                };
              }
              /* Conflict reset: drop the library voiceId + matchedFrom so the
                 cast view falls back to the engine's prebuilt-voice pick. The
                 ttsVoice line in the drawer already previewed what that will
                 sound like for the new identity. Fires on either a gender or
                 an age-bucket mismatch. */
              if (hasConflict) {
                next.voiceId = undefined;
                next.matchedFrom = undefined;
              }
              /* Series-scoped override write — fire-and-forget; the redux
                 character carries the same value so the UI is correct even
                 if the disk write is slow. Only when we actually designed a
                 Qwen voice and have a book to anchor the series. */
              if (engineChoice === 'qwen' && qwenVoiceId && bookId) {
                const voiceIdForApi = voice?.id ?? character.voiceId ?? character.id;
                void api
                  .setVoiceOverride(
                    voiceIdForApi,
                    { engine: 'qwen', name: qwenVoiceId },
                    { scope: 'series', bookId },
                  )
                  .catch(() => {
                    /* The next cast hydrate reconciles a failed write; the
                       drawer-local error surface already covered the design
                       step, so a swallow here keeps Save snappy. */
                  });
              }
              onSave(next, { hadConflict: hasConflict });
            }}
          >
            Save changes
          </PrimaryButton>
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
  return TTS_MODEL_OPTIONS.find((o) => o.id === key)?.label ?? key;
}

/* Button label per phase of the auto-load + synth pipeline. Mirrors the
   inline copy on the Generation view's pill so a user moving between
   surfaces sees consistent terminology. */
function sampleLoadingLabel(status: SampleStatus | 'idle', modelKey: TtsModelKey): string {
  switch (status) {
    case 'evicting':
      return 'Evicting analyzer to free VRAM…';
    case 'loading-tts':
      return 'Loading voice engine (~30s)…';
    case 'synthesizing':
    case 'idle':
    default:
      return `Generating with ${ttsModelLabel(modelKey)}… (5–10s)`;
  }
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
    if (lc === 'male') return 'male';
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
    if (lc === 'child') return 'child';
    if (lc === 'teen') return 'teen';
    if (lc === 'adult') return 'adult';
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

/* Picker that lets the user override the auto-assigned model voice with a
   specific base voice from any engine. Sits inside the Voice profile
   section of the drawer so the swap and the resulting preview live
   next to each other. Persists via PUT /api/voices/:id/override. */
/* Normalise the on-Voice override fields into the picker's expected
   shape. Prefers the new per-engine map; falls back to projecting the
   legacy singular field into a single-slot map so older Voice payloads
   (from a not-yet-rolled-out server) still render correctly. */
function mapOverridesToBaseVoiceMap(
  map: Partial<Record<TtsEngine, { name: string }>> | null,
  legacy: BaseVoice | null,
): Partial<Record<TtsEngine, BaseVoice>> {
  const out: Partial<Record<TtsEngine, BaseVoice>> = {};
  if (map) {
    for (const [engine, slot] of Object.entries(map)) {
      if (slot?.name) {
        out[engine as TtsEngine] = { engine: engine as TtsEngine, name: slot.name };
      }
    }
  }
  if (legacy?.engine && legacy.name && !out[legacy.engine]) {
    out[legacy.engine] = legacy;
  }
  return out;
}

interface OverridePickerProps {
  voiceId: string;
  /** Per-engine override map — what's stored on the Voice and what the
      tabbed picker reads/writes. The picker shows one tab per engine
      present in `baseVoices`, with the current selection coming from
      `currentOverrides[engineTab]`. */
  currentOverrides: Partial<Record<TtsEngine, BaseVoice>>;
  /** Name of the auto-resolved voice — shown as "Auto (currently <X>)" so
      the user can compare what they'd be moving away from. */
  autoVoiceName: string;
  /** Engine of the auto-resolved voice — the synth picker resolves this
      against the active engine when no override is set. */
  autoVoiceEngine: TtsEngine;
  /** TTS engine the project is currently set to. Used to decide which
      engine tab is selected on first render and which tab gets the
      "active" badge so the user knows which engine actually drives
      synthesis right now. */
  activeEngine: TtsEngine;
  baseVoices: BaseVoice[];
  baseVoicesLoaded: boolean;
  error: string | null;
  onChange: (next: BaseVoice | null) => Promise<void> | void;
  /** Sample line each preview button speaks. Hoisted into the parent
      drawer so the textarea + every candidate row read from the same
      source of truth. */
  previewText: string;
  onPreviewTextChange: (next: string) => void;
  /** Collapsed-by-default candidate-preview list. Toggled by the
      "Preview candidate voices" button so the drawer stays tidy on
      first open. */
  previewExpanded: boolean;
  onPreviewExpandedChange: (next: boolean) => void;
  /** Project-active model key forwarded to each preview button. The
      sidecar re-maps to a compatible model when the candidate's engine
      doesn't match. */
  previewModelKey: TtsModelKey;
}
function ModelVoiceOverridePicker({
  voiceId,
  currentOverrides,
  autoVoiceName,
  autoVoiceEngine,
  activeEngine,
  baseVoices,
  baseVoicesLoaded,
  error,
  onChange,
  previewText,
  onPreviewTextChange,
  previewExpanded,
  onPreviewExpandedChange,
  previewModelKey,
}: OverridePickerProps) {
  /* Group base voices by engine. Order tabs deterministically so the UI
     doesn't reshuffle between renders — Coqui first (longest-running),
     Kokoro second (new default), then anything else in insertion order. */
  const byEngine = new Map<TtsEngine, BaseVoice[]>();
  for (const bv of baseVoices) {
    const list = byEngine.get(bv.engine) ?? [];
    list.push(bv);
    byEngine.set(bv.engine, list);
  }
  const tabOrder: TtsEngine[] = ['coqui', 'kokoro', 'piper', 'gemini'];
  const availableEngines = tabOrder.filter((e) => byEngine.has(e));
  /* Pick a sensible default tab: the active engine if its catalog has
     voices, otherwise the first available. */
  const initialTab: TtsEngine = availableEngines.includes(activeEngine)
    ? activeEngine
    : (availableEngines[0] ?? activeEngine);
  const [engineTab, setEngineTab] = useState<TtsEngine>(initialTab);
  /* If the catalog hydrates after first render and the active engine
     becomes available, re-pin the tab to the active engine so the user
     lands on the slot that actually drives current synthesis. */
  useEffect(() => {
    if (availableEngines.includes(activeEngine) && engineTab !== activeEngine) {
      const otherSlots = (Object.keys(currentOverrides) as TtsEngine[]).filter(
        (e) => e !== engineTab,
      );
      /* Don't surprise the user mid-edit — only swap to the active
         engine if no slot is currently selected in the other engines
         (i.e. they haven't actively been working in a different tab). */
      if (otherSlots.length === 0) setEngineTab(activeEngine);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [baseVoicesLoaded]);

  const AUTO = 'auto';
  const currentForTab = currentOverrides[engineTab] ?? null;
  const selectedValue = currentForTab ? `${currentForTab.engine}|${currentForTab.name}` : AUTO;
  const voicesForTab = byEngine.get(engineTab) ?? [];

  return (
    <div className="mt-3 p-3 rounded-2xl bg-canvas border border-ink/10">
      <div className="flex items-center justify-between mb-2">
        <label className="text-[11px] text-ink/60 font-medium" htmlFor={`override-${voiceId}`}>
          Model voice
        </label>
        <span className="text-[10px] text-ink/40">Active engine: {capitalise(activeEngine)}</span>
      </div>
      {availableEngines.length > 1 && (
        <div
          role="tablist"
          aria-label="Override engine"
          className="mb-2 inline-flex rounded-xl border border-ink/10 bg-white/40 p-0.5"
        >
          {availableEngines.map((engine) => {
            const isCurrent = engine === engineTab;
            const slotFilled = !!currentOverrides[engine];
            return (
              <button
                key={engine}
                role="tab"
                aria-selected={isCurrent}
                onClick={() => setEngineTab(engine)}
                className={`px-3 py-1.5 text-[11px] font-medium rounded-lg transition-colors inline-flex items-center gap-1.5 ${
                  isCurrent
                    ? 'bg-white text-ink shadow-xs'
                    : 'text-ink/60 hover:text-ink hover:bg-white/60'
                }`}
              >
                <span>{capitalise(engine)}</span>
                {slotFilled && (
                  <span className="w-1.5 h-1.5 rounded-full bg-magenta" aria-hidden="true" />
                )}
                {engine === activeEngine && (
                  <span className="text-[9px] uppercase tracking-wider text-ink/40">Active</span>
                )}
              </button>
            );
          })}
        </div>
      )}
      <VoiceOverridePicker
        voiceId={voiceId}
        engineTab={engineTab}
        autoVoiceEngine={autoVoiceEngine}
        autoVoiceName={autoVoiceName}
        voicesForTab={voicesForTab}
        selectedValue={selectedValue}
        baseVoicesLoaded={baseVoicesLoaded}
        onChange={(next) => void onChange(next)}
      />
      {error && <p className="mt-2 text-[11px] text-red-600/90 font-medium">⚠ {error}</p>}
      <p className="mt-2 text-[11px] text-ink/50">
        Each engine has its own voice slot — switching the project's engine picks up the
        corresponding slot, so you don't need to re-cast when toggling Coqui ↔ Kokoro.
      </p>
      {/* Candidate-preview affordance — lets the user audition each base
          voice in the current engine's catalog against a custom sample
          line WITHOUT committing the assignment. Pairs with plan 60. */}
      <div className="mt-3 pt-3 border-t border-ink/10">
        <button
          type="button"
          onClick={() => onPreviewExpandedChange(!previewExpanded)}
          aria-expanded={previewExpanded}
          data-testid="voice-preview-toggle"
          className="text-[11px] font-medium text-ink/70 hover:text-ink underline-offset-4 hover:underline"
        >
          {previewExpanded
            ? '− Hide candidate previews'
            : `+ Preview ${capitalise(engineTab)} candidates`}
        </button>
        {previewExpanded && (
          <div className="mt-3 space-y-3">
            <label className="block">
              <span className="block text-[11px] text-ink/60 font-medium mb-1">Sample line</span>
              <textarea
                aria-label="Voice preview sample text"
                data-testid="voice-preview-sample-text"
                value={previewText}
                onChange={(e) => onPreviewTextChange(e.target.value)}
                rows={2}
                className="w-full px-3 py-2 rounded-xl border border-ink/15 bg-white text-sm text-ink focus:outline-hidden focus:ring-2 focus:ring-magenta/30 resize-y"
              />
              <span className="block text-[10px] text-ink/40 mt-1">
                Saved across drawer opens. Edit once, audition many.
              </span>
            </label>
            {voicesForTab.length === 0 ? (
              <p className="text-[11px] text-ink/50">
                No {capitalise(engineTab)} voices in the catalog yet.
              </p>
            ) : (
              <ul
                aria-label={`${capitalise(engineTab)} candidate voices`}
                data-testid="voice-preview-candidates"
                className="space-y-1.5 max-h-64 overflow-y-auto scrollbar-thin pr-1"
                style={{ ['--scrollbar-thin-radius' as string]: '0px' } as React.CSSProperties}
              >
                {voicesForTab.map((bv) => {
                  const key = `${bv.engine}|${bv.name}`;
                  const isCurrent = currentForTab?.name === bv.name;
                  return (
                    <li
                      key={key}
                      data-testid={`voice-preview-row-${bv.name}`}
                      className={`flex items-center justify-between gap-3 px-2.5 py-1.5 rounded-xl ${
                        isCurrent
                          ? 'bg-magenta/5 border border-magenta/30'
                          : 'border border-transparent'
                      }`}
                    >
                      <span className="text-xs text-ink/75 truncate">
                        {bv.name}
                        {isCurrent && (
                          <span className="ml-2 text-[10px] uppercase tracking-wider text-magenta">
                            Selected
                          </span>
                        )}
                      </span>
                      <VoicePreviewButton
                        voice={bv}
                        modelKey={previewModelKey}
                        text={previewText}
                        testId={`voice-preview-play-${bv.name}`}
                      />
                    </li>
                  );
                })}
              </ul>
            )}
            <p className="text-[10px] text-ink/40 leading-relaxed">
              Previews are read-only. The selection above only changes when you pick from the
              dropdown — auditioning a row does NOT commit the assignment.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}

interface ToneSliderProps {
  label: string;
  value: number;
  onChange: (v: number) => void;
  leftLabel: string;
  rightLabel: string;
}
export function ToneSlider({ label, value, onChange, leftLabel, rightLabel }: ToneSliderProps) {
  return (
    <div>
      <div className="flex items-center justify-between mb-2">
        <span className="text-sm font-medium text-ink">{label}</span>
        <span className="text-xs text-ink/50 tabular-nums">{value}</span>
      </div>
      <div className="relative h-1.5 rounded-full bg-ink/10">
        <div
          className="absolute left-0 top-0 bottom-0 rounded-full bg-gradient-cta-horizontal"
          style={{ width: `${value}%` }}
        />
        <input
          type="range"
          min={0}
          max={100}
          value={value}
          onChange={(e) => onChange(Number(e.target.value))}
          className="absolute inset-0 w-full opacity-0 cursor-pointer"
        />
        <span
          className="absolute top-1/2 -translate-y-1/2 -translate-x-1/2 w-4 h-4 rounded-full bg-white border border-ink/30 shadow-sm pointer-events-none"
          style={{ left: `${value}%` }}
        />
      </div>
      <div className="flex items-center justify-between mt-1.5 text-[11px] text-ink/40">
        <span>{leftLabel}</span>
        <span>{rightLabel}</span>
      </div>
    </div>
  );
}
