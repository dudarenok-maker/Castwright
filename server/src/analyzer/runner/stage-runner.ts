/* One stage runner for every analyzer engine (#3084). Generalised from the
   pre-extraction OllamaAnalyzer.runStage / GeminiAnalyzer.runStage; every
   difference between them lives in the ValidationRetryPolicy, and every wire
   difference in the ChatTransport. */
import { writeFile } from 'node:fs/promises';
import { z } from 'zod';
import { writeInbox, errorPath, rawAttemptPath, type HandoffKey } from '../../handoff/protocol.js';
import type { StageCall } from '../types.js';
import { AnalyzerInvalidOutputError, AnalyzerReasoningOverflowError, GeminiContentBlockedError } from '../errors.js';
import type { ReasoningLevel } from '../reasoning-level.js';
import { hasReasoningEvidence, mapFinish, withThinkEvidence } from './finish.js';
import { stripPayloadTemperature, withoutPayloadOutputCap } from './extra-params.js';
import { parseAndValidate, persistResponse, stripThink, summariseDetail } from './parse.js';
import { buildSystemInstruction, estimateInputTokens, loadSkill, type SkillName } from './prompt.js';
import type { ValidationRetryPolicy } from './retry-policy.js';
import type {
  ChatMessage,
  ChatTransport,
  FreeTextInput,
  StructuredOutputMode,
  StructuredOutputRequest,
  TransportResult,
} from './transport.js';

export interface StageSpec<T> {
  manuscriptId: string;
  key: HandoffKey;
  skillName: SkillName;
  promptMd: string;
  grammarSchema: z.ZodType<unknown>;
  validationSchema: z.ZodType<T>;
}

export interface EngineRequestSettings {
  structuredOutput: StructuredOutputMode;
  maxOutputTokens: number | undefined;
  /** #3084 wave 5 — omitted/undefined = the pre-W5 wire. */
  reasoning?: ReasoningLevel;
  /** #3084 wave 5 — omitted/undefined = no custom payload. */
  extraParams?: Record<string, unknown>;
}

export type SchemaAdapter = (draft07: Record<string, unknown>) => { schema: Record<string, unknown>; dropped: string[] };
export const identitySchemaAdapter: SchemaAdapter = (schema) => ({ schema, dropped: [] });

export class StageRunner {
  readonly transport: ChatTransport;
  private readonly policy: ValidationRetryPolicy;
  private readonly settings: () => EngineRequestSettings;
  private readonly adaptSchema: SchemaAdapter;

  constructor(opts: {
    transport: ChatTransport;
    policy: ValidationRetryPolicy;
    settings: () => EngineRequestSettings;
    adaptSchema: SchemaAdapter;
  }) {
    this.transport = opts.transport;
    this.policy = opts.policy;
    this.settings = opts.settings;
    this.adaptSchema = opts.adaptSchema;
  }

  async runStage<T>(spec: StageSpec<T>, call: StageCall): Promise<T> {
    const { manuscriptId, key, promptMd } = spec;
    const tag = this.transport.kind;
    const model = this.transport.model;
    await writeInbox(manuscriptId, key, promptMd);

    const skill = await loadSkill(spec.skillName);
    const system = buildSystemInstruction(skill, call.language, spec.skillName);
    /* Bind the request settings once for this call (#3084 Task 3b.2): the same
       structured-output mode builds the request and identifies the final throw
       below. maxOutputTokens stays read inside send(), after prepare() warms
       the catalog Auto max-output resolution depends on (wave 2b). */
    const settings = this.settings();
    const structuredOutput = this.structuredOutput(key, spec.grammarSchema, settings);

    const start = Date.now();
    const tick = call.onWaiting ? setInterval(() => call.onWaiting!(Date.now() - start), 500) : null;

    try {
      const firstMessages: ChatMessage[] = [{ role: 'user', content: promptMd }];
      const firstText = await this.send(system, firstMessages, this.policy.initialTemperature(), structuredOutput, call, true);

      const firstAttempt = parseAndValidate(firstText, spec.validationSchema);
      if (firstAttempt.ok) {
        if (firstAttempt.repaired && this.policy.warnsOnRepair) {
          console.warn(`[${tag}] ${model} ${key} required JSON cleanup before parse (markdown fence and/or unescaped quotes)`);
        }
        await persistResponse(manuscriptId, key, firstText);
        return firstAttempt.value;
      }

      /* Forensics: raw bytes (policy-gated) then the structured error. */
      if (this.policy.writesRawAttempts) {
        await writeFile(rawAttemptPath(manuscriptId, key, 1), firstText, 'utf8');
      }
      await writeFile(
        errorPath(manuscriptId, key),
        JSON.stringify({ kind: firstAttempt.kind, detail: firstAttempt.detail, attempt: 1 }, null, 2),
        'utf8',
      );

      const retry = this.policy.buildRetry({ messages: firstMessages, firstRaw: firstText, failure: firstAttempt });
      const secondText = await this.send(system, retry.messages, retry.temperature, structuredOutput, call, true, true);

      const secondAttempt = parseAndValidate(secondText, spec.validationSchema);
      if (secondAttempt.ok) {
        if (secondAttempt.repaired && this.policy.warnsOnRepair) {
          console.warn(`[${tag}] ${model} ${key} required JSON cleanup on retry (markdown fence and/or unescaped quotes)`);
        }
        await persistResponse(manuscriptId, key, secondText);
        return secondAttempt.value;
      }

      if (this.policy.writesRawAttempts) {
        await writeFile(rawAttemptPath(manuscriptId, key, 2), secondText, 'utf8');
      }
      await writeFile(
        errorPath(manuscriptId, key),
        JSON.stringify(
          {
            kind: secondAttempt.kind,
            detail: secondAttempt.detail,
            attempt: 2,
            firstError: { kind: firstAttempt.kind, detail: firstAttempt.detail },
          },
          null,
          2,
        ),
        'utf8',
      );
      throw new AnalyzerInvalidOutputError(
        this.transport.kind,
        model,
        key,
        `${secondAttempt.kind} — ${summariseDetail(secondAttempt.detail)}`,
        settings.structuredOutput,
      );
    } finally {
      if (tick) clearInterval(tick);
    }
  }

