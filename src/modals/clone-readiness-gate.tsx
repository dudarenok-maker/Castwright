/* Plan 276 (fs-cast-readiness), Task 7 — the cast-time clone-readiness gate.

   A SEPARATE modal from `voice-readiness-gate.tsx`, deliberately (Decision 5,
   "A new modal, not the existing one"). That modal is welded to the
   undesigned-Qwen concern: its copy promises a "generic fallback voice"
   (false here — a cloned voice hard-fails, it never silently substitutes),
   its primary CTA is "Design full cast" (which would design nobody — these
   characters already HAVE a voice, it just can't resolve on the routed
   engine), and its `onProceedAnyway` dispatches `openStartGenPrompt`,
   reintroducing the tier prompt Decision 5's own gate is independent of
   (`start-generation-flow.ts` gives this check its own entry condition and
   early return, precisely so a Coqui-only cloned cast reaches this gate
   without ever seeing the tier chooser). Branching the other modal would
   have re-imported all three problems; a fresh one does not.

   Decision 1's CTA table is the contract — a gate offering only Proceed and
   Cancel does not implement it and must fail review:

     no-transcript   -> Add transcript    (PATCH master.transcript, Decision 6)
     derive-failed   -> Retry derive      (POST .../engines/:engine/retry, Decision 7)
     wrong-engine    -> Cast on <engine>  (sets character.ttsEngine; only
                                            when castOnEngine is non-null —
                                            Decision 5's per-candidate scan)
     missing-entry   -> Assign a different voice (opens the cast profile drawer)
     revoked,
     missing-master  -> explanatory copy only, no CTA (no in-app repair exists)

   "Proceed anyway" is warn-and-allow (the settled repo-owner decision) but
   must NOT dispatch `openStartGenPrompt` — that is the specific bug
   inherited from voice-readiness-gate.tsx that this file exists to avoid
   repeating. It dispatches `requestStartGeneration` directly, exactly like
   the non-Qwen branch of `startGenerationFlow` does for a plain book. */

import { useState } from 'react';
import { IconClose } from '../lib/icons';
import { PrimaryButton } from '../components/primitives';
import { useAppDispatch, useAppSelector } from '../store';
import { uiActions } from '../store/ui-slice';
import { castActions } from '../store/cast-slice';
import { patchEntry, retryEngine } from '../store/voice-library-slice';
import { selectCloneReadinessVerdicts } from '../store/clone-readiness-selectors';
import { isCloneEngine } from '../../server/src/tts/clone-engines';
import { TranscriptField } from '../components/voices/transcript-field';
import { MAX_CLONE_TRANSCRIPT_CHARS } from '../lib/clone-transcript-limit';
import type { CloneCharacterVerdict } from '../store/clone-readiness-selectors';
import type { Character, TtsEngine } from '../lib/types';

/* Every TtsEngine, not just the two clone-capable ones — `verdict.engine` is
   whichever engine the character is ROUTED to (Decision 4), which can be
   any of the five (a `wrong-engine` verdict is exactly a cloned voice
   routed to a non-clone-capable engine). Mirrors the labels convention
   already used elsewhere (e.g. `src/views/voices.tsx`'s own `ENGINE_LABEL`)
   rather than reusing `engineDisplayName` (`kokoro`/`qwen`/`coqui` only). */
const ENGINE_LABEL: Record<TtsEngine, string> = {
  coqui: 'Coqui',
  gemini: 'Gemini',
  piper: 'Piper',
  kokoro: 'Kokoro',
  qwen: 'Qwen',
};

function reasonCopy(verdict: CloneCharacterVerdict): string {
  const { characterName, reason } = verdict;
  const engineName = ENGINE_LABEL[verdict.engine];
  switch (reason) {
    case 'revoked':
      return `The person who provided ${characterName}'s cloned voice has withdrawn consent, so it can no longer be used.`;
    case 'missing-master':
      return `${characterName}'s cloned voice is missing its original recording, so it can't be re-derived for ${engineName}.`;
    case 'no-transcript':
      return `${characterName}'s cloned voice has no reference transcript, which ${engineName} needs to derive it.`;
    case 'derive-failed':
      return `${characterName}'s cloned voice failed to derive for ${engineName} last time.`;
    case 'wrong-engine':
      return `${characterName} is routed to ${engineName}, which doesn't have this cloned voice.`;
    case 'missing-entry':
      return `${characterName}'s assigned voice is no longer in your voice library.`;
  }
}

