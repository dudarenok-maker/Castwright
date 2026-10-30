/* #3084 W3 — what a model accepts and enforces, recorded by the Test action (spec §2,
   P7) and checked before a run's first call. Pure helpers first; the request ladder
   (runModelTest) is appended by Task 3c.4. */
import { z } from 'zod';
import { randomBytes } from 'node:crypto';
import type { UserSettings } from '../workspace/user-settings.js';
import type { AdaptedSchema, ChatTransport, StructuredOutputMode, TransportRequest, TransportResult } from './runner/transport.js';
import { jsonParseCandidates, stripThink } from './runner/parse.js';
import {
  AnalysisAbortedError,
  AnalyzerCapabilityRejectedError,
  AnalyzerEndpointMissingError,
  AnalyzerHttpError,
  AnalyzerReasoningUnavailableError,
} from './errors.js';
import { estimateInputTokens } from './runner/prompt.js';
import { configValue } from '../config/resolver.js';
/* #3192 moved the Ollama URL resolver into this leaf (not user-settings.ts). */
import { getResolvedOllamaUrl } from '../config/ollama-resolved.js';
import { resolveEndpointApiKey, type AnalyzerEndpoint } from '../workspace/analyzer-endpoints.js';
import { inferEngineFromModelId, parseEndpointModelId, type AnalysisEngine } from './model-id.js';
import { entryForModelTag } from './ollama-tag.js';
import { sameServer } from './capability-record-merge.js';
import { namesContextOrTokenLimit } from './limit-400-patterns.js';
import {
  defaultReasoningLevel,
  offeredReasoningLevels,
  resolveReasoningSetting,
  testableReasoningLevels,
  type ReasoningLevel,
  type ReasoningSelection,
} from './reasoning.js';
import {
  emotionAnnotationSchema,
  escalationSchema,
  nonStoryClassificationSchema,
  scriptReviewSchema,
  stage1ChapterGrammarSchema,
  stage1GrammarSchema,
  stage2ChapterSchema,
  stage3ChapterSchema,
} from '../handoff/schemas.js';

export type ProbeOutcome = 'enforced' | 'ignored' | 'rejected' | 'accepted';

export interface ModelCapabilityRecord {
  /** Endpoint baseUrl, Ollama URL, or 'gemini'. A record for another URL is discarded. */
  serverUrl: string;
  testedAt: string;
  /** W3 saves only `{ ok: true }`: a failed control saves nothing (Task 3c.4). */
  control: { ok: true } | { ok: false; error: string };
  /** mode → reasoning level the requests actually sent → outcome (P7). */
  structuredOutput: Partial<Record<StructuredOutputMode, Record<string, ProbeOutcome>>>;
  /** Keys are ReasoningLevel values but stay `string` (as stored values are, N10), so this stays
      mutually assignable with the persisted schema. Required-keyed, not `Partial`: the persisted
      `modelCapabilityRecordSchema` (user-settings.ts) infers `z.record`, so a record typed by that
      schema and this interface must agree (Task 3c.3 Step 4 typecheck). A key is only ever present
      with a verdict. */
  reasoning: Record<string, 'accepted' | 'rejected'>;
  /** 3c (A3): Ollama only — the installed model's `/api/tags` digest when the Test ran. A record
      whose digest differs from the model installed now is discarded, like a moved server URL,
      so `ollama pull` of a fixed build cannot leave a stale `rejected` refusing every run. */
  digest?: string;
  /** #3084 wave 5 (A2) — each verdict's own Test date, keyed like the verdicts; a verdict with no
      entry takes `testedAt`. Mirrors modelCapabilityRecordSchema exactly (both directions, strict). */
  verdictTestedAt?: { reasoning?: Record<string, string>; structuredOutput?: Record<string, Record<string, string>> };
}

