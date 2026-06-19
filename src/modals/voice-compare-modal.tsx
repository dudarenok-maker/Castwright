/* Current-vs-proposed bespoke-voice audition (plan 161).

   Opened from the Profile drawer's Qwen "Design & compare" flow. Side A plays
   the character's CURRENT voice (the same sample the drawer's "Play 12s" plays);
   Side B is the freshly designed PROPOSED voice, with an editable persona +
   Regenerate + Re-design so the user can iterate the new take in place. The
   shared two-pane shell + Auto A → B sequence come from `AbCompareShell` +
   `useAbAudition`.

   Approve ("Use proposed voice") stages the chosen `{voiceId, persona}` back
   into the drawer via `onApprove`; the drawer's existing Save persists it
   (series-scoped override + voiceStyle). Cancel discards — it never calls
   onApprove, so a closed comparison leaves the drawer's pending state untouched
   (the designed voice file lingers server-side, exactly as a designed-then-
   closed drawer does today). */

import { useState } from 'react';
import { IconPlay, IconPause, IconSpinner, IconRefresh, IconSparkle, IconCheck } from '../lib/icons';
import { Avatar } from '../components/primitives';
import { AbCompareShell } from '../components/ab-compare-shell';
import { useAbAudition, type AbSide, type AbRowState } from '../lib/use-ab-audition';
import { useSamplePlayback } from '../lib/use-sample-playback';
import { playSampleWithAutoLoad } from '../lib/play-sample-with-auto-load';
import { buildCharacterHint } from '../lib/build-character-hint';
import { sampleUrlPrefix } from '../lib/sample-scope';
import { api } from '../lib/api';
import type { Character, Voice, TtsModelKey, CharColor } from '../lib/types';

interface Props {
  bookId: string;
  character: Character;
  /** The resolved current-voice sample subject + cache id the drawer already
      computed for its own "Play 12s" — so Side A is identical to that. */
  currentSubject: Voice;
  currentSampleVoiceId: string;
  /** Model key the CURRENT voice (Side A) samples under — the character's
      PERSISTED engine, which may differ from the proposed Qwen key (e.g. the
      character is on Kokoro today and being moved to a bespoke Qwen voice). */
  currentModelKey: TtsModelKey;
  /** Model key the PROPOSED Qwen design (Side B + re-design + promote) uses. */
  designModelKey: TtsModelKey;
  /** Cache scope for the proposed design (the drawer's sampleVoiceId). */
  sampleVoiceId: string;
  /** The proposed (preview) voice the drawer just designed before opening this
      form — `voiceId` is the staged `…-preview` id. */
  initial: { voiceId: string; previewUrl: string; persona: string };
  onApprove: (next: { voiceId: string; persona: string; previewUrl: string; voiceUuid?: string }) => void;
  onClose: () => void;
}

