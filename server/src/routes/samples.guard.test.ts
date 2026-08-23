/* #2513 — static guard that stops `process.env` being re-introduced in
   samples.ts.  The earlier seam used process.env.AUDIOBOOK_SAMPLES_DIR
   to inject a fixture root for testing, and this guard makes sure no
   future change re-introduces an env-read that bypasses the registered-
   knob audit (direct-env-reader-guard.test.ts).

   Follows the source-scanning guard idiom from state-language.guard.test.ts
   and cast-lock.guard.test.ts: a scan over raw source, string/comment-
   blind, so a docblock or debug-log that merely *mentions* the pattern
   never registers as a finding. */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SAMPLES_SRC = resolve(__dirname, 'samples.ts');

/** Blank out comments, string literals, and template literals so that
    prose or debug-text that mentions `process.env` is never mistaken
    for a real read site.  A raw character scan, not a parser; preserves
    line structure (newlines kept) so error messages are useful. */
function stripOpaque(src: string): string {
  const n = src.length;
  const out: string[] = new Array(n);
  let i = 0;

  while (i < n) {
    const ch = src[i];

    // Double-quoted string
    if (ch === '"') {
      out[i] = ' ';
      let j = i + 1;
      while (j < n) {
        if (src[j] === '\\') { out[j] = ' '; j += 1; if (j < n) { out[j] = ' '; } j += 1; continue; }
        if (src[j] === '"') { out[j] = ' '; j += 1; break; }
        out[j] = src[j] === '\n' ? '\n' : ' ';
        j += 1;
      }
      i = j;
      continue;
    }

    // Single-quoted string
    if (ch === "'") {
      out[i] = ' ';
      let j = i + 1;
      while (j < n) {
        if (src[j] === '\\') { out[j] = ' '; j += 1; if (j < n) { out[j] = ' '; } j += 1; continue; }
        if (src[j] === "'") { out[j] = ' '; j += 1; break; }
        out[j] = src[j] === '\n' ? '\n' : ' ';
        j += 1;
      }
      i = j;
      continue;
    }

    // Template literal (backtick)
    if (ch === '`') {
      out[i] = ' ';
      let j = i + 1;
      let depth = 0;
      while (j < n) {
        if (src[j] === '\\') { out[j] = ' '; j += 1; if (j < n) { out[j] = ' '; } j += 1; continue; }
        if (src[j] === '`' && depth === 0) { out[j] = ' '; j += 1; break; }
        if (src[j] === '$' && src[j + 1] === '{') { out[j] = ' '; out[j + 1] = ' '; j += 2; depth += 1; continue; }
        if (src[j] === '}') { out[j] = ' '; j += 1; depth -= 1; continue; }
        if (src[j] === '`') { out[j] = ' '; j += 1; depth -= 1; continue; }
        out[j] = src[j] === '\n' ? '\n' : ' ';
        j += 1;
      }
      i = j;
      continue;
    }

    // Single-line comment //
    if (ch === '/' && src[i + 1] === '/') {
      let j = i;
      while (j < n && src[j] !== '\n') { out[j] = ' '; j += 1; }
      i = j;
      continue;
    }

    // Multi-line comment /* */
    if (ch === '/' && src[i + 1] === '*') {
      let j = i;
      while (j < n && !(src[j] === '*' && src[j + 1] === '/')) {
        out[j] = src[j] === '\n' ? '\n' : ' ';
        j += 1;
      }
      if (j < n) { out[j] = ' '; out[j + 1] = ' '; j += 2; }
      i = j;
      continue;
    }

    out[i] = ch;
    i += 1;
  }

  return out.join('');
}

describe('samples.ts — no process.env reads (#2513)', () => {
  it('contains zero process.env occurrences in code (comments/strings stripped)', () => {
    const src = readFileSync(SAMPLES_SRC, 'utf8');
    const stripped = stripOpaque(src);

    const dotRe = /\bprocess\s*\.\s*env\b/g;
    const dotMatches = stripped.match(dotRe);
    const dotCount = dotMatches?.length ?? 0;

    // Also check bracket access and destructuring
    const bracketRe = /\bprocess\s*\.\s*env\s*\[/g;
    const bracketMatches = stripped.match(bracketRe);
    const bracketCount = bracketMatches?.length ?? 0;

    const destructureRe = /\{[^{}]{0,200}\}\s*=\s*process\s*\.\s*env\b/g;
    const destructureMatches = stripped.match(destructureRe);
    const destructureCount = destructureMatches?.length ?? 0;

    const total = dotCount + bracketCount + destructureCount;

    // Gather context lines for error reporting
    const lines = src.split('\n');
    const problemLines = lines
      .map((l, i) => `${i + 1}: ${l}`)
      .filter((l) => /\bprocess\s*\.\s*env\b/.test(l))
      .join('\n');

    expect(
      total,
      `Expected zero process.env reads in samples.ts, found ${total} (dot: ${dotCount}, bracket: ${bracketCount}, destructure: ${destructureCount}).\nLines mentioning process.env:\n${problemLines}`,
    ).toBe(0);
  });
});