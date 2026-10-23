/* #3084 P10 — options for an 'analyzer-engine' knob (analyzer.fallback.target from PR 3d; wave 4's
   analyzer.personaGeneration.engine reuses it): the knob's static entries, then every
   OpenAI-compatible endpoint model the analyzer catalog lists, then the saved value when neither
   list has it (an endpoint deleted, or not listed right now), so the select never silently shows
   a different choice than the one in effect. Static entries keep their raw values as labels. */
import type { AnalyzerCatalog } from './types';

export interface AnalyzerEngineOption {
  value: string;
  label: string;
}

/** Endpoint groups only: the group label is the endpoint name, each entry's label the bare model.
    A group whose listing failed has no models, so it contributes nothing. */
export function endpointModelOptions(catalog: AnalyzerCatalog | null | undefined): AnalyzerEngineOption[] {
  return (catalog?.groups ?? [])
    .filter((group) => group.kind === 'endpoint')
    .flatMap((group) => group.models.map((model) => ({ value: model.id, label: `${group.label || group.id} · ${model.label || model.model}` })));
}

export function analyzerEngineOptions(
  staticValues: readonly string[],
  endpointModels: readonly AnalyzerEngineOption[],
  current: string,
  /** Server-provided labels for the static entries (analyzer.fallback.target's value state); raw value otherwise. */
  labels: Readonly<Record<string, string>> = {},
): AnalyzerEngineOption[] {
  const options: AnalyzerEngineOption[] = staticValues.map((value) => ({ value, label: labels[value] ?? value }));
  for (const model of endpointModels) {
    if (!options.some((o) => o.value === model.value)) options.push(model);
  }
  if (current !== '' && !options.some((o) => o.value === current)) {
    options.push({ value: current, label: `${current} (not in the current model list)` });
  }
  return options;
}
