/* "Rebaseline the series" modal (plan 108, Wave 5 — the FINAL wave).

   Moves the principal cast onto bespoke Qwen voices across the whole
   series in one pass. This modal ORCHESTRATES capabilities already on
   main — it does not reimplement them:

   - `selectPrincipalCast` (src/lib/principal-cast.ts) → the default
     selection (~80% of non-narrator lines; narrator excluded).
   - `api.generateVoiceStyle` / `api.generateAllVoiceStyles` → the Gemini
     persona generator (Character.voiceStyle).
   - `api.designQwenVoice` → designs + caches a bespoke Qwen voice from a
     persona and returns an audition preview blob + a derived voiceId.
   - `api.setVoiceOverride(…, { scope:'series', bookId })` → writes the
     per-character Qwen override across the SERIES.
   - `playSampleWithAutoLoad` / `useSamplePlayback` → audition of the
     CURRENT voice; the PROPOSED voice plays the design preview blob.

   Per-character voice/engine changes surface as DRIFT automatically (the
   R5 detector compares resolved voice name + engine on the next revisions
   poll) — this modal never fabricates drift entries.

   Three steps: setup (toggle characters) → propose (design per character,
   current-vs-proposed rows) → approve (series-scoped write). */

import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  IconClose,
  IconSparkle,
  IconRefresh,
  IconPlay,
  IconPause,
  IconSpinner,
  IconCheck,
  IconAlertTri,
} from '../lib/icons';
import { Avatar } from '../components/primitives';
import { api } from '../lib/api';
import { useAppDispatch, useAppSelector } from '../store';
import { uiActions } from '../store/ui-slice';
import { castActions } from '../store/cast-slice';
import { notificationsActions } from '../store/notifications-slice';
import { rebaselineActions, includedProposals, type Proposal } from '../store/rebaseline-slice';
import { selectPrincipalCast } from '../lib/principal-cast';
import { findVoiceForCharacter } from '../lib/voice-character-link';
import { useSamplePlayback } from '../lib/use-sample-playback';
import { playSampleWithAutoLoad } from '../lib/play-sample-with-auto-load';
import { buildCharacterHint } from '../lib/build-character-hint';
import type { Character, CharColor, Voice } from '../lib/types';

const NARRATOR_IDS = new Set(['narrator', 'char-narrator']);
function isNarrator(c: Character): boolean {
  if (NARRATOR_IDS.has(c.id.toLowerCase())) return true;
  return (c.name ?? '').toLowerCase() === 'narrator';
}

/* Wires the modal to the store. Mounted in the Voices view; renders nothing
   when the modal is closed OR there is no book to anchor the series write
   (the global #/voices tab without a loaded book). */
export function RebaselineModalContainer({
  bookId,
}: {
  bookId: string | null;
}): JSX.Element | null {
  const open = useAppSelector((s) => s.ui.rebaselineModalOpen);
  if (!open || !bookId) return null;
  return <RebaselineModal bookId={bookId} />;
}

