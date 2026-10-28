/* #3084 wave 5 (D8, spec §8) — reasoning levels per engine family and per
   endpoint control style. Pure: no settings, capabilities or workspace import
   (those modules import THIS one; see the plan's cycle note). Its value
   imports are leaves: errors.ts (type-only import), catalog/gemini-catalog.ts
   (node:crypto, @google/genai, the import-free redact.ts) and ollama-tag.ts
   (its one import, the import-free model-id.ts).
   Every parameter type below is structural so AnalyzerEndpoint /
   ModelCapabilityRecord / UserSettings satisfy it.

   Sources:
   - Gemini levels per model: ai.google.dev/gemini-api/docs/generate-content/thinking
     and ai.google.dev/gemini-api/docs/latest-model (both re-verified 2026-09-13
     per owner feedback F2, which focuses this table on the current 3.x Flash
     family and retires the 2.5 thinkingBudget control): 3.8/3.7 Flash and
     3.1 Pro offer low/medium/high (MINIMAL is a 400); 3.6/3.5 Flash and
     3.5/3.1 Flash-Lite offer minimal/low/medium/high; no 3.x model can disable
     thinking. The two pages disagree on the 3.8/3.7 default (thinking page:
     low; 3.8 page: medium), so nothing here may depend on a default —
     `model-default` omits the field, same as an unknown id. Sending both
     `thinkingLevel` and `thinkingBudget` is a 400 — moot here, since this
     table never sends `thinkingBudget` (below). Gemma 4 on/off = thinkingLevel
     HIGH / MINIMAL: ai.google.dev/gemma/docs/core/gemma_on_gemini_api.
   - **2.5 is out of scope (F2).** Gemini 2.5 is legacy and Google is steering
     users to 3.x; the `thinkingBudget` control and its 1024/8192/24576 tier
     values are retired entirely, not just left unused. A 2.5 model id gets
     `model-default` only, exactly like an id this table has never heard of.
   - Ollama think values: true | false | "low" | "medium" | "high"; a level or
     true on a non-thinking model is a 400 (research 06 §16-17).
   - llama.cpp accepts reasoning_effort "none" (thinking off) and passes other
     strings to the template unvalidated; vLLM accepts none…high (research 06
     §3, §11). Help text must say a server may accept a level and ignore it. */

import type { AnalysisEngine } from './model-id.js';
import { AnalyzerReasoningUnavailableError, type TransportKind } from './errors.js';
import { geminiModelThinks } from './catalog/gemini-catalog.js';
import { entryForModelTag } from './ollama-tag.js';
export { REASONING_LEVELS, type ReasoningLevel } from './reasoning-level.js'; // review pass 3, item 2 — moved to a leaf so errors.ts can import it with no cycle back through here
import type { ReasoningLevel } from './reasoning-level.js';

/** Mirrors REASONING_STYLES in workspace/analyzer-endpoints.ts (pinned by reasoning.test.ts). */
export type ReasoningStyle = 'reasoning_effort' | 'enable_thinking' | 'not_controllable';

interface EndpointReasoningView {
  id: string;
  name: string;
  reasoningStyle: ReasoningStyle;
}
interface ReasoningRecordView {
  reasoning?: Partial<Record<ReasoningLevel, 'accepted' | 'rejected'>>;
}
export interface ReasoningSelection {
  engine: AnalysisEngine;
  model: string;
  endpoint?: EndpointReasoningView;
  record?: ReasoningRecordView;
}

const STYLE_LEVELS: Record<ReasoningStyle, readonly ReasoningLevel[]> = {
  reasoning_effort: ['model-default', 'none', 'minimal', 'low', 'medium', 'high'],
  enable_thinking: ['model-default', 'off', 'on'],
  not_controllable: ['model-default'],
};

export function levelsForReasoningStyle(style: ReasoningStyle): readonly ReasoningLevel[] {
  return STYLE_LEVELS[style];
}

export const OLLAMA_NAMED_LEVELS = ['low', 'medium', 'high'] as const satisfies readonly ReasoningLevel[];
const OLLAMA_BASE_LEVELS: readonly ReasoningLevel[] = ['model-default', 'off', 'on'];

/* F2 (2026-09-13) — 'thinkingBudget' is retired: the table covers only the
   3.x Flash family (thinkingLevel) and Gemma 4 (gemmaOnOff). A 2.5 id matches
   no row and offers model-default only, like any id this table has never
   heard of. */
type GeminiControl = 'thinkingLevel' | 'gemmaOnOff';
const LEVEL_FULL: ReasoningLevel[] = ['model-default', 'minimal', 'low', 'medium', 'high'];
const LEVEL_NO_MINIMAL: ReasoningLevel[] = ['model-default', 'low', 'medium', 'high'];

/* First match wins. Flash-Lite rows precede Flash rows, and every Flash row
   also carries (?!-lite), so a new "-lite" id never inherits a Flash row. An id
   that matches nothing — including every Gemini 2.5 id — offers model-default only. */
