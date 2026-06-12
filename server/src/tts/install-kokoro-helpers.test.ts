/* fs-21 — install-kokoro.mjs SHA256-verify helpers. The script's main() is
   guarded (runs only when invoked directly), so importing it here is inert. */

import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
// @ts-expect-error — standalone install script ships no .d.ts; helpers are plain JS.
import { sha256File, kokoroHashes } from '../../tts-sidecar/scripts/install-kokoro.mjs';

describe('install-kokoro helpers', () => {
  it('sha256File matches node:crypto', () => {
    const d = mkdtempSync(join(tmpdir(), 'k-')); const f = join(d, 'x');
    writeFileSync(f, 'hello kokoro');
    const want = createHash('sha256').update('hello kokoro').digest('hex');
    expect(sha256File(f)).toBe(want);
    rmSync(d, { recursive: true, force: true });
  });
  it('kokoroHashes exposes the two pinned weight files', () => {
    const h = kokoroHashes();
    expect(h['kokoro-v1.0.onnx'].sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(h['voices-v1.0.bin'].sizeBytes).toBeGreaterThan(0);
  });
});
