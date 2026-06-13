/* Targeted coverage for parseAndValidate + repairUnescapedQuotes.

   Context: qwen3.5:4b under Ollama 0.5+ structured output occasionally
   emits unescaped double-quotes inside JSON string values when transcribing
   dialogue from the manuscript ("quote": "Wren, let the dog go," Mr.
   Casper ordered.",). Ollama's `format:<schema>` enforces JSON Schema
   *shape* but not string-content escaping. The repair pass walks the text,
   detects each `"` inside a string, and escapes it iff the next non-ws
   char isn't a valid post-value token. Verified against the real broken
   raws from ch8 (byte 2363) and ch10 (byte 1432). */

import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import {
  parseAndValidate,
  repairUnescapedQuotes,
  repairStructuralPunctuation,
  stripCodeFences,
  trimTrailingProse,
} from './gemini.js';

describe('repairUnescapedQuotes', () => {
  it('is a no-op on already-valid JSON', () => {
    const ok = '{"a":"hello","b":42,"c":[1,2,3]}';
    expect(repairUnescapedQuotes(ok)).toBe(ok);
  });

  it('is a no-op on valid JSON with whitespace and nested objects', () => {
    const ok = JSON.stringify(
      { x: { y: ['a', 'b'], z: null }, w: 'value with spaces and , commas' },
      null,
      2,
    );
    expect(repairUnescapedQuotes(ok)).toBe(ok);
    expect(JSON.parse(repairUnescapedQuotes(ok))).toEqual(JSON.parse(ok));
  });

  it('escapes a single unescaped quote inside a string value (the canonical failure)', () => {
    /* Exact pattern from mns_QrZ0LtF0K9-stage1-ch8.attempt2.raw.txt:
       the model emitted `"quote": "Wren, let the dog go," Mr. Casper
       ordered.",` instead of properly-escaped dialogue. */
    const broken = '{"quote":"Wren, let the dog go," Mr. Casper ordered.","note":"x"}';
    const repaired = repairUnescapedQuotes(broken);
    const parsed = JSON.parse(repaired);
    expect(parsed.quote).toBe('Wren, let the dog go," Mr. Casper ordered.');
    expect(parsed.note).toBe('x');
  });

  it('escapes MULTIPLE unescaped quotes in a single string value', () => {
    /* Model transcribes a back-and-forth: two dialogue lines inside one
       evidence quote. Both inner `"` must be escaped. */
    const broken = '{"q":"She said "hi" and he said "bye"","n":"x"}';
    const repaired = repairUnescapedQuotes(broken);
    const parsed = JSON.parse(repaired);
    expect(parsed.q).toBe('She said "hi" and he said "bye"');
    expect(parsed.n).toBe('x');
  });

  it('leaves properly-escaped quotes alone', () => {
    const ok = '{"q":"She said \\"hi\\" and he said \\"bye\\"","n":"x"}';
    /* Repair walker treats `\X` as an opaque pass-through (it doesn't
       count `\"` as an inner quote). Result must round-trip. */
    expect(repairUnescapedQuotes(ok)).toBe(ok);
    expect(JSON.parse(repairUnescapedQuotes(ok))).toEqual(JSON.parse(ok));
  });

  it('handles whitespace between the unescaped quote and the next non-value token', () => {
    /* Real failure raws break with multiple spaces between the false-close
       `"` and the resumed sentence — e.g. `"...go,"  Mr. Casper ordered."`
       (the model formats dialogue with a space after the close paren). The
       peek must skip whitespace before deciding the next non-ws char. */
    const broken = '{"q":"a,"  Mr. ordered.","n":"x"}';
    const repaired = repairUnescapedQuotes(broken);
    const parsed = JSON.parse(repaired);
    expect(parsed.q).toBe('a,"  Mr. ordered.');
    expect(parsed.n).toBe('x');
  });

  it('keeps closing quotes followed by `,` `}` `]` `:` or EOF as real closes', () => {
    const variants = [
      '{"a":"x","b":"y"}', // followed by `,`
      '{"a":"x"}', // followed by `}`
      '["a","b"]', // followed by `,` and `]`
      '{"x":"y"}', // followed by `}`
    ];
    for (const v of variants) {
      expect(repairUnescapedQuotes(v)).toBe(v);
      expect(() => JSON.parse(repairUnescapedQuotes(v))).not.toThrow();
    }
  });

  it('preserves backslash-escape sequences exactly (\\n, \\t, \\\\, \\uXXXX)', () => {
    const ok = '{"s":"line1\\nline2\\tindent\\\\backslash\\u00e9"}';
    expect(repairUnescapedQuotes(ok)).toBe(ok);
    expect(JSON.parse(repairUnescapedQuotes(ok)).s).toBe('line1\nline2\tindent\\backslashé');
  });

  it('is safe on edge-case inputs (empty / single-char / unmatched)', () => {
    expect(repairUnescapedQuotes('')).toBe('');
    expect(repairUnescapedQuotes('"')).toBe('"');
    /* An entirely-open string at EOF: walker preserves it byte-for-byte;
       JSON.parse will still fail but that's the caller's problem. */
    expect(repairUnescapedQuotes('"unterminated')).toBe('"unterminated');
  });
});

