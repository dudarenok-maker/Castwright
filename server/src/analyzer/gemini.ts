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
  stage1ChapterSchema,
  stage2ChapterSchema,
  type Stage1Output,
  type Stage1ChapterOutput,
  type Stage2ChapterOutput,
} from '../handoff/schemas.js';
import type { Analyzer, StageCall, StageChunkInfo } from './index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SKILLS_DIR = resolve(__dirname, '..', '..', '..', 'skills');
const SKILL_FILES = {
  /* Legacy whole-book stage 1 — kept for any caller still wiring it. */
  whole_book_stage1: 'audiobook-character-analysis.md',
  /* Phase 0a — per-chapter cast detection (the current default). */
  per_chapter_stage1: 'audiobook-character-detection-per-chapter.md',
  /* Phase 1 — per-chapter sentence attribution. */
  per_chapter_stage2: 'audiobook-sentence-attribution.md',
} as const;
export type SkillName = keyof typeof SKILL_FILES;

/* Read the skill file fresh on every request so prompt iteration doesn't
   require a server restart. The files are small (~3-5 KB) and read once
   per analysis — negligible cost. */
export async function loadSkill(skill: SkillName): Promise<string> {
  return readFile(resolve(SKILLS_DIR, SKILL_FILES[skill]), 'utf8');
}

/* The skill text is moved to `systemInstruction` rather than re-sent as
   part of `contents` on every call (see callsite). This shaves ~10 KB off
   each per-chapter stage-2 request and makes the user-turn token count
   actually proportional to the task. */