  /* srv-59 Task 9 — flagged-window attribution escalation. Deliberately NOT
     runStage: an empty/blocked/unparseable reply must resolve to null so the
     caller skips the window, and there is no validation retry (Gemini's
     transport-level retries still apply inside send()). The prompt is fully
     self-contained: a single user turn, no system instruction. What rethrows
     is the policy's call (Ollama: abort + unreachable; Gemini: abort only). */
  async runSingleAttempt<T>(
    spec: Omit<StageSpec<T>, 'skillName' | 'grammarSchema'> & { grammarSchema: z.ZodType<unknown> },
    call: StageCall,
  ): Promise<T | null> {
    const tag = this.transport.kind;
    const model = this.transport.model;
    await writeInbox(spec.manuscriptId, spec.key, spec.promptMd);
    const settings = this.settings();
    const structuredOutput = this.structuredOutput(spec.key, spec.grammarSchema, settings);

    let text: string;
    try {
      text = await this.send('', [{ role: 'user', content: spec.promptMd }], this.policy.initialTemperature(), structuredOutput, call, false);
    } catch (err) {
      if (this.policy.escalationRethrows(err)) throw err;
      /* #3084 P20 — still skip the window, but report the overflow first: the
         same settings overflow on every later window, and only the route can
         stop them (it empties the book's escalation budget). */
      if (err instanceof AnalyzerReasoningOverflowError) call.onReasoningOverflow?.(err);
      console.warn(`[${tag}] ${model} ${spec.key} produced no usable response: ${(err as Error)?.message ?? err}`);
      return null;
    }

    const attempt = parseAndValidate(text, spec.validationSchema);
    if (!attempt.ok) {
      console.warn(`[${tag}] ${model} ${spec.key} failed to parse: ${attempt.kind}`);
      return null;
    }
    await persistResponse(spec.manuscriptId, spec.key, text);
    return attempt.value;
  }

