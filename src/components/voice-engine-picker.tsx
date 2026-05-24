/* Per-character TTS engine + bespoke-voice picker (plan 108, Wave 4).

   Sits inside the Profile Drawer's Voice profile section. Two jobs:

   1. Engine selector — "Default (Kokoro)" plus each installed engine. The
      narrator usually stays Default; speaking characters can move to a
      bespoke Qwen voice. Writes `Character.ttsEngine` (Default → undefined).

   2. When Qwen is selected, the bespoke voice-DESIGN flow: an editable
      persona textarea (the Gemini-generated `voiceStyle`), a Regenerate
      button (re-calls the persona generator), and a "Design & preview"
      button that POSTs the design-voice route and plays the returned
      audition. The drawer's Save commits `ttsEngine: 'qwen'` +
      `overrideTtsVoices.qwen.name = <designed voiceId>` series-scoped.

   Preset engines (Kokoro/Coqui) keep the existing VoiceOverridePicker —
   this component only owns the engine choice + the Qwen design sub-flow.
   State is lifted into the drawer so Save can read it; this is a
   controlled presentational component. */

import { IconSparkle, IconRefresh, IconWaveform, IconSpinner, IconPause } from '../lib/icons';
import type { TtsEngine } from '../lib/types';

/* Engine value the selector emits. 'default' maps to "no per-character
   engine" (use the project default). The rest are real TtsEngine ids. */
export type EngineChoice = 'default' | TtsEngine;

const ENGINE_LABELS: Record<TtsEngine, string> = {
  kokoro: 'Kokoro',
  qwen: 'Qwen (bespoke)',
  coqui: 'Coqui XTTS',
  gemini: 'Gemini',
  piper: 'Piper',
};

interface Props {
  /** Current per-character engine. 'default' renders the "Default
      (Kokoro)" option; any real engine selects that row. */
  value: EngineChoice;
  onChange: (next: EngineChoice) => void;
  /** Engines offered below "Default (Kokoro)". At minimum Kokoro + Qwen
      (plan 108). Order is preserved. */
  installedEngines: TtsEngine[];

  /* ── Qwen sub-flow (only rendered when value === 'qwen') ─────────── */
  /** The editable voice-design persona (Character.voiceStyle). */
  persona: string;
  onPersonaChange: (next: string) => void;
  /** Re-generate the persona via Gemini. */
  onRegeneratePersona: () => void;
  personaBusy: boolean;
  /** Design + audition the bespoke voice from the current persona. */
  onDesignVoice: () => void;
  designBusy: boolean;
  /** True while the designed-voice audition is playing (toggles the
      button to a Stop affordance). */
  designPlaying: boolean;
  /** Set once a voice has been designed this session — surfaces a
      "designed" confirmation + the voiceId. */
  designedVoiceId: string | null;
  /** Inline error from the persona generate / design calls. */
  error: string | null;
}

export function VoiceEnginePicker({
  value,
  onChange,
  installedEngines,
  persona,
  onPersonaChange,
  onRegeneratePersona,
  personaBusy,
  onDesignVoice,
  designBusy,
  designPlaying,
  designedVoiceId,
  error,
}: Props) {
  return (
    <div className="mt-3 p-3 rounded-2xl bg-canvas border border-ink/10">
      <label
        className="block text-[11px] text-ink/60 font-medium mb-1.5"
        htmlFor="character-engine"
      >
        TTS engine for this character
      </label>
      <select
        id="character-engine"
        aria-label="TTS engine for this character"
        value={value}
        onChange={(e) => onChange(e.target.value as EngineChoice)}
        className="w-full px-3 py-2 rounded-xl border border-ink/15 bg-white text-sm text-ink focus:outline-none focus:ring-2 focus:ring-magenta/30 min-h-[44px] sm:min-h-0"
      >
        <option value="default">Default (Kokoro)</option>
        {installedEngines.map((engine) => (
          <option key={engine} value={engine}>
            {ENGINE_LABELS[engine]}
          </option>
        ))}
      </select>

      {value === 'qwen' && (
        <div className="mt-3 space-y-3" data-testid="qwen-design-panel">
          <div>
            <div className="flex items-center justify-between mb-1">
              <label className="text-[11px] text-ink/60 font-medium" htmlFor="qwen-persona">
                Voice persona
              </label>
              <button
                type="button"
                onClick={onRegeneratePersona}
                disabled={personaBusy}
                data-testid="qwen-regenerate-persona"
                className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-semibold bg-peach/15 text-magenta hover:bg-peach/25 disabled:opacity-50 disabled:cursor-wait min-h-[32px] sm:min-h-0"
              >
                {personaBusy ? (
                  <IconSpinner className="w-3 h-3" />
                ) : (
                  <IconRefresh className="w-3 h-3" />
                )}
                <span>{personaBusy ? 'Generating…' : 'Regenerate'}</span>
              </button>
            </div>
            <textarea
              id="qwen-persona"
              aria-label="Voice persona"
              data-testid="qwen-persona-text"
              value={persona}
              onChange={(e) => onPersonaChange(e.target.value)}
              rows={3}
              placeholder="a warm, confident voice…"
              className="w-full px-3 py-2 rounded-xl border border-ink/15 bg-white text-sm text-ink focus:outline-none focus:ring-2 focus:ring-magenta/30 resize-y"
            />
            <p className="mt-1 text-[10px] text-ink/40 leading-relaxed">
              A short natural-language description Qwen uses to design a bespoke voice. Edit it,
              regenerate it, then design + audition below.
            </p>
          </div>

          <button
            type="button"
            onClick={onDesignVoice}
            disabled={designBusy || persona.trim().length === 0}
            data-testid="qwen-design-voice"
            className={`w-full inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-2xl text-sm font-semibold transition-colors min-h-[44px] sm:min-h-0 ${
              designBusy
                ? 'bg-magenta/10 text-magenta cursor-wait'
                : designPlaying
                  ? 'bg-magenta text-white hover:bg-magenta/90'
                  : 'bg-magenta/10 text-magenta hover:bg-magenta/20 disabled:opacity-50 disabled:cursor-not-allowed'
            }`}
          >
            {designBusy ? (
              <>
                <IconSpinner className="w-4 h-4" />
                <span>Designing voice…</span>
              </>
            ) : designPlaying ? (
              <>
                <IconPause className="w-4 h-4" />
                <span>Stop audition</span>
              </>
            ) : (
              <>
                <IconSparkle className="w-4 h-4" />
                <span>Design &amp; preview voice</span>
              </>
            )}
          </button>

          {designedVoiceId && !designBusy && (
            <p
              className="inline-flex items-center gap-1.5 text-[11px] text-emerald-700"
              data-testid="qwen-designed-confirm"
            >
              <IconWaveform className="w-3.5 h-3.5" />
              Voice designed — saving will pin it across this series.
            </p>
          )}
          {error && (
            <p className="text-[11px] text-red-600/90 font-medium" data-testid="qwen-design-error">
              ⚠ {error}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