describe('stripCodeFences', () => {
  it('is a no-op on plain JSON with no fence wrapper', () => {
    const ok = '{"a":"hello","b":42}';
    expect(stripCodeFences(ok)).toBe(ok);
  });

  it('is a no-op (byte-identical) on JSON with leading/trailing whitespace but no fence', () => {
    /* Trim happens INSIDE the strip helper to detect a fence, but if none
       is found we return the original buffer untouched — the parser will
       tolerate the whitespace, and we want to avoid spuriously flagging
       `repaired:true` on benign formatting. */
    const ok = '  \n{"a":"hello"}\n  ';
    expect(stripCodeFences(ok)).toBe(ok);
  });

  it('strips a ```json\\n ... \\n``` fence (the canonical qwen3.5:4b failure mode)', () => {
    /* Exact pattern from the ch13 failure: "Unexpected token '`',
       \"```json { \"... is not valid JSON". Model emitted its JSON wrapped
       in a fenced block despite the system prompt's "no code fences" rule. */
    const wrapped = '```json\n{"a":"hello","b":42}\n```';
    const stripped = stripCodeFences(wrapped);
    expect(JSON.parse(stripped)).toEqual({ a: 'hello', b: 42 });
  });

  it('strips a bare ```\\n ... \\n``` fence (no language tag)', () => {
    const wrapped = '```\n{"a":"hello"}\n```';
    expect(JSON.parse(stripCodeFences(wrapped))).toEqual({ a: 'hello' });
  });

  it('strips an inline ```json {...} ``` fence (no newline between fence and body)', () => {
    const wrapped = '```json {"a":"hello"} ```';
    expect(JSON.parse(stripCodeFences(wrapped))).toEqual({ a: 'hello' });
  });

  it('tolerates leading/trailing whitespace around the fence', () => {
    const wrapped = '  \n```json\n{"a":"hello"}\n```\n  ';
    expect(JSON.parse(stripCodeFences(wrapped))).toEqual({ a: 'hello' });
  });

  it('does NOT strip stray backticks that appear inside string values', () => {
    /* Anchored at start-of-trimmed-input: a `"value with `backticks`"` in
       the middle of a payload must not trigger fence-stripping. */
    const ok = '{"q":"value with `backticks` in it","n":"x"}';
    expect(stripCodeFences(ok)).toBe(ok);
    expect(JSON.parse(stripCodeFences(ok))).toEqual({ q: 'value with `backticks` in it', n: 'x' });
  });

  it('preserves the wrapped JSON byte-for-byte except for the fence markers', () => {
    /* The body inside the fence must round-trip unchanged — including
       backslash-escapes that the JSON parser cares about. */
    const body = '{"s":"line1\\nline2\\t\\"quoted\\""}';
    const wrapped = '```json\n' + body + '\n```';
    expect(stripCodeFences(wrapped)).toBe(body);
    expect(JSON.parse(stripCodeFences(wrapped)).s).toBe('line1\nline2\t"quoted"');
  });

  it('is safe on empty / fence-only / unclosed-fence inputs', () => {
    expect(stripCodeFences('')).toBe('');
    /* No leading triple-backtick → no-op. */
    expect(stripCodeFences('``')).toBe('``');
    /* Leading fence but no closing fence: strip the opener and return what
       remains. The downstream JSON.parse will still fail, but the caller's
       invalid-json branch handles that. We don't want this helper to throw. */
    expect(() => stripCodeFences('```json\n{"a":1}')).not.toThrow();
  });
});

