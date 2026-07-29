/* Voice-override picker — wraps the generic SearchablePicker
   primitive for the per-engine "Model voice" override in the Profile
   Drawer's Voice Profile section (`src/modals/profile-drawer.tsx`).
   Pre-extraction this was a native `<select>` with up to 40+ Kokoro
   voices and no typeahead.

   Three rendering states:
   - Loaded with voices: search-input picker with Auto + voice rows.
   - Loaded with empty catalog: trigger remains pickable (the Auto row
     is always available); the list shows "Auto" only.
   - Not loaded: trigger disabled, label collapses to "Loading base
     voice catalog…" (same UX as the legacy `<select disabled>`). */

import { useEffect, useRef, useState } from 'react';
import { IconCheck, IconChevD, IconPause, IconPlay, IconSpinner } from '../lib/icons';
import type { BaseVoice, TtsEngine, TtsModelKey } from '../lib/types';
import { useSamplePlayback } from '../lib/use-sample-playback';
import {
  playBaseVoiceSampleWithAutoLoad,
  type SampleStatus,
} from '../lib/play-sample-with-auto-load';
import { SearchablePicker, type PickerGroup, type PickerItem } from './searchable-picker';

type Choice = { kind: 'auto' } | { kind: 'voice'; voice: BaseVoice };

interface VoiceOverridePickerProps {
  /** The voiceId of the character — used to derive a stable id for the
      label association (matches the legacy `<select id>`). */
  voiceId: string;
  /** Active engine tab — drives both the picker's voice list and the
      "Auto" row's resolved-voice label. */
  engineTab: TtsEngine;
  /** Project-active engine — drives the Auto row's "currently …" vs
      "attribute-driven" labelling so the user knows whether the Auto
      slot for this tab matches the project's synth engine. */
  autoVoiceEngine: TtsEngine;
  autoVoiceName: string;
  /** Voices for the active engine tab — already filtered by the
      parent. The Auto row is prepended internally. */
  voicesForTab: BaseVoice[];
  /** Selected value in the legacy `${engine}|${name}` encoding, or
      'auto' when nothing is overridden. */
  selectedValue: string;
  /** Catalog hydration flag from the voices slice. When false the
      trigger is disabled and shows a loading label. */
  baseVoicesLoaded: boolean;
  onChange: (next: { engine: TtsEngine; name: string } | null) => void;
  /** Sample line the per-row Play button speaks — same drawer-level
      value the candidate-preview block below the picker uses (fe-7). */
  previewText: string;
  /** Project-active model key forwarded to the auto-load helper so the
      sidecar re-maps to a compatible model when needed. */
  previewModelKey: TtsModelKey;
  /** fs-38 Wave 3c Task 26 fix round 1 — locks the trigger closed
      regardless of `baseVoicesLoaded` (e.g. a consented clone occupies
      this engine's slot; picking a catalog voice here would silently
      overwrite it via PUT /api/voices/:id/override). Absent/false
      preserves the existing loaded/loading behaviour. A popover already
      open when this flips true is force-closed (see the effect below) —
      `disabled` alone doesn't touch already-open state. */
  disabled?: boolean;
  /** fs-38 Wave 3c Task 26 fix round 2 [a11y] — id of an element (e.g. an
      explanatory note) that documents WHY the trigger is disabled, wired
      onto the trigger's `aria-describedby` so a screen-reader user gets a
      programmatic reason instead of only DOM-order discovery. */
  describedById?: string;
}

const AUTO_VALUE = 'auto';

function capitalise(s: string) {
  return s.length > 0 ? s[0].toUpperCase() + s.slice(1) : s;
}

/* Per-row "audition without committing" affordance (fe-7). Mirrors
   VoicePreviewButton's state machine (idle/loading/playing) and a11y
   label convention, but icon-only + hover/focus-revealed so it fits a
   compact picker row instead of the roomy candidate-preview list.

   Rendered as a focusable `<span role="button">` rather than a native
   `<button>`: the SearchablePicker option row is ITSELF a `<button>`, and
   a button-in-button is invalid HTML (React's validateDOMNesting warns).
   The span keeps keyboard activation via an explicit Enter/Space handler.
   `stopPropagation` on both click AND keydown keeps auditioning from also
   picking the row. */
