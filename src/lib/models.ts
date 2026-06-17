/* Frontend-facing list of analysis models. Each entry's `engine` tag tells
   the server which dispatch path to take when the id is sent as a per-
   request `model` override (Ollama tags always contain `:`, Gemini ids
   never do — see selectAnalyzer in server/src/analyzer/index.ts).

   The user picks from these in three places:
     - upload screen "Analysis model" dropdown
     - re-parse modal "Analyse with"
     - analysing view's per-run override
   Account view's "Default analysis model" also reads this list. */

export interface ModelOption {
  id: string;
  label: string;
  hint?: string;
  engine: 'local' | 'gemini';
}

export const MODEL_OPTIONS: ModelOption[] = [
  /* --- Local (Ollama) — small → large, default first ----------------- */
  {
    id: 'qwen3.5:4b',
    label: 'Qwen3.5 4B (local)',
    hint: 'Recommended default — ~3 GB VRAM, stays resident across the analysis loop',
    engine: 'local',
  },
  {
    id: 'qwen3.5:9b',
    label: 'Qwen3.5 9B (local)',
    hint: '~6.6 GB VRAM, stronger on edge cases; unloads between chapters',
    engine: 'local',
  },
  {
    id: 'llama3.1:8b',
    label: 'Llama 3.1 8B (local)',
    hint: '~5 GB VRAM, stays resident across the analysis loop; stronger than the 4B on dialogue-dense edge cases',
    engine: 'local',
  },
  /* --- Gemini API (direct or fallback) — sorted by free-tier headroom,
        most-comfortable first. Hints carry the live RPM/TPM/RPD limits
        pulled from aistudio.google.com/app/rate-limit on 2026-05-16 so
        the picker sets the user's expectation BEFORE they pick a model
        and watch it stall mid-run. The new server-side limiter blocks
        proactively rather than letting these limits surface as 429s,
        but the daily caps below still bound the total work each model
        can do in a session. ----------------------------------------- */
  {
    id: 'gemma-4-31b-it',
    label: 'Gemma 4 31B',
    hint: '15 RPM, unlimited TPM, 1,500/day — best fit for long-chapter books',
    engine: 'gemini',
  },
  {
    id: 'gemma-4-26b-a4b-it',
    label: 'Gemma 4 26B',
    hint: '15 RPM, unlimited TPM, 1,500/day — lighter Gemma variant',
    engine: 'gemini',
  },
  {
    id: 'gemini-3.1-flash-lite',
    label: 'Gemini 3.1 Flash Lite',
    hint: '15 RPM, 250K TPM, 500/day — fastest Gemini, comfortably parses a novel',
    engine: 'gemini',
  },
  {
    id: 'gemini-3.5-flash',
    label: 'Gemini 3.5 Flash',
    hint: '5 RPM, 250K TPM, 20/day — strongest Flash, but only enough for a short book',
    engine: 'gemini',
  },
  {
    id: 'gemini-3-flash-preview',
    label: 'Gemini 3 Flash',
    hint: '5 RPM, 250K TPM, 20/day — only enough for a short book',
    engine: 'gemini',
  },
  {
    id: 'gemini-2.5-flash',
    label: 'Gemini 2.5 Flash',
    hint: '5 RPM, 250K TPM, 20/day — only enough for a short book',
    engine: 'gemini',
  },
];

import { FRONTEND_ACCOUNT_DEFAULTS } from './account-defaults';

/* Frontend's view of the "no settings hydrated yet" default. Single source
   of truth lives in src/lib/account-defaults.ts — flip there once and the
   slice, mock, and per-book pick fallback all follow. */
export const DEFAULT_MODEL = FRONTEND_ACCOUNT_DEFAULTS.defaultAnalysisModel;

/** Engine classification from the id shape — Ollama tags contain ':',
    Gemini ids never do. Matches the server's inferEngineFromModelId. Use this
    everywhere instead of looking the id up in MODEL_OPTIONS, so a dynamically-
    pulled (uncurated) local tag is still correctly classified. */
