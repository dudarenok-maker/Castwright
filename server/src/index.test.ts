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

import { describe, it, expect, vi } from 'vitest';
import { runShutdownSequence, type ShutdownDeps } from './index.js';

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