function RowPreviewButton({
  voice,
  modelKey,
  text,
}: {
  voice: BaseVoice;
  modelKey: TtsModelKey;
  text: string;
}) {
  const playback = useSamplePlayback();
  const [status, setStatus] = useState<SampleStatus | 'idle'>('idle');
  const isLoading = status !== 'idle';
  const previewUrlPrefix = `/audio/voices/${encodeURIComponent(`raw-${voice.engine}-${voice.name}`)}-${modelKey}`;
  const isPlayingThis = playback.isPlaying && !!playback.currentUrl?.startsWith(previewUrlPrefix);

  async function activate() {
    if (isLoading) return;
    if (isPlayingThis) {
      playback.stop();
      return;
    }
    setStatus('synthesizing');
    try {
      await playBaseVoiceSampleWithAutoLoad({
        args: { engine: voice.engine, speakerName: voice.name, modelKey, text },
        playback,
        onStatus: (next) => setStatus(next),
      });
    } catch {
      /* Swallowed — the roomy candidate-preview list below the picker
         surfaces load/synth errors inline; this compact row affordance
         just resets to idle so the icon is clickable again. */
    } finally {
      setStatus('idle');
    }
  }

  return (
    <span
      role="button"
      tabIndex={0}
      onMouseDown={(e) => e.stopPropagation()}
      onClick={(e) => {
        e.stopPropagation();
        void activate();
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          e.stopPropagation();
          void activate();
        }
      }}
      aria-label={isPlayingThis ? `Stop sample for ${voice.name}` : `Play sample for ${voice.name}`}
      aria-disabled={isLoading || undefined}
      className={`shrink-0 grid place-items-center w-6 h-6 rounded-full text-ink/50 coarse-pointer:min-h-[44px] coarse-pointer:min-w-[44px] hover:bg-ink/8 hover:text-ink ${
        isLoading
          ? 'opacity-100 cursor-wait'
          : 'opacity-0 group-hover:opacity-100 coarse-pointer:opacity-60 focus-visible:opacity-100 cursor-pointer'
      }`}
    >
      {isLoading ? (
        <IconSpinner className="w-3.5 h-3.5" />
      ) : isPlayingThis ? (
        <IconPause className="w-3.5 h-3.5" />
      ) : (
        <IconPlay className="w-3.5 h-3.5" />
      )}
    </span>
  );
}

export function VoiceOverridePicker({
  voiceId,
  engineTab,
  autoVoiceEngine,
  autoVoiceName,
  voicesForTab,
  selectedValue,
  baseVoicesLoaded,
  onChange,
  previewText,
  previewModelKey,
  disabled = false,
  describedById,
}: VoiceOverridePickerProps) {
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);

  /* fs-38 Wave 3c Task 26 fix round 2 [F1 residual] — force-close a popover
     that's already open when `disabled` flips true mid-session (e.g. a
     clone lands on this character via the cross-tab BroadcastChannel sync
     while this drawer is open). Without this, "Auto" stays pickable in the
     already-rendered list even though the trigger itself is now disabled —
     picking it would still null the whole overrideTtsVoices map. Fixes the
     class (any future reason to disable while open), not just this one. */
  useEffect(() => {
    if (disabled) setOpen(false);
  }, [disabled]);

  const autoLabel =
    engineTab === autoVoiceEngine
      ? `Auto — currently ${capitalise(autoVoiceEngine)} · ${autoVoiceName}`
      : `Auto for ${capitalise(engineTab)} — attribute-driven`;

  /* Resolve the trigger label from the selected value. `auto` shows the
     same string the in-list Auto row uses; a specific voice shows its
     name (no engine prefix — the engine tab above already shows that). */
  const triggerLabel =
    selectedValue === AUTO_VALUE
      ? autoLabel
      : selectedValue.split('|').slice(1).join('|');

  const groups: PickerGroup<Choice>[] = [
    {
      items: [
        {
          id: AUTO_VALUE,
          haystack: ['auto', autoLabel],
          data: { kind: 'auto' },
        },
        ...voicesForTab.map<PickerItem<Choice>>((bv) => ({
          id: `${bv.engine}|${bv.name}`,
          haystack: [bv.name],
          data: { kind: 'voice', voice: bv },
        })),
      ],
    },
  ];

  function handlePick(choice: Choice) {
    if (choice.kind === 'auto') {
      onChange(null);
    } else {
      onChange({ engine: choice.voice.engine, name: choice.voice.name });
    }
    setOpen(false);
  }

  return (
    <>
      <button
        id={`override-${voiceId}`}
        ref={triggerRef}
        type="button"
        aria-label={`Model voice override (${engineTab})`}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-describedby={describedById}
        disabled={!baseVoicesLoaded || disabled}
        onClick={() => setOpen((v) => !v)}
        className="w-full inline-flex items-center justify-between gap-2 px-3 py-2 rounded-xl border border-ink/15 bg-white text-sm text-ink hover:border-ink/30 focus:outline-hidden focus:ring-2 focus:ring-magenta/30 disabled:opacity-60 disabled:cursor-not-allowed coarse-pointer:min-h-[44px]"
      >
        <span className="truncate text-left flex-1">
          {baseVoicesLoaded ? triggerLabel : 'Loading base voice catalog…'}
        </span>
        <IconChevD className="w-3.5 h-3.5 text-ink/50 shrink-0" />
      </button>
      {open && (
        <SearchablePicker<Choice>
          groups={groups}
          activeId={selectedValue}
          renderItem={(choice, ctx) => (
            <div className="group flex flex-1 min-w-0 items-center gap-2">
              <span className="flex-1 truncate">
                {choice.kind === 'auto' ? autoLabel : choice.voice.name}
              </span>
              {choice.kind === 'voice' && (
                <RowPreviewButton voice={choice.voice} modelKey={previewModelKey} text={previewText} />
              )}
              {ctx.active && <IconCheck className="w-3.5 h-3.5 text-ink/60" />}
            </div>
          )}
          onPick={handlePick}
          onClose={() => setOpen(false)}
          anchorRef={triggerRef}
          placement="bottom-start"
          minWidth={288}
          searchPlaceholder="Search voice…"
          ariaLabel={`Model voice override (${engineTab})`}
        />
      )}
    </>
  );
}
