/* #1366 — shutdown()'s teardown sequence (releaseSidecarOwnership,
   sidecarSupervisor.stop(), mdnsResponderHandle.kill(),
   portForwarderHandle.close(), allowSleep()) had zero automated coverage:
   a code-review pass on #1365 caught that allowSleep() had been added to
   shutdown() by hand with no test locking the call in. `runShutdownSequence`
   is the extracted, injectable-dependency equivalent (mirrors
   resolveUpgradePaths in upgrade/paths.ts) — this pins every call firing
   exactly once, in order, without index.ts binding a real port (the
   isMainModule guard at the bottom of index.ts keeps `main()` from running
   merely because this test imports the module). */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/* #3174 (G4) — bootWarmUserSettings() calls the real (module-level)
   readUserSettings import, so forcing its malformed-file throw needs the
   whole module mocked (node:fs's own writeFileSync-style spy trick doesn't
   apply here — this is a plain named export). Same pass-through-delegate
   convention as server/src/tts/restart-breadcrumb.test.ts. */
let readUserSettingsShouldThrow = false;
vi.mock('./workspace/user-settings.js', async () => {
  const actual = await vi.importActual<typeof import('./workspace/user-settings.js')>(
    './workspace/user-settings.js',
  );
  return {
    ...actual,
    readUserSettings: async (...args: Parameters<typeof actual.readUserSettings>) => {
      if (readUserSettingsShouldThrow) {
        throw new Error('simulated malformed user-settings.json (JSON.parse failure)');
      }
      return actual.readUserSettings(...args);
    },
  };
});

import {
  runShutdownSequence,
  bootWarmUserSettings,
  bootStartSidecarSupervisor,
  bootRepairDuplicateBookIds,
  type ShutdownDeps,
} from './index.js';

function makeDeps(overrides: Partial<ShutdownDeps> = {}): {
  deps: ShutdownDeps;
  calls: string[];
} {
  const calls: string[] = [];
  const deps: ShutdownDeps = {
    releaseSidecarOwnership: vi.fn(() => {
      calls.push('releaseSidecarOwnership');
    }),
    allowSleep: vi.fn(() => {
      calls.push('allowSleep');
    }),
    runDir: '/fake/.run',
    sidecarSupervisor: {
      stop: vi.fn(async () => {
        calls.push('sidecarSupervisor.stop');
      }),
    },
    mdnsResponderHandle: {
      kill: vi.fn(async () => {
        calls.push('mdnsResponderHandle.kill');
      }),
    },
    portForwarderHandle: {
      close: vi.fn(async () => {
        calls.push('portForwarderHandle.close');
      }),
    },
    ...overrides,
  };
  return { deps, calls };
}

describe('runShutdownSequence (#1366)', () => {
  it('calls every teardown dependency exactly once', async () => {
    const { deps } = makeDeps();
    await runShutdownSequence(deps);

    expect(deps.releaseSidecarOwnership).toHaveBeenCalledTimes(1);
    expect(deps.allowSleep).toHaveBeenCalledTimes(1);
    expect(deps.sidecarSupervisor!.stop).toHaveBeenCalledTimes(1);
    expect(deps.mdnsResponderHandle!.kill).toHaveBeenCalledTimes(1);
    expect(deps.portForwarderHandle!.close).toHaveBeenCalledTimes(1);
  });

  it('passes runDir through to releaseSidecarOwnership', async () => {
    const { deps } = makeDeps({ runDir: '/some/other/.run' });
    await runShutdownSequence(deps);

    expect(deps.releaseSidecarOwnership).toHaveBeenCalledWith('/some/other/.run');
  });

  it('releases sidecar ownership and drops the sleep lock before reaping the sidecar/mDNS/port-forwarder handles', async () => {
    const { deps, calls } = makeDeps();
    await runShutdownSequence(deps);

    // releaseSidecarOwnership and allowSleep are synchronous and must run,
    // in order, before the async reap/kill/close calls are even invoked.
    expect(calls.slice(0, 2)).toEqual(['releaseSidecarOwnership', 'allowSleep']);
    // The remaining three (sidecar reap, mDNS kill, port-forwarder close) are
    // invoked in this order and all awaited via Promise.all before resolving.
    expect(calls.slice(2)).toEqual([
      'sidecarSupervisor.stop',
      'mdnsResponderHandle.kill',
      'portForwarderHandle.close',
    ]);
  });

  it('tolerates null sidecarSupervisor/mdnsResponderHandle/portForwarderHandle (never spawned, e.g. autoStart off / non-LAN boot)', async () => {
    const { deps } = makeDeps({
      sidecarSupervisor: null,
      mdnsResponderHandle: null,
      portForwarderHandle: null,
    });

    await expect(runShutdownSequence(deps)).resolves.toBeUndefined();
    expect(deps.releaseSidecarOwnership).toHaveBeenCalledTimes(1);
    expect(deps.allowSleep).toHaveBeenCalledTimes(1);
  });

  it('resolves only after all three async teardown calls settle', async () => {
    let sidecarResolved = false;
    let mdnsResolved = false;
    let forwarderResolved = false;
    const { deps } = makeDeps({
      sidecarSupervisor: {
        stop: () =>
          new Promise((res) =>
            setTimeout(() => {
              sidecarResolved = true;
              res();
            }, 5),
          ),
      },
      mdnsResponderHandle: {
        kill: () =>
          new Promise((res) =>
            setTimeout(() => {
              mdnsResolved = true;
              res();
            }, 1),
          ),
      },
      portForwarderHandle: {
        close: () =>
          new Promise((res) =>
            setTimeout(() => {
              forwarderResolved = true;
              res();
            }, 1),
          ),
      },
    });

    await runShutdownSequence(deps);

    expect(sidecarResolved).toBe(true);
    expect(mdnsResolved).toBe(true);
    expect(forwarderResolved).toBe(true);
  });
});

