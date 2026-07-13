/* Regression coverage for the pip constraints-file sanitiser used by the
   in-app model installers (install-coqui.mjs / install-qwen3.mjs). Those
   scripts reuse requirements/base.txt as a pip *constraints* file (`-c`), but
   pip forbids extras in a constraints file — a single `uvicorn[standard]` pin
   makes the whole install abort with `ERROR: Constraints cannot have extras`.
   The sanitiser strips the `[extras]` token (keeping the version pin, which is
   all a constraint contributes) so `-c` accepts the file. The scripts ship no
   .d.ts; the guard runs only when invoked directly, so importing the helpers
   here is inert. */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
// @ts-expect-error — standalone install helper ships no .d.ts; plain JS.
import { sanitizeConstraintsText, writeSanitizedConstraintsFile } from '../../tts-sidecar/scripts/pip-constraints.mjs';

describe('sanitizeConstraintsText', () => {
  it('strips extras but keeps the version pin', () => {
    expect(sanitizeConstraintsText('uvicorn[standard]>=0.30,<0.32')).toBe(
      'uvicorn>=0.30,<0.32',
    );
  });

  it('strips multi-extra groups', () => {
    expect(sanitizeConstraintsText('pkg[a,b]==1.2.3')).toBe('pkg==1.2.3');
  });

  it('leaves extras-free requirement lines untouched', () => {
    expect(sanitizeConstraintsText('numpy>=1.26,<3.0')).toBe('numpy>=1.26,<3.0');
  });

  it('preserves comments and blank lines', () => {
    const input = '# a comment [with brackets]\n\nfastapi>=0.115,<0.116\n';
    expect(sanitizeConstraintsText(input)).toBe(input);
  });

  it('leaves the real base.txt free of any extras (the actual reported failure)', () => {
    const baseTxt = readFileSync(
      resolve(__dirname, '..', '..', 'tts-sidecar', 'requirements', 'base.txt'),
      'utf8',
    );
    const sanitized = sanitizeConstraintsText(baseTxt);
    for (const line of sanitized.split('\n')) {
      const code = line.split('#')[0];
      expect(code).not.toMatch(/\[[^\]]*\]/);
    }
  });
});

describe('writeSanitizedConstraintsFile', () => {
  it('falls back to the original path when the file is unreadable (no crash)', () => {
    /* A missing base.txt must not throw a raw ENOENT from the helper — pip
       should receive the path and emit its own clean error instead. */
    const missing = resolve(__dirname, 'does-not-exist-constraints.txt');
    expect(writeSanitizedConstraintsFile(missing)).toBe(missing);
  });

  it('writes an extras-free copy and returns its path', () => {
    const baseTxt = resolve(
      __dirname,
      '..',
      '..',
      'tts-sidecar',
      'requirements',
      'base.txt',
    );
    const out = writeSanitizedConstraintsFile(baseTxt);
    expect(out).not.toBe(baseTxt);
    const written = readFileSync(out, 'utf8');
    for (const line of written.split('\n')) {
      expect(line.split('#')[0]).not.toMatch(/\[[^\]]*\]/);
    }
  });
});