/* Stable empty array so the closed-gate / no-cloned-cast case (the common
   one — this modal is a global, always-mounted overlay) doesn't hand
   useSelector a fresh `[]` on every call — same #1285 fix
   `voice-readiness-gate.tsx`'s `NO_UNDESIGNED_CHARACTERS` cites. */
const NO_CLONE_VERDICTS: CloneCharacterVerdict[] = [];

function CloneVerdictRow({
  verdict,
  character,
}: {
  verdict: CloneCharacterVerdict;
  character: Character | undefined;
}) {
  const dispatch = useAppDispatch();
  const [editingTranscript, setEditingTranscript] = useState(false);
  const [transcript, setTranscript] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /* The library uuid backing THIS character's slot at the routed engine.
     Only meaningful for `no-transcript`/`derive-failed`, both of which only
     fire when `characterHasSlot` (the character's OWN cast slot at
     `verdict.engine`) is true — see clone-readiness-selectors.ts's rule
     ordering — so `overrideTtsVoices[verdict.engine].libraryUuid` is
     guaranteed populated for those two reasons. */
  const libraryUuid = character?.overrideTtsVoices?.[verdict.engine]?.libraryUuid;

  const onSaveTranscript = async () => {
    if (!libraryUuid) return;
    setBusy(true);
    setError(null);
    try {
      await dispatch(patchEntry({ voiceUuid: libraryUuid, patch: { transcript } })).unwrap();
      setEditingTranscript(false);
    } catch (e) {
      setError((e as Error).message || 'Could not save the transcript.');
    } finally {
      setBusy(false);
    }
  };

  const onRetryDerive = async () => {
    /* `isCloneEngine` narrows `verdict.engine` (`TtsEngine`) to `CloneEngine`
       for the retry route's param type. Always true at runtime here — rule
       4 (`derive-failed`) is only reached after rule 3 confirms the engine
       IS clone-capable (clone-readiness.ts) — but TypeScript can't see that
       from the verdict's shape, so the guard makes it explicit rather than
       casting. */
    if (!libraryUuid || !isCloneEngine(verdict.engine)) return;
    setBusy(true);
    setError(null);
    try {
      await dispatch(retryEngine({ voiceUuid: libraryUuid, engine: verdict.engine })).unwrap();
    } catch (e) {
      setError((e as Error).message || 'Could not retry the derive.');
    } finally {
      setBusy(false);
    }
  };

  const onCastOnEngine = () => {
    if (!character || !verdict.castOnEngine) return;
    dispatch(castActions.updateCharacter({ ...character, ttsEngine: verdict.castOnEngine }));
  };

  const onAssignDifferentVoice = () => {
    dispatch(uiActions.changeView('cast'));
    dispatch(uiActions.setOpenProfileId(verdict.characterId));
    dispatch(uiActions.closeCloneReadinessGate());
  };

  return (
    <li
      className="rounded-2xl border border-ink/10 p-3"
      data-testid={`clone-readiness-row-${verdict.characterId}`}
    >
      <div className="flex items-center justify-between gap-3">
        <span className="font-medium text-ink">{verdict.characterName}</span>
        <span className="text-xs text-ink/50">{ENGINE_LABEL[verdict.engine]}</span>
      </div>
      <p className="mt-1 text-xs text-ink/60 leading-relaxed">{reasonCopy(verdict)}</p>

      {verdict.reason === 'no-transcript' &&
        (editingTranscript ? (
          <div className="mt-2">
            <TranscriptField value={transcript} onChange={setTranscript} />
            <button
              onClick={onSaveTranscript}
              disabled={
                busy || transcript.trim().length === 0 || transcript.length > MAX_CLONE_TRANSCRIPT_CHARS
              }
              className="mt-1.5 inline-flex items-center px-3 py-1.5 rounded-full text-xs font-semibold bg-magenta/10 text-magenta hover:bg-magenta/20 disabled:opacity-50 disabled:cursor-not-allowed min-h-[44px] fine-pointer:min-h-0"
            >
              {busy ? 'Saving…' : 'Save transcript'}
            </button>
          </div>
        ) : (
          <button
            onClick={() => setEditingTranscript(true)}
            className="mt-2 inline-flex items-center px-3 py-1.5 rounded-full text-xs font-semibold bg-magenta/10 text-magenta hover:bg-magenta/20 min-h-[44px] fine-pointer:min-h-0"
          >
            Add transcript
          </button>
        ))}

      {verdict.reason === 'derive-failed' && (
        <button
          onClick={onRetryDerive}
          disabled={busy}
          className="mt-2 inline-flex items-center px-3 py-1.5 rounded-full text-xs font-semibold bg-magenta/10 text-magenta hover:bg-magenta/20 disabled:opacity-50 disabled:cursor-wait min-h-[44px] fine-pointer:min-h-0"
        >
          {busy ? 'Retrying…' : 'Retry derive'}
        </button>
      )}

      {verdict.reason === 'wrong-engine' && verdict.castOnEngine && (
        <button
          onClick={onCastOnEngine}
          className="mt-2 inline-flex items-center px-3 py-1.5 rounded-full text-xs font-semibold bg-magenta/10 text-magenta hover:bg-magenta/20 min-h-[44px] fine-pointer:min-h-0"
        >
          Cast on {ENGINE_LABEL[verdict.castOnEngine]}
        </button>
      )}

      {verdict.reason === 'missing-entry' && (
        <button
          onClick={onAssignDifferentVoice}
          className="mt-2 inline-flex items-center px-3 py-1.5 rounded-full text-xs font-semibold bg-magenta/10 text-magenta hover:bg-magenta/20 min-h-[44px] fine-pointer:min-h-0"
        >
          Assign a different voice
        </button>
      )}

      {error && <p className="mt-1.5 text-xs text-magenta">{error}</p>}
    </li>
  );
}