/* defaultLevel (review item 2, 2026-09-13; corrected review pass 2 per
   docs/superpowers/specs/2026-09-11-openai-compatible-analyzer-planning-facts.md §C.2, re-verified
   2026-09-13) — the level Google's docs name as the model's own default. It decides only whether a
   model-default overflow still has a lower rung to suggest (Task 5.5b's reasoningOverflowFixes); the
   wire keeps omitting the field at model-default regardless. Gemma's gemmaOnOff row carries none —
   its model-default is outside the thinking rule entirely (P27) and never gets a reasoning fix at all.
   3 Flash (bare, no dot-version — "gemini-3-flash-preview") defaults to `high`, distinct from 3.5/3.6
   Flash's `medium` (facts §C.2: "3.6 Flash / 3.5 Flash / 3 Flash: minimal supported; default medium
   (3.6/3.5), high (3 Flash)"), so it is its own row rather than sharing 3.5/3.6's. */
export const GEMINI_REASONING_TABLE: ReadonlyArray<{ match: RegExp; control: GeminiControl; levels: ReasoningLevel[]; defaultLevel?: ReasoningLevel }> = [
  { match: /^gemini-3\.(?:5|1)-flash-lite(?:$|-)/, control: 'thinkingLevel', levels: LEVEL_FULL, defaultLevel: 'minimal' },
  { match: /^gemini-3-flash(?!-lite)(?:$|-)/, control: 'thinkingLevel', levels: LEVEL_FULL, defaultLevel: 'high' },
  { match: /^gemini-3\.(?:5|6)-flash(?!-lite)(?:$|-)/, control: 'thinkingLevel', levels: LEVEL_FULL, defaultLevel: 'medium' },
  { match: /^gemini-3\.(?:7|8)-flash(?!-lite)(?:$|-)/, control: 'thinkingLevel', levels: LEVEL_NO_MINIMAL, defaultLevel: 'medium' },
  { match: /^gemini-3\.1-pro(?:$|-)/, control: 'thinkingLevel', levels: LEVEL_NO_MINIMAL, defaultLevel: 'high' },
  { match: /^gemma-4-/, control: 'gemmaOnOff', levels: ['model-default', 'off', 'on'] },
];