export interface ModelTestDeps {
  transport: ChatTransport;
  serverUrl: string;
  /** 3c (A3): Ollama only — resolves the installed model's digest, stamped on the record. Absent
      for Gemini and endpoints (no digest exists). A rejection or throw stamps nothing. */
  modelDigest?: () => Promise<string | undefined>;
  configuredMode: StructuredOutputMode;
  offeredModes: readonly StructuredOutputMode[];
  adaptSchema: (draft07: Record<string, unknown>) => AdaptedSchema;
  /** P7: the model's context size and resolved Auto output cap (`null` = no cap, the context
      governs). Read once, after `transport.prepare()` has warmed served limits (P15). */
  probeLimits: () => { contextTokens: number; maxOutputTokens: number | null };
  /** #3084 wave 5 — engine, bare model, endpoint and Test record for the id (reasoning.ts shape). */
  reasoningSelection: (modelId: string) => ReasoningSelection;
  /** #3084 wave 5 — the level the next run of this model would send (resolveReasoningSetting). */
  configuredReasoning: (modelId: string) => ReasoningLevel;
  /** #3084 wave 5b (P19) — the engine/endpoint custom payload a run would send; every ladder request carries it. */
  extraParams?: Record<string, unknown>;
  /** The client's abort signal: the route aborts it when the request closes. */
  signal?: AbortSignal;
  now?: () => Date;
  markerValue?: () => string;
  redact?: (text: string) => string;
}

export const ALL_STRUCTURED_OUTPUT_MODES: readonly StructuredOutputMode[] = ['schema', 'json', 'off'];

export const STAGE_GRAMMAR_SCHEMAS: ReadonlyArray<{ name: string; schema: z.ZodType<unknown> }> = [
  { name: 'stage1GrammarSchema', schema: stage1GrammarSchema },
  { name: 'stage1ChapterGrammarSchema', schema: stage1ChapterGrammarSchema },
  { name: 'stage2ChapterSchema', schema: stage2ChapterSchema },
  { name: 'emotionAnnotationSchema', schema: emotionAnnotationSchema },
  { name: 'nonStoryClassificationSchema', schema: nonStoryClassificationSchema },
  { name: 'scriptReviewSchema', schema: scriptReviewSchema },
  { name: 'stage3ChapterSchema', schema: stage3ChapterSchema },
  { name: 'escalationSchema', schema: escalationSchema },
];

/** The exact conversion the stage runner uses (today `ollama.ts:505`). */
export function draft07(schema: z.ZodType<unknown>): Record<string, unknown> {
  return z.toJSONSchema(schema, { target: 'draft-07', reused: 'inline' }) as Record<string, unknown>;
}

/** The largest real stage schema by serialised length — measured at call time. */
export function largestStageSchema(): { name: string; schema: Record<string, unknown> } {
  let best = { name: STAGE_GRAMMAR_SCHEMAS[0].name, schema: draft07(STAGE_GRAMMAR_SCHEMAS[0].schema) };
  let bestChars = JSON.stringify(best.schema).length;
  for (const entry of STAGE_GRAMMAR_SCHEMAS.slice(1)) {
    const schema = draft07(entry.schema);
    const chars = JSON.stringify(schema).length;
    if (chars > bestChars) {
      best = { name: entry.name, schema };
      bestChars = chars;
    }
  }
  return best;
}

/** Required key the probe prompt never mentions: only an enforced schema produces it. */
export const MARKER_KEY = 'cw_probe_marker';

export function newMarkerValue(): string {
  return `mk-${randomBytes(6).toString('hex')}`;
}

export function withMarker(schema: Record<string, unknown>, marker: string): Record<string, unknown> {
  const properties = {
    ...((schema.properties as Record<string, unknown> | undefined) ?? {}),
    [MARKER_KEY]: { type: 'string', enum: [marker] },
  };
  const required = [...((schema.required as string[] | undefined) ?? []), MARKER_KEY];
  return { ...schema, properties, required };
}

/** `enforced` only when the output, after the runner's own extraction and repair chain,
    is an object whose marker key carries the exact value. The chain is W1's `<think>` strip,
    then parseAndValidate's candidates (fence strip, trailing-prose trim, structural and quote
    repairs). Some models write their reasoning before the JSON in a form the runner does not
    strip (`Thinking Process:`, `[THINK]…[/THINK]`). For those, the text is also tried from its
    first `{`, so a model that followed the schema after thinking out loud is never recorded
    "not enforced". */
