/* #3084 — every analyzer model label goes through modelLabel. A new
   MODEL_OPTIONS.find(...) label lookup silently shows raw ids for live-listed and
   endpoint models; this fails the build instead. TTS_MODEL_OPTIONS is excluded by
   the lookbehind. */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..');

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(full);
  }
  return out;
}

describe('analyzer model labels go through modelLabel (#3084)', () => {
  it('no source file resolves a label with MODEL_OPTIONS.find(...)', () => {
    const offenders = walk(SRC).filter((file) => /(?<![A-Z_])MODEL_OPTIONS\.find\(/.test(readFileSync(file, 'utf8')));
    expect(offenders.map((f) => f.slice(SRC.length + 1))).toEqual([]);
  });
});
