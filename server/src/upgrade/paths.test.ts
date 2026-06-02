/* fs-1 — pin upgrade path resolution for versioned vs dev layouts. */

import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import { resolveUpgradePaths } from './paths.js';

describe('resolveUpgradePaths', () => {
  it('resolves install/releases siblings in a versioned-dir install', () => {
    const repoRoot = join('/opt', 'audiobook', 'releases', 'v1.6.0');
    const p = resolveUpgradePaths(repoRoot, {} as NodeJS.ProcessEnv);
    expect(p.isVersioned).toBe(true);
    expect(p.installRoot).toBe(join('/opt', 'audiobook'));
    expect(p.releasesDir).toBe(join('/opt', 'audiobook', 'releases'));
    expect(p.stagingDir).toBe(join('/opt', 'audiobook', '.upgrade-staging'));
    expect(p.stagedZip).toBe(join('/opt', 'audiobook', '.upgrade-staging', 'incoming.zip'));
  });

  it('treats a plain checkout as its own install root (dev)', () => {
    const repoRoot = join('/home', 'dev', 'Audiobook-Generator');
    const p = resolveUpgradePaths(repoRoot, {} as NodeJS.ProcessEnv);
    expect(p.isVersioned).toBe(false);
    expect(p.installRoot).toBe(repoRoot);
    expect(p.releasesDir).toBe(join(repoRoot, 'releases'));
  });

  it('honours SIDECAR_VENV_DIR for the venv path, else the per-release default', () => {
    const repoRoot = join('/opt', 'audiobook', 'releases', 'v1.6.0');
    expect(resolveUpgradePaths(repoRoot, { SIDECAR_VENV_DIR: join('/opt', 'audiobook', 'venv') } as NodeJS.ProcessEnv).venvDir).toBe(
      join('/opt', 'audiobook', 'venv'),
    );
    expect(resolveUpgradePaths(repoRoot, {} as NodeJS.ProcessEnv).venvDir).toBe(
      join(repoRoot, 'server', 'tts-sidecar', '.venv'),
    );
  });
});
