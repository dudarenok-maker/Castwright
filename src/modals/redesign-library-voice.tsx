/* fs-38 Wave 1, Task 15 — RedesignLibraryVoiceModal.

   A/B old-vs-new redesign for a "My voices" library entry — the plan-161
   compare idiom (see src/modals/voice-compare-modal.tsx), reused here via
   the same `AbCompareShell` + `useAbAudition` building blocks: OLD plays
   `api.sampleLibraryVoice(entry.voiceUuid)`, NEW plays the previewUrl the
   Task 13 `redesignVoice` thunk resolves with. "Keep new" / "Keep old"
   dispatch `promoteRedesign` / `discardRedesign` and close the modal once
   the server call succeeds. */

import { useState } from 'react';
import { useAppDispatch } from '../store';
import {
  redesignVoice,
  promoteRedesign,
  discardRedesign,
  type VoiceLibraryEntry,
} from '../store/voice-library-slice';
import { AbCompareShell } from '../components/ab-compare-shell';
import { useAbAudition, type AbSide, type AbRowState } from '../lib/use-ab-audition';
import { useSamplePlayback } from '../lib/use-sample-playback';
import { api } from '../lib/api';
import { IconPlay, IconPause, IconSpinner, IconSparkle, IconCheck } from '../lib/icons';

interface Props {
  entry: VoiceLibraryEntry;
  onClose: () => void;
}

