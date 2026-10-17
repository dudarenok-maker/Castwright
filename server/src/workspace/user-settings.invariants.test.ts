/* #3625 delta review 3 — the settings read path's four invariants, one
   describe each (the invariants themselves are written out above
   readUserSettings in user-settings.ts):

     I1  a read never commits values older than the newest completed write
         in this process;
     I2  a deliberate delete (no live write in flight) resets to defaults and
         never resurrects;
     I3  a crash mid-write is recovered from backup at most once, then main is
         rewritten;
     I4  any uncertainty (a readdir error, unknown marker state) refuses writes
         rather than serving defaults.

   `rename` and `readFile` are gated through node:fs/promises so a test can
   hold a save's rename-in, or a read of `.bak.1`, at an exact point;
   `readdirSync` can be made to fail. All pass straight through by default. */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync, readdirSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { basename, dirname } from 'node:path';

const hooks = vi.hoisted(() => ({
  rename: null as null | ((src: string, dest: string) => Promise<void>),
  readFile: null as null | ((path: string) => Promise<void>),
  readdirFails: false,
}));

vi.mock('node:fs/promises', async () => {
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  return {
    ...actual,
    rename: async (src: string, dest: string) => {
      if (hooks.rename) await hooks.rename(String(src), String(dest));
      return actual.rename(src, dest);
    },
    readFile: (async (...args: Parameters<typeof actual.readFile>) => {
      if (hooks.readFile) await hooks.readFile(String(args[0]));
      return actual.readFile(...args);
    }) as typeof actual.readFile,
  };
});

vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  return {
    ...actual,
    readdirSync: ((...args: Parameters<typeof actual.readdirSync>) => {
      if (hooks.readdirFails) throw Object.assign(new Error('EPERM: readdir denied'), { code: 'EPERM' });
      return actual.readdirSync(...args);
    }) as typeof actual.readdirSync,
  };
});

import * as mod from './user-settings.js';

const P = mod.USER_SETTINGS_PATH;
const bak = (n: number) => `${P}.bak.${n}`;
const settings = (over: Record<string, unknown>) => JSON.stringify({ ...mod.DEFAULT_USER_SETTINGS, ...over });
const onDisk = () => JSON.parse(readFileSync(P, 'utf8')) as Record<string, unknown>;
const markers = () => readdirSync(dirname(P)).filter((n) => n.startsWith(`${basename(P)}.writing-`));

function clean(): void {
  mkdirSync(dirname(P), { recursive: true });
  for (const p of [P, bak(1), bak(2), bak(3)]) rmSync(p, { force: true });
  for (const m of markers()) rmSync(`${dirname(P)}/${m}`, { force: true });
}

beforeEach(() => {
  hooks.rename = null;
  hooks.readFile = null;
  hooks.readdirFails = false;
  clean();
  mod._resetUserSettingsCache();
});

afterEach(() => {
  hooks.rename = null;
  hooks.readFile = null;
  hooks.readdirFails = false;
  clean();
  mod._resetUserSettingsCache();
});

function gate(): { wait: Promise<void>; open: () => void } {
  let open!: () => void;
  const wait = new Promise<void>((r) => (open = r));
  return { wait, open };
}

describe('I1 — a read never commits values older than the newest completed write', () => {
  /* Probe R1 (delta review 3, 🟠1): a read that starts inside a save's
     rename-in sees main absent + the saver's own marker, reads `.bak.1` (the
     pre-save settings) and used to commit them over the save's cache. */
  it('R1: a read held on .bak.1 across the save does not revert the saved cache, and a later save keeps it on disk', async () => {
    writeFileSync(P, settings({ displayName: 'Old', allowCloudFallback: true }));
    await mod.readUserSettings(); // warm on Old

    const renameIn = gate();
    const renameHeld = gate();
    const bakRead = gate();
    const bakHeld = gate();
    hooks.rename = async (src) => {
      if (src.includes('.tmp-')) {
        renameHeld.open();
        await renameIn.wait;
      }
    };
    hooks.readFile = async (p) => {
      if (p === bak(1)) {
        bakHeld.open();
        await bakRead.wait;
      }
    };

    const save = mod.writeUserSettings({ displayName: 'New', allowCloudFallback: false });
    await renameHeld.wait; // main is now absent, the save's marker present
    const read = mod.readUserSettings();
    await bakHeld.wait; // the read is reading the pre-save backup
    renameIn.open();
    await save; // the save's cache is New
    bakRead.open();
    await read;
    hooks.rename = null;
    hooks.readFile = null;

    expect(mod.getResolvedAllowCloudFallback()).toBe(false);
    expect((await mod.readUserSettings()).displayName).toBe('New');
    await mod.writeUserSettings({ minorCastMinLines: 7 });
    expect(onDisk()).toMatchObject({ displayName: 'New', allowCloudFallback: false, minorCastMinLines: 7 });
  });

  /* Probe R2: the natural order, no read gate — the rename-in is delayed a
     millisecond and a read starts inside it. Looped: the race is timing-bound. */
  it('R2: a read started inside a 1 ms rename-in never ends with the cache older than the disk (20 runs)', async () => {
    for (let run = 0; run < 20; run += 1) {
      clean();
      mod._resetUserSettingsCache();
      writeFileSync(P, settings({ displayName: 'Old', allowCloudFallback: true }));
      await mod.readUserSettings();
      let read: Promise<unknown> | null = null;
      hooks.rename = async (src) => {
        if (src.includes('.tmp-')) {
          read = mod.readUserSettings();
          await new Promise((r) => setTimeout(r, 1));
        }
      };
      await mod.writeUserSettings({ displayName: 'New', allowCloudFallback: false });
      hooks.rename = null;
      await read;
      expect(mod.getCachedUserSettings().displayName, `run ${run}`).toBe('New');
      expect(mod.getResolvedAllowCloudFallback(), `run ${run}`).toBe(false);
    }
  });
});
