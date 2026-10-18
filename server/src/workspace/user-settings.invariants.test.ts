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
import { existsSync, readFileSync, readdirSync, renameSync, rmSync, utimesSync, writeFileSync, mkdirSync } from 'node:fs';
import { basename, dirname } from 'node:path';

const hooks = vi.hoisted(() => ({
  rename: null as null | ((src: string, dest: string) => Promise<void>),
  readFile: null as null | ((path: string) => Promise<void>),
  /** Runs after the real read has returned its bytes, before the caller sees them. */
  readFileAfter: null as null | ((path: string) => Promise<void>),
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
      const out = await actual.readFile(...args);
      if (hooks.readFileAfter) await hooks.readFileAfter(String(args[0]));
      return out;
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
  hooks.readFileAfter = null;
  hooks.readdirFails = false;
  clean();
  mod._resetUserSettingsCache();
});

afterEach(() => {
  vi.restoreAllMocks();
  hooks.rename = null;
  hooks.readFile = null;
  hooks.readFileAfter = null;
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

  /* Pass 6 🟡1: the stamp a read commits is the one taken BEFORE it read, never
     a stat at commit time. Another process's rename-in that lands after this
     read parsed main, but before it committed, would otherwise be recorded
     under the OLD content, and nothing would ever re-read it. */
  it('a rename-in by another process between the parse and the commit is picked up by the next read', async () => {
    writeFileSync(P, settings({ displayName: 'Old' }));
    let swapped = false;
    hooks.readFileAfter = async (p) => {
      if (p !== P || swapped) return;
      swapped = true;
      const tmp = `${P}.tmp-sibling`;
      writeFileSync(tmp, settings({ displayName: 'Sibling, written after our parse' }));
      renameSync(tmp, P);
    };
    expect((await mod.readUserSettings()).displayName).toBe('Old');
    hooks.readFileAfter = null;
    expect(swapped).toBe(true);
    expect((await mod.readUserSettings()).displayName).toBe('Sibling, written after our parse');
  });
});

const erofs = () => Object.assign(new Error('EROFS: simulated'), { code: 'EROFS' });
/** A marker another process left, `ageMs` old. */
function foreignMarker(ageMs: number): string {
  const m = `${P}.writing-31337-4`;
  writeFileSync(m, '');
  const t = (Date.now() - ageMs) / 1000;
  utimesSync(m, t, t);
  return m;
}
const HOUR = 60 * 60 * 1000;

describe('I2 — a deliberate delete resets to defaults and never resurrects', () => {
  /* Probe S1 (delta review 3, 🟠2a): the restore-failure path keeps its marker
     on purpose; nothing ever removed it, so every later delete recovered. */
  it('S1: after a write whose rename-in and restore both failed, later deletes still reset (warm, again, and after a restart)', async () => {
    await mod.writeUserSettings({ displayName: 'v1' });
    await mod.writeUserSettings({ displayName: 'v2' });
    hooks.rename = async (src, dest) => {
      if (src.includes('.tmp-') || dest === P) throw erofs();
    };
    await expect(mod.writeUserSettings({ displayName: 'v3' })).rejects.toThrow(/EROFS/);
    hooks.rename = null;
    expect(existsSync(P)).toBe(false);
    expect((await mod.readUserSettings()).displayName).toBe('v2'); // stranded: recovered
    await mod.writeUserSettings({ displayName: 'v4' });
    await mod.writeUserSettings({ displayName: 'v5' });
    expect(markers()).toEqual([]);

    rmSync(P);
    expect((await mod.readUserSettings()).displayName).toBe(mod.DEFAULT_USER_SETTINGS.displayName);
    await mod.writeUserSettings({ displayName: 'v6' });
    rmSync(P);
    expect((await mod.readUserSettings()).displayName).toBe(mod.DEFAULT_USER_SETTINGS.displayName);
    await mod.writeUserSettings({ displayName: 'v7' });
    mod._resetUserSettingsCache();
    rmSync(P);
    expect((await mod.readUserSettings()).displayName).toBe(mod.DEFAULT_USER_SETTINGS.displayName);
  });

  /* Probe S2: a marker from a process killed long ago (before this boot). */
  it('S2: a stale marker from a killed process is swept by the next save, so a delete after a restart resets', async () => {
    foreignMarker(HOUR);
    await mod.writeUserSettings({ displayName: 'first' });
    await mod.writeUserSettings({ displayName: 'second' });
    await mod.writeUserSettings({ displayName: 'latest' });
    expect(markers()).toEqual([]);
    rmSync(P);
    mod._resetUserSettingsCache();
    expect((await mod.readUserSettings()).displayName).toBe(mod.DEFAULT_USER_SETTINGS.displayName);
  });

  /* Probe S3: a stale marker, and the user deleted main AND every backup. */
  it('S3: a thorough reset under a stale marker is a reset (warm): no wedge, writes allowed', async () => {
    await mod.writeUserSettings({ displayName: 'Mine' });
    await mod.writeUserSettings({ displayName: 'Mine2' });
    foreignMarker(HOUR);
    for (const p of [P, bak(1), bak(2), bak(3)]) rmSync(p, { force: true });
    expect((await mod.readUserSettings()).displayName).toBe(mod.DEFAULT_USER_SETTINGS.displayName);
    expect(mod.isUserSettingsFileUnreadable()).toBe(false);
    expect(mod.isUserSettingsFileCorrupt()).toBe(false);
    await expect(mod.writeUserSettings({ displayName: 'After' })).resolves.toBeTruthy();
  });

  /* Pass 6 🟠2, probe P-I2a: a dead marker that no save has swept since it
     appeared. Its mtime predates this process's last sighting of a present
     main, so it cannot explain main's absence. */
  it('P-I2a: an hour-old marker with no save after it does not turn a delete into a recovery (warm)', async () => {
    await mod.writeUserSettings({ displayName: 'v1' });
    await mod.writeUserSettings({ displayName: 'v2' });
    foreignMarker(HOUR);
    rmSync(P);
    expect((await mod.readUserSettings()).displayName).toBe(mod.DEFAULT_USER_SETTINGS.displayName);
    expect(existsSync(P)).toBe(false);
  });

  /* P-I2b: a young foreign marker survives the post-write sweeps (it could be a
     live sibling), then ages. It was on disk before the last save, so it
     predates the last sighting of main. */
  it('P-I2b: a fresh foreign marker kept by two saves, then aged, does not resurrect on delete', async () => {
    await mod.writeUserSettings({ displayName: 'v1' });
    foreignMarker(0);
    await mod.writeUserSettings({ displayName: 'v2' });
    await mod.writeUserSettings({ displayName: 'v3' });
    expect(markers()).toHaveLength(1); // young and foreign: the sweeps keep it
    const realNow = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(realNow + HOUR); // the marker ages
    rmSync(P);
    expect((await mod.readUserSettings()).displayName).toBe(mod.DEFAULT_USER_SETTINGS.displayName);
    expect(existsSync(P)).toBe(false);
  });

  /* P-I2c, the cold case. At boot this process has never seen main, so a crash
     mid-save (I3) and a stale marker followed by a deliberate delete (I2) look
     the same on disk. Owner decision (#3625 pass 6): delete wins. */
  it('P-I2c: at boot, a dead marker beside a missing main is a delete: defaults', async () => {
    await mod.writeUserSettings({ displayName: 'v1' });
    await mod.writeUserSettings({ displayName: 'v2' });
    foreignMarker(HOUR);
    rmSync(P);
    mod._resetUserSettingsCache(); // a restart
    expect((await mod.readUserSettings()).displayName).toBe(mod.DEFAULT_USER_SETTINGS.displayName);
    expect(existsSync(P)).toBe(false);
    expect(mod.isUserSettingsFileCorrupt()).toBe(false);
    expect(mod.isUserSettingsFileUnreadable()).toBe(false);
  });

  /* Pass 6 🟠2 (c): reads sweep too, not only writes, so a dead marker beside a
     present main does not wait for the next save. */
  it('a read that finds main present sweeps dead markers, at boot too, and keeps a live one', async () => {
    writeFileSync(P, settings({ displayName: 'Mine' }));
    foreignMarker(HOUR);
    expect((await mod.readUserSettings()).displayName).toBe('Mine');
    expect(markers()).toEqual([]);

    mod._resetUserSettingsCache();
    const live = foreignMarker(0);
    expect((await mod.readUserSettings()).displayName).toBe('Mine');
    expect(markers()).toEqual([basename(live)]);
  });

  it('S3: a thorough reset under a stale marker is a reset (cold): defaults, not flagged corrupt', async () => {
    foreignMarker(HOUR);
    const s = await mod.readUserSettings();
    expect(s.displayName).toBe(mod.DEFAULT_USER_SETTINGS.displayName);
    expect(mod.isUserSettingsFileCorrupt()).toBe(false);
    expect(mod.isUserSettingsFileUnreadable()).toBe(false);
  });
});

describe('I3 — a crash mid-write is recovered from backup at most once, then main is rewritten', () => {
  /* Pass 6: I3 applies to a strand this process can ATTRIBUTE - a live marker,
     or a dead one newer than its last sighting of a present main. Here main was
     seen two hours ago and a sibling died mid-save an hour ago. */
  it('a dead marker newer than the last sighting of main recovers .bak.1, writes it back and drops the marker; a later delete resets', async () => {
    const realNow = Date.now();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(realNow - 2 * HOUR);
    writeFileSync(P, settings({ displayName: 'Crashed', allowCloudFallback: false }));
    await mod.readUserSettings(); // this process sees main, two hours ago
    clock.mockRestore();
    renameSync(P, bak(1)); // the sibling's rename-away, an hour ago
    foreignMarker(HOUR);
    expect((await mod.readUserSettings()).displayName).toBe('Crashed');
    expect(existsSync(P)).toBe(true);
    expect(onDisk()).toMatchObject({ displayName: 'Crashed', allowCloudFallback: false });
    expect(markers()).toEqual([]);

    rmSync(P);
    expect((await mod.readUserSettings()).displayName).toBe(mod.DEFAULT_USER_SETTINGS.displayName);
  });

  /* Pass 6: a marker this process kept after its OWN failed write is a strand it
     can always attribute, whatever its mtime says (a filesystem clock coarser
     than Date.now() can date it before the last sighting of main). */
  it('the marker kept by our own failed write is recovered even when its mtime predates the last sighting', async () => {
    await mod.writeUserSettings({ displayName: 'v1' });
    await mod.writeUserSettings({ displayName: 'v2' });
    hooks.rename = async (src, dest) => {
      if (src.includes('.tmp-') || dest === P) throw erofs();
    };
    await expect(mod.writeUserSettings({ displayName: 'v3' })).rejects.toThrow(/EROFS/);
    hooks.rename = null;
    expect(markers()).toHaveLength(1);
    const t = (Date.now() - HOUR) / 1000;
    utimesSync(`${dirname(P)}/${markers()[0]}`, t, t);
    expect((await mod.readUserSettings()).displayName).toBe('v2');
    expect(onDisk()).toMatchObject({ displayName: 'v2' });
  });

  /* Pass 6 🟡2: the warning on a failed write-back says the next read recovers
     again; the read must actually retry, not serve the cache forever. */
  it('a failed write-back is retried by the next read', async () => {
    await mod.writeUserSettings({ displayName: 'v1' });
    await mod.writeUserSettings({ displayName: 'v2' });
    hooks.rename = async (src, dest) => {
      if (src.includes('.tmp-') || dest === P) throw erofs();
    };
    await expect(mod.writeUserSettings({ displayName: 'v3' })).rejects.toThrow(/EROFS/);
    expect(existsSync(P)).toBe(false);
    expect((await mod.readUserSettings()).displayName).toBe('v2'); // its write-back fails too
    expect(existsSync(P)).toBe(false);
    hooks.rename = null;
    expect((await mod.readUserSettings()).displayName).toBe('v2');
    expect(existsSync(P)).toBe(true);
    expect(onDisk()).toMatchObject({ displayName: 'v2' });
  });

  it('a LIVE marker (a sibling mid-write) is served from the backup but main is not written under it', async () => {
    writeFileSync(bak(1), settings({ displayName: 'Sibling' }));
    foreignMarker(0);
    expect((await mod.readUserSettings()).displayName).toBe('Sibling');
    expect(existsSync(P)).toBe(false);
    expect(markers()).toHaveLength(1);
  });
});

describe('I4 — uncertainty refuses writes rather than serving defaults', () => {
  it('a readdir error in a sibling window keeps the last-known settings, refuses writes and deletes no backup', async () => {
    writeFileSync(P, settings({ displayName: 'Mine', allowCloudFallback: false }));
    await mod.readUserSettings(); // warm
    writeFileSync(bak(1), readFileSync(P));
    rmSync(P); // the sibling's rename window
    foreignMarker(0);
    hooks.readdirFails = true;
    const s = await mod.readUserSettings();
    hooks.readdirFails = false;
    expect(s.displayName).toBe('Mine');
    expect(mod.getResolvedAllowCloudFallback()).toBe(false);
    expect(mod.isUserSettingsFileUnreadable()).toBe(true);
    expect(existsSync(bak(1))).toBe(true);
    hooks.readdirFails = true;
    try {
      await expect(mod.writeUpgradeMeta({ showWhatsNew: false })).rejects.toThrow();
    } finally {
      hooks.readdirFails = false;
    }
  });
});