export function buildSystemInstruction(skill: string): string {
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
    return this.runStage(manuscriptId, '1', 'whole_book_stage1', promptMd, stage1Schema, call);
  }

  async runStage1Chapter(
    manuscriptId: string,
    chapterId: number,
    promptMd: string,
    call: StageCall,
  ): Promise<Stage1ChapterOutput> {
    const key = `1-ch${chapterId}` as const;
    return this.runStage(manuscriptId, key, 'per_chapter_stage1', promptMd, stage1ChapterSchema, call);
  }

  async runStage2Chapter(
    manuscriptId: string,
    chapterId: number,
    promptMd: string,
    call: StageCall,
  ): Promise<Stage2ChapterOutput> {
    const key = `2-ch${chapterId}` as const;
    return this.runStage(manuscriptId, key, 'per_chapter_stage2', promptMd, stage2ChapterSchema, call);
  }

  private async runStage<T>(
    manuscriptId: string,
    key: HandoffKey,
    skillName: SkillName,
    promptMd: string,
    schema: z.ZodType<T>,
    call: StageCall,
  ): Promise<T> {
    await writeInbox(manuscriptId, key, promptMd);

    const skill = await loadSkill(skillName);
    const systemInstruction = buildSystemInstruction(skill);

    const start = Date.now();
    const tick = call.onWaiting
      ? setInterval(() => call.onWaiting!(Date.now() - start), 500)
      : null;

    try {
      const firstText = await this.generateWithRetry(
        [{ role: 'user', parts: [{ text: promptMd }] }],
        systemInstruction,
        call.onChunk,
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
        call.onChunk,
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
    onChunk?: (info: StageChunkInfo) => void,
  ): Promise<string> {
    try {
      return await this.generate(contents, systemInstruction, onChunk);
    } catch (err) {
      if (!isRetryable5xx(err)) throw err;
      console.warn(`[gemini] transient ${describeStatus(err)} — retrying once in 3s`);
      await sleep(3000);
      return await this.generate(contents, systemInstruction, onChunk);
    }
  }

  /* Streamed generation. Iterating the stream gives us a per-chunk
     heartbeat — first chunk usually arrives within 1–3s, every subsequent
     chunk is hard proof the model is alive. The route layer surfaces this
     as a live "Receiving response · N KB · last chunk Ms ago" indicator and
     a watchdog that warns when chunks stop arriving. */
  private async generate(
    contents: Array<{ role: 'user' | 'model'; parts: Array<{ text: string }> }>,
    systemInstruction: string,
    onChunk?: (info: StageChunkInfo) => void,
  ): Promise<string> {
    try {
      const stream = await this.client.models.generateContentStream({
        model: this.model,
        contents,
        config: {
          responseMimeType: 'application/json',
          systemInstruction,
        },
      });
      const start = Date.now();
      let lastChunkAt = start;
      let buf = '';
      for await (const chunk of stream) {
        const text = chunk.text;
        if (!text) continue;
        buf += text;
        const now = Date.now();
        onChunk?.({
          receivedBytes: buf.length,
          receivedText: buf,
          sinceLastChunkMs: now - lastChunkAt,
          elapsedMs: now - start,
        });
        lastChunkAt = now;
      }
      if (!buf) {
        throw new Error(`Gemini ${this.model} returned an empty response.`);
      }
      return buf;
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

export type ParseResult<T> =
  | { ok: true; value: T; repaired: boolean }
  | { ok: false; kind: 'invalid-json'; detail: string }
  | { ok: false; kind: 'schema-validation'; detail: z.ZodIssue[] };

export function parseAndValidate<T>(raw: string, schema: z.ZodType<T>): ParseResult<T> {
  /* Pre-pass: strip a wrapping ```json ... ``` markdown fence if present.
     qwen3.5:4b occasionally ignores the system prompt's "no code fences"
     rule and emits its JSON wrapped in a fenced block, even when Ollama's
     `format:<schema>` constrained decoding is in effect (real failure:
     ch13 returned "```json {...}```", causing JSON.parse to choke on the
     leading backtick). The strip is a no-op on byte-clean JSON and on any
     payload that doesn't start with a fence, so it's safe to run always. */
  const stripped = stripCodeFences(raw);
  let parsed: unknown;
  let repaired = stripped !== raw;
  try {
    parsed = JSON.parse(stripped);
  } catch {
    /* Targeted recovery for qwen3.5:4b's other signature failure mode:
       unescaped double-quote inside a string value when transcribing
       dialogue from the manuscript, e.g. `"quote": "Wren, let the dog
       go," Mr. Casper ordered.",`. Ollama's `format:<schema>` enforces
       JSON Schema shape but not string-content escaping — once the model
       is inside a JSON string, the constrained decoder still lets a raw
       `"` token close it. The repair pass walks the text, finds each `"`
       inside a string, and escapes it iff the next non-whitespace char
       isn't a valid post-value token (`,` `}` `]` `:` EOF). Verified
       against the real failing raws (ch8 byte 2363, ch10 byte 1432). */
    const repairedRaw = repairUnescapedQuotes(stripped);
    try {
      parsed = JSON.parse(repairedRaw);
      repaired = true;
    } catch (e2) {
      /* Neither cleanup helped — return the post-repair error message so
         the operator sees the actual remaining issue. */
      return { ok: false, kind: 'invalid-json', detail: (e2 as Error).message };
    }
  }
  const result = schema.safeParse(parsed);
  if (!result.success) {
    return { ok: false, kind: 'schema-validation', detail: result.error.issues };
  }
  return { ok: true, value: result.data, repaired };
}

/* Strips a wrapping ```json ... ``` (or bare ``` ... ```) markdown fence
   if present. Returns the input unchanged if no leading fence is found,
   so this is byte-identical on the happy path. The match is anchored at
   the start/end of the trimmed text, which means backticks embedded inside
   string values can't false-positive. */
export function stripCodeFences(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed.startsWith('```')) return raw;
  /* Drop opening fence + optional language tag + optional newline.
     Handles ```json\n, ```JSON\n, ```\n, ``` (inline, no newline). */
  let body = trimmed.replace(/^```[a-zA-Z]*[ \t]*\n?/, '');
  /* Drop closing fence at the very end. */
  body = body.replace(/\n?[ \t]*```\s*$/, '');
  return body.trim();
}

/* Walks the text character by character. Tracks whether we're currently
   inside a JSON string value. When we hit a `"` inside a string, peek the
   next non-whitespace char: if it's `,` `}` `]` `:` or EOF the `"` is a
   real string close; otherwise treat it as an unescaped inner quote and
   replace with `\"`. Existing `\"` and other `\X` escape sequences are
   passed through verbatim.

   This is intentionally narrow: it handles the dialogue-quote pattern that
   accounts for ~all of our observed failures, and is a no-op on already-
   valid JSON (every real close quote is followed by `,`/`}`/`]`/`:`/EOF).
   It is NOT a general JSON repair — for unrelated structural breakage
   (missing braces, trailing commas, etc.) the caller's `invalid-json`
   retry path still fires. */
export function repairUnescapedQuotes(raw: string): string {
  let out = '';
  let inString = false;
  let i = 0;
  while (i < raw.length) {
    const c = raw[i];
    if (!inString) {
      out += c;
      if (c === '"') inString = true;
      i += 1;
      continue;
    }
    if (c === '\\') {
      /* Pass through the escape and its target byte unchanged. Covers `\"`,
         `\\`, `\n`, `\uXXXX` (the first two chars suffice — the four hex
         digits are normal string content from this walker's POV). */
      out += c;
      if (i + 1 < raw.length) { out += raw[i + 1]; i += 2; }
      else { i += 1; }
      continue;
    }
    if (c === '"') {
      /* Peek the next non-whitespace char to decide if this `"` is a real
         string close or an unescaped inner quote. */
      let j = i + 1;
      while (j < raw.length && (raw[j] === ' ' || raw[j] === '\t' || raw[j] === '\n' || raw[j] === '\r')) {
        j += 1;
      }
      const next = j < raw.length ? raw[j] : '';
      if (next === ',' || next === '}' || next === ']' || next === ':' || next === '') {
        out += c;
        inString = false;
      } else {
        out += '\\"';
      }
      i += 1;
      continue;
    }
    out += c;
    i += 1;
  }
  return out;
}

export function buildRetryMessage(failure: Extract<ParseResult<unknown>, { ok: false }>): string {
  if (failure.kind === 'invalid-json') {
    return `Your previous response was not valid JSON: ${failure.detail}\n\nReturn ONLY a valid JSON object matching the schema. No prose, no markdown code fences.`;
  }
  return `Your previous response failed schema validation. Fix the following issues and resend the corrected JSON. Return ONLY the JSON object — no prose, no code fences.\n\n${JSON.stringify(failure.detail, null, 2)}`;
}

export function summariseDetail(detail: unknown): string {
  if (typeof detail === 'string') return detail;
  try {
    const s = JSON.stringify(detail);
    return s.length > 240 ? `${s.slice(0, 240)}…` : s;
  } catch {
    return String(detail);
  }
}

export async function persistResponse(manuscriptId: string, key: HandoffKey, raw: string): Promise<void> {
  await writeFile(outboxPath(manuscriptId, key), raw, 'utf8');
}
