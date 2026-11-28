/* A name-scrub codemod (956978af) rewrote the Tailwind class `backdrop-blur-md` to
   `backdrop-haze-md` in the profile drawer header — a class defined nowhere, so the
   blur silently vanished. This is deliberately narrow: it bans only that rewrite's
   output token under src/. A class-level undefined-Tailwind check is tracked in #4958. */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..');

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(tsx?|css)$/.test(name) && !name.endsWith('scrub-collateral.guard.test.ts')) out.push(full);
  }
  return out;
}

describe('name-scrub left no backdrop-haze token (the blur->haze rewrite)', () => {
  it('no file under src/ uses backdrop-haze*', () => {
    const offenders = walk(SRC).filter((file) => /backdrop-haze/.test(readFileSync(file, 'utf8')));
    expect(offenders.map((f) => f.slice(SRC.length + 1))).toEqual([]);
  });
});