function RebaselineModal({ bookId }: { bookId: string }): JSX.Element {
  const dispatch = useAppDispatch();
  const reduxCharacters = useAppSelector((s) => s.cast.characters);
  /* The open book (redux cast is its cast). When the modal targets the open
     book we use redux directly; for a foreign book (the per-series global-
     view buttons), we fetch that book's cast on open. */
  const currentBookId = useAppSelector((s) =>
    s.ui.stage.kind === 'ready' ? s.ui.stage.bookId : null,
  );
  const voices = useAppSelector((s) => s.voices.voices);
  const ttsModelKey = useAppSelector((s) => s.ui.ttsModelKey);
  const status = useAppSelector((s) => s.rebaseline.status);
  const selectedCharacterIds = useAppSelector((s) => s.rebaseline.selectedCharacterIds);
  const proposals = useAppSelector((s) => s.rebaseline.proposals);
  const appliedCount = useAppSelector((s) => s.rebaseline.appliedCount);
  const playback = useSamplePlayback();

  const targetIsOpenBook = bookId === currentBookId;

  /* Foreign-book cast (fetched when the modal targets a book other than the
     open one). null while loading / before the fetch resolves; the open-book
     path leaves it null and reads redux instead.

     v1 uses the representative book's cast — its principal cast covers the
     recurring characters, and the series-scoped override write propagates by
     voiceId across the whole series. Full cross-series cast aggregation (a
     union of every book's cast) is a follow-up. */
  const [foreignCharacters, setForeignCharacters] = useState<Character[] | null>(null);
  const [foreignError, setForeignError] = useState<string | null>(null);

  useEffect(() => {
    if (targetIsOpenBook) return;
    let cancelled = false;
    setForeignCharacters(null);
    setForeignError(null);
    api
      .getBookState(bookId)
      .then((res) => {
        if (cancelled) return;
        setForeignCharacters(res?.cast?.characters ?? []);
      })
      .catch((err) => {
        if (cancelled) return;
        console.error('[rebaseline] target cast fetch failed', err);
        setForeignError('Could not load that series’ cast — try again.');
        setForeignCharacters([]);
      });
    return () => {
      cancelled = true;
    };
  }, [bookId, targetIsOpenBook]);

  /* The cast the modal works from: redux for the open book, the fetched
     cast otherwise. Empty array while a foreign fetch is in flight. Memoised
     so the ternary doesn't hand a fresh array to downstream useMemos every
     render. */
  const characters = useMemo(
    () => (targetIsOpenBook ? reduxCharacters : (foreignCharacters ?? [])),
    [targetIsOpenBook, reduxCharacters, foreignCharacters],
  );
  const loadingCast = !targetIsOpenBook && foreignCharacters === null;

  /* Guards the propose / approve loops against a second click + a close
     mid-flight (so a dispatch doesn't fire against a reset slice). */
  const runningRef = useRef(false);

  /* Per-character line counts → the principal-cast default selection. */
  const lineCountById = useMemo(() => {
    const map: Record<string, number> = {};
    for (const c of characters) map[c.id] = c.lines ?? 0;
    return map;
  }, [characters]);

  /* Seed the default selection (principal cast) once the resolved cast is in
     hand. For the open book that's on mount; for a foreign book it's once the
     fetch lands (guarded so a transient empty cast during the fetch doesn't
     seed an empty selection). `begin` resets any prior run. */
  const seededRef = useRef(false);
  useEffect(() => {
    if (seededRef.current) return;
    if (loadingCast) return;
    seededRef.current = true;
    const principal = selectPrincipalCast(
      characters.map((c) => ({ id: c.id, name: c.name })),
      lineCountById,
    );
    dispatch(rebaselineActions.begin({ bookId, selectedCharacterIds: Array.from(principal) }));
    // Deps intentionally narrow: seed exactly once per modal open, after the
    // cast resolves. A later cast re-hydrate must not blow away user toggles.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loadingCast]);

  function close() {
    if (playback.isPlaying) playback.stop();
    dispatch(uiActions.closeRebaselineModal());
    dispatch(rebaselineActions.reset());
  }

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') close();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const charById = useMemo(() => {
    const map = new Map<string, Character>();
    for (const c of characters) map.set(c.id, c);
    return map;
  }, [characters]);

  /* Design one character's bespoke voice: generate a persona if we don't
     have one, then design + cache the Qwen voice. Tolerates failure. */
  async function designOne(characterId: string, seedPersona: string): Promise<void> {
    dispatch(rebaselineActions.proposalDesigning({ characterId }));
    try {
      let persona = seedPersona.trim();
      if (!persona) {
        const res = await api.generateVoiceStyle(bookId, characterId);
        persona = res.voiceStyle;
        dispatch(castActions.setVoiceStyle({ characterId, voiceStyle: persona }));
      }
      const { voiceId, previewUrl } = await api.designQwenVoice(bookId, characterId, persona);
      dispatch(
        rebaselineActions.proposalReady({
          characterId,
          persona,
          proposedVoiceId: voiceId,
          previewUrl,
        }),
      );
    } catch (e) {
      dispatch(
        rebaselineActions.proposalFailed({
          characterId,
          error: (e as Error).message || 'Voice design failed.',
        }),
      );
    }
  }

  /* Propose step — batch-generate personas (one call up front so the
     network cadence is gated server-side), then design each selected
     character's voice sequentially. Per-character failures don't abort. */
  async function runPropose() {
    if (runningRef.current) return;
    runningRef.current = true;
    /* Pre-seed personas: characters with an existing voiceStyle seed the
       textarea; the batch generator fills the rest. We fire the batch but
       tolerate it failing (mock returns an empty map; designOne then
       falls back to the per-character generate). */
    const seeds: Record<string, string> = {};
    for (const id of selectedCharacterIds) {
      const c = charById.get(id);
      if (c?.voiceStyle) seeds[id] = c.voiceStyle;
    }
    try {
      const batch = await api.generateAllVoiceStyles(bookId);
      for (const [id, persona] of Object.entries(batch.voiceStyles)) {
        if (selectedCharacterIds.includes(id)) {
          seeds[id] = persona;
          dispatch(castActions.setVoiceStyle({ characterId: id, voiceStyle: persona }));
        }
      }
    } catch {
      /* Batch is best-effort; designOne falls back to the per-character
         generate when a seed is missing. */
    }
    dispatch(rebaselineActions.startProposing({ personaSeeds: seeds }));
    for (const id of selectedCharacterIds) {
      await designOne(id, seeds[id] ?? '');
    }
    dispatch(rebaselineActions.proposingSettled());
    runningRef.current = false;
  }

  /* Regenerate one row's persona + re-design (the ↻ button). */
  async function regenerateOne(characterId: string) {
    if (runningRef.current) return;
    dispatch(rebaselineActions.proposalDesigning({ characterId }));
    try {
      const res = await api.generateVoiceStyle(bookId, characterId);
      const persona = res.voiceStyle;
      dispatch(castActions.setVoiceStyle({ characterId, voiceStyle: persona }));
      const { voiceId, previewUrl } = await api.designQwenVoice(bookId, characterId, persona);
      dispatch(
        rebaselineActions.proposalReady({
          characterId,
          persona,
          proposedVoiceId: voiceId,
          previewUrl,
        }),
      );
    } catch (e) {
      dispatch(
        rebaselineActions.proposalFailed({
          characterId,
          error: (e as Error).message || 'Regenerate failed.',
        }),
      );
    }
  }

  /* Re-design one row off its (possibly edited) persona without a new
     persona generation — used after the user tweaks the textarea. */
  async function redesignOne(characterId: string, persona: string) {
    const trimmed = persona.trim();
    if (!trimmed) return;
    dispatch(rebaselineActions.proposalDesigning({ characterId }));
    try {
      const { voiceId, previewUrl } = await api.designQwenVoice(bookId, characterId, trimmed);
      dispatch(
        rebaselineActions.proposalReady({
          characterId,
          persona: trimmed,
          proposedVoiceId: voiceId,
          previewUrl,
        }),
      );
    } catch (e) {
      dispatch(
        rebaselineActions.proposalFailed({
          characterId,
          error: (e as Error).message || 'Voice design failed.',
        }),
      );
    }
  }

  /* Approve step — for each INCLUDED proposal, write the series-scoped Qwen
     override + persist ttsEngine:'qwen' + voiceStyle on the character. The
     drift detector flags affected chapters on the next poll. */
  async function runApprove() {
    if (runningRef.current) return;
    runningRef.current = true;
    const included = includedProposals({
      status,
      bookId,
      selectedCharacterIds,
      proposals,
      appliedCount,
    });
    dispatch(rebaselineActions.startApproving());
    let applied = 0;
    for (const p of included) {
      const character = charById.get(p.characterId);
      if (!character || !p.proposedVoiceId) continue;
      /* The voice override is keyed by the character's library voiceId
         (mirrors the profile drawer); fall back to the character id. */
      const matched = findVoiceForCharacter(character, voices);
      const voiceIdForApi = matched?.id ?? character.voiceId ?? character.id;
      try {
        await api.setVoiceOverride(
          voiceIdForApi,
          { engine: 'qwen', name: p.proposedVoiceId },
          { scope: 'series', bookId },
        );
        /* Mirror the engine + persona + override into redux so the cast
           view is correct without a full re-hydrate. */
        const next: Character = {
          ...character,
          ttsEngine: 'qwen',
          voiceStyle: p.persona,
          overrideTtsVoices: {
            ...(character.overrideTtsVoices ?? {}),
            qwen: { name: p.proposedVoiceId },
          },
        };
        dispatch(castActions.updateCharacter(next));
        dispatch(rebaselineActions.proposalApplied({ characterId: p.characterId }));
        applied += 1;
      } catch {
        /* A failed series write leaves the row un-applied; the next cast
           hydrate reconciles. We don't abort the rest of the batch. */
      }
    }
    dispatch(rebaselineActions.approveDone({ appliedCount: applied }));
    dispatch(
      notificationsActions.pushToast({
        kind: 'info',
        message:
          applied > 0
            ? `Rebaselined ${applied} character${applied === 1 ? '' : 's'} across the series — drift will flag affected chapters to regenerate.`
            : 'No characters were rebaselined.',
        dedupeKey: `rebaseline-done:${bookId}`,
      }),
    );
    runningRef.current = false;
  }

  /* Audition the CURRENT voice for a character (existing sample path). */
  async function playCurrent(character: Character) {
    const matched = findVoiceForCharacter(character, voices);
    const voiceId = matched?.id ?? `char-${character.id}`;
    const subject: Voice =
      matched ??
      ({
        id: voiceId,
        character: character.name,
        bookId,
        bookTitle: '',
        attributes: character.attributes ?? [],
        usedIn: 0,
        source: 'current',
      } as Voice);
    try {
      await playSampleWithAutoLoad({
        args: {
          voiceId,
          voice: subject,
          modelKey: ttsModelKey,
          characterHint: buildCharacterHint(character),
        },
        playback,
      });
    } catch {
      /* The row surfaces nothing extra on a current-voice play failure —
         it's an audition, not a gating step. */
    }
  }

  /* Audition the PROPOSED voice — plays the design preview blob. */
  async function playProposed(previewUrl: string) {
    if (playback.isPlaying && playback.currentUrl === previewUrl) {
      playback.stop();
      return;
    }
    try {
      await playback.play(previewUrl);
    } catch {
      /* no-op */
    }
  }

  const orderedSelected = useMemo(
    () =>
      characters
        .filter((c) => selectedCharacterIds.includes(c.id))
        .sort((a, b) => (b.lines ?? 0) - (a.lines ?? 0)),
    [characters, selectedCharacterIds],
  );

  const proposalList = useMemo(
    () => Object.values(proposals).sort((a, b) => a.characterId.localeCompare(b.characterId)),
    [proposals],
  );

  const includedCount = includedProposals({
    status,
    bookId,
    selectedCharacterIds,
    proposals,
    appliedCount,
  }).length;

  const proposeBusy = status === 'proposing';
  const approveBusy = status === 'approving';

  return createPortal(
    <>
      <div
        onClick={close}
        className="fixed inset-0 bg-ink/40 z-50 fade-in"
        data-testid="rebaseline-overlay"
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Rebaseline the series"
        className="fixed inset-0 z-50 grid place-items-center p-0 sm:p-6 pointer-events-none"
      >
        <div className="bg-white w-full h-full sm:h-auto sm:rounded-3xl shadow-float sm:max-w-2xl pointer-events-auto fade-in overflow-hidden sm:max-h-[90vh] flex flex-col">
          <header className="px-6 py-4 border-b border-ink/10 flex items-center gap-3">
            <span className="w-10 h-10 rounded-full bg-magenta/10 grid place-items-center text-magenta shrink-0">
              <IconSparkle className="w-5 h-5" />
            </span>
            <div className="flex-1 min-w-0">
              <p className="text-[10px] uppercase tracking-widest text-ink/50 font-semibold">
                Rebaseline the series
              </p>
              <h3 className="text-base font-bold text-ink leading-tight">
                Move the principal cast onto bespoke Qwen voices
              </h3>
            </div>
            <button
              onClick={close}
              aria-label="Close"
              className="p-2 rounded-full hover:bg-ink/5 text-ink/60 min-h-[44px] min-w-[44px] sm:min-h-0 sm:min-w-0 grid place-items-center"
            >
              <IconClose className="w-4 h-4" />
            </button>
          </header>

          <div className="p-6 overflow-y-auto scrollbar-thin flex-1">
            {loadingCast ? (
              <div
                className="grid place-items-center py-16 text-center"
                data-testid="rebaseline-loading"
              >
                <IconSpinner className="w-6 h-6 text-magenta mb-3" />
                <p className="text-sm text-ink/60">Loading the series’ cast…</p>
              </div>
            ) : foreignError ? (
              <p className="text-sm text-red-600 py-8 text-center" role="alert">
                {foreignError}
              </p>
            ) : status === 'setup' ? (
              <SetupStep
                candidates={characters.filter((c) => !isNarrator(c))}
                narrator={characters.find(isNarrator) ?? null}
                selectedIds={selectedCharacterIds}
                lineCountById={lineCountById}
                onToggle={(id) => dispatch(rebaselineActions.toggleSelected(id))}
              />
            ) : (
              <ProposeStep
                proposals={proposalList}
                charById={charById}
                voices={voices}
                playbackUrl={playback.currentUrl}
                playbackPlaying={playback.isPlaying}
                onPlayCurrent={playCurrent}
                onPlayProposed={playProposed}
                onPersonaChange={(characterId, persona) =>
                  dispatch(rebaselineActions.setProposalPersona({ characterId, persona }))
                }
                onRegenerate={regenerateOne}
                onRedesign={redesignOne}
                onToggleInclude={(characterId) =>
                  dispatch(rebaselineActions.toggleProposalInclude({ characterId }))
                }
                done={status === 'done'}
              />
            )}
          </div>

          <footer className="px-6 py-4 border-t border-ink/10 flex items-center gap-3 flex-wrap">
            {status === 'setup' && (
              <>
                <span className="text-xs text-ink/55">
                  {selectedCharacterIds.length} character
                  {selectedCharacterIds.length === 1 ? '' : 's'} selected
                </span>
                <button
                  onClick={() => void runPropose()}
                  disabled={orderedSelected.length === 0}
                  data-testid="rebaseline-propose"
                  className="ml-auto inline-flex items-center gap-2 px-4 py-2 rounded-full bg-ink text-canvas text-sm font-semibold hover:bg-ink-soft disabled:opacity-40 disabled:cursor-not-allowed min-h-[44px] sm:min-h-0"
                >
                  <IconSparkle className="w-4 h-4" /> Propose voices
                </button>
              </>
            )}
            {(status === 'proposing' || status === 'proposed') && (
              <>
                <span className="text-xs text-ink/55">
                  {proposeBusy
                    ? 'Designing voices…'
                    : `${includedCount} of ${proposalList.length} included`}
                </span>
                <button
                  onClick={close}
                  className="ml-auto px-4 py-2 rounded-full border border-ink/10 bg-white text-sm font-medium text-ink/70 hover:text-ink min-h-[44px] sm:min-h-0"
                >
                  Cancel
                </button>
                <button
                  onClick={() => void runApprove()}
                  disabled={proposeBusy || includedCount === 0}
                  data-testid="rebaseline-approve"
                  className="inline-flex items-center gap-2 px-4 py-2 rounded-full bg-magenta text-white text-sm font-semibold hover:bg-magenta/90 disabled:opacity-40 disabled:cursor-not-allowed min-h-[44px] sm:min-h-0"
                >
                  {approveBusy ? (
                    <IconSpinner className="w-4 h-4" />
                  ) : (
                    <IconCheck className="w-4 h-4" />
                  )}
                  Approve transfer
                </button>
              </>
            )}
            {(status === 'approving' || status === 'done') && (
              <>
                <span className="text-xs text-ink/55">
                  {status === 'approving'
                    ? 'Writing series overrides…'
                    : `Rebaselined ${appliedCount} character${appliedCount === 1 ? '' : 's'}.`}
                </span>
                <button
                  onClick={close}
                  disabled={status === 'approving'}
                  data-testid="rebaseline-done"
                  className="ml-auto px-4 py-2 rounded-full bg-ink text-canvas text-sm font-semibold hover:bg-ink-soft disabled:opacity-40 min-h-[44px] sm:min-h-0"
                >
                  Done
                </button>
              </>
            )}
          </footer>
        </div>
      </div>
    </>,
    document.body,
  );
}

