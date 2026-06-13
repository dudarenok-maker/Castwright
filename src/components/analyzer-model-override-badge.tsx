/* Surfaces an active per-run analyzer-model override so it can never
   silently shadow the saved default. Background: a per-run model pick
   (ui.selectedModel, e.g. qwen3.5:4b chosen to dodge a Gemini recitation
   block) used to persist device-local and globally, overriding the saved
   `analysisEngine`/`defaultAnalysisModel` on every later run, on every
   book, with no UI signal — the "Ollama silently forced" bug. The override
   is now transient (not persisted); this badge makes it visible within a
   session and offers a one-click reset back to the saved default.

   Self-contained: reads ui + account straight off the store and renders
   nothing unless an explicit pick differs from the saved default, so it can
   be dropped next to any analyzer-model picker. */

import { useAppDispatch, useAppSelector } from '../store';
import { uiActions } from '../store/ui-slice';
import { MODEL_OPTIONS } from '../lib/models';

function modelLabel(id: string): string {
  return MODEL_OPTIONS.find((m) => m.id === id)?.label ?? id;
}

export function AnalyzerModelOverrideBadge() {
  const dispatch = useAppDispatch();
  const selectedModel = useAppSelector((s) => s.ui.selectedModel);
  const explicit = useAppSelector((s) => s.ui.selectedModelExplicit);
  const savedDefault = useAppSelector((s) => s.account?.defaultAnalysisModel ?? '');

  /* Only when a per-run pick is active AND actually differs from the saved
     default — an explicit pick that matches the default is not an override. */
  if (!explicit || !savedDefault || selectedModel === savedDefault) return null;

  return (
    <div
      data-testid="analyzer-model-override-badge"
      className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-ink/70"
    >
      <span>
        This run uses <span className="font-semibold text-ink">{modelLabel(selectedModel)}</span> —
        overrides your saved default ({modelLabel(savedDefault)}).
      </span>
      <button
        type="button"
        onClick={() => dispatch(uiActions.resetSelectedModelToDefault(savedDefault))}
        className="font-semibold text-magenta hover:underline focus:outline-hidden focus:ring-2 focus:ring-magenta/30 rounded"
      >
        Reset to default
      </button>
    </div>
  );
}