export function classifyMarkerProbe(text: string, marker: string): 'enforced' | 'ignored' {
  const answer = stripThink(text).text;
  const firstBrace = answer.indexOf('{');
  const seeds = firstBrace > 0 ? [answer, answer.slice(firstBrace)] : [answer];
  const seen = new Set<string>();
  for (const seed of seeds) {
    for (const candidate of jsonParseCandidates(seed)) {
      if (seen.has(candidate)) continue;
      seen.add(candidate);
      let parsed: unknown;
      try {
        parsed = JSON.parse(candidate);
      } catch {
        continue;
      }
      if (
        parsed !== null &&
        typeof parsed === 'object' &&
        !Array.isArray(parsed) &&
        (parsed as Record<string, unknown>)[MARKER_KEY] === marker
      ) {
        return 'enforced';
      }
    }
  }
  return 'ignored';
}

export { capabilityRecordKey, sameCapabilityRecordModel } from './ollama-tag.js';

/** A2 — the date of the Test that recorded one verdict: its own `verdictTestedAt` entry, else the
    record's `testedAt` (a record written before per-verdict dates existed). The pre-run refusal cites
    this, never a newer date a later Test of another verdict brought in. */
export function verdictTestedAtFor(
  record: ModelCapabilityRecord,
  cell:
    | { setting: 'reasoning'; reasoning: string }
    | { setting: 'structuredOutput'; structuredOutput: StructuredOutputMode; reasoning: string },
): string {
  const own =
    cell.setting === 'reasoning'
      ? record.verdictTestedAt?.reasoning?.[cell.reasoning]
      : record.verdictTestedAt?.structuredOutput?.[cell.structuredOutput]?.[cell.reasoning];
  return own ?? record.testedAt;
}

export function capabilityRecordFor(
  settings: UserSettings,
  modelId: string,
  currentServerUrl: string,
  /** A3: the digest of the model installed now (Ollama only). Unknown → the record is kept. */
  currentDigest?: string,
): ModelCapabilityRecord | undefined {
  /* N7 — an Ollama record saved under either tag form answers for the other; an endpoint id is exact. */
  const stored =
    inferEngineFromModelId(modelId) === 'openai'
      ? settings.analyzerCapabilitiesByModel[modelId]
      : entryForModelTag(settings.analyzerCapabilitiesByModel, modelId);
  if (!stored || !sameServer(stored.serverUrl, currentServerUrl)) return undefined;
  /* A3: a record written for another build of the model says nothing about this one. Fail-open on
     an unknown current digest: the check never invents a discard it cannot see a reason for. */
  if (stored.digest !== undefined && currentDigest !== undefined && stored.digest !== currentDigest) return undefined;
  return stored;
}

export function assertConfiguredCapabilitiesAllowed(
  record: ModelCapabilityRecord | undefined,
  configured: { structuredOutput: StructuredOutputMode; reasoning: string },
  modelId: string,
): void {
  if (!record || !record.control.ok) return;
  if (record.reasoning[configured.reasoning] === 'rejected') {
    throw new AnalyzerCapabilityRejectedError(modelId, 'reasoning', configured.reasoning, verdictTestedAtFor(record, { setting: 'reasoning', reasoning: configured.reasoning }));
  }
  /* P7: only a rejection recorded at the level this run sends refuses it. */
  if (record.structuredOutput[configured.structuredOutput]?.[configured.reasoning] === 'rejected') {
    throw new AnalyzerCapabilityRejectedError(
      modelId,
      'structuredOutput',
      configured.structuredOutput,
      verdictTestedAtFor(record, { setting: 'structuredOutput', structuredOutput: configured.structuredOutput, reasoning: configured.reasoning }),
    );
  }
}

/** #3084 — one target's pre-run checks (3c.10), shared by runAnalyzerPreflight and a fallback
    target's first call (P30). Here rather than in preflight.ts because index.ts must not import
    preflight.ts (preflight → select-analyzer → index is a cycle). */