function SetupStep({
  candidates,
  narrator,
  selectedIds,
  lineCountById,
  onToggle,
}: {
  candidates: Character[];
  narrator: Character | null;
  selectedIds: string[];
  lineCountById: Record<string, number>;
  onToggle: (id: string) => void;
}): JSX.Element {
  const sorted = [...candidates].sort(
    (a, b) => (lineCountById[b.id] ?? 0) - (lineCountById[a.id] ?? 0),
  );
  return (
    <div className="space-y-4">
      <p className="text-sm text-ink/70 leading-relaxed">
        The principal cast (the speaking characters who carry ~80% of the dialogue) is pre-selected.
        Each selected character gets a bespoke Qwen voice designed from a persona. The narrator
        stays on its Kokoro preset by default.
      </p>
      <ul className="space-y-2">
        {sorted.map((c) => (
          <CharacterToggleRow
            key={c.id}
            character={c}
            lines={lineCountById[c.id] ?? 0}
            checked={selectedIds.includes(c.id)}
            onToggle={() => onToggle(c.id)}
          />
        ))}
        {narrator && (
          <CharacterToggleRow
            key={narrator.id}
            character={narrator}
            lines={lineCountById[narrator.id] ?? 0}
            checked={selectedIds.includes(narrator.id)}
            onToggle={() => onToggle(narrator.id)}
            isNarrator
          />
        )}
      </ul>
    </div>
  );
}

