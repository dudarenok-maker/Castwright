/* #3084 — the one analyzer model label resolver (spec §3 "Labels"). Order: curated
   MODEL_OPTIONS label → `<endpoint name> · <model>` for an OpenAI-compatible endpoint id →
   the catalog entry's `label` (Gemini's live displayName, else the id; the Ollama tag) →
   the raw id. */
import { MODEL_OPTIONS } from './models';
import { parseEndpointModelId } from './model-id';
import type { AnalyzerCatalog, AnalyzerCatalogEntry } from './types';

export function catalogEntryFor(id: string, catalog: AnalyzerCatalog | null | undefined): AnalyzerCatalogEntry | undefined {
  if (!catalog) return undefined;
  for (const group of catalog.groups) {
    const hit = group.models.find((m) => m.id === id);
    if (hit) return hit;
  }
  return undefined;
}

/* A Map, not a MODEL_OPTIONS .find() lookup: model-label.guard.test.ts bans that shape. */
const CURATED_LABELS = new Map(MODEL_OPTIONS.map((m) => [m.id, m.label]));

export function modelLabel(id: string, catalog?: AnalyzerCatalog | null): string {
  const curated = CURATED_LABELS.get(id);
  if (curated) return curated;
  /* Endpoint ids first: an endpoint entry's own `label` is the bare model name. */
  const parsed = parseEndpointModelId(id);
  if (parsed) {
    const group = catalog?.groups.find((g) => g.kind === 'endpoint' && g.id === parsed.endpointId);
    return `${group?.label ?? parsed.endpointId} · ${parsed.model}`;
  }
  const entry = catalogEntryFor(id, catalog);
  if (entry) return entry.label;
  return id;
}

/** Suffixes a run label shows after the model name. W3: the structured-output label.
    W5 (custom payload) appends '+ custom params' here. */
export function runLabelSuffixes(entry: AnalyzerCatalogEntry | undefined): string[] {
  return entry ? [entry.structuredOutput.label] : [];
}