export function assertAnalyzerTargetUsable(
  target: { modelId: string; source: 'env' | 'run-pick' | 'settings'; engine: AnalysisEngine },
  settings: UserSettings,
  digest?: string,
  /** P17/N10 — 'mid-run' when a fallback target's first call runs this (index.ts checkedTarget):
      the run has started, so Task 5.5's copy must not say it was not started. */
  when: 'before-start' | 'mid-run' = 'before-start',
): void {
  if (target.engine === 'openai') {
    const parsed = parseEndpointModelId(target.modelId);
    const endpoint = parsed ? settings.analyzerEndpoints.find((e) => e.id === parsed.endpointId) : undefined;
    if (!parsed || !endpoint) throw new AnalyzerEndpointMissingError(parsed?.endpointId ?? target.modelId, target.source, parsed ? 'not-saved' : 'not-an-endpoint');
    resolveEndpointApiKey(settings, endpoint, endpoint.baseUrl); // throws AnalyzerKeyOriginError for a key bound to another host
    assertConfiguredCapabilitiesAllowed(
      capabilityRecordFor(settings, target.modelId, endpoint.baseUrl),
      { structuredOutput: endpoint.structuredOutput, reasoning: assertConfiguredReasoningOffered(settings, target.modelId, target.engine, undefined, when) },
      target.modelId,
    );
  } else if (target.engine === 'gemini') {
    assertConfiguredCapabilitiesAllowed(
      capabilityRecordFor(settings, target.modelId, 'gemini'),
      { structuredOutput: configValue<StructuredOutputMode>('analyzer.gemini.structuredOutput'), reasoning: assertConfiguredReasoningOffered(settings, target.modelId, target.engine, undefined, when) },
      target.modelId,
    );
  } else {
    assertConfiguredCapabilitiesAllowed(
      capabilityRecordFor(settings, target.modelId, getResolvedOllamaUrl(), digest),
      { structuredOutput: configValue<StructuredOutputMode>('analyzer.ollama.structuredOutput'), reasoning: assertConfiguredReasoningOffered(settings, target.modelId, target.engine, digest, when) },
      target.modelId,
    );
  }
}

export function plannedTestRequestCount(
  input: { modelId: string; scope: 'configured' | 'all' },
  deps: Pick<ModelTestDeps, 'configuredMode' | 'offeredModes' | 'reasoningSelection' | 'configuredReasoning'>,
): number {
  const sel = deps.reasoningSelection(input.modelId);
  const levels = reasoningLevelsToProbe(input.scope, sel, deps.configuredReasoning(input.modelId));
  const modes = input.scope === 'all' ? deps.offeredModes : [deps.configuredMode];
  /* P7 ladder: the control; the level step's requests (every level other than the control's); one
     mode step per `schema` / `json` mode. A rejected configured level skips the mode steps, so this
     is the upper bound the confirmation shows. */
  return 1 + plannedReasoningProbeCount(levels, defaultReasoningLevel(sel.engine)) + modes.filter((mode) => mode !== 'off').length;
}

/** The control request failed, so nothing could be attributed. Nothing is saved; an
    earlier record stays (spec §2). */
export class ModelTestControlFailedError extends Error {
  constructor(
    readonly modelId: string,
    detail: string,
  ) {
    super(`The control request to ${modelId} failed, so nothing could be tested: ${detail} Nothing was recorded; any earlier test result is kept.`);
    this.name = 'ModelTestControlFailedError';
  }
}

/** A step's outcome cannot be attributed to the field it changed. Nothing is saved. */
export class ModelTestInconclusiveError extends Error {
  constructor(
    readonly modelId: string,
    readonly step: StructuredOutputMode,
    detail: string,
  ) {
    super(`The ${step} check for ${modelId} was inconclusive (${detail}). Nothing was recorded; any earlier test result is kept. Run the test again.`);
    this.name = 'ModelTestInconclusiveError';
  }
}

