/* srv-15 — sidecar respawn supervision.
 *
 * The server used to only LOG the sidecar's exit (plan 43 moved ownership to
 * Node and start-app.ps1 stopped supervising), so a crash / OOM-kill / poison
 * self-exit stalled generation forever. These tests pin the supervisor: it
 * respawns on unexpected exit with backoff, gives up after a crash loop, resets
 * the counter for a child that ran a while, and never respawns after stop().
 *
 * All timing is injected (delayFn / nowFn) so the suite is deterministic and
 * instant — no real timers, no real process. */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  createSidecarSupervisor,
  type SidecarSupervisorOpts,
} from './sidecar-supervisor.js';
import type { SidecarHandle, SpawnSidecarOpts } from './spawn-sidecar.js';

const BASE_OPTS: Omit<SpawnSidecarOpts, 'onExit'> = {
  autoStart: true,
  modelKey: 'kokoro-v1' as SpawnSidecarOpts['modelKey'],
  eagerLoadKokoro: true,
  eagerLoadQwen: true,
  repoRoot: '/repo',
};

function makeHandle(): SidecarHandle & { kill: ReturnType<typeof vi.fn> } {
  return { pid: 4242, child: {} as SidecarHandle['child'], kill: vi.fn(async () => {}) };
}

/** A spawnFn test double that records the latest `onExit` it was handed (the
 *  supervisor wires a fresh one each spawn — actually a stable closure) and
 *  returns a fresh handle each call so kill() assertions are unambiguous. */
function makeSpawn(handles: ReturnType<typeof makeHandle>[]) {
  let captured: SpawnSidecarOpts['onExit'];
  const fn = vi.fn(async (opts: SpawnSidecarOpts) => {
    captured = opts.onExit;
    const h = makeHandle();
    handles.push(h);
    return h as SidecarHandle;
  });
  return { fn, exit: (code: number | null) => captured?.(code, null) };
}

function build(overrides: Partial<SidecarSupervisorOpts> = {}) {
  const handles: ReturnType<typeof makeHandle>[] = [];
  const spawn = makeSpawn(handles);
  const warn = vi.fn();
  const log = vi.fn();
  let clock = 0;
  const sup = createSidecarSupervisor({
    buildOpts: async () => BASE_OPTS,
    spawnFn: spawn.fn,
    delayFn: async () => {}, // instant backoff
    nowFn: () => clock,
    warn,
    log,
    backoffsMs: [10, 20, 30],
    maxConsecutiveFailures: 3,
    ...overrides,
  });
  return { sup, spawn, handles, warn, log, advance: (ms: number) => (clock += ms) };
}

beforeEach(() => vi.clearAllMocks());

describe('sidecar supervisor (srv-15)', () => {
  it('spawns once on start and stores the handle', async () => {
    const { sup, spawn, handles } = build();
    await sup.start();
    expect(spawn.fn).toHaveBeenCalledTimes(1);
    expect(sup.current()).toBe(handles[0]);
  });

  it('respawns after an unexpected child exit', async () => {
    const { sup, spawn } = build();
    await sup.start();
    spawn.exit(1); // crash
    await vi.waitFor(() => expect(spawn.fn).toHaveBeenCalledTimes(2));
  });

  it('respawns on the poison self-exit code 42', async () => {
    const { sup, spawn } = build();
    await sup.start();
    spawn.exit(42);
    await vi.waitFor(() => expect(spawn.fn).toHaveBeenCalledTimes(2));
  });

  it('gives up after a crash loop and warns (does not spawn forever)', async () => {
    const { sup, spawn, warn } = build({ maxConsecutiveFailures: 2 });
    await sup.start(); // spawn #1
    spawn.exit(1);
    await vi.waitFor(() => expect(spawn.fn).toHaveBeenCalledTimes(2)); // respawn #2
    spawn.exit(1);
    await vi.waitFor(() => expect(spawn.fn).toHaveBeenCalledTimes(3)); // respawn #3
    spawn.exit(1); // 3rd consecutive failure > cap(2) → give up
    await vi.waitFor(() => expect(warn).toHaveBeenCalled());
    // No 4th spawn — the loop stopped.
    await new Promise((r) => setTimeout(r, 20));
    expect(spawn.fn).toHaveBeenCalledTimes(3);
  });

  it('resets the failure counter for a child that ran a while before dying', async () => {
    const { sup, spawn, warn, advance } = build({ maxConsecutiveFailures: 2 });
    await sup.start();
    // Three deaths, but each child "lived" >30s → counter never accumulates.
    for (let i = 0; i < 3; i += 1) {
      advance(60_000); // child lived a full minute
      spawn.exit(1);
      await vi.waitFor(() => expect(spawn.fn).toHaveBeenCalledTimes(i + 2));
    }
    expect(warn).not.toHaveBeenCalled(); // never tripped the crash-loop cap
  });

  it('stop() reaps the current child and prevents any respawn', async () => {
    const { sup, spawn, handles } = build();
    await sup.start();
    await sup.stop();
    expect(handles[0].kill).toHaveBeenCalledTimes(1);
    expect(sup.current()).toBeNull();
    // An exit firing after stop must NOT respawn.
    spawn.exit(1);
    await new Promise((r) => setTimeout(r, 20));
    expect(spawn.fn).toHaveBeenCalledTimes(1);
  });
});
