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

import { useRef, useState } from 'react';
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
}

const AUTO_VALUE = 'auto';

function capitalise(s: string) {
  return s.length > 0 ? s[0].toUpperCase() + s.slice(1) : s;
}

/* Per-row "audition without committing" affordance (fe-7). Mirrors
   VoicePreviewButton's state machine (idle/loading/playing) and a11y
   label convention, but icon-only + hover/focus-revealed so it fits a
   compact picker row instead of the roomy candidate-preview list.
   `stopPropagation` on click keeps auditioning from also picking the
   row — the row itself is the SearchablePicker option button. */
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

  async function onClick(e: React.MouseEvent) {
    e.stopPropagation();
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
    <button
      type="button"
      onMouseDown={(e) => e.stopPropagation()}
      onClick={onClick}
      disabled={isLoading}
      aria-label={isPlayingThis ? `Stop sample for ${voice.name}` : `Play sample for ${voice.name}`}
      className="shrink-0 grid place-items-center w-6 h-6 rounded-full text-ink/50 opacity-0 group-hover:opacity-100 coarse-pointer:opacity-60 focus-visible:opacity-100 coarse-pointer:min-h-[44px] coarse-pointer:min-w-[44px] hover:bg-ink/8 hover:text-ink disabled:opacity-100 disabled:cursor-wait"
    >
      {isLoading ? (
        <IconSpinner className="w-3.5 h-3.5" />
      ) : isPlayingThis ? (
        <IconPause className="w-3.5 h-3.5" />
      ) : (
        <IconPlay className="w-3.5 h-3.5" />
      )}
    </button>
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
}: VoiceOverridePickerProps) {
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);

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
        disabled={!baseVoicesLoaded}
        onClick={() => setOpen((v) => !v)}
        className="w-full inline-flex items-center justify-between gap-2 px-3 py-2 rounded-xl border border-ink/15 bg-white text-sm text-ink hover:border-ink/30 focus:outline-hidden focus:ring-2 focus:ring-magenta/30 disabled:opacity-60 disabled:cursor-not-allowed min-h-[44px] sm:min-h-0"
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
