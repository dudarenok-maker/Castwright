/* JSON parse, repair and validation helpers shared by every analyzer transport. Moved verbatim from gemini.ts (#3084 wave 1). */
import { writeFile } from 'node:fs/promises';
import type { z } from 'zod';
import { outboxPath, type HandoffKey } from '../../handoff/protocol.js';

export type ParseResult<T> =
  | { ok: true; value: T; repaired: boolean }
  | { ok: false; kind: 'invalid-json'; detail: string }
  | { ok: false; kind: 'schema-validation'; detail: z.ZodIssue[] };

export function parseAndValidate<T>(raw: string, schema: z.ZodType<T>): ParseResult<T> {
  /* Repair pipeline. Each pass is a no-op on already-valid JSON, so we
     can try several layered combinations and accept the first that
     parses. Conservative passes (fence-strip, trailing-prose trim,
     structural-punctuation repair) run BEFORE the aggressive
     `repairUnescapedQuotes` walker — that walker is willing to insert
     `\"` mid-string when it sees a `"` not followed by a value-end
     token, which can wrongly corrupt a payload whose breakage is
     actually a missing comma between two string-valued properties
     (e.g. `{"a":"x" "b":"y"}` — the walker sees the close-quote of `x`
     as an unescaped inner quote because the next non-ws char is `"`,
     not `,`/`}`).

     Order of candidates tried:
     0. `stripped` — fence strip only.
     1. `trimTrailingProse(stripped)` — Ch44 shape.
     2. `repairStructuralPunctuation(...prev)` — Ch49 shape; missing
        comma or close brace.
     3. `repairUnescapedQuotes(stripped)` — ch8/ch10 dialogue-quote
        shape; aggressive walker.
     4. `trimTrailingProse(prev)` then `repairStructuralPunctuation(prev)`
        on top of the quote-fixed seed — combination cases.

     After all candidates fail, return `invalid-json` with the LATEST
     error message so the operator can see what the surviving issue
     actually is.

     `stripCodeFences` ALWAYS runs first because backticks confuse every
     downstream walker; it's deterministic and detects its own opt-out
     (no leading fence → byte-identical return). */
  const stripped = stripCodeFences(raw);

  /* Build the candidate list and dedupe so each parse is attempted at
     most once. */
  const trimmed = trimTrailingProse(stripped);
  const trimThenStruct = repairStructuralPunctuation(trimmed);
  const quoteFixed = repairUnescapedQuotes(stripped);
  const quoteThenTrim = trimTrailingProse(quoteFixed);
  const quoteThenTrimThenStruct = repairStructuralPunctuation(quoteThenTrim);

  const candidates: string[] = [
    stripped,
    trimmed,
    trimThenStruct,
    quoteFixed,
    quoteThenTrim,
    quoteThenTrimThenStruct,
  ];
  const seen = new Set<string>();
  let parsed: unknown;
  let winner: string | null = null;
  let lastErrorMessage = 'unknown parse error';
  for (const c of candidates) {
    if (seen.has(c)) continue;
    seen.add(c);
    try {
      parsed = JSON.parse(c);
      winner = c;
      break;
    } catch (e) {
      lastErrorMessage = (e as Error).message;
    }
  }
  if (winner === null) {
    return { ok: false, kind: 'invalid-json', detail: lastErrorMessage };
  }
  const repaired = winner !== raw;

  const result = schema.safeParse(parsed);
  if (!result.success) {
    /* Constrained-decoding stray-key tolerance. Ollama's `format:<schema>`
       (and Gemini's responseSchema) enforce JSON *shape* but NOT
       additionalProperties:false, so a local model routinely stamps an extra
       key the strict schema doesn't want onto an otherwise-valid object — the
       real qwen3.5:9b per-chapter cast failure stamped a top-level `chapterId`
       and the whole chapter's roster was discarded. When EVERY issue is an
       unrecognized key, strip the offending keys at their reported paths and
       re-validate once. Genuine shape problems (missing required fields, wrong
       types) surface different issue codes and still hard-fail here. */
    const issues = result.error.issues;
    if (issues.length > 0 && issues.every((i) => i.code === 'unrecognized_keys')) {
      const cleaned = stripUnrecognizedKeys(parsed, issues);
      const reparse = schema.safeParse(cleaned);
      if (reparse.success) {
        return { ok: true, value: reparse.data, repaired: true };
      }
    }
    return { ok: false, kind: 'schema-validation', detail: issues };
  }
  return { ok: true, value: result.data, repaired };
}

/* Remove the keys Zod flagged as `unrecognized_keys` from a deep clone of the
   parsed object. Each `unrecognized_keys` issue carries the `path` to the
   object that owns the extra keys and the `keys` list itself; walk to that
   object and delete them. The clone keeps the caller's parsed value intact.
   Used only by parseAndValidate to salvage a payload whose sole fault is stray
   keys that constrained decoding failed to suppress. */
