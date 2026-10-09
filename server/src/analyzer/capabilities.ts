/* #3084 W3 — what a model accepts and enforces, recorded by the Test action (spec §2,
   P7) and checked before a run's first call. Pure helpers first; the request ladder
   (runModelTest) is appended by Task 3c.4. */
import { z } from 'zod';
import { randomBytes } from 'node:crypto';
import type { UserSettings } from '../workspace/user-settings.js';
import type { ChatTransport, StructuredOutputMode, TransportRequest, TransportResult } from './runner/transport.js';
import type { AdaptedSchema } from './runner/schema-adapters.js';
import { jsonParseCandidates, stripThink } from './runner/parse.js';
import { AnalysisAbortedError, AnalyzerCapabilityRejectedError, AnalyzerHttpError, type TransportKind } from './errors.js';
import { estimateInputTokens } from './runner/prompt.js';
import { namesContextOrTokenLimit } from './limit-400-patterns.js';
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
  /** W5 narrows the key to ReasoningLevel; W3 records `{}`. Required-keyed, not
      `Partial`: the persisted `modelCapabilityRecordSchema` (user-settings.ts) infers
      `z.record`, so a record typed by that schema and this interface must agree
      (Task 3c.3 Step 4 typecheck). A key is only ever present with a verdict. */
  reasoning: Record<string, 'accepted' | 'rejected'>;
  /** 3c (A3): Ollama only — the installed model's `/api/tags` digest when the Test ran. A record
      whose digest differs from the model installed now is discarded, like a moved server URL,
      so `ollama pull` of a fixed build cannot leave a stale `rejected` refusing every run. */
  digest?: string;
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
  /** The client's abort signal: the route aborts it when the request closes. */
  signal?: AbortSignal;
  now?: () => Date;
  markerValue?: () => string;
  redact?: (text: string) => string;
}

export const ALL_STRUCTURED_OUTPUT_MODES: readonly StructuredOutputMode[] = ['schema', 'json', 'off'];

/** The reasoning level every W3 request is sent at, and so the key a Test record is filed
    under (P7). Ollama sends `think: false` on every analyzer call (`ollama.ts:652`), so
    `off`; Gemini and endpoints send no reasoning field, so `model-default`. W5 replaces this
    with reasoning.ts `defaultReasoningLevel`, which returns the same values. */
export function defaultReasoningKey(kind: TransportKind): string {
  return kind === 'ollama' ? 'off' : 'model-default';
}

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

function sameServer(a: string, b: string): boolean {
  return a.replace(/\/+$/, '') === b.replace(/\/+$/, '');
}

export function capabilityRecordFor(
  settings: UserSettings,
  modelId: string,
  currentServerUrl: string,
  /** A3: the digest of the model installed now (Ollama only). Unknown → the record is kept. */
  currentDigest?: string,
): ModelCapabilityRecord | undefined {
  const stored = settings.analyzerCapabilitiesByModel[modelId];
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
    throw new AnalyzerCapabilityRejectedError(modelId, 'reasoning', configured.reasoning, record.testedAt);
  }
  /* P7: only a rejection recorded at the level this run sends refuses it. */
  if (record.structuredOutput[configured.structuredOutput]?.[configured.reasoning] === 'rejected') {
    throw new AnalyzerCapabilityRejectedError(modelId, 'structuredOutput', configured.structuredOutput, record.testedAt);
  }
}

export function plannedTestRequestCount(
  input: { modelId: string; scope: 'configured' | 'all' },
  deps: Pick<ModelTestDeps, 'configuredMode' | 'offeredModes'>,
): number {
  /* P7 ladder: the control (`off` mode) always; wave 5 adds its level step here; then one
     mode step per `schema` / `json` mode. An `off` mode step is the control itself. */
  const modes = input.scope === 'all' ? deps.offeredModes : [deps.configuredMode];
  return 1 + modes.filter((mode) => mode !== 'off').length;
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

function isHttp400(err: unknown): boolean {
  if (err instanceof AnalyzerHttpError) return err.httpStatus === 400;
  return (err as { status?: unknown } | null)?.status === 400; // @google/genai ApiError
}

/** The provider's own words: the error message plus, for a transport HTTP error, its body excerpt. */
function providerText(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  return err instanceof AnalyzerHttpError ? `${message} ${err.bodyExcerpt}` : message;
}

function sendStep(deps: ModelTestDeps, format: ProbeFormat, maxOutputTokens: number): Promise<TransportResult> {
  throwIfAborted(deps.signal);
  return deps.transport.send({
    system: PROBE_SYSTEM,
    messages: [{ role: 'user', content: PROBE_PROMPT }],
    structuredOutput: format,
    temperature: 0,
    maxOutputTokens,
    estimatedInputTokens: estimateProbeInput(format),
    signal: deps.signal,
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
  deps: ModelTestDeps,
  redact: (text: string) => string,
): Promise<ProbeOutcome> {
  let result: TransportResult;
  try {
    result = await sendStep(deps, format, cap);
  } catch (err) {
    if (err instanceof AnalysisAbortedError) throw err;
    if (isHttp400(err)) {
      if (!namesContextOrTokenLimit(providerText(err))) return 'rejected';
      throw new ModelTestInconclusiveError(modelId, mode, 'the provider refused the request size, not the mode');
    }
    throw new ModelTestInconclusiveError(modelId, mode, redact(err instanceof Error ? err.message : String(err)).slice(0, 300));
  }
  /* Only a `stop` finish is evidence: a `length` or `blocked` finish says nothing about the mode. */
  if (result.finish !== 'stop') throw new ModelTestInconclusiveError(modelId, mode, `finish=${result.finish}`);
  return mode === 'schema' ? classifyMarkerProbe(result.text, marker) : 'accepted';
}

export async function runModelTest(
  input: { modelId: string; scope: 'configured' | 'all' },
  deps: ModelTestDeps,
): Promise<ModelCapabilityRecord> {
  const redact = deps.redact ?? ((t: string) => t);
  const testedAt = (deps.now ?? (() => new Date()))().toISOString();
  /* P7: a record is keyed by the level its requests actually sent. */
  const level = defaultReasoningKey(deps.transport.kind);
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
    await sendStep(deps, control, cap);
  } catch (err) {
    if (err instanceof AnalysisAbortedError) throw err;
    throw new ModelTestControlFailedError(input.modelId, redact(err instanceof Error ? err.message : String(err)).slice(0, 500));
  }

  /* Step 2 — WAVE 5 (Task 5a) INSERTS THE LEVEL STEP HERE: `off` mode at the configured
     reasoning level, differing from the control only in that level. It records
     `reasoning[configuredLevel]`, skips step 3 when that level is rejected, and changes
     `level` below to the configured level. W3 sends no reasoning field, so the control's
     level is the only level there is. */

  /* Step 3 — one mode step per tested mode. An `off` step is the control, already sent. */
  const structuredOutput: ModelCapabilityRecord['structuredOutput'] = {};
  for (const mode of modes) {
    const format = stepFormats.get(mode);
    structuredOutput[mode] = {
      [level]: format && mode !== 'off' ? await modeStep(input.modelId, mode, format, marker, cap, deps, redact) : 'accepted',
    };
  }
  /* A3: stamp the installed build, so a later `ollama pull` discards this record rather than
     letting a stale verdict refuse runs. Best-effort: no digest, no stamp. */
  const digest = deps.modelDigest ? await deps.modelDigest().catch(() => undefined) : undefined;
  return { serverUrl: deps.serverUrl, testedAt, control: { ok: true }, structuredOutput, reasoning: {}, ...(digest ? { digest } : {}) };
}