  /** #3084 W4 — one unstructured, single-attempt call (persona generation, spec §10).
      No schema, no validation retry, no chunking, and NO engine output cap: free text gets the
      model's default length, as the persona calls had before they ran through a transport.
      It carries the engine's reasoning level and custom payload (wave 5), minus the payload's output-cap keys (A4).
      Returns the answer text with a leading <think> block removed. An empty string is returned
      as-is for the caller to judge; a blocked response and a length stop that produced only
      reasoning throw, so neither failure is collapsed into an empty answer. */
  async runFreeText(input: FreeTextInput): Promise<string> {
    /* The runner awaits prepare(signal) before it reads settings, as wave 2's private send does (P26). */
    await this.transport.prepare?.(input.signal);
    const settings = this.settings();
    const system = input.system ?? '';
    const sent = await this.transport.send({
      system,
      messages: [{ role: 'user', content: input.prompt }],
      structuredOutput: { mode: 'off' },
      temperature: input.temperature,
      maxOutputTokens: undefined,
      reasoning: settings.reasoning,
      /* A4 — a persona request carries the engine's payload WITHOUT its output-cap keys: free text
         takes the model's own length (W4), and a cap chosen for chapter work would truncate a voice
         description. Every other payload key applies (P19). */
      extraParams: withoutPayloadOutputCap(this.transport.kind, settings.extraParams),
      /* The persona limiter estimate from voice-style.ts:219 at 6c3a0a49 (its Gemini branch's `const estTokens`): ~chars/4 plus a flat margin. */
      estimatedInputTokens: Math.ceil((system.length + input.prompt.length) / 4) + 200,
      signal: input.signal,
      call: {},
      /* The persona ceiling is the one free-text field EVERY transport reads (owner decision 4.3-B1). */
      freeText: {
        ...input.ollama,
        ...(input.absoluteMaxMs !== undefined ? { absoluteMaxMs: input.absoluteMaxMs } : {}),
      },
    });
    const think = stripThink(sent.text);
    const answer: TransportResult = think.unterminated
      ? { ...sent, text: '', reasoningSeen: true }
      : { ...sent, text: think.text };
    if (answer.finish === 'blocked') {
      /* Gemini reports an empty STOP reply (or none at all) through the same 'blocked' finish as a real
         filter; that is an empty persona, not a block, so the caller's empty-persona guard words it. */
      const real = answer.blockReason && answer.blockReason !== 'FINISH_REASON_UNSPECIFIED' && answer.blockReason !== 'STOP';
      if (!real) return '';
      throw new GeminiContentBlockedError(this.transport.model, answer.blockReason, { transport: this.transport.kind });
    }
    if (answer.finish === 'length' && answer.text.trim() === '' && hasReasoningEvidence(answer)) {
      throw new AnalyzerReasoningOverflowError(this.transport.kind, this.transport.model, answer.usage?.reasoningTokens, { persona: true, reasoningLevel: settings.reasoning });
    }
    return answer.text;
  }

  /* The GRAMMAR schema (may differ from the validation schema) as draft-07
     with reused:'inline' so no $ref reaches the provider. Only built in
     'schema' mode; pre-W1 Gemini never built one. */
  private structuredOutput(
    key: HandoffKey,
    grammarSchema: z.ZodType<unknown>,
    settings: EngineRequestSettings,
  ): StructuredOutputRequest {
    const mode = settings.structuredOutput;
    if (mode !== 'schema') return { mode };
    const draft07 = z.toJSONSchema(grammarSchema, { target: 'draft-07', reused: 'inline' }) as Record<string, unknown>;
    const adapted = this.adaptSchema(draft07);
    /* identitySchemaAdapter (wave 1's only adapter) always returns dropped:[]
       — a provider-specific adapter (wave 3) that narrows the schema for its
       own constrained-decoding dialect can drop keys draft-07 offered but the
       provider can't express. Surface it now rather than leaving the field
       write-only until wave 3 needs it (pr-review-gate pass 1 finding 7). */
    if (adapted.dropped.length > 0) {
      console.warn(`[${this.transport.kind}] ${this.transport.model} ${key} schema adapter dropped: ${adapted.dropped.join(', ')}`);
    }
    return { mode: 'schema', name: String(key).replace(/[^A-Za-z0-9_-]/g, '_'), schema: adapted.schema };
  }

  private async send(
    system: string,
    messages: ChatMessage[],
    temperature: number,
    structuredOutput: StructuredOutputRequest,
    call: StageCall,
    withEvalTiming: boolean,
    stripTemperature = false,
  ): Promise<string> {
    /* #3084 wave 2b — warm whatever settings resolution reads synchronously
       (the Gemini model catalog behind Auto max output tokens) BEFORE reading
       settings, on every request. The caller's signal lets pause release a
       warm-up (P26). structuredOutput() reads settings().structuredOutput
       before the first send without this await, so that field must never
       depend on prepare(). */
    await this.transport.prepare?.(call.signal);
    const settings = this.settings();
    /* D9: a payload temperature sets attempt 1 only; on the validation retry the retry policy's
       temperature (req.temperature, applied natively) must win. */
    const extraParams = stripTemperature ? stripPayloadTemperature(this.transport.kind, settings.extraParams) : settings.extraParams;
    const result = await this.transport.send({
      system,
      messages,
      structuredOutput,
      temperature,
      maxOutputTokens: settings.maxOutputTokens,
      reasoning: settings.reasoning,
      extraParams,
      estimatedInputTokens: estimateInputTokens(
        system,
        messages.map((m) => ({ role: m.role === 'assistant' ? ('model' as const) : ('user' as const), parts: [{ text: m.content }] })),
      ),
      signal: call.signal,
      call: {
        onChunk: call.onChunk,
        onThrottle: call.onThrottle,
        onEvalTiming: withEvalTiming ? call.onEvalTiming : undefined,
      },
    });
    return mapFinish(withThinkEvidence(result), { kind: this.transport.kind, model: this.transport.model, reasoningLevel: settings.reasoning });
  }
}