function stripUnrecognizedKeys(root: unknown, issues: z.ZodIssue[]): unknown {
  const clone = structuredClone(root);
  for (const issue of issues) {
    if (issue.code !== 'unrecognized_keys') continue;
    let target: unknown = clone;
    for (const seg of issue.path) {
      if (target == null || typeof target !== 'object') break;
      target = (target as Record<PropertyKey, unknown>)[seg];
    }
    if (target != null && typeof target === 'object') {
      for (const key of issue.keys) {
        delete (target as Record<string, unknown>)[key];
      }
    }
  }
  return clone;
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
      if (i + 1 < raw.length) {
        out += raw[i + 1];
        i += 2;
      } else {
        i += 1;
      }
      continue;
    }
    if (c === '"') {
      /* Peek the next non-whitespace char to decide if this `"` is a real
         string close or an unescaped inner quote. */
      let j = i + 1;
      while (
        j < raw.length &&
        (raw[j] === ' ' || raw[j] === '\t' || raw[j] === '\n' || raw[j] === '\r')
      ) {
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

/* Walks the text tracking brace/bracket depth, respecting JSON string
   state (and escapes). When the OUTERMOST balanced close character is
   found, slice up to and including it and return — any trailing prose
   the model emitted after the object closed is dropped.

   Real failure shape this handles: qwen3.5:4b occasionally completes a
   structurally valid JSON object on long chapters and then continues
   writing free-form prose after the closing `}` (e.g. "Note that this
   chapter…"). JSON.parse rejects the whole payload because of the
   trailing content. We can rescue that without round-tripping the model
   by trimming everything after the outer close.

   Returns the input unchanged when:
   - There is no opening `{` or `[`.
   - The outer container never closes (unbalanced depth at EOF) — in that
     case `repairStructuralPunctuation` is the right next pass, not this
     one.
   - The string is empty. */
export function trimTrailingProse(raw: string): string {
  if (!raw) return raw;
  let depth = 0;
  let inString = false;
  let started = false;
  for (let i = 0; i < raw.length; i += 1) {
    const c = raw[i];
    if (inString) {
      if (c === '\\') {
        i += 1;
        continue;
      } /* skip escape target */
      if (c === '"') inString = false;
      continue;
    }
    if (c === '"') {
      inString = true;
      continue;
    }
    if (c === '{' || c === '[') {
      depth += 1;
      started = true;
      continue;
    }
    if (c === '}' || c === ']') {
      depth -= 1;
      if (started && depth === 0) {
        /* Outermost close. Slice up to and including this position. */
        const trimmed = raw.slice(0, i + 1);
        return trimmed;
      }
    }
  }
  /* Never closed cleanly — leave it for repairStructuralPunctuation. */
  return raw;
}

/* Inserts at most `maxInserts` structural tokens (`,` between adjacent
   values, or trailing `}` / `]` to close unbalanced containers) so a
   payload broken only by a missing comma or missing close brace round-
   trips through JSON.parse.

   Heuristic, in order:
   1. **Missing comma** — walk the text; when a value-end position (close
      of string, number, `}`, `]`, or a `true`/`false`/`null` literal) is
      followed by whitespace and then a property-start token (`"`, `{`,
      `[`), insert a `,` at that boundary. We track JSON string state
      with escapes so spaces inside strings don't trigger.
   2. **Missing close braces/brackets at EOF** — after a single pass, if
      depth > 0 append the closers in LIFO order (stack of opens).

   Out of scope: unquoted identifiers, missing colons, extraneous commas,
   structural errors that JSON.parse can't pinpoint with a position. For
   anything outside the comma+close-brace window, this helper returns
   whatever it managed to produce (which still won't parse) so the
   caller's invalid-json branch fires.

   `maxInserts` bounds the budget so a hopelessly-broken payload can't
   loop the parser. Default 2 covers the documented realistic case (one
   missing comma + one missing close brace at EOF). A deeply-truncated
   payload — e.g. 3+ unclosed containers because the model was cut off
   mid-string — stays unparseable, which is correct: those should fail
   `invalid-json` so the retry policy drops the broken assistant turn
   and bumps temperature, instead of replaying a half-rescued skeleton
   that anchors the model to a wrong shape (see ollama.test.ts:352). */
export function repairStructuralPunctuation(raw: string, maxInserts = 2): string {
  if (!raw) return raw;
  let out = '';
  const openStack: Array<'}' | ']'> = [];
  let inString = false;
  let inserts = 0;
  let lastNonWsWasValueEnd = false;

  const isPropertyStart = (ch: string): boolean => ch === '"' || ch === '{' || ch === '[';

  for (let i = 0; i < raw.length; i += 1) {
    const c = raw[i];

    if (inString) {
      out += c;
      if (c === '\\' && i + 1 < raw.length) {
        out += raw[i + 1];
        i += 1;
        continue;
      }
      if (c === '"') {
        inString = false;
        lastNonWsWasValueEnd = true;
      }
      continue;
    }

    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') {
      out += c;
      continue;
    }

    /* Decide whether we need to splice a comma BEFORE writing `c`. */
    if (lastNonWsWasValueEnd && isPropertyStart(c) && inserts < maxInserts) {
      out += ',';
      inserts += 1;
      lastNonWsWasValueEnd = false;
    }

    if (c === '"') {
      out += c;
      inString = true;
      continue;
    }
    if (c === '{') {
      out += c;
      openStack.push('}');
      lastNonWsWasValueEnd = false;
      continue;
    }
    if (c === '[') {
      out += c;
      openStack.push(']');
      lastNonWsWasValueEnd = false;
      continue;
    }
    if (c === '}' || c === ']') {
      out += c;
      openStack.pop();
      lastNonWsWasValueEnd = true;
      continue;
    }
    if (c === ',' || c === ':') {
      out += c;
      lastNonWsWasValueEnd = false;
      continue;
    }
    /* Number / literal / unknown — append. Treat digits and
       alphanumeric runs as value-content; a value ends at the next
       structural break. */
    out += c;
    lastNonWsWasValueEnd = /[\d\w]/.test(c) || c === '.' || c === '-' || c === '+';
  }

  /* Append any unclosed containers in LIFO order, bounded by maxInserts. */
  while (openStack.length > 0 && inserts < maxInserts) {
    out += openStack.pop()!;
    inserts += 1;
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

export async function persistResponse(
  manuscriptId: string,
  key: HandoffKey,
  raw: string,
): Promise<void> {
  await writeFile(outboxPath(manuscriptId, key), raw, 'utf8');
}
