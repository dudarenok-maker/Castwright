import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { expandForSpeech, applyPasses } from './index.js';
import { fr } from './lang/fr.js';
import type { LangNormalizer } from './types.js';

const here = dirname(fileURLToPath(import.meta.url));

function load(lang: string): Array<[string, string]> {
  const raw = readFileSync(join(here, '__fixtures__', `${lang}.txt`), 'utf8');
  return raw.split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'))
    .map((l) => {
      const [input, expected] = l.split(' ⇒ ');
      return [input, expected] as [string, string];
    });
}

for (const lang of ['en', 'es', 'ru']) { // extended per language in later tasks
  describe(`fixtures: ${lang}`, () => {
    it.each(load(lang))('%s', (input, expected) => {
      expect(expandForSpeech(input, lang)).toBe(expected);
    });
  });
}

// Dormant engines (supported:false) no-op through the gated expandForSpeech, so
// their fixtures drive the UNGATED applyPasses directly to exercise the engine.
const DORMANT: Record<string, LangNormalizer> = { fr };
for (const [lang, norm] of Object.entries(DORMANT)) {
  describe(`fixtures (dormant): ${lang}`, () => {
    it.each(load(lang))('%s', (input, expected) => {
      expect(applyPasses(input, norm)).toBe(expected);
    });
  });
}