/** P7 — an inconclusive LEVEL step. It runs in `off` mode, but its copy names the level, never "The off check". */
export class ReasoningLevelTestInconclusiveError extends ModelTestInconclusiveError {
  constructor(
    modelId: string,
    readonly level: ReasoningLevel,
    detail: string,
  ) {
    super(modelId, 'off', detail);
    this.message = `The reasoning level "${level}" check for ${modelId} was inconclusive (${detail}). Nothing was recorded; any earlier test result is kept. Run the test again.`;
    this.name = 'ReasoningLevelTestInconclusiveError';
  }
}

/* P7 — a 400 whose provider text names a context, token or length limit is about the request's
   size, not about the field the step changed, so it is inconclusive. The table and
   namesContextOrTokenLimit live in the leaf ./limit-400-patterns.ts (3b Task 3b.1), shared with
   the failure taxonomy's max-output hint (P24); add rows there, never here. */

const PROBE_SYSTEM = 'You are a JSON generator. Output only JSON.';
/** P7: the one prompt every step sends. It names no key, so only an enforced schema yields the marker. */
export const PROBE_PROMPT =
  'Return one JSON object. If you were given a response format, satisfy it; otherwise return {"ok": true}. Use empty arrays, zeros and short placeholder strings wherever a value is required.';

type ProbeFormat = TransportRequest['structuredOutput'];

/** P7: the one output cap every step uses — the model's resolved Auto cap clamped to the
    context minus the largest step's estimated input. */
export function probeOutputCap(limits: { contextTokens: number; maxOutputTokens: number | null }, estimatedInputTokens: number): number {
  const room = Math.max(1, limits.contextTokens - estimatedInputTokens);
  return limits.maxOutputTokens !== null && limits.maxOutputTokens > 0 ? Math.min(limits.maxOutputTokens, room) : room;
}

function estimateProbeInput(format: ProbeFormat): number {
  /* An enforced schema is input on every provider that enforces it: charge its JSON as prompt text. */
  const formatText = format.mode === 'schema' ? `\n${JSON.stringify(format.schema)}` : '';
  return estimateInputTokens(PROBE_SYSTEM, [{ role: 'user', parts: [{ text: `${PROBE_PROMPT}${formatText}` }] }]);
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new AnalysisAbortedError('Model test cancelled: the client left.');
}

/** A probe is `rejected` only on a 400 (AnalyzerHttpError from Ollama/OpenAI, or
    the Gemini SDK's ApiError status 400). */
export function isProbeRejected(err: unknown): boolean {
  if (err instanceof AnalyzerHttpError) return err.httpStatus === 400;
  return (err as { status?: unknown } | null)?.status === 400; // @google/genai ApiError
}

/** The provider's own words: the error message plus, for a transport HTTP error, its body excerpt. */
function providerText(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  return err instanceof AnalyzerHttpError ? `${message} ${err.bodyExcerpt}` : message;
}

function sendStep(deps: ModelTestDeps, format: ProbeFormat, maxOutputTokens: number, reasoning: ReasoningLevel): Promise<TransportResult> {
  throwIfAborted(deps.signal);
  return deps.transport.send({
    system: PROBE_SYSTEM,
    messages: [{ role: 'user', content: PROBE_PROMPT }],
    structuredOutput: format,
    temperature: 0,
    maxOutputTokens,
    estimatedInputTokens: estimateProbeInput(format),
    signal: deps.signal,
    reasoning,
    extraParams: deps.extraParams,
    call: {},
  });
}

function formatFor(mode: Exclude<StructuredOutputMode, 'off'>, marker: string, deps: ModelTestDeps): ProbeFormat {
  if (mode === 'json') return { mode: 'json' };
  const largest = largestStageSchema();
  return { mode: 'schema', name: `castwright_probe_${largest.name}`, schema: deps.adaptSchema(withMarker(largest.schema, marker)).schema };
}

