/* Guard test for the Stage-3 instruct-annotation skill prompt (fs-57).
   Every asserted clause is load-bearing: if the LLM prompt loses any of
   these constraints the contract silently breaks downstream.

   Unicode note: any asserted string containing U+2026 (…) or curly
   quotes must use the REAL Unicode character — Write/Edit can silently
   flatten them to ASCII.  The bytes are checked explicitly in the UTF-8
   test below. */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SKILL_PATH = resolve(__dirname, 'audiobook-instruct-annotation.md');

describe('skills/audiobook-instruct-annotation.md — strict envelope shape', () => {
  it('names the "annotations" envelope and all three optional fields', () => {
    const text = readFileSync(SKILL_PATH, 'utf8');
    expect(text).toContain('"annotations"');
    expect(text).toContain('"sentenceId"');
    expect(text).toContain('"instruct"');
    expect(text).toContain('"vocalization"');
    // text field is also part of the schema
    expect(text).toContain('"text"');
  });
});

describe('skills/audiobook-instruct-annotation.md — sentenceId contract', () => {
  it('states that sentenceId must be copied exactly from the input, NOT a counter', () => {
    const text = readFileSync(SKILL_PATH, 'utf8');
    // Must say "copied exactly from the input" (mirrors audiobook-script-review contract)
    expect(text).toContain('copied exactly from the input');
    // Must explicitly warn it is NOT a new counter
    expect(text).toMatch(/not a (?:new )?(?:1-based )?counter|NOT a (?:new )?(?:1-based )?counter/i);
  });
});

describe('skills/audiobook-instruct-annotation.md — language split contract', () => {
  it('specifies instruct in English', () => {
    const text = readFileSync(SKILL_PATH, 'utf8');
    expect(text).toMatch(/instruct.*[Ee]nglish|[Ee]nglish.*instruct/);
  });

  it("specifies vocalization text in the book's / manuscript's language", () => {
    const text = readFileSync(SKILL_PATH, 'utf8');
    // Either phrasing is fine — "book's language" or "manuscript's language"
    expect(text).toMatch(/(?:book|manuscript)'?s? language/i);
  });
});

describe('skills/audiobook-instruct-annotation.md — edit-in-place contract', () => {
  it('says to edit the existing sentence text, never insert a new sentence', () => {
    const text = readFileSync(SKILL_PATH, 'utf8');
    // Must prohibit inserting new sentences
    expect(text).toMatch(/never insert a new sentence|do not insert.*sentence/i);
    // Must say the existing sentence's text is edited
    expect(text).toMatch(/edit the existing sentence|prepend.*existing sentence/i);
  });
});

describe('skills/audiobook-instruct-annotation.md — conservative clause', () => {
  it('says to omit unless the narrative makes the reaction explicit', () => {
    const text = readFileSync(SKILL_PATH, 'utf8');
    expect(text).toMatch(/omit unless/i);
    expect(text).toMatch(/explicit/i);
  });
});

describe('skills/audiobook-instruct-annotation.md — Unicode integrity', () => {
  it('uses real Unicode ellipsis U+2026 in examples, not three ASCII dots', () => {
    const text = readFileSync(SKILL_PATH, 'utf8');
    // The examples must include a real ellipsis (e.g. "Haah…" or similar)
    expect(text).toContain('…');
  });

  it('is UTF-8 without BOM', () => {
    const buf = readFileSync(SKILL_PATH);
    // BOM would be EF BB BF
    expect(buf[0]).not.toBe(0xef);
    // No mojibake for … (E2 80 A6 mangled as latin1 → C3 A2 C2 80 C2 A6)
    expect(buf.includes(Buffer.from([0xc3, 0xa2]))).toBe(false);
  });
});
