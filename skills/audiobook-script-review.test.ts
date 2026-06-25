/* Snapshot guard for the M5 vocalization-protection clause in the script-review
   skill prompt. The clause is load-bearing: the LLM must never strip
   intentional non-verbal vocalizations (e.g. "Ah!", "Haah…", "Mmm"). If the
   clause is accidentally edited or removed, this test fails immediately —
   behavioural enforcement lives in manual eval, but this guard ensures the
   text at least reaches the model unchanged. */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SKILL_PATH = resolve(__dirname, 'audiobook-script-review.md');

describe('skills/audiobook-script-review.md — op.id contract', () => {
  it('states that op id is the sentenceId of the target sentence, copied exactly from the input', () => {
    const text = readFileSync(SKILL_PATH, 'utf8');
    /* The id field must NOT describe a sequential counter. It must be
       unambiguous that the value comes from the input sentenceId.
       The backtick-wrapped form matches the markdown source in the file. */
    expect(text).toContain('`sentenceId` of the target sentence');
    expect(text).toContain('copied exactly from the input');
  });
});

describe('skills/audiobook-script-review.md — M5 vocalization-protection clause', () => {
  it('contains the verbatim M5 vocalization-protection clause', () => {
    const text = readFileSync(SKILL_PATH, 'utf8');
    /* Stable substrings from the M5 clause — must survive any future edits
       to surrounding prose. Checked in three parts because the clause is
       line-wrapped in the source file. The ellipsis must be the real Unicode
       char U+2026 (…), not three ASCII dots (...). */
    expect(text).toContain('NEVER strip intentional non-verbal vocalizations');
    expect(text).toContain('"Ah!", "Haah…", "Mmm"');
    expect(text).toContain(
      'Only strip true speech-attribution tags ("he said", "she whispered").',
    );
  });

  it('contains the real Unicode ellipsis U+2026 (not ASCII dots)', () => {
    const text = readFileSync(SKILL_PATH, 'utf8');
    expect(text).toContain('…'); // …
  });

  it('is UTF-8 without BOM', () => {
    const buf = readFileSync(SKILL_PATH);
    // BOM would be EF BB BF at the start
    expect(buf[0]).not.toBe(0xef);
    // No mojibake sequence for … (C3 A2 E2 80 A6 mangled as latin1)
    expect(buf.includes(Buffer.from([0xc3, 0xa2]))).toBe(false);
  });

  /* fs-57 lock: the guard names the canonical non-verbal vocalization examples
     ("Ah!", "Haah…", "Mmm") that correspond to the new fs-57 `vocalization: true`
     field. If this test fails the prompt has been edited in a way that could cause
     the LLM to strip vocalizations that are authored as `vocalization: true` sentences. */
  it('(fs-57) names the canonical vocalization examples that map to the vocalization field', () => {
    const text = readFileSync(SKILL_PATH, 'utf8');
    // "Ah!" — prototypical short non-verbal
    expect(text).toContain('"Ah!"');
    // "Haah…" — uses the real U+2026 ellipsis
    expect(text).toContain('"Haah…"');
    // "Mmm" — prototypical hum
    expect(text).toContain('"Mmm"');
  });
});

describe('skills/audiobook-script-review.md — fs-58 Unit B classes', () => {
  it('documents reattribute with the characterId-XOR-proposed contract', () => {
    const text = readFileSync(SKILL_PATH, 'utf8');
    expect(text).toMatch(/reattribute/);
    expect(text).toMatch(/never invent a `?characterId/i);
  });
  it('documents flag_nonstory and forbids flagging story prose', () => {
    const text = readFileSync(SKILL_PATH, 'utf8');
    expect(text).toMatch(/flag_nonstory/);
    expect(text).toMatch(/never flag story/i);
  });
});
