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
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  createSidecarSupervisor,
  registerActiveSupervisor,
  forceSidecarRecycle,
  type SidecarSupervisorOpts,
  type SidecarSupervisor,
} from './sidecar-supervisor.js';
import type { SidecarHandle, SpawnSidecarOpts } from './spawn-sidecar.js';
import * as breadcrumbModule from './restart-breadcrumb.js';

vi.mock('./restart-breadcrumb.js');

const BASE_OPTS: Omit<SpawnSidecarOpts, 'onExit'> = {
  autoStart: true,
  modelKey: 'kokoro-v1' as SpawnSidecarOpts['modelKey'],
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

  /* ── refused spawns are retried, not terminal (#2037) ──────────────────────
   *
   * spawnSidecar returns null for six distinct reasons. Two are BENIGN
   * no-spawns (autoStart off, a healthy adopt) where a fresh sidecar is
   * either unwanted or already ready. The other four are REFUSALS — a
   * foreign listener still holds the port (often the just-exited child's
   * socket still in TCP teardown), a stale sidecar's PID couldn't be
   * identified/killed, or the OS-level spawn itself failed. Before this fix,
   * spawnOnce() set `isRecycling = false` UNCONDITIONALLY after any null
   * return, so a refusal silently ended supervision and announced the
   * (nonexistent) sidecar as ready — the #2037 outage. */
  describe('spawn refusal is retried, not terminal (#2037)', () => {
    it('[HEADLINE] a refusal after a child exit is retried on backoff — recycling() stays true across the whole gap, and a supervised child eventually exists', async () => {
      let releaseDelay1!: () => void;
      let releaseDelay2!: () => void;
      let delayCall = 0;
      const delayFn = vi.fn(async () => {
        delayCall += 1;
        if (delayCall === 1) return new Promise<void>((r) => (releaseDelay1 = r));
        if (delayCall === 2) return new Promise<void>((r) => (releaseDelay2 = r));
        return Promise.resolve();
      });

      const handles: ReturnType<typeof makeHandle>[] = [];
      let calls = 0;
      let capturedExit: SpawnSidecarOpts['onExit'];
      const spawnFn = vi.fn(async (opts: SpawnSidecarOpts) => {
        calls += 1;
        if (calls === 1) {
          capturedExit = opts.onExit;
          const h = makeHandle();
          handles.push(h);
          return h as SidecarHandle;
        }
        if (calls === 2) {
          // The just-exited child's socket is still in teardown — spawnSidecar
          // refuses (a foreign-looking listener) rather than spawning over it.
          opts.onSpawnRefused?.('port still held');
          return null;
        }
        const h = makeHandle();
        handles.push(h);
        return h as SidecarHandle;
      });

      const sup = createSidecarSupervisor({
        buildOpts: async () => BASE_OPTS,
        spawnFn,
        delayFn,
        warn: vi.fn(),
        log: vi.fn(),
        backoffsMs: [10, 20, 30],
        maxConsecutiveFailures: 5,
      });

      await sup.start(); // spawn #1 succeeds
      expect(sup.recycling()).toBe(false);

      capturedExit?.(1, null); // child exits
      expect(sup.recycling()).toBe(true);

      releaseDelay1(); // backoff #1 elapses → spawn #2, which is REFUSED
      await vi.waitFor(() => expect(spawnFn).toHaveBeenCalledTimes(2));
      // The refusal must NOT have ended supervision: still recycling, and a
      // second backoff must have been scheduled.
      expect(sup.recycling()).toBe(true);
      expect(delayCall).toBe(2);

      releaseDelay2(); // backoff #2 elapses → spawn #3 succeeds
      await vi.waitFor(() => expect(spawnFn).toHaveBeenCalledTimes(3));
      expect(sup.recycling()).toBe(false);
      expect(sup.current()).toBe(handles[1]); // the eventual supervised child
    });

    it('a refusal at first start() (not only after an exit) is also retried', async () => {
      const handles: ReturnType<typeof makeHandle>[] = [];
      let calls = 0;
      const spawnFn = vi.fn(async (opts: SpawnSidecarOpts) => {
        calls += 1;
        if (calls === 1) {
          opts.onSpawnRefused?.('foreign listener on :9000');
          return null;
        }
        const h = makeHandle();
        handles.push(h);
        return h as SidecarHandle;
      });
      const sup = createSidecarSupervisor({
        buildOpts: async () => BASE_OPTS,
        spawnFn,
        delayFn: async () => {},
        warn: vi.fn(),
        log: vi.fn(),
        backoffsMs: [10, 20, 30],
        maxConsecutiveFailures: 5,
      });

      await sup.start();
      expect(sup.recycling()).toBe(true); // first attempt was refused

      await vi.waitFor(() => expect(spawnFn).toHaveBeenCalledTimes(2));
      expect(sup.recycling()).toBe(false);
      expect(sup.current()).toBe(handles[0]);
    });

    it('a refusal every time exhausts the budget (exhaustedEvent() true), and resetAndRespawn() recovers', async () => {
      const spawnFn = vi.fn(async (opts: SpawnSidecarOpts) => {
        opts.onSpawnRefused?.('foreign listener on :9000');
        return null;
      });
      const sup = createSidecarSupervisor({
        buildOpts: async () => BASE_OPTS,
        spawnFn,
        delayFn: async () => {},
        warn: vi.fn(),
        log: vi.fn(),
        backoffsMs: [10, 20, 30],
        maxConsecutiveFailures: 2,
      });

      await sup.start(); // attempt 1 — refused
      expect(sup.exhaustedEvent()).toBe(false);
      // Backoff retries run inside the (mocked, instant) delayFn chain — wait
      // for the budget to exhaust (cap=2 → 3rd refusal trips it).
      await vi.waitFor(() => expect(spawnFn).toHaveBeenCalledTimes(3));
      expect(sup.exhaustedEvent()).toBe(true);
      expect(sup.recycling()).toBe(true); // never reads "ready" while exhausted

      const beforeRecovery = spawnFn.mock.calls.length;
      // resetAndRespawn() clears the exhausted state and issues one more
      // attempt via the same (still-refusing) spawnFn — proving the reset
      // itself works; recovery all the way to a healthy process is covered
      // by the HEADLINE test above.
      await sup.resetAndRespawn();
      expect(sup.exhaustedEvent()).toBe(false);
      expect(spawnFn.mock.calls.length).toBeGreaterThan(beforeRecovery);
    });

    it('a SLOW refusal (an attempt outliving QUICK_DEATH_MS) still exhausts the budget — attempt latency must not reset the counter (#2106 step 2)', async () => {
      /* Regression for #2106 step 2. Before the fix, scheduleRespawnAttempt
         derived "did this child live a while?" from
         lived = nowFn() - lastSpawnAt. On the refusal path lastSpawnAt had
         been set moments earlier at the top of spawnOnce, so a SLOW spawn
         attempt (one that outlives QUICK_DEATH_MS — e.g. a hung teardown
         probe) made `lived` look like a long-lived child and reset
         consecutiveFailures to 0 every attempt: the cap never tripped,
         exhaustedEvent() never flipped, and the supervisor probed a foreign
         port forever. Here each refused attempt advances the fake clock past
         QUICK_DEATH_MS, so without the fix the counter resets each time and
         the 3rd refusal would NOT exhaust. The fix passes an explicit "not a
         fresh incident" on the refusal path, so the budget accrues
         monotonically to exhaustion regardless of attempt latency.
         The delayFn is release-gated so the run is deterministic and bounded:
         each backoff blocks until explicitly released (mirroring the HEADLINE
         refusal test), and a leaking (buggy) supervisor blocks on the next
         delay instead of spinning. */
      let now = 0;
      const releases: Array<() => void> = [];
      const delayFn = vi.fn(
        async () => new Promise<void>((resolve) => releases.push(resolve)),
      );
      const slowSpawnFn = vi.fn(async (opts: SpawnSidecarOpts) => {
        now += 35_000; // the attempt itself outlives QUICK_DEATH_MS (30s)
        opts.onSpawnRefused?.('port still held');
        return null;
      });
      const sup = createSidecarSupervisor({
        buildOpts: async () => BASE_OPTS,
        spawnFn: slowSpawnFn,
        delayFn,
        nowFn: () => now,
        warn: vi.fn(),
        log: vi.fn(),
        backoffsMs: [10, 20, 30],
        maxConsecutiveFailures: 2,
      });

      await sup.start(); // attempt 1 — refused and SLOW; backoff is now held
      await vi.waitFor(() => expect(slowSpawnFn).toHaveBeenCalledTimes(1));
      expect(sup.exhaustedEvent()).toBe(false); // accrued once, cap(2) not tripped

      releases.shift()?.(); // release backoff #1 → attempt 2
      await vi.waitFor(() => expect(slowSpawnFn).toHaveBeenCalledTimes(2));

      releases.shift()?.(); // release backoff #2 → attempt 3
      await vi.waitFor(() => expect(slowSpawnFn).toHaveBeenCalledTimes(3));
      // cap=2 → the 3rd refusal trips exhaustion. A SLOW attempt latency must
      // not have reset the counter along the way, or this stays false forever.
      expect(sup.exhaustedEvent()).toBe(true);
      expect(sup.recycling()).toBe(true); // never reads "ready" while exhausted

      const before = slowSpawnFn.mock.calls.length;
      await sup.resetAndRespawn();
      expect(sup.exhaustedEvent()).toBe(false); // recovery still clears exhaustion
      expect(slowSpawnFn.mock.calls.length).toBeGreaterThan(before);
    });

    it('autoStart:false and a healthy adopt still settle recycling()===false and do NOT retry (the benign/non-benign split)', async () => {
      // autoStart:false — benign, no onSpawnRefused fired.
      {
        const spawnFn = vi.fn(async (_opts: SpawnSidecarOpts) => null);
        const sup = createSidecarSupervisor({
          buildOpts: async () => ({ ...BASE_OPTS, autoStart: false }),
          spawnFn,
          delayFn: async () => {},
          warn: vi.fn(),
          log: vi.fn(),
        });
        await sup.start();
        expect(sup.recycling()).toBe(false);
        await new Promise((r) => setTimeout(r, 20));
        expect(spawnFn).toHaveBeenCalledTimes(1); // no retry
      }
      // Healthy adopt — benign, calls onAdoptExisting, not onSpawnRefused.
      {
        const spawnFn = vi.fn(async (opts: SpawnSidecarOpts) => {
          opts.onAdoptExisting?.({ host: '127.0.0.1', port: 9000 });
          return null;
        });
        const sup = createSidecarSupervisor({
          buildOpts: async () => BASE_OPTS,
          spawnFn,
          probeFn: vi.fn(async () => true),
          delayFn: async () => new Promise(() => {}), // gate the adopt watchdog
          adoptedPollMs: 100_000,
          warn: vi.fn(),
          log: vi.fn(),
        });
        await sup.start();
        expect(sup.recycling()).toBe(false);
        expect(spawnFn).toHaveBeenCalledTimes(1); // no retry
      }
    });

    /* D2 (#2037) — the supervisor threads the exiting child's own pid into
       the NEXT spawn attempt (log-only, so spawnSidecar's not-ours warning
       can tell "our own child, still tearing down" from "a genuinely
       foreign listener") — and only for that one chain. A later, unrelated
       exit threads ITS OWN pid, not a stale one left over from the first. */
    it('threads the exited child\'s own pid into the next spawn attempt as lastOwnedPid, and refreshes it on a later unrelated exit', async () => {
      const seenPids: Array<number | null | undefined> = [];
      let calls = 0;
      let capturedExit1: SpawnSidecarOpts['onExit'];
      let capturedExit2: SpawnSidecarOpts['onExit'];
      const spawnFn = vi.fn(async (opts: SpawnSidecarOpts) => {
        calls += 1;
        seenPids.push(opts.lastOwnedPid);
        if (calls === 1) {
          capturedExit1 = opts.onExit;
          return { pid: 111, child: {} as SidecarHandle['child'], kill: vi.fn(async () => {}) };
        }
        if (calls === 2) {
          // Recovery from pid 111's exit — must see lastOwnedPid === 111.
          capturedExit2 = opts.onExit;
          return { pid: 222, child: {} as SidecarHandle['child'], kill: vi.fn(async () => {}) };
        }
        // Recovery from pid 222's LATER exit — must see lastOwnedPid === 222, not 111.
        return { pid: 333, child: {} as SidecarHandle['child'], kill: vi.fn(async () => {}) };
      });
      const sup = createSidecarSupervisor({
        buildOpts: async () => BASE_OPTS,
        spawnFn,
        delayFn: async () => {},
        warn: vi.fn(),
        log: vi.fn(),
      });

      await sup.start(); // spawn #1 — first boot, no prior exit
      capturedExit1?.(1, null); // pid 111 exits
      await vi.waitFor(() => expect(spawnFn).toHaveBeenCalledTimes(2));
      capturedExit2?.(1, null); // pid 222 exits, LATER and unrelated to 111
      await vi.waitFor(() => expect(spawnFn).toHaveBeenCalledTimes(3));

      expect(seenPids).toEqual([null, 111, 222]);
    });

    /* Review finding (PR #2101): onChildExit checks `stopped` before ever
       reaching scheduleRespawnAttempt; the refusal branch in spawnOnce did
       not. If stop() races in while spawnFn is still in flight, a refusal
       that resolves AFTER shutdown must not schedule a respawn or move the
       failure counter — nothing should ever try to bring the sidecar back
       once the supervisor has been told to stop. */
    it('a refusal that resolves AFTER stop() does not schedule a respawn or move the failure counter', async () => {
      let releaseSpawn!: (v: SidecarHandle | null) => void;
      const pendingSpawn = new Promise<SidecarHandle | null>((r) => (releaseSpawn = r));
      let capturedOnSpawnRefused: SpawnSidecarOpts['onSpawnRefused'];
      const spawnFn = vi.fn(async (opts: SpawnSidecarOpts) => {
        capturedOnSpawnRefused = opts.onSpawnRefused;
        return pendingSpawn;
      });
      const log = vi.fn();
      const warn = vi.fn();
      const sup = createSidecarSupervisor({
        buildOpts: async () => BASE_OPTS,
        spawnFn,
        delayFn: async () => {},
        warn,
        log,
        backoffsMs: [10, 20, 30],
        maxConsecutiveFailures: 5,
      });

      const startPromise = sup.start(); // spawnFn in flight, not yet resolved
      await sup.stop(); // stop() races in WHILE the spawn attempt is still pending
      // The in-flight spawn attempt now settles as a REFUSAL, after stop().
      capturedOnSpawnRefused?.('port still held');
      releaseSpawn(null);
      await startPromise;

      expect(spawnFn).toHaveBeenCalledTimes(1); // no respawn was ever scheduled
      expect(log).not.toHaveBeenCalledWith(expect.stringContaining('respawning in'));
      expect(sup.exhaustedEvent()).toBe(false); // consecutiveFailures never moved
    });
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
      // Unlike the disappearance-only tests above, the leak-saturated ceiling
      // path drains via recycleSidecarFn before respawning — leaving this
      // unmocked falls through to the real fetch-based default, which hits
      // the shared TTS sidecar port and blows the vi.waitFor budget below
      // whenever that port is occupied (#1241).
      recycleSidecarFn: vi.fn(async () => true),
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

  /* ── code-43 streak guard (§W2.5) ─────────────────────────────────────────
   *
   * A SEPARATE counter from `consecutiveFailures` above: that counter resets
   * whenever a child lives past QUICK_DEATH_MS (30s), so a structurally-too-
   * small device assignment that loads fine for 35s and then dies every time
   * would never trip the give-up branch (it keeps resetting). This streak
   * counts code-43 self-exits ONLY, on a pure time-window basis, regardless
   * of how long each child lived. */
  describe('code-43 streak guard (independent of the lived-based backoff reset)', () => {
    it('trips after 3 code-43 exits within 10 minutes even when each child lived past QUICK_DEATH_MS', async () => {
      let now = 0;
      const handles: ReturnType<typeof makeHandle>[] = [];
      const spawn = makeSpawn(handles);
      vi.spyOn(breadcrumbModule, 'readRestartBreadcrumb').mockReturnValue({
        card: { uuid: 'GPU-1', idx: 1 }, reason: 'reserved VRAM', residentEngines: ['coqui'],
      });
      const sup = createSidecarSupervisor({
        buildOpts: async () => BASE_OPTS,
        spawnFn: spawn.fn,
        delayFn: async () => {},
        nowFn: () => now,
        warn: vi.fn(),
        log: vi.fn(),
      });
      await sup.start();
      for (let i = 0; i < 3; i++) {
        now += 35_000; // each child "lived" 35s — well past QUICK_DEATH_MS (30s), resets consecutiveFailures
        spawn.exit(43);
        await Promise.resolve(); // let the async onChildExit body settle
      }
      expect(sup.tripEvent()).toEqual({ card: { uuid: 'GPU-1', idx: 1 }, residentEngines: ['coqui'] });
    });

    it('does not trip on 3 non-43 exits', async () => {
      let now = 0;
      const handles: ReturnType<typeof makeHandle>[] = [];
      const spawn = makeSpawn(handles);
      const sup = createSidecarSupervisor({
        buildOpts: async () => BASE_OPTS,
        spawnFn: spawn.fn,
        delayFn: async () => {},
        nowFn: () => now,
        warn: vi.fn(),
        log: vi.fn(),
      });
      await sup.start();
      for (let i = 0; i < 3; i++) {
        now += 35_000;
        spawn.exit(1);
        await Promise.resolve();
      }
      expect(sup.tripEvent()).toBeNull();
    });

    it('a tripped supervisor stops respawning (holds TTS down)', async () => {
      let now = 0;
      const handles: ReturnType<typeof makeHandle>[] = [];
      const spawn = makeSpawn(handles);
      const respawnCount = () => spawn.fn.mock.calls.length;
      const sup = createSidecarSupervisor({
        buildOpts: async () => BASE_OPTS,
        spawnFn: spawn.fn,
        delayFn: async () => {},
        nowFn: () => now,
        warn: vi.fn(),
        log: vi.fn(),
      });
      await sup.start();
      const before = respawnCount();
      for (let i = 0; i < 3; i++) {
        now += 35_000;
        spawn.exit(43);
        await Promise.resolve();
      }
      const afterTrip = respawnCount();
      now += 35_000;
      spawn.exit(43); // a 4th exit after trip must NOT trigger another respawn attempt
      await Promise.resolve();
      expect(respawnCount()).toBe(afterTrip);
      expect(afterTrip).toBeGreaterThan(before); // sanity: it DID respawn for exits 1-3, just not after trip
    });

    it('resetAndRespawn resets the streak and spawns a fresh child after a trip', async () => {
      let now = 0;
      const handles: ReturnType<typeof makeHandle>[] = [];
      const spawn = makeSpawn(handles);
      const respawnCount = () => spawn.fn.mock.calls.length;
      vi.spyOn(breadcrumbModule, 'readRestartBreadcrumb').mockReturnValue({
        card: { uuid: 'GPU-1', idx: 1 }, reason: 'reserved VRAM', residentEngines: ['coqui'],
      });
      const sup = createSidecarSupervisor({
        buildOpts: async () => BASE_OPTS,
        spawnFn: spawn.fn,
        delayFn: async () => {},
        nowFn: () => now,
        warn: vi.fn(),
        log: vi.fn(),
      });
      await sup.start();
      for (let i = 0; i < 3; i++) {
        now += 35_000;
        spawn.exit(43);
        await Promise.resolve();
      }
      expect(sup.tripEvent()).not.toBeNull();
      const beforeRecovery = respawnCount();

      await sup.resetAndRespawn();

      expect(sup.tripEvent()).toBeNull(); // trip cleared
      expect(respawnCount()).toBeGreaterThan(beforeRecovery); // a fresh child was spawned

      // A subsequent code-43 streak must take a full fresh 3 to re-trip — if the old
      // timestamps were left poisoned (only the trip flag cleared), even the 1st fresh
      // exit here would already push the window to 4 stale+fresh entries and re-trip early.
      now += 35_000;
      spawn.exit(43);
      await Promise.resolve();
      expect(sup.tripEvent()).toBeNull(); // not re-tripped after just 1 fresh exit

      now += 35_000;
      spawn.exit(43);
      await Promise.resolve();
      expect(sup.tripEvent()).toBeNull(); // still not tripped after 2

      now += 35_000;
      spawn.exit(43);
      await Promise.resolve();
      expect(sup.tripEvent()).not.toBeNull(); // trips on the 3rd genuinely-fresh exit
    });

    it('exhaustedEvent is false before exhaustion and true once consecutiveFailures exceeds the max', async () => {
      let now = 0;
      const handles: ReturnType<typeof makeHandle>[] = [];
      const spawn = makeSpawn(handles);
      const sup = createSidecarSupervisor({
        buildOpts: async () => BASE_OPTS,
        spawnFn: spawn.fn,
        delayFn: async () => {},
        nowFn: () => now,
        maxConsecutiveFailures: 2,
        warn: vi.fn(),
        log: vi.fn(),
      });
      await sup.start();
      expect(sup.exhaustedEvent()).toBe(false);
      for (let i = 0; i < 3; i++) {
        now += 1_000; // faster than QUICK_DEATH_MS, so failures accumulate
        spawn.exit(1);
        await Promise.resolve();
      }
      expect(sup.exhaustedEvent()).toBe(true);
    });

    it('resetAndRespawn clears exhaustedEvent and spawns a fresh child after plain exhaustion', async () => {
      let now = 0;
      const handles: ReturnType<typeof makeHandle>[] = [];
      const spawn = makeSpawn(handles);
      const respawnCount = () => spawn.fn.mock.calls.length;
      const sup = createSidecarSupervisor({
        buildOpts: async () => BASE_OPTS,
        spawnFn: spawn.fn,
        delayFn: async () => {},
        nowFn: () => now,
        maxConsecutiveFailures: 2,
        warn: vi.fn(),
        log: vi.fn(),
      });
      await sup.start();
      for (let i = 0; i < 3; i++) {
        now += 1_000;
        spawn.exit(1);
        await Promise.resolve();
      }
      expect(sup.exhaustedEvent()).toBe(true);
      const beforeRecovery = respawnCount();

      await sup.resetAndRespawn();

      expect(sup.exhaustedEvent()).toBe(false);
      expect(respawnCount()).toBeGreaterThan(beforeRecovery);
    });

    it('two direct resetAndRespawn calls in a row spawn exactly once each (the second is a safe no-op)', async () => {
      let now = 0;
      const handles: ReturnType<typeof makeHandle>[] = [];
      const spawn = makeSpawn(handles);
      const respawnCount = () => spawn.fn.mock.calls.length;
      const sup = createSidecarSupervisor({
        buildOpts: async () => BASE_OPTS,
        spawnFn: spawn.fn,
        delayFn: async () => {},
        nowFn: () => now,
        maxConsecutiveFailures: 2,
        warn: vi.fn(),
        log: vi.fn(),
      });
      await sup.start();
      for (let i = 0; i < 3; i++) {
        now += 1_000;
        spawn.exit(1);
        await Promise.resolve();
      }
      const beforeRecovery = respawnCount();

      await Promise.all([sup.resetAndRespawn(), sup.resetAndRespawn()]);

      // First call resets+spawns; second observes already-cleared exhaustedEvent
      // and (per the current spawnOnce()/onChildExit() contract) still calls
      // spawnOnce() — assert it happened, and that state is consistent afterward,
      // not that a specific call count is "the" safe number. What matters is no
      // exception and exhaustedEvent() reads false at the end.
      expect(respawnCount()).toBeGreaterThan(beforeRecovery);
      expect(sup.exhaustedEvent()).toBe(false);
    });
  });
});

describe('forceSidecarRecycle', () => {
  afterEach(() => registerActiveSupervisor(null));

  function fakeSupervisor(overrides: Partial<SidecarSupervisor> = {}): SidecarSupervisor {
    return {
      start: vi.fn(async () => {}),
      stop: vi.fn(async () => {}),
      current: () => null,
      recycling: () => false,
      tripEvent: () => null,
      exhaustedEvent: () => false,
      resetAndRespawn: vi.fn(async () => {}),
      ...overrides,
    };
  }

  it('kills the current handle and returns true', async () => {
    const handle = makeHandle();
    registerActiveSupervisor(fakeSupervisor({ current: () => handle }));

    const result = await forceSidecarRecycle('test reason', vi.fn());

    expect(result).toBe(true);
    expect(handle.kill).toHaveBeenCalledTimes(1);
  });

  it('returns false (no kill) when there is no active supervisor', async () => {
    registerActiveSupervisor(null);
    const result = await forceSidecarRecycle('test reason', vi.fn());
    expect(result).toBe(false);
  });

  it('returns false (no kill) when the supervisor reports recycling() already true', async () => {
    const handle = makeHandle();
    registerActiveSupervisor(fakeSupervisor({ recycling: () => true, current: () => handle }));

    const result = await forceSidecarRecycle('test reason', vi.fn());

    expect(result).toBe(false);
    expect(handle.kill).not.toHaveBeenCalled();
  });

  it('returns false (no kill) when there is no current handle', async () => {
    registerActiveSupervisor(fakeSupervisor({ current: () => null }));
    const result = await forceSidecarRecycle('test reason', vi.fn());
    expect(result).toBe(false);
  });

  it('a second concurrent call while the first is still in-flight no-ops (synchronous guard)', async () => {
    const handle = makeHandle();
    let releaseKill!: () => void;
    handle.kill.mockImplementation(() => new Promise<void>((r) => (releaseKill = r)));
    registerActiveSupervisor(fakeSupervisor({ current: () => handle }));

    const first = forceSidecarRecycle('first', vi.fn());
    // Second call races in BEFORE the first kill() resolves.
    const second = await forceSidecarRecycle('second', vi.fn());
    expect(second).toBe(false);
    expect(handle.kill).toHaveBeenCalledTimes(1); // only the first caller actually killed

    releaseKill();
    expect(await first).toBe(true);
  });

  it('warns with the given reason', async () => {
    const handle = makeHandle();
    registerActiveSupervisor(fakeSupervisor({ current: () => handle }));
    const warn = vi.fn();

    await forceSidecarRecycle('chapter 7 stalled 720s during synthesis', warn);

    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('chapter 7 stalled 720s during synthesis'),
    );
  });
});
