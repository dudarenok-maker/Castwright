/* fs-1 — pin validateUpgradeManifest (pure structural + version checks). */

import { describe, it, expect } from 'vitest';
import { validateUpgradeManifest, REQUIRED_ENTRIES } from './zip-validate.js';

const TOP = 'castwright-v1.6.0';
function goodEntries(top = TOP): string[] {
  return [`${top}/`, ...REQUIRED_ENTRIES.map((e) => `${top}/${e}`), `${top}/src/main.tsx`];
}

describe('validateUpgradeManifest', () => {
  it('accepts a well-formed newer release', () => {
    const r = validateUpgradeManifest({ entryNames: goodEntries(), packageJsonVersion: '1.6.0', runningVersion: '1.5.1' });
    expect(r.ok).toBe(true);
    expect(r.candidateVersion).toBe('1.6.0');
    expect(r.isDowngrade).toBe(false);
  });

  it('rejects more than one top-level directory', () => {
    const r = validateUpgradeManifest({
      entryNames: [...goodEntries(), 'evil/passwd'],
      packageJsonVersion: '1.6.0',
      runningVersion: '1.5.1',
    });
    expect(r.ok).toBe(false);
    expect(r.code).toBe('bad-structure');
  });

  it('rejects a wrong top-dir name', () => {
    const r = validateUpgradeManifest({
      entryNames: goodEntries('totally-not-us-v1.6.0'),
      packageJsonVersion: '1.6.0',
      runningVersion: '1.5.1',
    });
    expect(r.code).toBe('bad-structure');
  });

  it('rejects a missing required artefact', () => {
    const entries = goodEntries().filter((e) => !e.endsWith('server/dist/index.js'));
    const r = validateUpgradeManifest({ entryNames: entries, packageJsonVersion: '1.6.0', runningVersion: '1.5.1' });
    expect(r.code).toBe('missing-entry');
    expect(r.reason).toContain('server/dist/index.js');
  });

  it('rejects an unparseable version', () => {
    const r = validateUpgradeManifest({ entryNames: goodEntries(), packageJsonVersion: 'nope', runningVersion: '1.5.1' });
    expect(r.code).toBe('bad-version');
  });

  it('refuses a downgrade unless forced', () => {
    const down = validateUpgradeManifest({
      entryNames: goodEntries('castwright-v1.4.0'),
      packageJsonVersion: '1.4.0',
      runningVersion: '1.6.0',
    });
    expect(down.ok).toBe(false);
    expect(down.code).toBe('downgrade');
    expect(down.isDowngrade).toBe(true);

    const forced = validateUpgradeManifest({
      entryNames: goodEntries('castwright-v1.4.0'),
      packageJsonVersion: '1.4.0',
      runningVersion: '1.6.0',
      allowDowngrade: true,
    });
    expect(forced.ok).toBe(true);
    expect(forced.isDowngrade).toBe(true);
  });

  it('allows a same-version reinstall (not a downgrade)', () => {
    const r = validateUpgradeManifest({ entryNames: goodEntries(), packageJsonVersion: '1.6.0', runningVersion: '1.6.0' });
    expect(r.ok).toBe(true);
    expect(r.isDowngrade).toBe(false);
  });

  it('rejects a legacy audiobook-generator-* top dir as bad-structure', () => {
    const res = validateUpgradeManifest({
      entryNames: ['audiobook-generator-v1.6.0/package.json'],
      packageJsonVersion: '1.7.0',
      runningVersion: '1.6.0',
      allowDowngrade: false,
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe('bad-structure');
  });
});
