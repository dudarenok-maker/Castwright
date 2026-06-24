import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { expandForSpeech } from './index.js';

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
