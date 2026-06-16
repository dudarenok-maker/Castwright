/* Analysis-model picker — wraps the generic SearchablePicker primitive
   for the upload screen's "Analysis model" dropdown
   (`src/views/upload.tsx`). Same data source as the re-parse modal and
   the analysing-view override (`MODEL_OPTION_GROUPS` in
   `src/lib/models.ts`). Pre-extraction this was a native `<select>` +
   `<optgroup>`; the model catalog only carries ~7 entries so typeahead
   is light-touch — the win is consistency with the rest of the app's
   pickers. */

import { useRef, useState } from 'react';
import { IconCheck, IconChevD } from '../lib/icons';
import {
  MODEL_OPTION_GROUPS,
  type ModelOption,
} from '../lib/models';
import { SearchablePicker, type PickerGroup } from './searchable-picker';

interface AnalysisModelPickerProps {
  selectedModel: string;
  onChange: (modelId: string) => void;
  disabled?: boolean;
  /** Grouped model catalog to render. Defaults to the curated-only static
      groups for store-less callers; the upload view passes the dynamic
      curated ∪ live-Ollama-tag union so pulled tags are selectable. */
  groups?: typeof MODEL_OPTION_GROUPS;
}

export function AnalysisModelPicker({
  selectedModel,
  onChange,
  disabled = false,
  groups: groupsProp = MODEL_OPTION_GROUPS,
}: AnalysisModelPickerProps) {
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);

  /* Resolve the trigger label from the selected id. Falls back to the
     id itself if the catalog ever rolls a model we don't carry locally
     (defensive — the catalog is the single source of truth). */
  const selectedOption = groupsProp.flatMap((g) => g.models).find(
    (m) => m.id === selectedModel,
  );
  const triggerLabel = selectedOption?.label ?? selectedModel;

  const groups: PickerGroup<ModelOption>[] = groupsProp.map((g) => ({
    label: g.label,
    items: g.models.map((m) => ({
      id: m.id,
      haystack: [m.label, m.hint ?? '', m.id],
      data: m,
    })),
  }));

  return (
    <>
      <button
        id="model-select"
        ref={triggerRef}
        type="button"
        aria-label="Analysis model"
        aria-haspopup="listbox"
        aria-expanded={open}
        disabled={disabled}
        onClick={() => setOpen((v) => !v)}
        className="w-full sm:w-auto min-h-[44px] px-3 py-1.5 rounded-full bg-white border border-ink/15 text-ink/80 hover:border-ink/30 focus:outline-hidden focus:border-peach disabled:opacity-50 inline-flex items-center justify-between gap-2 text-sm"
      >
        <span className="truncate">{triggerLabel}</span>
        <IconChevD className="w-3.5 h-3.5 text-ink/50 shrink-0" />
      </button>
      {open && (
        <SearchablePicker<ModelOption>
          groups={groups}
          activeId={selectedModel}
          renderItem={(m, ctx) => (
            <span className="flex-1 min-w-0">
              <span className="flex items-center gap-2">
                <span className="truncate">{m.label}</span>
                {ctx.active && <IconCheck className="w-3.5 h-3.5 text-ink/60 shrink-0" />}
              </span>
              {m.hint && (
                <span className="block text-[10px] text-ink/50 italic truncate">
                  {m.hint}
                </span>
              )}
            </span>
          )}
          onPick={(m) => {
            onChange(m.id);
            setOpen(false);
          }}
          onClose={() => setOpen(false)}
          anchorRef={triggerRef}
          placement="bottom-start"
          minWidth={320}
          searchPlaceholder="Search model…"
          ariaLabel="Analysis model"
        />
      )}
    </>
  );
}
