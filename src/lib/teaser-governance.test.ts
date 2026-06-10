/* fe-37 — teaser governance (BRAND_CHANGELOG decision 2). "Even in your own
   voice" is the fs-38 teaser: it may render ONLY alongside its in-development
   flag until fs-38 ships. This static guard fails if any component renders the
   teaser (the TEASER constant or the literal) without the flag in the same file.

   When fs-38 ships, INVERT this test: the flag must then be GONE. */

import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';
import { describe, it, expect } from 'vitest';

const srcRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..'); // src/

const TEASER_TEXT = 'Even in your own voice';
const FLAG_TEXT = 'In development';

function sourceFiles(): string[] {
  return readdirSync(srcRoot, { recursive: true, encoding: 'utf8' })
    .filter((f) => /\.(ts|tsx)$/.test(f) && !/\.test\.(ts|tsx)$/.test(f))
    .map((f) => join(srcRoot, f));
}

describe('teaser governance', () => {
  it('any component using the teaser also carries its in-development flag', () => {
    const offenders: string[] = [];
    for (const file of sourceFiles()) {
      if (file.endsWith('brand.ts')) continue; // the definition module
      const src = readFileSync(file, 'utf8');
      // \bTEASER\b matches the standalone identifier but NOT TEASER_FLAG.
      const usesTeaser = src.includes(TEASER_TEXT) || /\bTEASER\b/.test(src);
      if (!usesTeaser) continue;
      const hasFlag = src.includes(FLAG_TEXT) || /\bTEASER_FLAG\b/.test(src);
      if (!hasFlag) offenders.push(file);
    }
    expect(offenders, `teaser rendered without its flag: ${offenders.join(', ')}`).toEqual([]);
  });
});