function CharacterToggleRow({
  character,
  lines,
  checked,
  onToggle,
  isNarrator: narratorRow,
}: {
  character: Character;
  lines: number;
  checked: boolean;
  onToggle: () => void;
  isNarrator?: boolean;
}): JSX.Element {
  return (
    <li>
      <label
        className="flex items-center gap-3 p-3 rounded-2xl border border-ink/10 bg-white hover:bg-ink/[0.02] cursor-pointer min-h-[44px]"
        data-testid={`rebaseline-row-${character.id}`}
      >
        <input
          type="checkbox"
          checked={checked}
          onChange={onToggle}
          aria-label={`Rebaseline ${character.name}`}
          className="w-5 h-5 accent-magenta shrink-0"
        />
        <Avatar name={character.name} color={character.color as CharColor} size={32} />
        <div className="flex-1 min-w-0">
          <p className="text-sm font-bold text-ink truncate">
            {character.name}
            {narratorRow && (
              <span className="ml-2 text-[10px] uppercase tracking-wider text-ink/40 font-semibold">
                Narrator
              </span>
            )}
          </p>
          <p className="text-xs text-ink/50 truncate">{character.role}</p>
        </div>
        <span className="text-xs text-ink/50 tabular-nums shrink-0">
          {lines} line{lines === 1 ? '' : 's'}
        </span>
      </label>
    </li>
  );
}