export function geminiReasoningRow(model: string) {
  const id = model.replace(/^models\//, '');
  return GEMINI_REASONING_TABLE.find((row) => row.match.test(id));
}

export function defaultReasoningLevel(engine: AnalysisEngine): ReasoningLevel {
  return engine === 'local' ? 'off' : 'model-default';
}

export function offeredReasoningLevels(sel: ReasoningSelection): ReasoningLevel[] {
  switch (sel.engine) {
    case 'openai':
      return sel.endpoint ? [...levelsForReasoningStyle(sel.endpoint.reasoningStyle)] : ['model-default'];
    case 'gemini':
      return [...(geminiReasoningRow(sel.model)?.levels ?? ['model-default'])];
    case 'local':
      return [...OLLAMA_BASE_LEVELS, ...OLLAMA_NAMED_LEVELS.filter((l) => sel.record?.reasoning?.[l] === 'accepted')];
  }
}

/** The levels a Test action probes: what is offered, plus Ollama's named levels,
    which are offered only after a Test has accepted them. */
export function testableReasoningLevels(sel: ReasoningSelection): ReasoningLevel[] {
  return sel.engine === 'local' ? [...OLLAMA_BASE_LEVELS, ...OLLAMA_NAMED_LEVELS] : offeredReasoningLevels(sel);
}

/* N10 — the guard `reasoningWireFragment` falls back on. A level only reaches it when a value slipped
   past every save rule AND the pre-run check (a hand-edited user-settings.json), so it is reported as
   the same coded refusal, marked `mid-run`: the failure taxonomy then names the setting instead of
   surfacing an uncoded throw from inside a request. `modelId` is the model the transport holds (for an
   endpoint, its bare model name). */
function unavailable(kind: TransportKind, model: string, level: ReasoningLevel): AnalyzerReasoningUnavailableError {
  return new AnalyzerReasoningUnavailableError(model, level, kind === 'ollama' ? 'local' : kind, 'mid-run');
}

export function reasoningWireFragment(
  kind: TransportKind,
  sel: { model: string; endpoint?: Pick<EndpointReasoningView, 'reasoningStyle'> },
  level: ReasoningLevel,
): Record<string, unknown> {
  switch (kind) {
    case 'ollama': {
      if (level === 'model-default') return {};
      if (level === 'off') return { think: false };
      if (level === 'on') return { think: true };
      if ((OLLAMA_NAMED_LEVELS as readonly string[]).includes(level)) return { think: level };
      throw unavailable(kind, sel.model, level);
    }
    case 'gemini': {
      const row = geminiReasoningRow(sel.model);
      if (!(row?.levels ?? ['model-default']).includes(level)) throw unavailable(kind, sel.model, level);
      if (level === 'model-default' || !row) return {};
      /* P19: every request that thinks asks for thought summaries (they feed the heartbeat and never
         enter the answer). `off` (Gemma's MINIMAL — the only row with an `off` level; thinkingBudget
         is retired, F2) does not think, so it carries none. */
      const thoughts = level === 'off' ? {} : { includeThoughts: true };
      if (row.control === 'gemmaOnOff') {
        return { thinkingConfig: { thinkingLevel: level === 'on' ? 'HIGH' : 'MINIMAL', ...thoughts } };
      }
      /* F2 — 'thinkingBudget' is retired; every remaining row is 'thinkingLevel'. */
      return { thinkingConfig: { thinkingLevel: level.toUpperCase(), ...thoughts } };
    }
    case 'openai': {
      const style = sel.endpoint?.reasoningStyle ?? 'not_controllable';
      if (!levelsForReasoningStyle(style).includes(level)) throw unavailable(kind, sel.model, level);
      if (level === 'model-default') return {};
      if (style === 'reasoning_effort') return { reasoning_effort: level };
      return { chat_template_kwargs: { enable_thinking: level === 'on' } };
    }
  }
}

/** P27 — whether ONE Gemini request thinks. The static id rule (W2's geminiModelThinks) decides the
    model's default; a level that turns thinking on (Gemma `on`, any 3.x level above `off`)
    makes the request a thinking request, and a level that turns it off (Gemma's `off`, i.e.
    MINIMAL) makes it a non-thinking one. A 2.5 id has no row, so any level falls back to the id
    rule (F2). Settings alone decide it, never the catalog. It agrees with
    reasoningWireFragment's includeThoughts for every offered level (reasoning.test.ts). A level the
    model does not offer falls back to the id rule: reasoningWireFragment refuses that request, and the
    pre-run check refuses the run (P17), before anything is sent. One function feeds both
    `includeThoughts` and the thinking window (Task 5.3). */
export function geminiRequestThinks(model: string, level: ReasoningLevel | undefined): boolean {
  if (level === undefined || level === 'model-default') return geminiModelThinks(model);
  const row = geminiReasoningRow(model);
  if (!row || !row.levels.includes(level)) return geminiModelThinks(model);
  return level !== 'off';
}

/* N10 — stored values are plain strings: a value this version does not know (e.g. `xhigh`) loads,
   and the pre-run check refuses it as stale (P17). */
interface ReasoningSettingsView {
  analyzerReasoningByEngine?: { ollama?: Record<string, string>; gemini?: Record<string, string> };
}

export function resolveReasoningSetting(
  settings: ReasoningSettingsView,
  sel: { engine: AnalysisEngine; model: string; endpoint?: { reasoning: string } },
): ReasoningLevel {
  switch (sel.engine) {
    case 'local':
      /* P18: per model. N7: one Ollama model id — a bare tag and its `:latest` form are the same model. */
      return (entryForModelTag(settings.analyzerReasoningByEngine?.ollama, sel.model) as ReasoningLevel | undefined) ?? defaultReasoningLevel('local');
    case 'gemini':
      return (settings.analyzerReasoningByEngine?.gemini?.[sel.model] as ReasoningLevel | undefined) ?? defaultReasoningLevel('gemini');
    case 'openai':
      return (sel.endpoint?.reasoning as ReasoningLevel | undefined) ?? defaultReasoningLevel('openai');
  }
}

/** Copy for failure messages and help text: which setting controls reasoning
    for this engine/endpoint, and what it is sent as. */
export function reasoningControlDescription(
  kind: TransportKind,
  sel: { model: string; endpoint?: EndpointReasoningView },
): string {
  if (kind === 'ollama') {
    return 'the Ollama reasoning setting (Advanced settings → Analyzer request controls; sent as "think")';
  }
  if (kind === 'gemini') {
    const row = geminiReasoningRow(sel.model);
    const where = `the Gemini reasoning setting for ${sel.model} (Advanced settings → Analyzer request controls`;
    /* F2 — a 2.5 id has no row (thinkingBudget is retired), so it reads the same as an unknown id. */
    if (!row) return `${where}) — this model's reasoning cannot be controlled from Castwright yet`;
    if (row.control === 'gemmaOnOff') return `${where}; sent as thinkingLevel — "off" sends MINIMAL)`;
    return `${where}; sent as thinkingLevel — this model cannot turn thinking off, the lowest level is ${row.levels[1]})`;
  }
  if (!sel.endpoint) {
    return "this endpoint's Reasoning setting (its control style decides whether it is sent as reasoning_effort or chat_template_kwargs.enable_thinking)";
  }
  const name = `the "${sel.endpoint.name}" endpoint's Reasoning setting`;
  switch (sel.endpoint.reasoningStyle) {
    case 'reasoning_effort':
      return `${name} (sent as reasoning_effort)`;
    case 'enable_thinking':
      return `${name} (sent as chat_template_kwargs.enable_thinking)`;
    case 'not_controllable':
      return `${name} — its control style is "not controllable"; switch it to reasoning_effort or enable_thinking if the server supports one`;
  }
}



