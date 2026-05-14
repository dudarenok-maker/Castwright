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
import { parseAndValidate, repairUnescapedQuotes } from './gemini.js';

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
      '{"a":"x","b":"y"}',  // followed by `,`
      '{"a":"x"}',          // followed by `}`
      '["a","b"]',          // followed by `,` and `]`
      '{"x":"y"}',          // followed by `}`
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

describe('parseAndValidate — repair integration', () => {
  const schema = z.object({
    quote: z.string(),
    note:  z.string(),
  }).strict();

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

  it('returns invalid-json when even the repair cannot salvage the raw', () => {
    /* Structurally broken in a way the walker can't fix — missing closing
       brace and orphan content. The invalid-json detail comes from the
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
});
