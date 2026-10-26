/* #3084 wave 5 — frontend view of reasoning levels. The per-model/per-record
   level sets are computed server-side and arrive as `offeredReasoningLevels`
   on catalog entries; only the endpoint control-style table lives here, pinned
   to the server's table by reasoning-levels.test.ts via the shared fixture. */
import type { components } from './api-types';
import type { AnalyzerCatalog } from './types';
import { engineForModelId } from './model-id';

export type ReasoningLevel = components['schemas']['ReasoningLevel'];
export type ReasoningStyle = 'reasoning_effort' | 'enable_thinking' | 'not_controllable';

const STYLE_LEVELS: Record<ReasoningStyle, readonly ReasoningLevel[]> = {
  reasoning_effort: ['model-default', 'none', 'minimal', 'low', 'medium', 'high'],
  enable_thinking: ['model-default', 'off', 'on'],
  not_controllable: ['model-default'],
};

export function levelsForEndpointStyle(style: ReasoningStyle): readonly ReasoningLevel[] {
  return STYLE_LEVELS[style];
}

export const REASONING_LEVEL_LABELS: Record<ReasoningLevel, string> = {
  'model-default': 'Model default (send nothing)',
  off: 'Off',
  on: 'On',
  none: 'None',
  minimal: 'Minimal',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
};

export const REASONING_STYLE_LABELS: Record<ReasoningStyle, string> = {
  reasoning_effort: 'reasoning_effort (llama.cpp, vLLM, OpenRouter)',
  enable_thinking: 'chat_template_kwargs.enable_thinking (templates that key on it)',
  not_controllable: 'Not controllable',
};

export const REASONING_HELP =
  'Only levels this model or endpoint can take are offered. A server may accept a level and still ignore it — Castwright cannot observe that. A level the Test action recorded as rejected refuses the run before it starts.';

export interface CatalogModelReasoning {
  id: string;
  label: string;
  /** The catalog group the entry came from; an Ollama tag without ":" would infer as Gemini from its id. */
  kind: AnalyzerCatalog['groups'][number]['kind'];
  offeredReasoningLevels: ReasoningLevel[];
}

/** Every entry of a GET /api/analyzer/models response (W3c `AnalyzerCatalog`, contract
    shape `groups[].models[]`) that carries `offeredReasoningLevels`, in group order. */
export function collectCatalogModels(catalog: Pick<AnalyzerCatalog, 'groups'> | null | undefined): CatalogModelReasoning[] {
  return (catalog?.groups ?? []).flatMap((group) =>
    group.models.flatMap((m) =>
      m.offeredReasoningLevels
        ? [{ id: m.id, label: m.label, kind: group.kind, offeredReasoningLevels: m.offeredReasoningLevels as ReasoningLevel[] }]
        : [],
    ),
  );
}

const OLLAMA_BASE_LEVELS: ReasoningLevel[] = ['model-default', 'off', 'on'];
const LEVEL_ORDER: string[] = ['model-default', 'off', 'on', 'none', 'minimal', 'low', 'medium', 'high'];

/** N7 — the server's normalizeModelTag (server/src/analyzer/ollama-tag.ts): Ollama treats a bare tag and
    its `:latest` form as one model. Pinned to the server by the shared ollama-tag-cases.json fixture. */
export function normalizeOllamaTag(tag: string): string {
  return tag.endsWith(':latest') ? tag.slice(0, -':latest'.length) : tag;
}

/** N7 — a saved Ollama reasoning map keyed by normalised tag. The server stores it that way; a key saved
    before normalisation, or by hand, is folded in, and the normalised key wins. */
export function normalizeOllamaReasoningMap(saved: Record<string, string> | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [tag, level] of Object.entries(saved ?? {})) {
    const key = normalizeOllamaTag(tag);
    if (tag === key || !(key in out)) out[key] = level;
  }
  return out;
}

export interface OllamaReasoningRow {
  id: string;
  label: string;
  levels: string[];
  isCurrent: boolean;
}

/** P18 — one row per Ollama model: the current analysis model first, then every other model the
    catalog lists, then any model a saved level names that neither covers. Each row offers ITS OWN
    model's levels (the catalog's `offeredReasoningLevels`, else model-default/off/on) plus its saved
    value, so a level accepted for one model is never offered for another, and a stale saved level
    stays visible (the pre-run check refuses it, naming the model). N7: rows are keyed by the
    normalised tag, so `qwen3` and `qwen3:latest` are one row. N10: a saved value this version does not
    know stays visible after the known levels. */
export function ollamaReasoningRows(
  models: CatalogModelReasoning[],
  currentModelId: string | undefined,
  saved: Record<string, string>,
): OllamaReasoningRow[] {
  const listed = models.filter((m) => m.kind === 'ollama');
  const savedByTag = normalizeOllamaReasoningMap(saved);
  const current = currentModelId === undefined ? undefined : normalizeOllamaTag(currentModelId);
  const currentIsOllama =
    currentModelId !== undefined &&
    (listed.some((m) => normalizeOllamaTag(m.id) === current) || engineForModelId(currentModelId) === 'local');
  const ids = [
    ...(currentIsOllama && current !== undefined ? [current] : []),
    ...listed.map((m) => normalizeOllamaTag(m.id)),
    ...Object.keys(savedByTag),
  ].filter((id, i, all) => all.indexOf(id) === i);
  return ids.map((id) => {
    const entry = listed.find((m) => normalizeOllamaTag(m.id) === id);
    const levels = new Set<string>([...(entry?.offeredReasoningLevels ?? OLLAMA_BASE_LEVELS), ...(savedByTag[id] ? [savedByTag[id]] : [])]);
    return {
      id,
      label: entry?.label ?? id,
      levels: [...LEVEL_ORDER.filter((l) => levels.has(l)), ...[...levels].filter((l) => !LEVEL_ORDER.includes(l))],
      isCurrent: id === current,
    };
  });
}