describe('parseAndValidate — repair integration', () => {
  const schema = z
    .object({
      quote: z.string(),
      note: z.string(),
    })
    .strict();

  it('returns ok with repaired:false for clean valid JSON', () => {
    const r = parseAndValidate('{"quote":"hi","note":"n"}', schema);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value).toEqual({ quote: 'hi', note: 'n' });
      expect(r.repaired).toBe(false);
    }
  });

  it('returns ok with repaired:true when the raw needed quote-escape repair', () => {
    /* The canonical qwen3.5:4b failure pattern. */
    const broken = '{"quote":"Wren, let the dog go," Mr. Casper ordered.","note":"x"}';
    /* Sanity: strict JSON.parse should NOT accept this; otherwise the test
       is verifying the wrong thing. */
    expect(() => JSON.parse(broken)).toThrow();

    const r = parseAndValidate(broken, schema);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.repaired).toBe(true);
      expect(r.value.quote).toBe('Wren, let the dog go," Mr. Casper ordered.');
      expect(r.value.note).toBe('x');
    }
  });

  it('returns ok with repaired:true when the raw was wrapped in ```json fences', () => {
    /* The canonical ch13 failure pattern — JSON.parse on the raw text
       chokes on the leading backtick. Strip-then-parse must succeed and
       flag the result as `repaired` so the caller logs the cleanup. */
    const fenced = '```json\n{"quote":"hi","note":"n"}\n```';
    expect(() => JSON.parse(fenced)).toThrow();

    const r = parseAndValidate(fenced, schema);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.repaired).toBe(true);
      expect(r.value).toEqual({ quote: 'hi', note: 'n' });
    }
  });

  it('returns ok with repaired:true when fence AND quote-escape repair are BOTH needed', () => {
    /* Worst-case: model emits the fence wrapper AND has unescaped dialogue
       quotes inside a string value. Both cleanup passes must run, in order. */
    const fenced =
      '```json\n{"quote":"Wren, let the dog go," Mr. Casper ordered.","note":"x"}\n```';
    expect(() => JSON.parse(fenced)).toThrow();

    const r = parseAndValidate(fenced, schema);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.repaired).toBe(true);
      expect(r.value.quote).toBe('Wren, let the dog go," Mr. Casper ordered.');
      expect(r.value.note).toBe('x');
    }
  });

  it('returns invalid-json when even the repair cannot salvage the raw', () => {
    /* Structurally broken in a way no repair pass can fix — value is a
       bare unquoted identifier mid-object. trimTrailingProse can't find a
       balanced outer close (the structure never closes cleanly because
       the parse fails before the object ends), and
       repairStructuralPunctuation only inserts missing commas/braces, not
       unquote-fix identifiers. The invalid-json detail comes from the
       POST-repair parse so the operator sees the actual remaining issue. */
    const unrepairable = '{"quote": broken, no closing';
    const r = parseAndValidate(unrepairable, schema);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.kind).toBe('invalid-json');
    }
  });

  it('returns schema-validation when the JSON is valid but violates the schema', () => {
    /* Repair path is not engaged — JSON.parse succeeds on the first try.
       Result must NOT spuriously claim `repaired: true`. */
    const r = parseAndValidate('{"quote":"hi","note":"n","extra":"forbidden"}', schema);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.kind).toBe('schema-validation');
    }
  });

  it('returns ok with repaired:true when the raw had trailing prose after the closing brace (Ch44 shape)', () => {
    /* Real failure raw from the the Coalfall Commission run: qwen3.5:4b emitted
       its JSON correctly but appended a free-form sentence after the
       closing brace. trimTrailingProse must locate the outermost balanced
       `}` and slice up to it. */
    const broken = '{"quote":"hi","note":"n"}\n\nNote that this chapter has heavy dialogue.';
    expect(() => JSON.parse(broken)).toThrow();
    const r = parseAndValidate(broken, schema);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.repaired).toBe(true);
      expect(r.value).toEqual({ quote: 'hi', note: 'n' });
    }
  });

  it('returns ok with repaired:true when the raw had a missing comma between properties (Ch49 shape)', () => {
    /* Real failure raw: "Expected `,` or `}` after property value" —
       qwen3.5:4b dropped a comma mid-object. repairStructuralPunctuation
       must detect the missing-comma shape (value <ws> then `"`) and
       insert it. */
    const broken = '{"quote":"hi" "note":"n"}';
    expect(() => JSON.parse(broken)).toThrow();
    const r = parseAndValidate(broken, schema);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.repaired).toBe(true);
      expect(r.value).toEqual({ quote: 'hi', note: 'n' });
    }
  });

  it('returns ok with repaired:true when the raw was missing the outer closing brace', () => {
    const broken = '{"quote":"hi","note":"n"';
    expect(() => JSON.parse(broken)).toThrow();
    const r = parseAndValidate(broken, schema);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.repaired).toBe(true);
      expect(r.value).toEqual({ quote: 'hi', note: 'n' });
    }
  });

  it('returns ok with repaired:true when fence + unescaped quote + trailing prose ALL apply (composition)', () => {
    /* Every repair pass engages, in order: stripCodeFences →
       repairUnescapedQuotes → trimTrailingProse → repairStructuralPunctuation. */
    const fenced =
      '```json\n' +
      '{"quote":"Wren, let the dog go," Mr. Casper ordered.","note":"x"}\n' +
      '```\n\nNote: this run was on chapter 8.';
    expect(() => JSON.parse(fenced)).toThrow();
    const r = parseAndValidate(fenced, schema);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.repaired).toBe(true);
      expect(r.value.quote).toBe('Wren, let the dog go," Mr. Casper ordered.');
      expect(r.value.note).toBe('x');
    }
  });
});