export function RedesignLibraryVoiceModal({ entry, onClose }: Props) {
  const dispatch = useAppDispatch();
  const playback = useSamplePlayback();
  const [persona, setPersona] = useState(entry.persona ?? '');
  const [oldPreviewUrl, setOldPreviewUrl] = useState<string | null>(null);
  const [proposed, setProposed] = useState<{ previewUrl: string } | null>(null);
  const [redesignBusy, setRedesignBusy] = useState(false);
  const [promoteBusy, setPromoteBusy] = useState(false);
  const [discardBusy, setDiscardBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /* Side A's URL isn't known until the sample fetch resolves (the server
     signs/derives it), so `matchUrl` starts empty and picks up the resolved
     value on the next render — mirrors VoiceCompareModal's Side B (a known
     preview URL) rather than its Side A (which instead matches by a
     predictable prefix, not available here). */
  const sides: Record<'a' | 'b', AbSide> = {
    a: {
      matchUrl: oldPreviewUrl ?? '',
      matchMode: 'exact',
      play: async () => {
        const { url } = await api.sampleLibraryVoice(entry.voiceUuid);
        setOldPreviewUrl(url);
        await playback.play(url);
      },
    },
    b: {
      matchUrl: proposed?.previewUrl ?? '',
      matchMode: 'exact',
      play: async () => {
        if (!proposed) throw new Error('Design a new take first.');
        await playback.play(proposed.previewUrl);
      },
    },
  };

  const { rowState, autoRunning, footerError, playSide, runAuto, stopAndCancel, isSidePlaying } =
    useAbAudition({ sides, playback });

  function handleClose() {
    stopAndCancel();
    onClose();
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
      const result = await dispatch(
        redesignVoice({ voiceUuid: entry.voiceUuid, persona: trimmed }),
      ).unwrap();
      setProposed({ previewUrl: result.previewUrl });
      await playback.play(result.previewUrl);
    } catch (e) {
      setError((e as Error).message || 'Voice redesign failed.');
    } finally {
      setRedesignBusy(false);
    }
  }

  async function keepNew() {
    if (promoteBusy || !proposed) return;
    if (playback.isPlaying) playback.stop();
    setPromoteBusy(true);
    setError(null);
    try {
      await dispatch(promoteRedesign(entry.voiceUuid)).unwrap();
      onClose();
    } catch (e) {
      setError((e as Error).message || 'Could not keep the new take.');
    } finally {
      setPromoteBusy(false);
    }
  }

  async function keepOld() {
    if (discardBusy) return;
    if (playback.isPlaying) playback.stop();
    setDiscardBusy(true);
    setError(null);
    try {
      await dispatch(discardRedesign(entry.voiceUuid)).unwrap();
      onClose();
    } catch (e) {
      setError((e as Error).message || 'Could not discard the new take.');
    } finally {
      setDiscardBusy(false);
    }
  }

  return (
    <AbCompareShell
      title={`Redesign ${entry.name}`}
      subtitle="Compare the current voice with the proposed one, then keep whichever sounds right."
      ariaLabel={`Compare current and proposed voice for ${entry.name}`}
      overlayTestId="redesign-library-voice-overlay"
      autoRunning={autoRunning}
      autoDisabled={
        !autoRunning &&
        !!(rowState.a?.loading || rowState.b?.loading || redesignBusy || promoteBusy || discardBusy)
      }
      footerError={footerError ?? error}
      onRunAuto={runAuto}
      onClose={handleClose}
      sideA={
        <section
          aria-label="Side A: Current voice"
          className="bg-white rounded-2xl border border-ink/10 p-5 space-y-4"
        >
          <header>
            <p className="font-bold text-ink">Current voice</p>
            {entry.persona && (
              <p
                data-testid="redesign-library-voice-current-persona"
                className="mt-1 text-[11px] text-ink/60 whitespace-pre-wrap"
              >
                {entry.persona}
              </p>
            )}
          </header>
          <PlayButton
            testId="redesign-library-voice-play-old"
            label="Play current"
            playing={isSidePlaying('a')}
            row={rowState.a}
            disabled={autoRunning && (rowState.b?.loading ?? false)}
            onClick={() => void playSide('a')}
          />
        </section>
      }
      sideB={
        <section
          aria-label="Side B: Proposed voice"
          className="bg-white rounded-2xl border border-ink/10 p-5 space-y-4"
        >
          <header>
            <p className="font-bold text-ink">Proposed voice</p>
          </header>
          <div>
            <label
              className="text-[11px] text-ink/60 font-medium mb-1 block"
              htmlFor="redesign-library-voice-persona"
            >
              Voice persona
            </label>
            <textarea
              id="redesign-library-voice-persona"
              data-testid="redesign-library-voice-persona"
              value={persona}
              onChange={(e) => setPersona(e.target.value)}
              rows={3}
              className="w-full px-3 py-2 rounded-xl border border-ink/15 bg-white text-sm text-ink focus:outline-hidden focus:ring-2 focus:ring-magenta/30 resize-y"
            />
          </div>
          <button
            type="button"
            onClick={() => void redesign()}
            disabled={redesignBusy || persona.trim().length === 0}
            data-testid="redesign-library-voice-redesign"
            className={`w-full inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-2xl text-sm font-semibold transition-colors min-h-[44px] fine-pointer:min-h-0 ${
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
            testId="redesign-library-voice-play-new"
            label="Play proposed"
            playing={isSidePlaying('b')}
            row={rowState.b}
            disabled={(autoRunning && (rowState.a?.loading ?? false)) || redesignBusy || !proposed}
            onClick={() => void playSide('b')}
          />
        </section>
      }
      footerEnd={
        <>
          <button
            onClick={() => void keepOld()}
            disabled={discardBusy || promoteBusy}
            data-testid="redesign-library-voice-keep-old"
            className="px-4 py-2 rounded-full border border-ink/10 bg-white text-sm font-medium text-ink/70 hover:text-ink min-h-[44px] fine-pointer:min-h-0"
          >
            {discardBusy ? 'Keeping…' : 'Keep old'}
          </button>
          <button
            onClick={() => void keepNew()}
            disabled={!proposed || promoteBusy || discardBusy}
            data-testid="redesign-library-voice-keep-new"
            className="inline-flex items-center gap-1.5 px-4 py-2 rounded-full bg-ink text-canvas text-sm font-semibold hover:bg-ink-soft disabled:opacity-50 disabled:cursor-not-allowed min-h-[44px] fine-pointer:min-h-0"
          >
            {promoteBusy ? <IconSpinner className="w-4 h-4" /> : <IconCheck className="w-4 h-4" />}
            {promoteBusy ? 'Keeping…' : 'Keep new'}
          </button>
        </>
      }
    />
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
      className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-semibold transition-colors disabled:opacity-50 disabled:cursor-not-allowed min-h-[44px] fine-pointer:min-h-0 ${
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