async function modeStep(
  modelId: string,
  mode: Exclude<StructuredOutputMode, 'off'>,
  format: ProbeFormat,
  marker: string,
  cap: number,
  level: ReasoningLevel,
  deps: ModelTestDeps,
  redact: (text: string) => string,
): Promise<ProbeOutcome> {
  let result: TransportResult;
  try {
    result = await sendStep(deps, format, cap, level);
  } catch (err) {
    if (err instanceof AnalysisAbortedError) throw err;
    if (isProbeRejected(err)) {
      if (!namesContextOrTokenLimit(providerText(err))) return 'rejected';
      throw new ModelTestInconclusiveError(modelId, mode, 'the provider refused the request size, not the mode');
    }
    throw new ModelTestInconclusiveError(modelId, mode, redact(err instanceof Error ? err.message : String(err)).slice(0, 300));
  }
  /* Only a `stop` finish is evidence: a `length` or `blocked` finish says nothing about the mode. */
  if (result.finish !== 'stop') throw new ModelTestInconclusiveError(modelId, mode, `finish=${result.finish}`);
  return mode === 'schema' ? classifyMarkerProbe(result.text, marker) : 'accepted';
}

export function reasoningLevelsToProbe(
  scope: 'configured' | 'all',
  sel: ReasoningSelection,
  configured: ReasoningLevel,
): ReasoningLevel[] {
  return scope === 'all' ? testableReasoningLevels(sel) : [configured];
}

export function plannedReasoningProbeCount(levels: readonly ReasoningLevel[], controlLevel: ReasoningLevel): number {
  return levels.filter((l) => l !== controlLevel).length;
}

/** The level step (spec §2, P7): `send(level)` sends the control request with only `reasoning`
    changed (runModelTest passes `sendStep(deps, { mode: 'off' }, cap, level)`). It proves
    acceptance only, and classifies failures exactly as W3c's modeStep does. */
export async function probeReasoningLevels(
  levels: readonly ReasoningLevel[],
  deps: {
    modelId: string;
    controlLevel: ReasoningLevel;
    send: (level: ReasoningLevel) => Promise<TransportResult>;
    redact?: (text: string) => string;
  },
): Promise<ModelCapabilityRecord['reasoning']> {
  const redact = deps.redact ?? ((t: string) => t);
  const out: ModelCapabilityRecord['reasoning'] = {};
  for (const level of levels) {
    if (level === deps.controlLevel) {
      out[level] = 'accepted'; // the control request already ran at this level
      continue;
    }
    try {
      await deps.send(level);
    } catch (err) {
      if (err instanceof AnalysisAbortedError) throw err;
      /* P20 — a GeminiContentBlockedError and an AnalyzerReasoningOverflowError are handled alike here,
         as W3c's modeStep handles them: inconclusive, below. A transport returns `blocked` / `length` as a
         finish (only the runner's mapFinish raises either error), and a Test is not a run to stop. */
      if (isProbeRejected(err)) {
        if (!namesContextOrTokenLimit(providerText(err))) {
          out[level] = 'rejected';
          continue;
        }
        /* P7: a 400 naming a context, token or length limit is about the request size, not the level. */
        throw new ReasoningLevelTestInconclusiveError(deps.modelId, level, 'the provider refused the request size, not the level');
      }
      /* P7: a 5xx after the transport's retries, a timeout or an unreachable server proves nothing about
         the level. Inconclusive: nothing is recorded and the route answers 502. */
      throw new ReasoningLevelTestInconclusiveError(deps.modelId, level, redact(err instanceof Error ? err.message : String(err)).slice(0, 300));
    }
    /* P7: the provider accepted the request. Any finish counts, `length` and `blocked` included:
       a thinking model spends the cap reasoning, which is the shape a level step expects. */
    out[level] = 'accepted';
  }
  return out;
}