export function engineForModelId(id: string): 'local' | 'gemini' {
  return id.includes(':') ? 'local' : 'gemini';
}

/** The local subset of a run's effective model ids — the ones that actually hit
    Ollama. The analysing view warms / checks residency on THESE, never on the
    server's configured default (`/health.modelResident` keys off the default,
    which is wrong for a per-run override or per-phase pick). */
export function localRunModelIds(effectiveModelIds: readonly string[]): string[] {
  return effectiveModelIds.filter((id) => engineForModelId(id) === 'local');
}

const norm = (t: string) => (t.includes(':') ? t : `${t}:latest`);

/** True when `id` is resident in the given Ollama `/api/ps` name list, tolerating
    Ollama's tag canonicalisation (bare-name ⇄ `:latest`, family-root prefix) —
    mirrors the server-side match in `server/src/routes/ollama-health.ts`. */
export function isOllamaModelResident(id: string, resident: readonly string[]): boolean {
  const target = norm(id);
  const root = id.split(':')[0];
  return resident.some(
    (r) => norm(r) === target || (r.split(':')[0] === root && r.startsWith(`${root}:`)),
  );
}

/** Whether EVERY local model the run will execute on is resident in VRAM. Empty
    local set (a pure-cloud run) → false here; callers gate that separately with
    the engine check (a cloud run is "ready" regardless of Ollama). */
export function runModelsAllResident(
  effectiveModelIds: readonly string[],
  resident: readonly string[],
): boolean {
  const locals = localRunModelIds(effectiveModelIds);
  return locals.length > 0 && locals.every((id) => isOllamaModelResident(id, resident));
}

/** Build the local-analyzer-picker options from the live Ollama tag list —
    INSTALLED-ONLY. Each installed tag gets its curated label/hint when one
    matches (so `qwen3.5:4b` reads "Qwen3.5 4B (local)"); an installed tag with
    no curated entry becomes a bare option (so a custom local model still shows
    as-is). A curated entry that is NOT installed is deliberately omitted — the
    dropdown only lists models you can actually run. (Curated-but-not-pulled
    models are still offered for install in the Model Manager's pull list, which
    reads the server `pullable` allowlist, not this catalog.)

    The picker is never blank: the Gemini group always renders alongside this
    one (see buildModelOptionGroups). Replaces the older curated-∪-live union;
    the change is intentional — see plan 221 invariant 1. */
export function buildLocalModelOptions(
  liveTags: Array<{ name: string; size?: number }>,
  curated: ModelOption[] = MODEL_OPTIONS.filter((m) => m.engine === 'local'),
): ModelOption[] {
  const curatedByTag = new Map(curated.map((m) => [norm(m.id), m]));
  const out: ModelOption[] = [];
  const seen = new Set<string>();
  for (const tag of liveTags) {
    const key = norm(tag.name);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(curatedByTag.get(key) ?? { id: tag.name, label: tag.name, engine: 'local' });
  }
  return out;
}

/** Grouped form for <optgroup>-rendering pickers. Gemini is the curated static
    catalog; the local group is whatever was merged from live tags. Keeps the
    optgroup labels in one place so the upload / re-parse / analysing pickers
    stay in sync. Gemini renders first because it's now the default analyzer
    engine — local Ollama follows as the on-device alternative. */
export function buildModelOptionGroups(localOptions: ModelOption[]): Array<{
  engine: 'local' | 'gemini';
  label: string;
  models: ModelOption[];
}> {
  return [
    {
      engine: 'gemini',
      label: 'Gemini API (default)',
      models: MODEL_OPTIONS.filter((m) => m.engine === 'gemini'),
    },
    { engine: 'local', label: 'Local Ollama (on-device)', models: localOptions },
  ];
}

/** Back-compat static export: groups built from the CURATED local entries only
    (no live tags). Existing importers without store access keep working; the
    dynamic pickers (later task) call buildModelOptionGroups(live) instead. */
export const MODEL_OPTION_GROUPS = buildModelOptionGroups(
  MODEL_OPTIONS.filter((m) => m.engine === 'local'),
);
