import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Mock data must never carry a real home folder (#4875): it would surface in
// any capture or demo. Only obviously fake account names are allowed.
const FAKE_NAMES = new Set(['you', 'alice', 'user', 'example']);
const HOME_PATH = /Users[\\/]+([A-Za-z0-9_.-]+)/g;

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return walk(p);
    return /\.(ts|tsx|json|md)$/.test(name) && !name.endsWith('.test.ts') ? [p] : [];
  });
}

describe('mock layer has no real home paths', () => {
  const files = [join(root, 'lib', 'api.ts'), ...walk(join(root, 'mocks'))];

  it('scans a non-empty file set', () => {
    expect(files.length).toBeGreaterThan(1);
  });

  it('every Users home path or /Users/<name> uses a fake placeholder name', () => {
    const offenders: string[] = [];
    for (const f of files) {
      const text = readFileSync(f, 'utf8');
      for (const m of text.matchAll(HOME_PATH)) {
        if (!FAKE_NAMES.has(m[1].toLowerCase()))
          offenders.push(`${f}: home path, name of ${m[1].length} chars`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
