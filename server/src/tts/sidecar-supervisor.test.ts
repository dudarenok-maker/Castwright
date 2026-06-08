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

  /* Adopt-supervision: when the server honours an ALREADY-listening sidecar
     (no child spawned, so no onExit can fire), the supervisor must watch the
     port and respawn an OWNED child once that adopted sidecar disappears.
     Without this, a self-recycle of an adopted sidecar — e.g. after a `tsx
     watch` dev reload re-adopted the orphan (the 2026-06-01 stall) — is never
     recovered and generation wedges on "sidecar not reachable". */
  it('watches an adopted sidecar and respawns an owned child when it vanishes', async () => {
    const handles: ReturnType<typeof makeHandle>[] = [];
    let calls = 0;
    const spawnFn = vi.fn(async (opts: SpawnSidecarOpts) => {
      calls += 1;
      if (calls === 1) {
        // A fresh sidecar is already listening → honour it, announce the adopt.
        opts.onAdoptExisting?.({ host: '127.0.0.1', port: 9000 });
        return null;
      }
      const h = makeHandle();
      handles.push(h);
      return h as SidecarHandle;
    });
    // The adopted sidecar answers two polls, then the port goes silent.
    const probes = [true, true, false];
    let pi = 0;
    const probeFn = vi.fn(async () => probes[Math.min(pi++, probes.length - 1)]);
    const sup = createSidecarSupervisor({
      buildOpts: async () => BASE_OPTS,
      spawnFn,
      probeFn,
      delayFn: async () => {},
      adoptedPollMs: 1,
      warn: vi.fn(),
      log: vi.fn(),
    });
    await sup.start();
    expect(spawnFn).toHaveBeenCalledTimes(1); // adopted — nothing spawned yet
    expect(sup.current()).toBeNull();
    // Watcher polls; on the silent poll it respawns an owned, supervised child.
    await vi.waitFor(() => expect(spawnFn).toHaveBeenCalledTimes(2));
    expect(sup.current()).toBe(handles[0]);
  });

  /* Fitness watchdog: an adopted sidecar that stays TCP-up but becomes
     leak-saturated (committed over the adopt ceiling) must be replaced too —
     the 2026-06-02 "stuck after restart" left a fresh server bolted onto a
     26 GB adopted orphan that never exited, so a disappearance-only watch never
     recovered it. */
  it('replaces an adopted sidecar that becomes leak-saturated (fitness watchdog)', async () => {
    const handles: ReturnType<typeof makeHandle>[] = [];
    let calls = 0;
    const spawnFn = vi.fn(async (opts: SpawnSidecarOpts) => {
      calls += 1;
      if (calls === 1) {
        opts.onAdoptExisting?.({ host: '127.0.0.1', port: 9000 });
        return null;
      }
      const h = makeHandle();
      handles.push(h);
      return h as SidecarHandle;
    });
    const probeFn = vi.fn(async () => true); // port stays up the whole time
    const healths = [
      { reachable: true, looksLikeSidecar: true, protocolVersion: 1, committedMb: 9000, recyclePending: false },
      { reachable: true, looksLikeSidecar: true, protocolVersion: 1, committedMb: 26000, recyclePending: false },
    ];
    let hi = 0;
    const healthProbeFn = vi.fn(async () => healths[Math.min(hi++, healths.length - 1)]);
    const sup = createSidecarSupervisor({
      buildOpts: async () => BASE_OPTS,
      spawnFn,
      probeFn,
      healthProbeFn,
      delayFn: async () => {},
      adoptedPollMs: 1,
      adoptedHealthPollMs: 1, // health-check every tick
      warn: vi.fn(),
      log: vi.fn(),
    });
    await sup.start();
    expect(spawnFn).toHaveBeenCalledTimes(1); // adopted
    // First health poll is fit; the second crosses the ceiling → respawn an owned child.
    await vi.waitFor(() => expect(spawnFn).toHaveBeenCalledTimes(2));
    expect(sup.current()).toBe(handles[0]);
  });

  /* Graceful drain before fitness-triggered replace (B1).
     When the supervisor detects a fitness violation on an alive adopted sidecar
     it must POST /recycle first so in-flight synth drains cleanly, wait for the
     port to free, and only then bring up the replacement.  The hard-kill path is
     unchanged for the disappearance branch and as a fallback when drain fails. */

  it('on a fitness trigger, calls recycleSidecarFn BEFORE spawning the replacement', async () => {
    const callOrder: string[] = [];
    let calls = 0;
    const spawnFn = vi.fn(async (opts: SpawnSidecarOpts) => {
      calls += 1;
      if (calls === 1) {
        opts.onAdoptExisting?.({ host: '127.0.0.1', port: 9000 });
        return null;
      }
      callOrder.push('spawn');
      const h = makeHandle();
      return h as SidecarHandle;
    });
    const recycleSidecarFn = vi.fn(async (_host: string, _port: number) => {
      callOrder.push('recycle');
      return true; // graceful recycle succeeded
    });
    // Port stays up for one tick after recycle (draining), then frees.
    const probes = [true, true, true, false];
    let pi = 0;
    const probeFn = vi.fn(async () => probes[Math.min(pi++, probes.length - 1)]);
    const healths = [
      { reachable: true, looksLikeSidecar: true, protocolVersion: 1, committedMb: 9000, recyclePending: false },
      { reachable: true, looksLikeSidecar: true, protocolVersion: 1, committedMb: 26000, recyclePending: false },
    ];
    let hi = 0;
    const healthProbeFn = vi.fn(async () => healths[Math.min(hi++, healths.length - 1)]);
    const sup = createSidecarSupervisor({
      buildOpts: async () => BASE_OPTS,
      spawnFn,
      probeFn,
      healthProbeFn,
      recycleSidecarFn,
      delayFn: async () => {},
      adoptedPollMs: 1,
      adoptedHealthPollMs: 1,
      drainWaitMs: 50,
      warn: vi.fn(),
      log: vi.fn(),
    });
    await sup.start();
    expect(spawnFn).toHaveBeenCalledTimes(1); // adopted
    await vi.waitFor(() => expect(spawnFn).toHaveBeenCalledTimes(2));
    // recycleSidecarFn must have been called exactly once.
    expect(recycleSidecarFn).toHaveBeenCalledTimes(1);
    expect(recycleSidecarFn).toHaveBeenCalledWith('127.0.0.1', 9000);
    // recycle must appear before spawn in the call order.
    expect(callOrder.indexOf('recycle')).toBeLessThan(callOrder.indexOf('spawn'));
  });

  it('falls back to hard replace when graceful recycle fails', async () => {
    let calls = 0;
    const spawnFn = vi.fn(async (opts: SpawnSidecarOpts) => {
      calls += 1;
      if (calls === 1) {
        opts.onAdoptExisting?.({ host: '127.0.0.1', port: 9000 });
        return null;
      }
      return makeHandle() as SidecarHandle;
    });
    // recycleSidecarFn always fails (network error / non-2xx).
    const recycleSidecarFn = vi.fn(async () => false);
    // Port never frees on its own (recycle was rejected by the sidecar).
    const probeFn = vi.fn(async () => true);
    const healths = [
      { reachable: true, looksLikeSidecar: true, protocolVersion: 1, committedMb: 9000, recyclePending: false },
      { reachable: true, looksLikeSidecar: true, protocolVersion: 1, committedMb: 26000, recyclePending: false },
    ];
    let hi = 0;
    const healthProbeFn = vi.fn(async () => healths[Math.min(hi++, healths.length - 1)]);
    const sup = createSidecarSupervisor({
      buildOpts: async () => BASE_OPTS,
      spawnFn,
      probeFn,
      healthProbeFn,
      recycleSidecarFn,
      delayFn: async () => {},
      adoptedPollMs: 1,
      adoptedHealthPollMs: 1,
      drainWaitMs: 50, // short so the test does not hang
      warn: vi.fn(),
      log: vi.fn(),
    });
    await sup.start();
    expect(spawnFn).toHaveBeenCalledTimes(1); // adopted
    // Even though recycle failed, the hard-kill path still brings up a replacement.
    await vi.waitFor(() => expect(spawnFn).toHaveBeenCalledTimes(2));
    expect(recycleSidecarFn).toHaveBeenCalledTimes(1);
  });

  it('falls back to hard replace when the graceful recycle THROWS', async () => {
    let calls = 0;
    const spawnFn = vi.fn(async (opts: SpawnSidecarOpts) => {
      calls += 1;
      if (calls === 1) {
        opts.onAdoptExisting?.({ host: '127.0.0.1', port: 9000 });
        return null;
      }
      return makeHandle() as SidecarHandle;
    });
    // recycleSidecarFn throws instead of resolving false.
    const recycleSidecarFn = vi.fn(async () => {
      throw new Error('boom');
    });
    // Port stays up (recycle threw, sidecar didn't self-exit).
    const probeFn = vi.fn(async () => true);
    const healths = [
      { reachable: true, looksLikeSidecar: true, protocolVersion: 1, committedMb: 9000, recyclePending: false },
      { reachable: true, looksLikeSidecar: true, protocolVersion: 1, committedMb: 26000, recyclePending: false },
    ];
    let hi = 0;
    const healthProbeFn = vi.fn(async () => healths[Math.min(hi++, healths.length - 1)]);
    const warn = vi.fn();
    const sup = createSidecarSupervisor({
      buildOpts: async () => BASE_OPTS,
      spawnFn,
      probeFn,
      healthProbeFn,
      recycleSidecarFn,
      delayFn: async () => {},
      adoptedPollMs: 1,
      adoptedHealthPollMs: 1,
      drainWaitMs: 50,
      warn,
      log: vi.fn(),
    });
    await sup.start();
    expect(spawnFn).toHaveBeenCalledTimes(1); // adopted
    // The throw must NOT escape as an unhandledRejection — spawnFn still reached.
    await vi.waitFor(() => expect(spawnFn).toHaveBeenCalledTimes(2));
    expect(recycleSidecarFn).toHaveBeenCalledTimes(1);
    // The warn about the throw must appear.
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('boom'));
  });

  it('does NOT call recycleSidecarFn on the disappearance trigger', async () => {
    let calls = 0;
    const spawnFn = vi.fn(async (opts: SpawnSidecarOpts) => {
      calls += 1;
      if (calls === 1) {
        opts.onAdoptExisting?.({ host: '127.0.0.1', port: 9000 });
        return null;
      }
      return makeHandle() as SidecarHandle;
    });
    const recycleSidecarFn = vi.fn(async () => true);
    // Port answers one probe (so start() returns at count=1), then goes silent.
    const probes = [true, false];
    let pi = 0;
    const probeFn = vi.fn(async () => probes[Math.min(pi++, probes.length - 1)]);
    const sup = createSidecarSupervisor({
      buildOpts: async () => BASE_OPTS,
      spawnFn,
      probeFn,
      recycleSidecarFn,
      delayFn: async () => {},
      adoptedPollMs: 1,
      warn: vi.fn(),
      log: vi.fn(),
    });
    await sup.start();
    // Disappearance detected → respawn without calling recycle.
    await vi.waitFor(() => expect(spawnFn).toHaveBeenCalledTimes(2));
    expect(recycleSidecarFn).not.toHaveBeenCalled();
  });

  it('stops watching an adopted sidecar after stop() (no respawn)', async () => {
    let calls = 0;
    const spawnFn = vi.fn(async (opts: SpawnSidecarOpts) => {
      calls += 1;
      if (calls === 1) {
        opts.onAdoptExisting?.({ host: '127.0.0.1', port: 9000 });
        return null;
      }
      return makeHandle() as SidecarHandle;
    });
    // Gate the watcher's first delay so we can stop() before it polls.
    let releaseDelay = () => {};
    const delayFn = () => new Promise<void>((r) => (releaseDelay = r));
    const probeFn = vi.fn(async () => false); // would trigger a respawn if reached
    const sup = createSidecarSupervisor({
      buildOpts: async () => BASE_OPTS,
      spawnFn,
      probeFn,
      delayFn,
      adoptedPollMs: 1,
      warn: vi.fn(),
      log: vi.fn(),
    });
    await sup.start();
    await sup.stop();
    releaseDelay(); // watcher resumes, sees stopped → bails before probing
    await new Promise((r) => setTimeout(r, 20));
    expect(probeFn).not.toHaveBeenCalled();
    expect(spawnFn).toHaveBeenCalledTimes(1); // no respawn after stop
  });

  /* ── recycling() accessor (B2 integration bug fix) ──────────────────────────
   *
   * B2 sourced `recycling` from `current() == null`, which is permanently true
   * for an ADOPTED sidecar (handle is null for its whole lifetime — it's not our
   * child).  The fix adds an explicit `recycling` boolean that is true only while
   * a respawn/drain-wait is actually in progress. */
  describe('recycling() accessor', () => {
    it('is false after a successful owned-child spawn', async () => {
      const { sup } = build();
      await sup.start();
      expect(sup.recycling()).toBe(false);
    });

    it('is true before the first spawn completes (not-ready-until-first-spawn)', async () => {
      // Use a gated spawnFn so we can observe the state mid-start.
      let releaseSpawn!: (h: SidecarHandle) => void;
      const pendingSpawn = new Promise<SidecarHandle>((r) => (releaseSpawn = r));
      const spawnFn = vi.fn(async (_opts: SpawnSidecarOpts) => pendingSpawn);
      const sup = createSidecarSupervisor({
        buildOpts: async () => BASE_OPTS,
        spawnFn,
        delayFn: async () => {},
        warn: vi.fn(),
        log: vi.fn(),
      });
      const startPromise = sup.start();
      // Spawn has not resolved yet → sidecar not ready → recycling must be true.
      expect(sup.recycling()).toBe(true);
      // Now let the spawn complete.
      releaseSpawn(makeHandle());
      await startPromise;
      expect(sup.recycling()).toBe(false);
    });

    it('is false after a successful ADOPT of a healthy sidecar (THE BUG: current() is null but sidecar is ready)', async () => {
      const spawnFn = vi.fn(async (opts: SpawnSidecarOpts) => {
        // Announce the adopt, return null (not our child).
        opts.onAdoptExisting?.({ host: '127.0.0.1', port: 9000 });
        return null;
      });
      const sup = createSidecarSupervisor({
        buildOpts: async () => BASE_OPTS,
        spawnFn,
        probeFn: vi.fn(async () => true), // keep the watchdog alive but not polling
        delayFn: async () => new Promise(() => {}), // gate the watchdog so it never polls
        adoptedPollMs: 100_000,
        warn: vi.fn(),
        log: vi.fn(),
      });
      await sup.start();
      // After a healthy adopt, handle is null but the sidecar IS ready.
      expect(sup.current()).toBeNull(); // confirm the original bug premise
      expect(sup.recycling()).toBe(false); // this is what the fix must guarantee
    });

    it('is true while a respawn is in progress (during backoff after child exit)', async () => {
      let releaseDelay!: () => void;
      const delayFn = vi.fn(async () => new Promise<void>((r) => (releaseDelay = r)));
      const handles: ReturnType<typeof makeHandle>[] = [];
      // Capture onExit from the initial spawn.
      let capturedExit!: SpawnSidecarOpts['onExit'];
      const realSpawnFn = vi.fn(async (opts: SpawnSidecarOpts) => {
        capturedExit = opts.onExit;
        const h = makeHandle();
        handles.push(h);
        return h as SidecarHandle;
      });
      const sup = createSidecarSupervisor({
        buildOpts: async () => BASE_OPTS,
        spawnFn: realSpawnFn,
        delayFn,
        nowFn: () => 0, // all deaths are "quick" → consecutive counter accumulates
        backoffsMs: [50],
        maxConsecutiveFailures: 5,
        warn: vi.fn(),
        log: vi.fn(),
      });
      await sup.start(); // spawns once → handles[0], capturedExit set
      expect(sup.recycling()).toBe(false);
      // Kill the child.
      capturedExit?.(1, null); // triggers onChildExit → sets recycling=true, awaits delayFn
      // recycling must be true immediately after the exit (during backoff).
      expect(sup.recycling()).toBe(true);
      // Let the backoff complete and the respawn finish.
      releaseDelay();
      await vi.waitFor(() => expect(realSpawnFn).toHaveBeenCalledTimes(2));
      expect(sup.recycling()).toBe(false);
    });

    it('drain-timeout fallback: when probeFn never frees the port within drainWaitMs, spawnFn is still called (drain budget exhausted → hard replace)', async () => {
      let calls = 0;
      const spawnFn = vi.fn(async (opts: SpawnSidecarOpts) => {
        calls += 1;
        if (calls === 1) {
          opts.onAdoptExisting?.({ host: '127.0.0.1', port: 9000 });
          return null;
        }
        return makeHandle() as SidecarHandle;
      });
      const recycleSidecarFn = vi.fn(async () => true); // recycle accepted
      // probeFn always returns true — port NEVER frees → drain-wait budget exhausted.
      const probeFn = vi.fn(async () => true);
      const healths = [
        { reachable: true, looksLikeSidecar: true, protocolVersion: 1, committedMb: 9000, recyclePending: false },
        { reachable: true, looksLikeSidecar: true, protocolVersion: 1, committedMb: 26000, recyclePending: false },
      ];
      let hi = 0;
      const healthProbeFn = vi.fn(async () => healths[Math.min(hi++, healths.length - 1)]);
      const sup = createSidecarSupervisor({
        buildOpts: async () => BASE_OPTS,
        spawnFn,
        probeFn,
        healthProbeFn,
        recycleSidecarFn,
        delayFn: async () => {},
        adoptedPollMs: 1,
        adoptedHealthPollMs: 1,
        drainWaitMs: 3, // very short budget — will be exceeded immediately since probeFn always returns true
        warn: vi.fn(),
        log: vi.fn(),
      });
      await sup.start();
      expect(spawnFn).toHaveBeenCalledTimes(1); // adopted
      // Even though the port never frees, the supervisor must eventually call spawnFn.
      await vi.waitFor(() => expect(spawnFn).toHaveBeenCalledTimes(2));
      expect(recycleSidecarFn).toHaveBeenCalledTimes(1); // graceful attempt was made
    });
  });
});
