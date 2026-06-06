/* ops-7 — install-qwen3.mjs FA2-wheel integrity helpers. The script's main() is
   guarded (runs only when invoked directly), so importing it here is inert. */

import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
// @ts-expect-error — standalone install script ships no .d.ts; helpers are plain JS.
import { flashAttnWheelPin, sha256File } from '../../tts-sidecar/scripts/install-qwen3.mjs';

describe('sha256File', () => {
  it('hashes a file to its lowercased hex digest', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sha-'));
    try {
      const p = join(dir, 'x.bin');
      writeFileSync(p, Buffer.from('hello'));
      /* sha256("hello") — known vector. */
      expect(sha256File(p)).toBe(
        '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824',
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('flashAttnWheelPin', () => {
  it('reads the committed manifest (currently UNPINNED → null)', () => {
    /* The FA2 wheel ships unpinned until blessed on a box that has it, so the
       pin reader returns null and install-qwen3 warns + proceeds rather than
       failing. When a hash is blessed in model-hashes.json this flips to the
       digest and the integrity gate activates. */
    expect(flashAttnWheelPin()).toBeNull();
  });
});
