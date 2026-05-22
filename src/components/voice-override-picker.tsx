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
import { IconCheck, IconChevD } from '../lib/icons';
import type { BaseVoice, TtsEngine } from '../lib/types';
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
}

const AUTO_VALUE = 'auto';

function capitalise(s: string) {
  return s.length > 0 ? s[0].toUpperCase() + s.slice(1) : s;
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
        className="w-full inline-flex items-center justify-between gap-2 px-3 py-2 rounded-xl border border-ink/15 bg-white text-sm text-ink hover:border-ink/30 focus:outline-none focus:ring-2 focus:ring-magenta/30 disabled:opacity-60 disabled:cursor-not-allowed min-h-[44px] sm:min-h-0"
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
            <>
              <span className="flex-1 truncate">
                {choice.kind === 'auto' ? autoLabel : choice.voice.name}
              </span>
              {ctx.active && <IconCheck className="w-3.5 h-3.5 text-ink/60" />}
            </>
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