export function VoiceCompareModal({
  bookId,
  character,
  currentSubject,
  currentSampleVoiceId,
  currentModelKey,
  designModelKey,
  sampleVoiceId,
  initial,
  onApprove,
  onClose,
}: Props) {
  const playback = useSamplePlayback();
  const [persona, setPersona] = useState(initial.persona);
  const [proposed, setProposed] = useState({ voiceId: initial.voiceId, previewUrl: initial.previewUrl });
  const [personaBusy, setPersonaBusy] = useState(false);
  const [redesignBusy, setRedesignBusy] = useState(false);
  const [approveBusy, setApproveBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const currentPrefix = sampleUrlPrefix(currentSampleVoiceId, currentModelKey);

  /* The current voice's Qwen voiceId. A designed/reused Qwen voice carries its
     id in `ttsVoice.name` but often NOT in `overrideTtsVoices.qwen` — and the
     server's `pickVoiceForEngine('qwen', …)` reads ONLY the override slot and
     returns '' otherwise (sidecar then 400s). So resolve it the same 3-way way
     the drawer does and inject it below, mirroring the drawer's own Play 12s. */
  const currentQwenName =
    currentSubject.overrideTtsVoices?.qwen?.name ??
    (currentSubject.ttsVoice?.provider === 'qwen' ? currentSubject.ttsVoice.name : undefined);

  const sides: Record<'a' | 'b', AbSide> = {
    a: {
      matchUrl: currentPrefix,
      matchMode: 'prefix',
      play: async () => {
        /* Inject the resolved Qwen voiceId into the override slot the server
           reads; non-Qwen current voices pass through unchanged.
           srv-43: also carry voiceUuid so qwenStorageKey resolves the
           uuid-keyed cache entry rather than the legacy name-derived key. */
        const requestVoice: Voice = currentQwenName
          ? {
              ...currentSubject,
              voiceUuid: currentSubject.voiceUuid ?? character.voiceUuid,
              overrideTtsVoices: {
                ...(currentSubject.overrideTtsVoices ?? {}),
                qwen: { name: currentQwenName },
              },
            }
          : currentSubject;
        await playSampleWithAutoLoad({
          args: {
            voiceId: currentSampleVoiceId,
            voice: requestVoice,
            modelKey: currentModelKey,
            characterHint: buildCharacterHint(character),
          },
          playback,
        });
      },
    },
    b: {
      matchUrl: proposed.previewUrl,
      matchMode: 'exact',
      play: async () => {
        await playback.play(proposed.previewUrl);
      },
    },
  };

  const { rowState, autoRunning, footerError, playSide, runAuto, stopAndCancel, isSidePlaying } =
    useAbAudition({ sides, playback });

  function handleClose() {
    stopAndCancel();
    /* Cancel → drop the staged preview design (best-effort; never blocks the
       close). The live voice was never touched, so nothing else to undo. */
    void api.discardQwenPreview(bookId, character.id, {
      previewVoiceId: proposed.voiceId,
      sampleVoiceId,
      modelKey: designModelKey,
    });
    onClose();
  }

  async function regenerate() {
    if (personaBusy) return;
    setPersonaBusy(true);
    setError(null);
    try {
      const { voiceStyle } = await api.generateVoiceStyle(bookId, character.id);
      setPersona(voiceStyle);
    } catch (e) {
      setError((e as Error).message || 'Voice-style generation failed.');
    } finally {
      setPersonaBusy(false);
    }
  }

  async function redesign() {
    if (redesignBusy) return;
    const trimmed = persona.trim();
    if (!trimmed) {
      setError('Add a persona before designing a voice.');
      return;
    }
    setRedesignBusy(true);
    setError(null);
    try {
      const { voiceId, previewUrl } = await api.designQwenVoice(bookId, character.id, {
        persona: trimmed,
        sampleVoiceId,
        modelKey: designModelKey,
        preview: true,
      });
      setProposed({ voiceId, previewUrl });
      await playback.play(previewUrl);
    } catch (e) {
      setError((e as Error).message || 'Voice design failed.');
    } finally {
      setRedesignBusy(false);
    }
  }

  async function approve() {
    if (approveBusy) return;
    if (playback.isPlaying) playback.stop();
    setApproveBusy(true);
    setError(null);
    try {
      /* Commit the staged preview onto the character's stable voiceId, then
         hand the REAL id + persona back to the drawer to stage; the drawer's
         Save persists the override series-scoped. */
      const { voiceId, url, voiceUuid } = await api.promoteQwenVoice(bookId, character.id, {
        previewVoiceId: proposed.voiceId,
        sampleVoiceId,
        modelKey: designModelKey,
      });
      onApprove({ voiceId, persona: persona.trim(), previewUrl: url, voiceUuid });
    } catch (e) {
      setError((e as Error).message || 'Could not keep the proposed voice.');
    } finally {
      setApproveBusy(false);
    }
  }

  return (
    <AbCompareShell
      title="Audition the new voice"
      subtitle="Compare the current voice with the proposed one, then keep whichever sounds right."
      ariaLabel="Compare current and proposed voice"
      overlayTestId="voice-compare-overlay"
      autoRunning={autoRunning}
      autoDisabled={
        !autoRunning && !!(rowState.a?.loading || rowState.b?.loading || redesignBusy || approveBusy)
      }
      footerError={footerError}
      onRunAuto={runAuto}
      onClose={handleClose}
      sideA={
        <SideCard side="a" title="Current voice" character={character}>
          {/* Descriptor line for the CURRENT voice — provider · name · description,
              mirroring the drawer card — so Side A isn't a bare voiceId. */}
          <p
            className="text-[11px] truncate"
            data-testid="voice-compare-current-name"
            title={`${capitalise(currentSubject.ttsVoice?.provider)} voice — ${currentSubject.ttsVoice?.description ?? ''}`}
          >
            <span className="text-ink/40">
              {capitalise(currentSubject.ttsVoice?.provider) || 'Voice'} ·{' '}
            </span>
            {currentSubject.ttsVoice?.name && (
              <span className="font-semibold text-ink/70">{currentSubject.ttsVoice.name}</span>
            )}
            <span className="text-ink/40">
              {currentSubject.ttsVoice?.name ? ' · ' : ''}
              {currentSubject.ttsVoice?.description ?? 'Current voice'}
            </span>
          </p>
          {/* The persona the current voice was designed with (read-only) so the
              user can A/B the old description against the proposed one on Side B. */}
          {character.voiceStyle?.trim() && (
            <div>
              <p className="text-[11px] text-ink/60 font-medium mb-1">Voice persona</p>
              <p
                data-testid="voice-compare-current-persona"
                className="w-full px-3 py-2 rounded-xl border border-ink/15 bg-white/60 text-sm text-ink/80 max-h-28 overflow-y-auto whitespace-pre-wrap"
              >
                {character.voiceStyle}
              </p>
            </div>
          )}
          <PlayButton
            testId="voice-compare-current-play"
            label="Play current"
            playing={isSidePlaying('a')}
            row={rowState.a}
            disabled={autoRunning && (rowState.b?.loading ?? false)}
            onClick={() => playSide('a')}
          />
          {rowState.a?.error && (
            <p
              className="text-[11px] text-red-600/90 font-medium"
              data-testid="voice-compare-current-error"
            >
              ⚠ {rowState.a.error}
            </p>
          )}
        </SideCard>
      }
      sideB={
        <SideCard side="b" title="Proposed voice" character={character}>
          <div>
            <div className="flex items-center justify-between mb-1">
              <label className="text-[11px] text-ink/60 font-medium" htmlFor="voice-compare-persona">
                Voice persona
              </label>
              <button
                type="button"
                onClick={regenerate}
                disabled={personaBusy}
                data-testid="voice-compare-regenerate"
                className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-semibold bg-peach/15 text-magenta hover:bg-peach/25 disabled:opacity-50 disabled:cursor-wait min-h-[32px] sm:min-h-0"
              >
                {personaBusy ? <IconSpinner className="w-3 h-3" /> : <IconRefresh className="w-3 h-3" />}
                <span>{personaBusy ? 'Generating…' : 'Regenerate'}</span>
              </button>
            </div>
            <textarea
              id="voice-compare-persona"
              aria-label="Voice persona"
              data-testid="voice-compare-persona"
              value={persona}
              onChange={(e) => setPersona(e.target.value)}
              rows={3}
              className="w-full px-3 py-2 rounded-xl border border-ink/15 bg-white text-sm text-ink focus:outline-hidden focus:ring-2 focus:ring-magenta/30 resize-y"
            />
          </div>
          <button
            type="button"
            onClick={redesign}
            disabled={redesignBusy || persona.trim().length === 0}
            data-testid="voice-compare-redesign"
            className={`w-full inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-2xl text-sm font-semibold transition-colors min-h-[44px] sm:min-h-0 ${
              redesignBusy
                ? 'bg-magenta/10 text-magenta cursor-wait'
                : 'bg-magenta/10 text-magenta hover:bg-magenta/20 disabled:opacity-50 disabled:cursor-not-allowed'
            }`}
          >
            {redesignBusy ? (
              <>
                <IconSpinner className="w-4 h-4" />
                <span>Designing voice…</span>
              </>
            ) : (
              <>
                <IconSparkle className="w-4 h-4" />
                <span>Re-design from persona</span>
              </>
            )}
          </button>
          <PlayButton
            testId="voice-compare-proposed-play"
            label="Play proposed"
            playing={isSidePlaying('b')}
            row={rowState.b}
            disabled={(autoRunning && (rowState.a?.loading ?? false)) || redesignBusy}
            onClick={() => playSide('b')}
          />
          {error && (
            <p className="text-[11px] text-red-600/90 font-medium" data-testid="voice-compare-error">
              ⚠ {error}
            </p>
          )}
        </SideCard>
      }
      footerEnd={
        <>
          <button
            onClick={handleClose}
            data-testid="voice-compare-cancel"
            className="px-4 py-2 rounded-full border border-ink/10 bg-white text-sm font-medium text-ink/70 hover:text-ink min-h-[44px] sm:min-h-0"
          >
            Cancel
          </button>
          <button
            onClick={() => void approve()}
            disabled={redesignBusy || approveBusy}
            data-testid="voice-compare-approve"
            className="inline-flex items-center gap-1.5 px-4 py-2 rounded-full bg-ink text-canvas text-sm font-semibold hover:bg-ink-soft disabled:opacity-50 disabled:cursor-not-allowed min-h-[44px] sm:min-h-0"
          >
            {approveBusy ? <IconSpinner className="w-4 h-4" /> : <IconCheck className="w-4 h-4" />}
            {approveBusy ? 'Keeping…' : 'Use proposed voice'}
          </button>
        </>
      }
    />
  );
}

/** Title-case a provider tag for the Side-A descriptor line (e.g. qwen → Qwen). */
function capitalise(s: string | undefined): string {
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : '';
}

function SideCard({
  side,
  title,
  character,
  children,
}: {
  side: 'a' | 'b';
  title: string;
  character: Character;
  children: React.ReactNode;
}) {
  return (
    <section
      aria-label={`Side ${side.toUpperCase()}: ${title}`}
      className="bg-white rounded-2xl border border-ink/10 p-5 space-y-4"
    >
      <header className="flex items-center gap-3 min-w-0">
        <Avatar name={character.name} color={character.color as CharColor} size={40} />
        <div className="min-w-0">
          <p className="font-bold text-ink truncate">{title}</p>
          <p className="text-xs text-ink/60 truncate">{character.name}</p>
        </div>
        <span className="ml-auto text-[10px] uppercase tracking-wider font-semibold text-ink/40">
          Side {side.toUpperCase()}
        </span>
      </header>
      {children}
    </section>
  );
}

function PlayButton({
  testId,
  label,
  playing,
  row,
  disabled,
  onClick,
}: {
  testId: string;
  label: string;
  playing: boolean;
  row: AbRowState;
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled || row.loading}
      data-testid={testId}
      aria-label={playing ? `Stop ${label}` : label}
      className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-semibold transition-colors disabled:opacity-50 disabled:cursor-not-allowed min-h-[44px] sm:min-h-0 ${
        row.loading
          ? 'bg-magenta/10 text-magenta cursor-wait'
          : playing
            ? 'bg-magenta text-white hover:bg-magenta/90'
            : 'bg-ink/6 text-ink/80 hover:bg-magenta/15 hover:text-magenta'
      }`}
    >
      {row.loading ? (
        <IconSpinner className="w-3 h-3" />
      ) : playing ? (
        <IconPause className="w-3 h-3" />
      ) : (
        <IconPlay className="w-3 h-3" />
      )}
      <span>{row.loading ? 'Generating…' : playing ? 'Stop' : label}</span>
    </button>
  );
}
