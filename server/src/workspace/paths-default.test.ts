import { describe, it, expect } from 'vitest';
import { resolve } from 'node:path';
import { WORKSPACE_ROOT, WORKSPACE_SOURCE } from './paths.js';

describe('default workspace dir', () => {
  it('defaults to ../castwright-workspace when WORKSPACE_DIR unset', () => {
    // When neither WORKSPACE_DIR env var nor workspaceDirOverride is set,
    // WORKSPACE_SOURCE === 'default' and WORKSPACE_ROOT must end with
    // castwright-workspace. In test runs with WORKSPACE_DIR set, we skip the
    // path assertion but still confirm the source value is valid.
    expect(['default', 'env', 'override']).toContain(WORKSPACE_SOURCE);
    if (WORKSPACE_SOURCE === 'default') {
      expect(WORKSPACE_ROOT.replace(/\\/g, '/')).toMatch(/\/castwright-workspace$/);
    }
  });

  it('the default path token is castwright-workspace (not audiobook-workspace)', () => {
    // Structural: when defaults apply, the resolved dir must use the new name.
    // Mirrors the resolution in paths.ts: SERVER_ROOT + '../castwright-workspace'.
    // This also documents the expected path for a fresh install.
    if (WORKSPACE_SOURCE !== 'default') return;
    const resolved = WORKSPACE_ROOT.replace(/\\/g, '/');
    expect(resolved).not.toMatch(/audiobook-workspace/);
    expect(resolved).toMatch(/castwright-workspace$/);
  });
});
