import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { venvCorePackageInstalled } from './venv-core-package.js';

let tmp: string | null = null;

afterEach(() => {
  if (tmp) rmSync(tmp, { recursive: true, force: true });
  tmp = null;
});

function makeRepoRoot(): string {
  tmp = mkdtempSync(join(tmpdir(), 'venv-core-pkg-'));
  return tmp;
}

describe('venvCorePackageInstalled', () => {
  it('returns false when the venv does not exist at all', () => {
    const repoRoot = makeRepoRoot();
    expect(venvCorePackageInstalled(repoRoot)).toBe(false);
  });

  it('returns false when the venv exists but fastapi is not in site-packages', () => {
    const repoRoot = makeRepoRoot();
    mkdirSync(join(repoRoot, 'server', 'tts-sidecar', '.venv', 'Lib', 'site-packages'), {
      recursive: true,
    });
    expect(venvCorePackageInstalled(repoRoot)).toBe(false);
  });

  it('returns true when fastapi is present under Windows-layout site-packages', () => {
    const repoRoot = makeRepoRoot();
    mkdirSync(
      join(repoRoot, 'server', 'tts-sidecar', '.venv', 'Lib', 'site-packages', 'fastapi'),
      { recursive: true },
    );
    expect(venvCorePackageInstalled(repoRoot)).toBe(true);
  });

  it('returns true when fastapi is present under posix-layout site-packages', () => {
    const repoRoot = makeRepoRoot();
    mkdirSync(
      join(
        repoRoot, 'server', 'tts-sidecar', '.venv', 'lib', 'python3.12', 'site-packages', 'fastapi',
      ),
      { recursive: true },
    );
    expect(venvCorePackageInstalled(repoRoot)).toBe(true);
  });
});