describe('trimTrailingProse', () => {
  it('is a no-op on valid JSON with no trailing content', () => {
    const ok = '{"a":"hi","b":42}';
    expect(trimTrailingProse(ok)).toBe(ok);
  });

  it('strips trailing prose after a top-level object close', () => {
    const broken = '{"a":1,"b":2}\n\nNote about chapter 44 and how the dialogue is heavy.';
    const trimmed = trimTrailingProse(broken);
    expect(trimmed).toBe('{"a":1,"b":2}');
    expect(JSON.parse(trimmed)).toEqual({ a: 1, b: 2 });
  });

  it('strips trailing prose for a top-level array close', () => {
    const broken = '[1,2,3] trailing notes go here';
    const trimmed = trimTrailingProse(broken);
    expect(trimmed).toBe('[1,2,3]');
    expect(JSON.parse(trimmed)).toEqual([1, 2, 3]);
  });

  it('tracks nested braces correctly (outermost close wins)', () => {
    const broken = '{"a":{"b":{"c":1}}} note: deeply nested';
    const trimmed = trimTrailingProse(broken);
    expect(trimmed).toBe('{"a":{"b":{"c":1}}}');
    expect(JSON.parse(trimmed)).toEqual({ a: { b: { c: 1 } } });
  });

  it('respects braces inside string values (no false close)', () => {
    const broken = '{"a":"text with } and { braces inside","b":1} trailing';
    const trimmed = trimTrailingProse(broken);
    expect(trimmed).toBe('{"a":"text with } and { braces inside","b":1}');
    expect(JSON.parse(trimmed)).toEqual({ a: 'text with } and { braces inside', b: 1 });
  });

  it('respects escaped quotes inside string values', () => {
    const broken = '{"a":"he said \\"hi\\""} trailing';
    const trimmed = trimTrailingProse(broken);
    expect(trimmed).toBe('{"a":"he said \\"hi\\""}');
    expect(JSON.parse(trimmed)).toEqual({ a: 'he said "hi"' });
  });

  it('is idempotent — running twice equals running once', () => {
    const broken = '{"a":1} prose';
    expect(trimTrailingProse(trimTrailingProse(broken))).toBe(trimTrailingProse(broken));
  });

  it('is a no-op when no outer balanced close exists (unbalanced JSON)', () => {
    /* Missing close brace — there's no point where depth returns to 0,
       so we can't find a safe trim point. Return the input unchanged and
       let repairStructuralPunctuation try to close it instead. */
    const broken = '{"a":1';
    expect(trimTrailingProse(broken)).toBe(broken);
  });

  it('is a no-op on the empty string', () => {
    expect(trimTrailingProse('')).toBe('');
  });
});

