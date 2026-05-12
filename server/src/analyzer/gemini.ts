/* Gemini analyzer — sends the same prompts the human would have run by hand
   through google.generativeai's free tier. Writes the prompt to inbox and the
   raw response to outbox for traceability (both gitignored), validates with
   the shared Zod schemas, and retries ONCE with the validation errors fed
   back as a follow-up turn before giving up. Drives the SSE progress bar
   via a setInterval ticking onWaiting while the API call is in flight. */

import { readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { GoogleGenAI } from '@google/genai';
import type { z } from 'zod';
import { writeInbox, outboxPath, errorPath, type HandoffKey } from '../handoff/protocol.js';
import {
  stage1Schema,
  stage2ChapterSchema,
  type Stage1Output,
  type Stage2ChapterOutput,
} from '../handoff/schemas.js';
import type { Analyzer, StageCall } from './index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SKILLS_DIR = resolve(__dirname, '..', '..', '..', 'skills');
const SKILL_FILES: Record<1 | 2, string> = {
  1: 'audiobook-character-analysis.md',
  2: 'audiobook-sentence-attribution.md',
};

/* Read the skill file fresh on every request so prompt iteration doesn't
   require a server restart. The files are small (~3-5 KB) and read once
   per analysis — negligible cost. */
async function loadSkill(stage: 1 | 2): Promise<string> {
  return readFile(resolve(SKILLS_DIR, SKILL_FILES[stage]), 'utf8');
}

/* The skill text is moved to `systemInstruction` rather than re-sent as
   part of `contents` on every call (see callsite). This shaves ~10 KB off
   each per-chapter stage-2 request and makes the user-turn token count
   actually proportional to the task. */
function buildSystemInstruction(skill: string): string {
  return `You are an automated worker, not a human. Follow the schema, rules, and JSON example in the SKILL section EXACTLY. Use the camelCase field names shown there (e.g. \`name\`, not \`character_name\`; \`chapterId\`, not \`chapter_id\`). Do NOT invent extra fields. Do NOT wrap the response in markdown fences. Ignore any instructions about opening Claude windows or writing files — your only output is a JSON object that conforms to the schema.

---

# SKILL

${skill}

---

Return ONLY a single JSON object that matches the schema in the SKILL section. No prose. No code fences.`;
}

interface GeminiOptions {
  apiKey: string;
  model: string;
}

export class GeminiAnalyzer implements Analyzer {
  private readonly client: GoogleGenAI;
  private readonly model: string;

  constructor(opts: GeminiOptions) {
    this.client = new GoogleGenAI({ apiKey: opts.apiKey });
    this.model = opts.model;
  }

  async runStage1(manuscriptId: string, promptMd: string, call: StageCall): Promise<Stage1Output> {
    return this.runStage(manuscriptId, '1', 1, promptMd, stage1Schema, call);
  }

  async runStage2Chapter(
    manuscriptId: string,
    chapterId: number,
    promptMd: string,
    call: StageCall,
  ): Promise<Stage2ChapterOutput> {
    const key = `2-ch${chapterId}` as const;
    return this.runStage(manuscriptId, key, 2, promptMd, stage2ChapterSchema, call);
  }

  private async runStage<T>(
    manuscriptId: string,
    key: HandoffKey,
    skillStage: 1 | 2,
    promptMd: string,
    schema: z.ZodType<T>,
    call: StageCall,
  ): Promise<T> {
    await writeInbox(manuscriptId, key, promptMd);

    const skill = await loadSkill(skillStage);
    const systemInstruction = buildSystemInstruction(skill);

    const start = Date.now();
    const tick = call.onWaiting
      ? setInterval(() => call.onWaiting!(Date.now() - start), 500)
      : null;

    try {
      const firstText = await this.generateWithRetry(
        [{ role: 'user', parts: [{ text: promptMd }] }],
        systemInstruction,
      );

      const firstAttempt = parseAndValidate(firstText, schema);
      if (firstAttempt.ok) {
        await persistResponse(manuscriptId, key, firstText);
        return firstAttempt.value;
      }

      // Retry once with the validation errors fed back.
      await writeFile(
        errorPath(manuscriptId, key),
        JSON.stringify({ kind: firstAttempt.kind, detail: firstAttempt.detail, attempt: 1 }, null, 2),
        'utf8',
      );

      const followup = buildRetryMessage(firstAttempt);
      const secondText = await this.generateWithRetry(
        [
          { role: 'user', parts: [{ text: promptMd }] },
          { role: 'model', parts: [{ text: firstText }] },
          { role: 'user', parts: [{ text: followup }] },
        ],
        systemInstruction,
      );

      const secondAttempt = parseAndValidate(secondText, schema);
      if (secondAttempt.ok) {
        await persistResponse(manuscriptId, key, secondText);
        return secondAttempt.value;
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
        `Gemini ${key} failed validation after retry: ${secondAttempt.kind} — ${summariseDetail(secondAttempt.detail)}`,
      );
    } finally {
      if (tick) clearInterval(tick);
    }
  }

  /* Single-retry policy for transient server errors (500/503/504). 429s are
     deliberately *not* retried — both flavors are counterproductive:
       • daily-quota 429s won't recover until reset; retries just confirm the
         block.
       • per-minute throttle 429s are best handled by letting the analysis
         loop's natural per-chapter pacing drift past the window, not by
         hammering with backoff inside one call.
     The route layer surfaces 429s to the UI with the friendly "switch
     model or wait" hint; the user retries explicitly when ready. */
  private async generateWithRetry(
    contents: Array<{ role: 'user' | 'model'; parts: Array<{ text: string }> }>,
    systemInstruction: string,
  ): Promise<string> {
    try {
      return await this.generate(contents, systemInstruction);
    } catch (err) {
      if (!isRetryable5xx(err)) throw err;
      console.warn(`[gemini] transient ${describeStatus(err)} — retrying once in 3s`);
      await sleep(3000);
      return await this.generate(contents, systemInstruction);
    }
  }

  private async generate(
    contents: Array<{ role: 'user' | 'model'; parts: Array<{ text: string }> }>,
    systemInstruction: string,
  ): Promise<string> {
    try {
      const response = await this.client.models.generateContent({
        model: this.model,
        contents,
        config: {
          responseMimeType: 'application/json',
          systemInstruction,
        },
      });
      const text = response.text;
      if (!text) {
        throw new Error(`Gemini ${this.model} returned an empty response.`);
      }
      return text;
    } catch (err) {
      /* The SDK's ApiError keeps the upstream body inside `.message` as a
         JSON envelope, so a bare console.error(err) only shows the stack +
         the start of the message. Force a structured dump so the server log
         carries the upstream `status` ('INTERNAL', 'INVALID_ARGUMENT', …)
         and any `details[]` payload — the only useful diagnostic for 5xx
         flakes. The route layer surfaces the same info to the UI. */
      const status = (err as { status?: number })?.status;
      const message = (err as Error)?.message ?? String(err);
      const userTurn = contents[contents.length - 1]?.parts[0]?.text ?? '';
      console.error('[gemini] generate failed', {
        model: this.model,
        status,
        name: (err as Error)?.name,
        message,
        userTurnLength: userTurn.length,
        userTurnHead: userTurn.slice(0, 200),
      });
      throw err;
    }
  }
}

function isRetryable5xx(err: unknown): boolean {
  const status = (err as { status?: number })?.status;
  return status === 500 || status === 503 || status === 504;
}

function describeStatus(err: unknown): string {
  const status = (err as { status?: number })?.status;
  if (status === 429) return '429 rate-limit';
  if (status === 503) return '503 unavailable';
  if (status === 500) return '500 internal';
  if (status === 504) return '504 timeout';
  return String(status ?? 'unknown');
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

type ParseResult<T> =
  | { ok: true; value: T }
  | { ok: false; kind: 'invalid-json'; detail: string }
  | { ok: false; kind: 'schema-validation'; detail: z.ZodIssue[] };

function parseAndValidate<T>(raw: string, schema: z.ZodType<T>): ParseResult<T> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    return { ok: false, kind: 'invalid-json', detail: (e as Error).message };
  }
  const result = schema.safeParse(parsed);
  if (!result.success) {
    return { ok: false, kind: 'schema-validation', detail: result.error.issues };
  }
  return { ok: true, value: result.data };
}

function buildRetryMessage(failure: Extract<ParseResult<unknown>, { ok: false }>): string {
  if (failure.kind === 'invalid-json') {
    return `Your previous response was not valid JSON: ${failure.detail}\n\nReturn ONLY a valid JSON object matching the schema. No prose, no markdown code fences.`;
  }
  return `Your previous response failed schema validation. Fix the following issues and resend the corrected JSON. Return ONLY the JSON object — no prose, no code fences.\n\n${JSON.stringify(failure.detail, null, 2)}`;
}

function summariseDetail(detail: unknown): string {
  if (typeof detail === 'string') return detail;
  try {
    const s = JSON.stringify(detail);
    return s.length > 240 ? `${s.slice(0, 240)}…` : s;
  } catch {
    return String(detail);
  }
}

async function persistResponse(manuscriptId: string, key: HandoffKey, raw: string): Promise<void> {
  await writeFile(outboxPath(manuscriptId, key), raw, 'utf8');
}