export function CloneReadinessGateModal() {
  const dispatch = useAppDispatch();
  const gate = useAppSelector((s) => s.ui.cloneReadinessGate);
  const characters = useAppSelector((s) => s.cast.characters);
  const verdicts = useAppSelector((s) =>
    gate ? selectCloneReadinessVerdicts(s, gate.bookId) : NO_CLONE_VERDICTS,
  );

  if (!gate) return null;

  const onClose = () => dispatch(uiActions.closeCloneReadinessGate());

  /* Decision 1 — warn-and-allow. Deliberately dispatches
     `requestStartGeneration` directly, NEVER `openStartGenPrompt`: this
     gate fires independently of the Qwen tier prompt (see
     `start-generation-flow.ts`), so "proceed" here means "start the render
     I already asked for", not "now choose a Qwen tier". */
  const onProceedAnyway = () => {
    onClose();
    dispatch(uiActions.requestStartGeneration());
  };

  return (
    <>
      <div onClick={onClose} className="fixed inset-0 bg-ink/40 z-50 fade-in" />
      <div className="fixed inset-0 z-50 grid place-items-center p-6 pointer-events-none">
        <div
          data-testid="clone-readiness-gate"
          className="bg-white rounded-3xl shadow-float w-full max-w-lg pointer-events-auto fade-in overflow-hidden max-h-[calc(100vh-3rem)] flex flex-col"
        >
          <div className="px-6 py-4 border-b border-ink/10 flex items-center gap-3">
            <div className="flex-1 min-w-0">
              <p className="text-[10px] uppercase tracking-widest text-ink/50 font-semibold">
                Voice readiness
              </p>
              <h3 className="text-base font-bold text-ink truncate">
                Some cloned voices may not render
              </h3>
            </div>
            <button
              onClick={onClose}
              className="p-2 rounded-full hover:bg-ink/5 text-ink/60 min-h-[44px] min-w-[44px] fine-pointer:min-h-0 fine-pointer:min-w-0 grid place-items-center"
              aria-label="Close"
            >
              <IconClose className="w-4 h-4" />
            </button>
          </div>

          <div className="px-6 py-5 text-sm text-ink/75 leading-relaxed overflow-y-auto flex-1">
            <ul data-testid="clone-readiness-gate-list" className="space-y-3">
              {verdicts.map((v) => (
                <CloneVerdictRow
                  key={v.characterId}
                  verdict={v}
                  character={characters.find((c) => c.id === v.characterId)}
                />
              ))}
            </ul>
          </div>

          <div className="px-6 py-4 border-t border-ink/10 flex flex-col-reverse sm:flex-row sm:items-center sm:justify-between gap-3">
            <button
              onClick={onClose}
              className="text-sm font-medium text-ink/60 hover:text-ink min-h-[44px] fine-pointer:min-h-0"
            >
              Cancel
            </button>
            <PrimaryButton variant="dark" onClick={onProceedAnyway}>
              Proceed anyway
            </PrimaryButton>
          </div>
        </div>
      </div>
    </>
  );
}
