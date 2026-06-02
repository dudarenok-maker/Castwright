/* fs-1 Phase 1 — pins the app-runtime-dir resolution contract.

   logs/ and .run/ default to <repoRoot>/logs and <repoRoot>/.run (today's
   behaviour), but honour APP_LOG_DIR / APP_RUN_DIR so a versioned-directory
   install can park them in a shared sibling OUTSIDE the per-release tree —
   otherwise a `releases/vX.Y.Z/logs` would be orphaned every upgrade. An
   explicit env value wins; absence is byte-identical to before. */

import { describe, it, expect, afterEach } from 'vitest';
import { resolve } from 'node:path';
import { resolveLogDir, resolveRunDir } from './app-dirs.js';

describe('app-dirs', () => {
  const prevLog = process.env.APP_LOG_DIR;
  const prevRun = process.env.APP_RUN_DIR;

  afterEach(() => {
    if (prevLog === undefined) delete process.env.APP_LOG_DIR;
    else process.env.APP_LOG_DIR = prevLog;
    if (prevRun === undefined) delete process.env.APP_RUN_DIR;
    else process.env.APP_RUN_DIR = prevRun;
  });

  it('defaults to <repoRoot>/logs and <repoRoot>/.run when env is unset', () => {
    delete process.env.APP_LOG_DIR;
    delete process.env.APP_RUN_DIR;
    expect(resolveLogDir('/srv/app')).toBe(resolve('/srv/app', 'logs'));
    expect(resolveRunDir('/srv/app')).toBe(resolve('/srv/app', '.run'));
  });

  it('honours APP_LOG_DIR / APP_RUN_DIR when set (versioned-dir install)', () => {
    process.env.APP_LOG_DIR = resolve('/shared/logs');
    process.env.APP_RUN_DIR = resolve('/shared/run');
    expect(resolveLogDir('/srv/app/releases/v1.6.0')).toBe(resolve('/shared/logs'));
    expect(resolveRunDir('/srv/app/releases/v1.6.0')).toBe(resolve('/shared/run'));
  });

  it('resolves a relative env value to an absolute path', () => {
    process.env.APP_LOG_DIR = 'relative/logs';
    expect(resolveLogDir('/srv/app')).toBe(resolve('relative/logs'));
  });
});
