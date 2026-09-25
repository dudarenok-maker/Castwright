/* One stage runner for every analyzer engine (#3084). Generalised from the
   pre-extraction OllamaAnalyzer.runStage / GeminiAnalyzer.runStage; every
   difference between them lives in the ValidationRetryPolicy, and every wire
   difference in the ChatTransport. */
import { writeFile } from 'node:fs/promises';
import { z } from 'zod';
import { writeInbox, errorPath, rawAttemptPath, type HandoffKey } from '../../handoff/protocol.js';
import type { StageCall } from '../types.js';
import { AnalyzerReasoningOverflowError } from '../errors.js';
import { mapFinish, withThinkEvidence } from './finish.js';
import { parseAndValidate, persistResponse, summariseDetail } from './parse.js';
import { buildSystemInstruction, estimateInputTokens, loadSkill, type SkillName } from './prompt.js';
import type { ValidationRetryPolicy } from './retry-policy.js';
import type { ChatMessage, ChatTransport, StructuredOutputMode, StructuredOutputRequest } from './transport.js';

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
    const structuredOutput = this.structuredOutput(key, spec.grammarSchema);

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
      const secondText = await this.send(system, retry.messages, retry.temperature, structuredOutput, call, true);

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
      throw new Error(
        this.policy.finalFailureMessage({
          model,
          key,
          detail: `${secondAttempt.kind} — ${summariseDetail(secondAttempt.detail)}`,
        }),
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
    const structuredOutput = this.structuredOutput(spec.key, spec.grammarSchema);

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

  /* The GRAMMAR schema (may differ from the validation schema) as draft-07
     with reused:'inline' so no $ref reaches the provider. Only built in
     'schema' mode; pre-W1 Gemini never built one. */
  private structuredOutput(key: HandoffKey, grammarSchema: z.ZodType<unknown>): StructuredOutputRequest {
    const mode = this.settings().structuredOutput;
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
  ): Promise<string> {
    /* #3084 wave 2b — warm whatever settings resolution reads synchronously
       (the Gemini model catalog behind Auto max output tokens) BEFORE reading
       settings, on every request. The caller's signal lets pause release a
       warm-up (P26). structuredOutput() reads settings().structuredOutput
       before the first send without this await, so that field must never
       depend on prepare(). */
    await this.transport.prepare?.(call.signal);
    const settings = this.settings();
    const result = await this.transport.send({
      system,
      messages,
      structuredOutput,
      temperature,
      maxOutputTokens: settings.maxOutputTokens,
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
    return mapFinish(withThinkEvidence(result), { kind: this.transport.kind, model: this.transport.model });
  }
}