function ProposeStep({
  proposals,
  charById,
  voices,
  playbackUrl,
  playbackPlaying,
  onPlayCurrent,
  onPlayProposed,
  onPersonaChange,
  onRegenerate,
  onRedesign,
  onToggleInclude,
  done,
}: {
  proposals: Proposal[];
  charById: Map<string, Character>;
  voices: Voice[];
  playbackUrl: string | null;
  playbackPlaying: boolean;
  onPlayCurrent: (c: Character) => void;
  onPlayProposed: (previewUrl: string) => void;
  onPersonaChange: (characterId: string, persona: string) => void;
  onRegenerate: (characterId: string) => void;
  onRedesign: (characterId: string, persona: string) => void;
  onToggleInclude: (characterId: string) => void;
  done: boolean;
}): JSX.Element {
  return (
    <div className="space-y-3">
      <p className="text-sm text-ink/70 leading-relaxed">
        Review each character's current voice against the proposed bespoke Qwen voice. Edit a
        persona and regenerate, or untick a row to leave it unchanged. Approving writes the new
        voices across the series — drift will flag the affected chapters.
      </p>
      {proposals.map((p) => {
        const character = charById.get(p.characterId);
        if (!character) return null;
        const matched = findVoiceForCharacter(character, voices);
        const currentVoiceName = matched?.ttsVoice?.name ?? 'Current voice';
        const proposedPlaying = playbackPlaying && !!p.previewUrl && playbackUrl === p.previewUrl;
        return (
          <article
            key={p.characterId}
            data-testid={`rebaseline-proposal-${p.characterId}`}
            className={`p-4 rounded-2xl border bg-white ${
              p.status === 'failed' ? 'border-red-300' : 'border-ink/10'
            }`}
          >
            <div className="flex items-start gap-3">
              {!done && p.status !== 'failed' && (
                <input
                  type="checkbox"
                  checked={p.include}
                  onChange={() => onToggleInclude(p.characterId)}
                  aria-label={`Include ${character.name}`}
                  data-testid={`rebaseline-include-${p.characterId}`}
                  className="mt-1 w-5 h-5 accent-magenta shrink-0"
                />
              )}
              <Avatar name={character.name} color={character.color as CharColor} size={36} />
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap mb-2">
                  <h4 className="text-sm font-bold text-ink">{character.name}</h4>
                  {p.status === 'designing' && (
                    <span className="inline-flex items-center gap-1 text-[11px] text-magenta">
                      <IconSpinner className="w-3 h-3" /> Designing…
                    </span>
                  )}
                  {p.status === 'ready' && (
                    <span className="inline-flex items-center gap-1 text-[11px] text-emerald-700">
                      <IconCheck className="w-3 h-3" /> Ready
                    </span>
                  )}
                  {p.status === 'applied' && (
                    <span className="inline-flex items-center gap-1 text-[11px] text-emerald-700 font-semibold">
                      <IconCheck className="w-3 h-3" /> Applied
                    </span>
                  )}
                  {p.status === 'failed' && (
                    <span className="inline-flex items-center gap-1 text-[11px] text-red-600">
                      <IconAlertTri className="w-3 h-3" /> Failed
                    </span>
                  )}
                </div>

                {/* current vs proposed, side-by-side per row */}
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div className="rounded-xl border border-ink/10 bg-canvas/50 p-3">
                    <p className="text-[10px] uppercase tracking-wider font-semibold text-ink/45 mb-1">
                      Current voice
                    </p>
                    <p className="text-xs text-ink/70 truncate" title={currentVoiceName}>
                      {currentVoiceName}
                    </p>
                    <button
                      type="button"
                      onClick={() => onPlayCurrent(character)}
                      data-testid={`rebaseline-play-current-${p.characterId}`}
                      className="mt-2 inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-ink/[0.06] text-ink/70 hover:text-ink text-[11px] font-medium min-h-[32px]"
                    >
                      <IconPlay className="w-3 h-3" /> Audition
                    </button>
                  </div>
                  <div className="rounded-xl border border-magenta/20 bg-magenta/[0.04] p-3">
                    <p className="text-[10px] uppercase tracking-wider font-semibold text-magenta/70 mb-1">
                      Proposed (Qwen)
                    </p>
                    <p className="text-xs text-ink/70 truncate" title={p.proposedVoiceId ?? ''}>
                      {p.proposedVoiceId ?? '—'}
                    </p>
                    <button
                      type="button"
                      onClick={() => p.previewUrl && onPlayProposed(p.previewUrl)}
                      disabled={!p.previewUrl}
                      data-testid={`rebaseline-play-proposed-${p.characterId}`}
                      className="mt-2 inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-magenta/10 text-magenta hover:bg-magenta/20 text-[11px] font-medium disabled:opacity-40 min-h-[32px]"
                    >
                      {proposedPlaying ? (
                        <IconPause className="w-3 h-3" />
                      ) : (
                        <IconPlay className="w-3 h-3" />
                      )}
                      {proposedPlaying ? 'Stop' : 'Audition'}
                    </button>
                  </div>
                </div>

                {/* editable persona + regenerate */}
                {!done && (
                  <div className="mt-3">
                    <div className="flex items-center justify-between mb-1">
                      <label
                        className="text-[11px] text-ink/60 font-medium"
                        htmlFor={`rebaseline-persona-${p.characterId}`}
                      >
                        Voice persona
                      </label>
                      <div className="flex items-center gap-1.5">
                        <button
                          type="button"
                          onClick={() => onRedesign(p.characterId, p.persona)}
                          disabled={p.status === 'designing' || p.persona.trim().length === 0}
                          data-testid={`rebaseline-redesign-${p.characterId}`}
                          className="inline-flex items-center gap-1 px-2 py-1 rounded-full text-[11px] font-semibold bg-ink/[0.06] text-ink/70 hover:text-ink disabled:opacity-40 disabled:cursor-wait min-h-[32px]"
                        >
                          <IconSparkle className="w-3 h-3" /> Re-design
                        </button>
                        <button
                          type="button"
                          onClick={() => onRegenerate(p.characterId)}
                          disabled={p.status === 'designing'}
                          data-testid={`rebaseline-regenerate-${p.characterId}`}
                          className="inline-flex items-center gap-1 px-2 py-1 rounded-full text-[11px] font-semibold bg-peach/15 text-magenta hover:bg-peach/25 disabled:opacity-40 disabled:cursor-wait min-h-[32px]"
                        >
                          <IconRefresh className="w-3 h-3" /> Regenerate
                        </button>
                      </div>
                    </div>
                    <textarea
                      id={`rebaseline-persona-${p.characterId}`}
                      aria-label={`Voice persona for ${character.name}`}
                      data-testid={`rebaseline-persona-${p.characterId}`}
                      value={p.persona}
                      onChange={(e) => onPersonaChange(p.characterId, e.target.value)}
                      rows={2}
                      className="w-full px-3 py-2 rounded-xl border border-ink/15 bg-white text-sm text-ink focus:outline-none focus:ring-2 focus:ring-magenta/30 resize-y"
                    />
                  </div>
                )}

                {p.status === 'failed' && p.error && (
                  <p className="mt-2 text-[11px] text-red-600/90" role="alert">
                    ⚠ {p.error}
                  </p>
                )}
              </div>
            </div>
          </article>
        );
      })}
    </div>
  );
}
