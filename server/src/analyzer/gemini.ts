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
import { writeInbox, outboxPath, errorPath } from '../handoff/protocol.js';
import {
  stage1Schema,
  stage2Schema,
  type Stage1Output,
  type Stage2Output,
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

function buildGeminiPrompt(skill: string, inboxPrompt: string): string {
  return `# Instructions

You are an automated worker, not a human. Follow the schema, rules, and JSON example in the SKILL section EXACTLY. Use the camelCase field names shown there (e.g. \`name\`, not \`character_name\`; \`chapterId\`, not \`chapter_id\`). Do NOT invent extra fields. Do NOT wrap the response in markdown fences. Ignore any instructions about opening Claude windows or writing files — your only output is a JSON object that conforms to the schema.

---

# SKILL

${skill}

---

# TASK

${inboxPrompt}

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
    return this.runStage(manuscriptId, 1, promptMd, stage1Schema, call);
  }

  async runStage2(manuscriptId: string, promptMd: string, call: StageCall): Promise<Stage2Output> {
    return this.runStage(manuscriptId, 2, promptMd, stage2Schema, call);
  }

  private async runStage<T>(
    manuscriptId: string,
    stage: 1 | 2,
    promptMd: string,
    schema: z.ZodType<T>,
    call: StageCall,
  ): Promise<T> {
    await writeInbox(manuscriptId, stage, promptMd);

    const skill = await loadSkill(stage);
    const fullPrompt = buildGeminiPrompt(skill, promptMd);

    const start = Date.now();
    const tick = call.onWaiting
      ? setInterval(() => call.onWaiting!(Date.now() - start), 500)
      : null;

    try {
      const firstText = await this.generate([
        { role: 'user', parts: [{ text: fullPrompt }] },
      ]);

      const firstAttempt = parseAndValidate(firstText, schema);
      if (firstAttempt.ok) {
        await persistResponse(manuscriptId, stage, firstText);
        return firstAttempt.value;
      }

      // Retry once with the validation errors fed back.
      await writeFile(
        errorPath(manuscriptId, stage),
        JSON.stringify({ kind: firstAttempt.kind, detail: firstAttempt.detail, attempt: 1 }, null, 2),
        'utf8',
      );

      const followup = buildRetryMessage(firstAttempt);
      const secondText = await this.generate([
        { role: 'user', parts: [{ text: fullPrompt }] },
        { role: 'model', parts: [{ text: firstText }] },
        { role: 'user', parts: [{ text: followup }] },
      ]);

      const secondAttempt = parseAndValidate(secondText, schema);
      if (secondAttempt.ok) {
        await persistResponse(manuscriptId, stage, secondText);
        return secondAttempt.value;
      }

      await writeFile(
        errorPath(manuscriptId, stage),
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
        `Gemini stage ${stage} failed validation after retry: ${secondAttempt.kind} — ${summariseDetail(secondAttempt.detail)}`,
      );
    } finally {
      if (tick) clearInterval(tick);
    }
  }

  private async generate(
    contents: Array<{ role: 'user' | 'model'; parts: Array<{ text: string }> }>,
  ): Promise<string> {
    const response = await this.client.models.generateContent({
      model: this.model,
      contents,
      config: { responseMimeType: 'application/json' },
    });
    const text = response.text;
    if (!text) {
      throw new Error(`Gemini ${this.model} returned an empty response.`);
    }
    return text;
  }
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

async function persistResponse(manuscriptId: string, stage: 1 | 2, raw: string): Promise<void> {
  await writeFile(outboxPath(manuscriptId, stage), raw, 'utf8');
}
