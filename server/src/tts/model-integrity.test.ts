/* ops-7 — Kokoro inventory integrity (size check vs the pinned manifest). */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { kokoroIntegrity } from './model-integrity.js';

let repoRoot: string;

const MANIFEST = {
  kokoro: {
    'kokoro-v1.0.onnx': { sha256: 'aa', sizeBytes: 1000 },
    'voices-v1.0.bin': { sha256: 'bb', sizeBytes: 200 },
  },
};

function writeFile(path: string, bytes: number) {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, Buffer.alloc(bytes, 1));
}

function writeManifest(obj: unknown) {
  const dir = join(repoRoot, 'server', 'tts-sidecar', 'scripts');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'model-hashes.json'), JSON.stringify(obj));
}

function kokoroFile(name: string, bytes: number) {
  writeFile(join(repoRoot, 'server', 'tts-sidecar', 'voices', 'kokoro', name), bytes);
}

beforeEach(() => {
  repoRoot = mkdtempSync(join(tmpdir(), 'mi-'));
});
afterEach(() => {
  rmSync(repoRoot, { recursive: true, force: true });
});

describe('kokoroIntegrity', () => {
  it("returns 'verified' when both files match their pinned sizes", () => {
    writeManifest(MANIFEST);
    kokoroFile('kokoro-v1.0.onnx', 1000);
    kokoroFile('voices-v1.0.bin', 200);
    expect(kokoroIntegrity(repoRoot)).toBe('verified');
  });

  it("returns 'mismatch' when a file's size differs from its pin", () => {
    writeManifest(MANIFEST);
    kokoroFile('kokoro-v1.0.onnx', 999); // wrong size
    kokoroFile('voices-v1.0.bin', 200);
    expect(kokoroIntegrity(repoRoot)).toBe('mismatch');
  });

  it('returns undefined when a weight file is missing (not fully installed)', () => {
    writeManifest(MANIFEST);
    kokoroFile('kokoro-v1.0.onnx', 1000); // bin absent
    expect(kokoroIntegrity(repoRoot)).toBeUndefined();
  });

  it('returns undefined when the manifest is absent', () => {
    kokoroFile('kokoro-v1.0.onnx', 1000);
    kokoroFile('voices-v1.0.bin', 200);
    expect(kokoroIntegrity(repoRoot)).toBeUndefined();
  });
});