export async function runModelTest(
  input: { modelId: string; scope: 'configured' | 'all' },
  deps: ModelTestDeps,
): Promise<ModelCapabilityRecord> {
  const redact = deps.redact ?? ((t: string) => t);
  const testedAt = (deps.now ?? (() => new Date()))().toISOString();
  /* P7: the control runs at the engine's default level; the level step and the mode steps at the
     configured level. Every record is keyed by the level its requests actually sent. */
  const sel = deps.reasoningSelection(input.modelId);
  const controlLevel = defaultReasoningLevel(sel.engine);
  const configuredLevel = deps.configuredReasoning(input.modelId);
  const modes = input.scope === 'all' ? deps.offeredModes : [deps.configuredMode];
  const marker = (deps.markerValue ?? newMarkerValue)();
  const control: ProbeFormat = { mode: 'off' };
  const stepFormats = new Map<StructuredOutputMode, ProbeFormat>(
    modes.filter((m): m is Exclude<StructuredOutputMode, 'off'> => m !== 'off').map((m) => [m, formatFor(m, marker, deps)]),
  );

  throwIfAborted(deps.signal);
  await deps.transport.prepare?.(deps.signal); // P15: served limits are warm before the cap is read; P26: leaving releases the warm-up
  const largestInput = Math.max(estimateProbeInput(control), ...[...stepFormats.values()].map(estimateProbeInput));
  const cap = probeOutputCap(deps.probeLimits(), largestInput);

  /* Step 1 — control: `off` mode at the engine's default level. Any finish passes. */
  try {
    await sendStep(deps, control, cap, controlLevel);
  } catch (err) {
    if (err instanceof AnalysisAbortedError) throw err;
    throw new ModelTestControlFailedError(input.modelId, redact(err instanceof Error ? err.message : String(err)).slice(0, 500));
  }

  /* Step 2 — the level step (P7): `off` mode, differing from the control only in `reasoning`. */
  const reasoning = await probeReasoningLevels(reasoningLevelsToProbe(input.scope, sel, configuredLevel), {
    modelId: input.modelId,
    controlLevel,
    redact,
    send: (level) => sendStep(deps, control, cap, level),
  });

  /* Step 3 — one mode step per tested mode, at the configured level. An `off` step is the level
     step (or the control), already sent. A rejected configured level leaves nothing to attribute. */
  const structuredOutput: ModelCapabilityRecord['structuredOutput'] = {};
  if (reasoning[configuredLevel] !== 'rejected') {
    for (const mode of modes) {
      const format = stepFormats.get(mode);
      structuredOutput[mode] = {
        [configuredLevel]:
          format && mode !== 'off' ? await modeStep(input.modelId, mode, format, marker, cap, configuredLevel, deps, redact) : 'accepted',
      };
    }
  }
  /* A3: stamp the installed build, so a later `ollama pull` discards this record rather than
     letting a stale verdict refuse runs. Best-effort: no digest, no stamp. */
  const digest = deps.modelDigest ? await deps.modelDigest().catch(() => undefined) : undefined;
  /* A2: each verdict's own date, so a later merge can keep a verdict without claiming this Test measured it. */
  const verdictTestedAt = {
    reasoning: Object.fromEntries(Object.keys(reasoning).map((level) => [level, testedAt])),
    structuredOutput: Object.fromEntries(
      Object.entries(structuredOutput).map(([mode, byLevel]) => [mode, Object.fromEntries(Object.keys(byLevel ?? {}).map((level) => [level, testedAt]))]),
    ),
  };
  return {
    serverUrl: deps.serverUrl,
    testedAt,
    control: { ok: true },
    structuredOutput,
    reasoning,
    ...(digest ? { digest } : {}),
    verdictTestedAt,
  };
}

/** Engine, bare model, saved endpoint and Test record for a model id. `engine` defaults to the id
    inference; persona generation passes it, because a bare local tag (`llama2`) infers as Gemini.
    `currentDigest` (A3) is the local engine's installed-model digest, threaded to `capabilityRecordFor`
    exactly as W3c's own structured-output check already threads it, so the two checks discard the same
    stale record instead of disagreeing about which one applies. Only `runAnalyzerPreflight` has a digest
    to pass — it already resolved one per target before either check runs. Every other caller
    (`modelTestDepsFor`, the catalog's `toEntry`, persona generation) omits it, which is `capabilityRecordFor`'s
    own fail-open rule (kept when either digest is unknown), unchanged from 3c. Gemini and endpoints carry
    no digest, so `currentDigest` is passed to `capabilityRecordFor` only when `engine === 'local'`. */