describe('bootWarmUserSettings (#3174 G4)', () => {
  afterEach(() => {
    readUserSettingsShouldThrow = false;
  });

  it('a malformed user-settings.json is contained: no unhandled rejection, logged loudly, resolves', async () => {
    readUserSettingsShouldThrow = true;
    let unhandledRejection: unknown = null;
    const onUnhandledRejection = (reason: unknown) => {
      unhandledRejection = reason;
    };
    process.on('unhandledRejection', onUnhandledRejection);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    try {
      // Detached the same way the real boot call site uses it
      // (`void bootWarmUserSettings()`) — a throw escaping as a rejection
      // here, rather than being caught inside the function, would surface
      // only as a process-level unhandledRejection.
      void bootWarmUserSettings();
      await new Promise((r) => setTimeout(r, 0));

      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining('user-settings.json could not be read at boot'),
        expect.any(Error),
      );
      expect(unhandledRejection).toBeNull();
    } finally {
      process.removeListener('unhandledRejection', onUnhandledRejection);
      errorSpy.mockRestore();
    }
  });

  it('the control: a readable user-settings.json resolves quietly, with no error logged', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await expect(bootWarmUserSettings()).resolves.toBeUndefined();
      expect(errorSpy).not.toHaveBeenCalled();
    } finally {
      errorSpy.mockRestore();
    }
  });
});

describe('bootRepairDuplicateBookIds (#3713)', () => {
  const repairRecord = {
    previousBookId: 'a__s__t',
    newBookId: 'a__s__t-2',
    keptFolder: 'A/S/T2',
    reassignedFolder: 'A/S/T',
  };

  it('a repair that resolves [] logs nothing', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await bootRepairDuplicateBookIds(async () => []);
      expect(logSpy).not.toHaveBeenCalled();
      expect(warnSpy).not.toHaveBeenCalled();
    } finally {
      logSpy.mockRestore();
      warnSpy.mockRestore();
    }
  });

  it('a repair that resolves one record logs the count line', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      await bootRepairDuplicateBookIds(async () => [repairRecord]);
      expect(logSpy).toHaveBeenCalledWith(
        '[duplicate-bookid] gave 1 book(s) a fresh id on startup (see the lines above).',
      );
    } finally {
      logSpy.mockRestore();
    }
  });

  it('a repair that rejects is swallowed and warned, never rethrown', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await expect(
        bootRepairDuplicateBookIds(async () => {
          throw new Error('simulated repair failure');
        }),
      ).resolves.toBeUndefined();
      expect(warnSpy).toHaveBeenCalledWith(
        '[duplicate-bookid] startup repair failed',
        expect.any(Error),
      );
    } finally {
      warnSpy.mockRestore();
    }
  });
});

describe('main() boot order (#3713, PR #4004)', () => {
  /* main() cannot run here (it binds a port), so pin the order in its source: the
     sweep rewrites state.json, so it must follow the upgrade coordinator's backup,
     precede listen, and precede the fire-and-forget fsck that reads state.json. */
  const source = readFileSync(fileURLToPath(new URL('./index.ts', import.meta.url)), 'utf8');
  const at = (needle: string): number => {
    const i = source.indexOf(needle);
    expect(i, `${needle} not found in index.ts`).toBeGreaterThan(-1);
    return i;
  };

  it('runs the duplicate-bookId sweep after the upgrade coordinator and before listen', () => {
    const coordinator = at('await runUpgradeCoordinator(');
    const sweep = at('await bootRepairDuplicateBookIds();');
    const listen = at('listenWithAutoRebind(server, {');
    expect(coordinator).toBeLessThan(sweep);
    expect(sweep).toBeLessThan(listen);
  });

  it('starts the fsck only after the sweep, so the two never touch a state.json together', () => {
    expect(at('await bootRepairDuplicateBookIds();')).toBeLessThan(at('void fsckAllBooks()'));
  });
});

describe('bootStartSidecarSupervisor (#3174 G4)', () => {
  it('a supervisor.start() rejection is contained: no unhandled rejection, logged loudly, resolves', async () => {
    const supervisor = {
      start: vi.fn(async () => {
        throw new Error('simulated spawnOnce/buildOpts failure');
      }),
    };
    let unhandledRejection: unknown = null;
    const onUnhandledRejection = (reason: unknown) => {
      unhandledRejection = reason;
    };
    process.on('unhandledRejection', onUnhandledRejection);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    try {
      // Detached the same way the real boot call site uses it
      // (`void bootStartSidecarSupervisor(sidecarSupervisor)`).
      void bootStartSidecarSupervisor(supervisor);
      await new Promise((r) => setTimeout(r, 0));

      expect(supervisor.start).toHaveBeenCalledTimes(1);
      expect(errorSpy).toHaveBeenCalledWith('[sidecar] supervisor failed to start', expect.any(Error));
      expect(unhandledRejection).toBeNull();
    } finally {
      process.removeListener('unhandledRejection', onUnhandledRejection);
      errorSpy.mockRestore();
    }
  });

  it('the control: a successful start() resolves quietly, with no error logged', async () => {
    const supervisor = { start: vi.fn(async () => {}) };
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await expect(bootStartSidecarSupervisor(supervisor)).resolves.toBeUndefined();
      expect(errorSpy).not.toHaveBeenCalled();
    } finally {
      errorSpy.mockRestore();
    }
  });
});