describe('repairStructuralPunctuation', () => {
  it('is a no-op on already-valid JSON', () => {
    const ok = '{"a":1,"b":2}';
    expect(repairStructuralPunctuation(ok)).toBe(ok);
  });

  it('inserts a missing comma between two string-value properties', () => {
    const broken = '{"a":"x" "b":"y"}';
    const repaired = repairStructuralPunctuation(broken);
    expect(JSON.parse(repaired)).toEqual({ a: 'x', b: 'y' });
  });

  it('inserts a missing comma between number-then-property', () => {
    const broken = '{"a":1 "b":2}';
    const repaired = repairStructuralPunctuation(broken);
    expect(JSON.parse(repaired)).toEqual({ a: 1, b: 2 });
  });

  it('inserts a missing comma between }-then-property (nested objects)', () => {
    const broken = '{"a":{"x":1} "b":2}';
    const repaired = repairStructuralPunctuation(broken);
    expect(JSON.parse(repaired)).toEqual({ a: { x: 1 }, b: 2 });
  });

  it('appends a single missing close brace at EOF', () => {
    const broken = '{"a":1,"b":2';
    const repaired = repairStructuralPunctuation(broken);
    expect(JSON.parse(repaired)).toEqual({ a: 1, b: 2 });
  });

  it('appends two missing close braces at EOF (within default maxInserts=2)', () => {
    const broken = '{"a":{"b":1';
    const repaired = repairStructuralPunctuation(broken);
    expect(JSON.parse(repaired)).toEqual({ a: { b: 1 } });
  });

  it('refuses to over-rescue deeply-truncated payloads (3+ unclosed → still invalid)', () => {
    /* 3 unclosed containers needs 3 inserts, exceeding the default
       maxInserts=2. Helper appends what it can and bails; the result is
       still unparseable, which is correct: the ollama retry policy
       drops the broken assistant turn for invalid-json (not
       schema-validation), giving the sampler real room to escape. */
    const truncated = '{"characters":[{"id":"narrator"';
    const repaired = repairStructuralPunctuation(truncated);
    expect(() => JSON.parse(repaired)).toThrow();
  });

  it('appends a missing close bracket at EOF for arrays', () => {
    const broken = '{"a":[1,2,3';
    const repaired = repairStructuralPunctuation(broken);
    expect(JSON.parse(repaired)).toEqual({ a: [1, 2, 3] });
  });

  it('does not touch JSON broken in ways outside its scope (unquoted identifier)', () => {
    /* The narrow heuristic only handles missing commas/braces. An
       unquoted value mid-object stays broken — repair returns the input
       (possibly with a speculative close, which still fails to parse) so
       the caller's invalid-json branch fires. */
    const broken = '{"a": broken';
    const repaired = repairStructuralPunctuation(broken);
    /* Either the helper returns the input unchanged OR appends a `}` —
       both are fine; the contract is "don't crash and don't lie that
       JSON.parse will succeed." */
    expect(() => JSON.parse(repaired)).toThrow();
  });

  it('respects strings — does not insert commas inside string values', () => {
    /* A space-then-quote pattern that looks like missing-comma but is
       INSIDE a string must not trigger insertion. */
    const ok = '{"a":"he said \\"hi\\" then left"}';
    const repaired = repairStructuralPunctuation(ok);
    expect(repaired).toBe(ok);
    expect(JSON.parse(repaired)).toEqual({ a: 'he said "hi" then left' });
  });

  it('is bounded by maxInserts so a hopelessly-broken payload cannot loop', () => {
    /* Bound the recursion depth at maxInserts. After the budget runs out
       the helper returns whatever it has — caller's invalid-json branch
       picks it up. */
    const hopelessly = '{xxxxx';
    const repaired = repairStructuralPunctuation(hopelessly, 2);
    expect(typeof repaired).toBe('string');
    expect(() => JSON.parse(repaired)).toThrow();
  });
});
