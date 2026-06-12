/* fs-1 — pin the boot upgrade coordinator: first-boot records the version;
   same version is a no-op; a downgrade migrates nothing; an upgrade backs up
   every workspace JSON BEFORE migrating, records the version + what's-new flag,
   and prunes old release dirs. Drives a real temp workspace with injected deps
   (no module-const WORKSPACE_ROOT wrestling). */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  runUpgradeCoordinator,
  backupSeamFiles,
  planReleasePrune,
  type CoordinatorDeps,
} from './upgrade-coordinator.js';

function writeJson(path: string, value: unknown) {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, JSON.stringify(value), 'utf8');
}

describe('upgrade-coordinator', () => {
  let root: string;
  let workspaceRoot: string;
  let booksRoot: string;
  let userSettingsPath: string;
  let writeMeta: ReturnType<typeof vi.fn>;

  const FIXED_NOW = () => new Date('2026-06-02T12:00:00.000Z');

  function baseDeps(overrides: Partial<CoordinatorDeps> = {}): CoordinatorDeps {
    return {
      appVersion: '1.6.0',
      workspaceRoot,
      booksRoot,
      userSettingsPath,
      readLastSeenAppVersion: async () => '1.5.1',
      writeMeta: writeMeta as unknown as CoordinatorDeps['writeMeta'],
      now: FIXED_NOW,
      ...overrides,
    };
  }

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'fs1-coord-'));
    workspaceRoot = join(root, 'workspace');
    booksRoot = join(workspaceRoot, 'books');
    userSettingsPath = join(root, 'user-settings.json');
    // One book with a couple of seam files.
    const bookDir = join(booksRoot, 'Della Renwick', 'Keeper', 'Book 1', '.audiobook');
    writeJson(join(bookDir, 'cast.json'), { characters: [{ id: 'wren' }] });
    writeJson(join(bookDir, 'state.json'), { schema: 1, title: 'Book 1' });
    writeJson(join(workspaceRoot, 'voices.json'), { pins: {} });
    writeFileSync(userSettingsPath, JSON.stringify({ displayName: 'Mike' }), 'utf8');
    writeMeta = vi.fn(async () => {});
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('records the version on first boot (no banner, no backup)', async () => {
    const res = await runUpgradeCoordinator(baseDeps({ readLastSeenAppVersion: async () => undefined }));
    expect(res.action).toBe('first-boot');
    expect(writeMeta).toHaveBeenCalledWith({ lastSeenAppVersion: '1.6.0' });
    expect(res.backupDir).toBeUndefined();
  });

  it('is a no-op when the version is unchanged', async () => {
    const res = await runUpgradeCoordinator(baseDeps({ readLastSeenAppVersion: async () => '1.6.0' }));
    expect(res.action).toBe('noop');
    expect(writeMeta).not.toHaveBeenCalled();
  });

  it('migrates nothing on a downgrade', async () => {
    const res = await runUpgradeCoordinator(baseDeps({ readLastSeenAppVersion: async () => '1.7.0' }));
    expect(res.action).toBe('downgrade');
    expect(writeMeta).not.toHaveBeenCalled();
    expect(existsSync(join(workspaceRoot, '.upgrade-backups'))).toBe(false);
  });

  it('backs up every seam JSON before migrating, then records version + what\'s-new', async () => {
    const res = await runUpgradeCoordinator(baseDeps());
    expect(res.action).toBe('upgrade');
    expect(res.fromVersion).toBe('1.5.1');

    // Backup dir is timestamped from the injected clock.
    expect(res.backupDir).toContain('from-1.5.1-to-1.6.0-2026-06-02T12-00-00-000Z');
    expect(existsSync(res.backupDir as string)).toBe(true);

    // The per-book files, workspace voices.json, and user-settings.json copied.
    expect(res.backedUp).toContain('voices.json');
    expect(res.backedUp).toContain('user-settings.json');
    expect(res.backedUp?.some((p) => p.endsWith('cast.json'))).toBe(true);
    expect(res.backedUp?.some((p) => p.endsWith('state.json'))).toBe(true);

    // Version recorded + banner flagged in ONE writeMeta call.
    expect(writeMeta).toHaveBeenCalledWith({ lastSeenAppVersion: '1.6.0', showWhatsNew: true });

    // v1 everywhere → no actual file transforms.
    expect(res.migrated).toEqual([]);
  });

  it('prunes old release dirs to the newest 2 + the current version', async () => {
    const releasesDir = join(root, 'releases');
    for (const v of ['v1.4.0', 'v1.5.0', 'v1.5.1', 'v1.6.0']) mkdirSync(join(releasesDir, v), { recursive: true });
    const res = await runUpgradeCoordinator(baseDeps({ releasesDir, keepReleases: 2 }));
    // keep newest 2 (v1.6.0, v1.5.1) + current (v1.6.0) → delete v1.5.0, v1.4.0.
    expect(res.prunedReleases?.sort()).toEqual(['v1.4.0', 'v1.5.0']);
    expect(existsSync(join(releasesDir, 'v1.4.0'))).toBe(false);
    expect(existsSync(join(releasesDir, 'v1.6.0'))).toBe(true);
    expect(existsSync(join(releasesDir, 'v1.5.1'))).toBe(true);
  });
});

describe('planReleasePrune', () => {
  it('keeps the newest N by semver plus the current version, drops the rest', () => {
    const dirs = ['v1.2.0', 'v1.10.0', 'v1.9.0', 'v1.6.0', 'junk'];
    // keep 2 newest (v1.10.0, v1.9.0) + current v1.6.0 → drop v1.2.0 only.
    expect(planReleasePrune(dirs, 2, '1.6.0').sort()).toEqual(['v1.2.0']);
  });

  it('ignores non-semver directory names', () => {
    expect(planReleasePrune(['junk', 'node_modules'], 2, '1.6.0')).toEqual([]);
  });
});

describe('backupSeamFiles', () => {
  it('returns [] for an empty workspace (no books, no voices, no settings)', async () => {
    const empty = mkdtempSync(join(tmpdir(), 'fs1-empty-'));
    try {
      const copied = await backupSeamFiles({
        booksRoot: join(empty, 'books'),
        workspaceRoot: empty,
        userSettingsPath: join(empty, 'nope.json'),
        backupDir: join(empty, '.upgrade-backups', 'x'),
      });
      expect(copied).toEqual([]);
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });
});