export function reasoningSelectionFor(
  settings: UserSettings,
  modelId: string,
  engine: AnalysisEngine = inferEngineFromModelId(modelId),
  currentDigest?: string,
): ReasoningSelection & { endpoint?: AnalyzerEndpoint } {
  if (engine !== 'openai') {
    return {
      engine,
      model: modelId,
      record: capabilityRecordFor(
        settings,
        modelId,
        engine === 'local' ? getResolvedOllamaUrl() : 'gemini',
        engine === 'local' ? currentDigest : undefined,
      ),
    };
  }
  const parsed = parseEndpointModelId(modelId);
  const endpoint = parsed ? settings.analyzerEndpoints.find((e) => e.id === parsed.endpointId) : undefined;
  return { engine, model: parsed?.model ?? modelId, endpoint, record: endpoint ? capabilityRecordFor(settings, modelId, endpoint.baseUrl) : undefined };
}

/** The reasoning level the next run of this model would send. `currentDigest` passes through to
    `reasoningSelectionFor` (A3). */
export function configuredReasoningFor(
  settings: UserSettings,
  modelId: string,
  engine: AnalysisEngine = inferEngineFromModelId(modelId),
  currentDigest?: string,
): ReasoningLevel {
  const sel = reasoningSelectionFor(settings, modelId, engine, currentDigest);
  return resolveReasoningSetting(settings, { engine: sel.engine, model: sel.model, endpoint: sel.endpoint });
}

/** P17 — the level the next run would send, refused when the current rules no longer offer it (a Gemini
    table change, an Ollama named level without its accepted Test record, an endpoint level saved under
    another control style, or a stored value this version does not know, N10). Returns the level, so a
    caller can hand it straight to `assertConfiguredCapabilitiesAllowed`. `when` is 'mid-run' for a
    fallback target's first call. */
export function assertConfiguredReasoningOffered(
  settings: UserSettings,
  modelId: string,
  engine: AnalysisEngine = inferEngineFromModelId(modelId),
  currentDigest?: string,
  when: 'before-start' | 'mid-run' = 'before-start',
): ReasoningLevel {
  const sel = reasoningSelectionFor(settings, modelId, engine, currentDigest);
  const level = resolveReasoningSetting(settings, { engine: sel.engine, model: sel.model, endpoint: sel.endpoint });
  /* N10: an unknown stored value (e.g. `xhigh`) is never offered, so it is refused here too. */
  if (!offeredReasoningLevels(sel).includes(level)) throw new AnalyzerReasoningUnavailableError(modelId, level, sel.engine, when);
  return level;
}

/** #3084 wave 5 (5.4-D1) — persona generation's pre-run reasoning check. A persona request sends a
    reasoning level and no structured output, so only the reasoning half applies: the level must still be
    offered (P17, AnalyzerReasoningUnavailableError) and must not be one this model's own Test recorded
    `rejected` (AnalyzerCapabilityRejectedError, citing that verdict's own date, A2). No digest: persona
    keeps capabilityRecordFor's fail-open rule. */
export function assertPersonaReasoningAllowed(
  settings: UserSettings,
  modelId: string,
  engine: AnalysisEngine = inferEngineFromModelId(modelId),
): ReasoningLevel {
  const level = assertConfiguredReasoningOffered(settings, modelId, engine);
  /* The full record, not reasoningSelectionFor's `record` (typed as reasoning.ts's narrow view). */
  let record: ModelCapabilityRecord | undefined;
  if (engine === 'openai') {
    const parsed = parseEndpointModelId(modelId);
    const endpoint = parsed ? settings.analyzerEndpoints.find((e) => e.id === parsed.endpointId) : undefined;
    record = endpoint ? capabilityRecordFor(settings, modelId, endpoint.baseUrl) : undefined;
  } else {
    record = capabilityRecordFor(settings, modelId, engine === 'local' ? getResolvedOllamaUrl() : 'gemini');
  }
  if (record?.control.ok && record.reasoning[level] === 'rejected') {
    throw new AnalyzerCapabilityRejectedError(modelId, 'reasoning', level, verdictTestedAtFor(record, { setting: 'reasoning', reasoning: level }));
  }
  return level;
}
