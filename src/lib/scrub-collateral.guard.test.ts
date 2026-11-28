/* A name-scrub codemod (956978af) rewrote the Tailwind class `backdrop-blur-md` to
   `backdrop-haze-md` in the profile drawer header — a class defined nowhere, so the
   blur silently vanished. Tailwind never errors on an unknown class, so this fails the
   build instead: the codemod's replacement token must appear nowhere under src/. */
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

describe('name-scrub codemod left no mangled Tailwind classes', () => {
  it('no file under src/ uses backdrop-haze*', () => {
    const offenders = walk(SRC).filter((file) => /backdrop-haze/.test(readFileSync(file, 'utf8')));
    expect(offenders.map((f) => f.slice(SRC.length + 1))).toEqual([]);
  });
});
