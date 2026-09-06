/* Plan 43 — pins the spawn-sidecar module contract:

   1. autoStart=false               → spawn not called, returns null.
   2. port 9000 already listening   → spawn not called, returns null.
   3. autoStart=true, modelKey=kokoro-v1 → spawn called once, env has
                                            PRELOAD_COQUI=0.
   4. autoStart=true, modelKey=coqui-xtts-v2 → spawn called once, env has
                                               PRELOAD_COQUI=1.
   5. PRELOAD_QWEN / PRELOAD_QWEN_BASE17 / PRELOAD_KOKORO are left unset
      (sidecar default) regardless of modelKey — no more modelKey coupling
      (preload-toggle dedup; see sidecar-env.test.ts for the full registry-
      override contract on these three flat, independent knobs).
   6. handle.kill() on win32 shells out to `taskkill /T /F /PID`. */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSidecar, sidecarCeilingMismatch, findListenerPid } from './spawn-sidecar.js';

interface FakeChild extends EventEmitter {
  pid: number;
  stdout: null;
  stderr: null;
}

function makeFakeChild(pid = 12345): FakeChild {
  const ee = new EventEmitter() as FakeChild;
  ee.pid = pid;
  ee.stdout = null;
  ee.stderr = null;
  return ee;
}

describe('spawnSidecar', () => {
  // Vitest 4: vi.fn() is typed Mock<Procedure | Constructable> and no longer
  // assigns to a specific function param — pin probeFn/log/warn to spawnSidecar's
  // own option signatures so the mocks stay assignable (and self-maintaining).
  // spawnFn is cast `as unknown as typeof spawn` at each call site, so it's fine
  // left untyped.
  type SpawnArgs = Parameters<typeof spawnSidecar>[0];
  let spawnFn: ReturnType<typeof vi.fn>;
  let probeFn: ReturnType<typeof vi.fn<NonNullable<SpawnArgs['probeFn']>>>;
  let log: ReturnType<typeof vi.fn<NonNullable<SpawnArgs['log']>>>;
  let warn: ReturnType<typeof vi.fn<NonNullable<SpawnArgs['warn']>>>;
  /* A real, writable temp dir per test — spawnSidecar opens the sidecar log
     files (logs/tts.log, logs/tts.err.log) and writes .run/tts.pid under
     repoRoot, so it must point at a directory we can actually create files
     in (the old '/repo' literal would EACCES on Linux CI and pollute C:\repo
     on Windows). */
  let repoRoot: string;

  beforeEach(() => {
    spawnFn = vi.fn(() => makeFakeChild());
    probeFn = vi.fn<NonNullable<SpawnArgs['probeFn']>>(async () => false);
    log = vi.fn<NonNullable<SpawnArgs['log']>>();
    warn = vi.fn<NonNullable<SpawnArgs['warn']>>();
    repoRoot = mkdtempSync(join(tmpdir(), 'wt-sidecar-'));
    // Clean up LOCAL_TTS_PORT before each test
    delete process.env.LOCAL_TTS_PORT;
  });

  afterEach(() => {
    rmSync(repoRoot, { recursive: true, force: true });
    delete process.env.LOCAL_TTS_PORT;
  });

  it('returns null and does not spawn when autoStart is false', async () => {
    const handle = await spawnSidecar({
      autoStart: false,
      modelKey: 'kokoro-v1',
      repoRoot,
      spawnFn: spawnFn as unknown as typeof import('node:child_process').spawn,
      probeFn,
      log,
      warn,
    });

    expect(handle).toBeNull();
    expect(spawnFn).not.toHaveBeenCalled();
    // probeFn IS now called to detect if an externally-started sidecar is running
    // (so onAdoptExisting can be signaled even when autoStart is off)
    expect(probeFn).toHaveBeenCalledWith('127.0.0.1', 9000);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('auto-start disabled'));
  });

  it('adopts a healthy externally-started sidecar when autoStart is off (no kill command)', async () => {
    // Regression test for #2192: with autoStart off and a healthy sidecar running on the port,
    // the server should adopt it (call onAdoptExisting), NOT kill it via taskkill /PID.
    // This must be tested with production config (NODE_ENV=production) so neverAdoptSidecar()
    // returns true and the old code path would have tried to kill it.
    const oldEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      probeFn.mockResolvedValueOnce(true);
      const healthProbeFn = vi.fn(async () => ({
        reachable: true,
        looksLikeSidecar: true,
        protocolVersion: 1,
        committedMb: 9000, // healthy
        recyclePending: false,
      }));
      let findPidCalled = false;
      const findPidFn = vi.fn(async () => {
        findPidCalled = true;
        return null; // simulate no PID found (shouldn't even get here)
      });
      const onAdoptExisting = vi.fn();
      const killCalls: any[] = [];
      const spawnFnWithKillTracking = vi.fn((...args: any[]) => {
        if (Array.isArray(args[1]) && args[1][0] === 'taskkill') {
          killCalls.push(args);
        }
        return makeFakeChild();
      });

      const handle = await spawnSidecar({
        autoStart: false,
        modelKey: 'kokoro-v1',
        repoRoot,
        spawnFn: spawnFnWithKillTracking as unknown as typeof import('node:child_process').spawn,
        probeFn,
        healthProbeFn,
        findPidFn,
        log,
        warn,
        onAdoptExisting,
      });

      expect(handle).toBeNull();
      expect(spawnFn).not.toHaveBeenCalled();
      expect(onAdoptExisting).toHaveBeenCalledWith({ host: '127.0.0.1', port: 9000 });
      // CRITICAL: No taskkill command should fire — we adopt the healthy sidecar, don't kill it
      expect(killCalls).toHaveLength(0);
      expect(findPidCalled).toBe(false); // findPidFn should never be called
      expect(log).toHaveBeenCalledWith(expect.stringContaining('adopting'));
    } finally {
      process.env.NODE_ENV = oldEnv;
    }
  });

  /* #3043 B1 — autoStart off means "this server does not own the sidecar on
     this port". Adopting a healthy one is the whole point of the probe; every
     OWNERSHIP action on anything else is off-limits, because `if (!autoStart)`
     guarantees no replacement is coming. Before this, an UNFIT listener took
     the replace branch and taskkill'd a process this server never started —
     and then returned null without spawning anything. */
  describe('autoStart off never takes an ownership action on an UNADOPTABLE listener', () => {
    const unfitCases: Array<{
      name: string;
      health: Awaited<ReturnType<NonNullable<Parameters<typeof spawnSidecar>[0]['healthProbeFn']>>>;
    }> = [
      {
        name: 'a STALE-protocol sidecar',
        health: {
          reachable: true,
          looksLikeSidecar: true,
          protocolVersion: 0,
          committedMb: 9000,
          recyclePending: false,
        },
      },
      {
        name: 'a sidecar that reports recycle_pending',
        health: {
          reachable: true,
          looksLikeSidecar: true,
          protocolVersion: 1,
          committedMb: 9000,
          recyclePending: true,
        },
      },
      {
        name: 'a FOREIGN process that does not answer as our sidecar',
        health: {
          reachable: true,
          looksLikeSidecar: false,
          protocolVersion: null,
          committedMb: null,
          recyclePending: false,
        },
      },
    ];

    for (const { name, health } of unfitCases) {
      it(`${name}: no kill, no spawn, no refusal, no adopt`, async () => {
        probeFn.mockResolvedValueOnce(true);
        const killCalls: unknown[][] = [];
        const trackingSpawn = vi.fn((...args: unknown[]) => {
          if (Array.isArray(args[1]) && args[1][0] === 'taskkill') killCalls.push(args);
          return makeFakeChild();
        });
        const findPidFn = vi.fn(async () => 4242);
        const onAdoptExisting = vi.fn();
        const onSpawnRefused = vi.fn();

        const handle = await spawnSidecar({
          autoStart: false,
          modelKey: 'kokoro-v1',
          repoRoot,
          spawnFn: trackingSpawn as unknown as typeof import('node:child_process').spawn,
          probeFn,
          healthProbeFn: async () => health,
          findPidFn,
          log,
          warn,
          onAdoptExisting,
          onSpawnRefused,
        });

        expect(handle).toBeNull();
        expect(killCalls).toHaveLength(0);
        expect(trackingSpawn).not.toHaveBeenCalled();
        // Never even asked which PID owns the port — nothing here is ours to act on.
        expect(findPidFn).not.toHaveBeenCalled();
        // Not adopted either: the supervisor must not report a usable sidecar.
        expect(onAdoptExisting).not.toHaveBeenCalled();
        // And no refusal, which would drive a retry loop toward a spawn that
        // `if (!autoStart)` will never perform.
        expect(onSpawnRefused).not.toHaveBeenCalled();
        expect(warn).toHaveBeenCalledWith(expect.stringContaining('NOT touching it'));
      });
    }

    /* The production launch config (NODE_ENV=production ⇒ neverAdoptSidecar())
       makes even a perfectly HEALTHY external sidecar take policyReplace. With
       autoStart off it must still be adopted, never replaced. */
    it('a HEALTHY sidecar under the production never-adopt policy is adopted, not killed', async () => {
      const oldEnv = process.env.NODE_ENV;
      process.env.NODE_ENV = 'production';
      try {
        probeFn.mockResolvedValueOnce(true);
        const killCalls: unknown[][] = [];
        const trackingSpawn = vi.fn((...args: unknown[]) => {
          if (Array.isArray(args[1]) && args[1][0] === 'taskkill') killCalls.push(args);
          return makeFakeChild();
        });
        const findPidFn = vi.fn(async () => 4242);
        const onAdoptExisting = vi.fn();
        const onSpawnRefused = vi.fn();

        const handle = await spawnSidecar({
          autoStart: false,
          modelKey: 'kokoro-v1',
          repoRoot,
          spawnFn: trackingSpawn as unknown as typeof import('node:child_process').spawn,
          probeFn,
          healthProbeFn: async () => ({
            reachable: true,
            looksLikeSidecar: true,
            protocolVersion: 1,
            committedMb: 9000,
            recyclePending: false,
          }),
          findPidFn,
          log,
          warn,
          onAdoptExisting,
          onSpawnRefused,
        });

        expect(handle).toBeNull();
        expect(killCalls).toHaveLength(0);
        expect(findPidFn).not.toHaveBeenCalled();
        expect(onSpawnRefused).not.toHaveBeenCalled();
        expect(onAdoptExisting).toHaveBeenCalledWith({ host: '127.0.0.1', port: 9000 });
      } finally {
        process.env.NODE_ENV = oldEnv;
      }
    });
  });

  it('reuses an already-listening sidecar when its protocol_version is current', async () => {
    probeFn.mockResolvedValueOnce(true);
    const healthProbeFn = vi.fn(async () => ({
      reachable: true,
      looksLikeSidecar: true,
      protocolVersion: 1,
      committedMb: 9000, // a healthy fresh load — well under the adopt ceiling
      recyclePending: false,
    }));

    const handle = await spawnSidecar({
      autoStart: true,
      modelKey: 'kokoro-v1',
      repoRoot,
      spawnFn: spawnFn as unknown as typeof import('node:child_process').spawn,
      probeFn,
      healthProbeFn,
      log,
      warn,
    });

    expect(handle).toBeNull();
    expect(healthProbeFn).toHaveBeenCalledTimes(1);
    expect(spawnFn).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(expect.stringContaining('current sidecar honoured'));
  });

  it('announces an adopted sidecar via onAdoptExisting so the supervisor can watch it', async () => {
    probeFn.mockResolvedValueOnce(true);
    const healthProbeFn = vi.fn(async () => ({
      reachable: true,
      looksLikeSidecar: true,
      protocolVersion: 1,
      committedMb: 9000,
      recyclePending: false,
    }));
    const onAdoptExisting = vi.fn();

    const handle = await spawnSidecar({
      autoStart: true,
      modelKey: 'kokoro-v1',
      repoRoot,
      port: 9000,
      host: '127.0.0.1',
      spawnFn: spawnFn as unknown as typeof import('node:child_process').spawn,
      probeFn,
      healthProbeFn,
      log,
      warn,
      onAdoptExisting,
    });

    expect(handle).toBeNull();
    expect(spawnFn).not.toHaveBeenCalled();
    expect(onAdoptExisting).toHaveBeenCalledWith({ host: '127.0.0.1', port: 9000 });
  });

  it('does NOT touch a listening process that is not our sidecar', async () => {
    /* Reachable-but-not-ours (or hung/non-HTTP): never kill an unknown process,
       just leave it and let the health route surface TTS-down. */
    probeFn.mockResolvedValueOnce(true);
    const healthProbeFn = vi.fn(async () => ({
      reachable: true,
      looksLikeSidecar: false,
      protocolVersion: null,
      committedMb: null,
      recyclePending: false,
    }));
    const findPidFn = vi.fn(async () => 999);

    const handle = await spawnSidecar({
      autoStart: true,
      modelKey: 'kokoro-v1',
      repoRoot,
      spawnFn: spawnFn as unknown as typeof import('node:child_process').spawn,
      probeFn,
      healthProbeFn,
      findPidFn,
      log,
      warn,
    });

    expect(handle).toBeNull();
    expect(findPidFn).not.toHaveBeenCalled();
    expect(spawnFn).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('does not look like our sidecar'));
  });

  it('leaves a stale sidecar in place when its PID cannot be identified', async () => {
    probeFn.mockResolvedValueOnce(true);
    const healthProbeFn = vi.fn(async () => ({
      reachable: true,
      looksLikeSidecar: true,
      protocolVersion: null, // stale: pre-side-8 build omits protocol_version
      committedMb: null,
      recyclePending: false,
    }));
    const findPidFn = vi.fn(async () => null);

    const handle = await spawnSidecar({
      autoStart: true,
      modelKey: 'kokoro-v1',
      repoRoot,
      spawnFn: spawnFn as unknown as typeof import('node:child_process').spawn,
      probeFn,
      healthProbeFn,
      findPidFn,
      log,
      warn,
    });

    expect(handle).toBeNull();
    expect(spawnFn).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('UNFIT sidecar'));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('could not identify the PID'));
  });

  it('exercises the real default findPidFn on stale-replace path; deadline expiry fires the timeout branch (Mutation A coverage)', async () => {
    /* Mutation A: the onExpiry parameter at line 607 can be dropped and all
       tests pass because every stale-replace test stubs findPidFn. This test
       does NOT stub it, so the wiring from spawnSidecar's default through to
       findListenerPid's onDeadlineExpiry callback is actually traversed. The
       timeout sentence only emits when deadlineExpired is true, which only
       happens when the callback fires — proving the wiring is live. */
    vi.useFakeTimers();
    try {
      probeFn.mockResolvedValueOnce(true);
      const healthProbeFn = vi.fn(async () => ({
        reachable: true,
        looksLikeSidecar: true,
        protocolVersion: null, // stale
        committedMb: null,
        recyclePending: false,
      }));
      /* Do NOT stub findPidFn — use the default that calls findListenerPid.
         Stub only spawnFn at the child level so the sidecar doesn't actually
         spawn (we're testing the stale-replace path, not the spawn itself). */
      const calls: Array<{ cmd: string; args: string[] }> = [];
      const trackingSpawn = vi.fn((cmd: string, args: string[]) => {
        calls.push({ cmd, args });
        const child = makeFakeChild();
        if (cmd === 'taskkill') setImmediate(() => child.emit('exit', 0, null));
        return child;
      });

      const pending = spawnSidecar({
        autoStart: true,
        modelKey: 'kokoro-v1',
        repoRoot,
        platform: 'win32',
        spawnFn: trackingSpawn as unknown as typeof import('node:child_process').spawn,
        probeFn,
        healthProbeFn,
        /* findPidFn is NOT stubbed — the real default will be used.
           That default spawns a child to find the listener PID. Make it hang
           so the deadline fires. */
        log,
        warn,
      });
      /* The hung findPidFn child (spawned by the real default) will timeout
         at LISTENER_PID_DEADLINE_MS. Advance past it. */
      const { LISTENER_PID_DEADLINE_MS } = await import('./spawn-sidecar.js');
      await vi.advanceTimersByTimeAsync(LISTENER_PID_DEADLINE_MS + 1);
      const handle = await pending;

      expect(handle).toBeNull();
      /* The timeout branch emitted — deadlineExpired was set by the callback. */
      expect(warn).toHaveBeenCalledWith(
        expect.stringMatching(/probe for the PID on.*timed out.*supervisor will retry/s),
      );
      expect(warn).not.toHaveBeenCalledWith(expect.stringMatching(/Restart the sidecar manually/));
    } finally {
      vi.useRealTimers();
    }
  });

  it('kills a STALE sidecar and spawns the current build (side-8)', async () => {
    const originalPlatform = process.platform;
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    try {
      /* Listening at first, then free after the kill so waitForPortFree
         resolves true. */
      probeFn.mockResolvedValueOnce(true).mockResolvedValue(false);
      const healthProbeFn = vi.fn(async () => ({
        reachable: true,
        looksLikeSidecar: true,
        protocolVersion: null, // stale
        committedMb: null,
        recyclePending: false,
      }));
      const findPidFn = vi.fn(async () => 68624);

      const calls: Array<{ cmd: string; args: string[] }> = [];
      const trackingSpawn = vi.fn((cmd: string, args: string[]) => {
        calls.push({ cmd, args });
        const child = makeFakeChild();
        if (cmd === 'taskkill') setImmediate(() => child.emit('exit', 0, null));
        return child;
      });

      const handle = await spawnSidecar({
        autoStart: true,
        modelKey: 'qwen3-tts-0.6b',
        repoRoot,
        spawnFn: trackingSpawn as unknown as typeof import('node:child_process').spawn,
        probeFn,
        healthProbeFn,
        findPidFn,
        log,
        warn,
      });

      /* Replaced: taskkill'd the stale PID, then spawned the current build. */
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('UNFIT sidecar'));
      expect(calls[0]).toEqual({ cmd: 'taskkill', args: ['/PID', '68624', '/T', '/F'] });
      expect(calls[1].cmd).toBe('powershell.exe');
      expect(handle).not.toBeNull();
      expect(log).toHaveBeenCalledWith(expect.stringContaining('replaced stale sidecar'));
    } finally {
      Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
    }
  });

  it('replaces a leak-saturated adopt target (committed over the ceiling) with a fresh process', async () => {
    /* 2026-06-02 "stuck after restart": the restart adopted an orphan at ~26 GB
       committed (fresh load ~10 GB) and wedged. A protocol-fresh but
       leak-saturated sidecar must be killed + respawned, not adopted. */
    const originalPlatform = process.platform;
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    try {
      probeFn.mockResolvedValueOnce(true).mockResolvedValue(false);
      const healthProbeFn = vi.fn(async () => ({
        reachable: true,
        looksLikeSidecar: true,
        protocolVersion: 1, // protocol is current...
        committedMb: 26000, // ...but it's leak-saturated (≥ 20 GB default ceiling)
        recyclePending: false,
      }));
      const findPidFn = vi.fn(async () => 4242);
      const onAdoptExisting = vi.fn();
      const calls: Array<{ cmd: string; args: string[] }> = [];
      const trackingSpawn = vi.fn((cmd: string, args: string[]) => {
        calls.push({ cmd, args });
        const child = makeFakeChild();
        if (cmd === 'taskkill') setImmediate(() => child.emit('exit', 0, null));
        return child;
      });

      const handle = await spawnSidecar({
        autoStart: true,
        modelKey: 'qwen3-tts-0.6b',
        repoRoot,
        spawnFn: trackingSpawn as unknown as typeof import('node:child_process').spawn,
        probeFn,
        healthProbeFn,
        findPidFn,
        log,
        warn,
        onAdoptExisting,
      });

      expect(onAdoptExisting).not.toHaveBeenCalled(); // NOT adopted
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('UNFIT sidecar'));
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('leak-saturated'));
      expect(calls[0]).toEqual({ cmd: 'taskkill', args: ['/PID', '4242', '/T', '/F'] });
      expect(handle).not.toBeNull(); // fresh process spawned
    } finally {
      Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
    }
  });

  it('in prod (NODE_ENV=production), REPLACES a healthy pre-existing sidecar instead of adopting it', async () => {
    /* prod-fresh policy: at server boot there is no in-flight synthesis, so a
       clean owned process is strictly safer than inheriting an orphan of unknown
       leak/build state. The graceful soft/hard recycle path then governs it. */
    const originalPlatform = process.platform;
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    const prev = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      /* Healthy sidecar: proto fresh, memory fine, not recycling. */
      probeFn.mockResolvedValueOnce(true).mockResolvedValue(false);
      const healthProbeFn = vi.fn(async () => ({
        reachable: true,
        looksLikeSidecar: true,
        protocolVersion: 1,
        committedMb: 9000,
        recyclePending: false,
      }));
      const findPidFn = vi.fn(async () => 5555);
      const onAdoptExisting = vi.fn();
      const calls: Array<{ cmd: string; args: string[] }> = [];
      const trackingSpawn = vi.fn((cmd: string, args: string[]) => {
        calls.push({ cmd, args });
        const child = makeFakeChild();
        if (cmd === 'taskkill') setImmediate(() => child.emit('exit', 0, null));
        return child;
      });

      const handle = await spawnSidecar({
        autoStart: true,
        modelKey: 'kokoro-v1',
        repoRoot,
        spawnFn: trackingSpawn as unknown as typeof import('node:child_process').spawn,
        probeFn,
        healthProbeFn,
        findPidFn,
        log,
        warn,
        onAdoptExisting,
      });

      expect(onAdoptExisting).not.toHaveBeenCalled(); // did NOT adopt
      expect(calls[0]).toEqual({ cmd: 'taskkill', args: ['/PID', '5555', '/T', '/F'] });
      expect(calls[1].cmd).toBe('powershell.exe'); // fresh spawn happened
      expect(handle).not.toBeNull();
    } finally {
      if (prev === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = prev;
      Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
    }
  });

  it('REPLACES a sidecar whose effective memory ceiling does not match the server config (stale dev sidecar)', async () => {
    /* The recurring trigger: a sidecar started WITHOUT this server's .env (a dev
       run, or a stale-worktree launch) computes the AUTO restart ceiling instead
       of the configured one, then recycles far too early and breaks bulk design.
       When the server is configured with an explicit ceiling, a live sidecar
       reporting a DIFFERENT effective ceiling was started under a different
       config and must be replaced (A1) — even in dev, where policy would
       otherwise adopt it. */
    const originalPlatform = process.platform;
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    const prevRestart = process.env.SIDECAR_RESTART_MB;
    const prevNodeEnv = process.env.NODE_ENV;
    process.env.SIDECAR_RESTART_MB = '48500'; // this server expects 48500 MB
    process.env.NODE_ENV = 'development'; // dev would normally ADOPT — guard is config-driven, not policy
    try {
      probeFn.mockResolvedValueOnce(true).mockResolvedValue(false);
      const healthProbeFn = vi.fn(async () => ({
        reachable: true,
        looksLikeSidecar: true,
        protocolVersion: 1,
        committedMb: 9000,
        recyclePending: false,
        memRestartMb: 14135, // auto ceiling — started without this server's .env
        vramRestartMb: 8000,
      }));
      const findPidFn = vi.fn(async () => 6161);
      const onAdoptExisting = vi.fn();
      const calls: Array<{ cmd: string; args: string[] }> = [];
      const trackingSpawn = vi.fn((cmd: string, args: string[]) => {
        calls.push({ cmd, args });
        const child = makeFakeChild();
        if (cmd === 'taskkill') setImmediate(() => child.emit('exit', 0, null));
        return child;
      });

      const handle = await spawnSidecar({
        autoStart: true,
        modelKey: 'kokoro-v1',
        repoRoot,
        spawnFn: trackingSpawn as unknown as typeof import('node:child_process').spawn,
        probeFn,
        healthProbeFn,
        findPidFn,
        log,
        warn,
        onAdoptExisting,
      });

      expect(onAdoptExisting).not.toHaveBeenCalled(); // did NOT adopt the mis-configured sidecar
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('config'));
      expect(calls[0]).toEqual({ cmd: 'taskkill', args: ['/PID', '6161', '/T', '/F'] });
      expect(calls[1].cmd).toBe('powershell.exe'); // fresh spawn happened
      expect(handle).not.toBeNull();
    } finally {
      if (prevRestart === undefined) delete process.env.SIDECAR_RESTART_MB;
      else process.env.SIDECAR_RESTART_MB = prevRestart;
      if (prevNodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = prevNodeEnv;
      Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
    }
  });

  it('ADOPTS a sidecar whose effective ceiling MATCHES the server config (no false replace)', async () => {
    /* The guard must not fire when the live sidecar agrees with the configured
       ceiling — otherwise every dev HMR reload would needlessly cold-restart. */
    const prevRestart = process.env.SIDECAR_RESTART_MB;
    const prevNodeEnv = process.env.NODE_ENV;
    process.env.SIDECAR_RESTART_MB = '48500';
    process.env.NODE_ENV = 'development';
    try {
      probeFn.mockResolvedValueOnce(true);
      const healthProbeFn = vi.fn(async () => ({
        reachable: true,
        looksLikeSidecar: true,
        protocolVersion: 1,
        committedMb: 9000,
        recyclePending: false,
        memRestartMb: 48500, // matches config
        vramRestartMb: 8000,
      }));
      const onAdoptExisting = vi.fn();

      const handle = await spawnSidecar({
        autoStart: true,
        modelKey: 'kokoro-v1',
        repoRoot,
        spawnFn: spawnFn as unknown as typeof import('node:child_process').spawn,
        probeFn,
        healthProbeFn,
        log,
        warn,
        onAdoptExisting,
      });

      expect(onAdoptExisting).toHaveBeenCalled(); // adopted — ceilings agree
      expect(handle).toBeNull(); // no spawn
    } finally {
      if (prevRestart === undefined) delete process.env.SIDECAR_RESTART_MB;
      else process.env.SIDECAR_RESTART_MB = prevRestart;
      if (prevNodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = prevNodeEnv;
    }
  });

  it('in dev, still ADOPTS a healthy same-build sidecar (HMR fast-path preserved)', async () => {
    /* dev adopt path must be unchanged — tsx watch HMR must not reload the
       model on every code save. */
    const prev = process.env.NODE_ENV;
    process.env.NODE_ENV = 'development';
    try {
      probeFn.mockResolvedValueOnce(true);
      const healthProbeFn = vi.fn(async () => ({
        reachable: true,
        looksLikeSidecar: true,
        protocolVersion: 1,
        committedMb: 9000,
        recyclePending: false,
      }));
      const onAdoptExisting = vi.fn();

      const res = await spawnSidecar({
        autoStart: true,
        modelKey: 'kokoro-v1',
        repoRoot,
        port: 9000,
        host: '127.0.0.1',
        spawnFn: spawnFn as unknown as typeof import('node:child_process').spawn,
        probeFn,
        healthProbeFn,
        log,
        warn,
        onAdoptExisting,
      });

      expect(onAdoptExisting).toHaveBeenCalledTimes(1);
      expect(spawnFn).not.toHaveBeenCalled();
      expect(res).toBeNull(); // adopt path returns null (no owned child)
    } finally {
      if (prev === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = prev;
    }
  });

  it('replaces an adopt target that reports recycle_pending', async () => {
    const originalPlatform = process.platform;
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    try {
      probeFn.mockResolvedValueOnce(true).mockResolvedValue(false);
      const healthProbeFn = vi.fn(async () => ({
        reachable: true,
        looksLikeSidecar: true,
        protocolVersion: 1,
        committedMb: 12000, // below the ceiling, but...
        recyclePending: true, // ...it's about to self-recycle
      }));
      const findPidFn = vi.fn(async () => 7777);
      const onAdoptExisting = vi.fn();
      const trackingSpawn = vi.fn((cmd: string) => {
        const child = makeFakeChild();
        if (cmd === 'taskkill') setImmediate(() => child.emit('exit', 0, null));
        return child;
      });

      const handle = await spawnSidecar({
        autoStart: true,
        modelKey: 'qwen3-tts-0.6b',
        repoRoot,
        spawnFn: trackingSpawn as unknown as typeof import('node:child_process').spawn,
        probeFn,
        healthProbeFn,
        findPidFn,
        log,
        warn,
        onAdoptExisting,
      });

      expect(onAdoptExisting).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('recycle_pending'));
      expect(handle).not.toBeNull();
    } finally {
      Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
    }
  });

  it('spawns with PRELOAD_COQUI=0 when default model is kokoro-v1', async () => {
    const handle = await spawnSidecar({
      autoStart: true,
      modelKey: 'kokoro-v1',
      repoRoot,
      // This case asserts the Windows spawn shape (powershell.exe + start.ps1),
      // so pin the platform — otherwise it fails on the Linux/macOS CI runners
      // where the production code (correctly) spawns `bash start.sh`. The POSIX
      // shape has its own case below. The env assertions are platform-agnostic.
      platform: 'win32',
      spawnFn: spawnFn as unknown as typeof import('node:child_process').spawn,
      probeFn,
      log,
      warn,
    });

    expect(handle).not.toBeNull();
    expect(handle?.pid).toBe(12345);
    expect(spawnFn).toHaveBeenCalledTimes(1);
    const [cmd, args, options] = spawnFn.mock.calls[0];
    expect(cmd).toBe('powershell.exe');
    expect(args).toEqual(
      expect.arrayContaining(['-ExecutionPolicy', 'Bypass', '-NoProfile', '-File']),
    );
    expect(options.env.PRELOAD_COQUI).toBe('0');
    // No registry override → left unset so the sidecar's own default (true) applies.
    expect(options.env.PRELOAD_KOKORO).toBeUndefined();
    /* The Qwen designed-voice cache is parked in the per-workspace tree
       (sibling to voices.json), not the sidecar's __file__-relative dir,
       so a restart / cwd change can't orphan a designed voice. */
    expect(options.env.QWEN_VOICES_DIR).toMatch(/voices[\\/]qwen$/);
    /* Cloned-voice latents (fs-38 Wave 3c) — same per-workspace-tree
       rationale as QWEN_VOICES_DIR above, sibling directory. */
    expect(options.env.XTTS_VOICES_DIR).toMatch(/voices[\\/]xtts$/);
    /* CUDA-fragmentation guard (2026-05-30 mid-run VRAM OOM) — defaulted on so
       a long run's variable-length batches don't fragment VRAM into an OOM.
       Plan 161: the default ALSO carries max_split_size_mb + garbage_collection,
       which (unlike expandable_segments) apply on Windows too. */
    expect(options.env.PYTORCH_CUDA_ALLOC_CONF).toBe(
      'expandable_segments:True,max_split_size_mb:256,garbage_collection_threshold:0.8',
    );
    expect(options.windowsHide).toBe(true);
  });

  it('spawns via bash start.sh on POSIX (same kokoro env contract)', async () => {
    const handle = await spawnSidecar({
      autoStart: true,
      modelKey: 'kokoro-v1',
      repoRoot,
      platform: 'linux',
      spawnFn: spawnFn as unknown as typeof import('node:child_process').spawn,
      probeFn,
      log,
      warn,
    });

    expect(handle).not.toBeNull();
    expect(spawnFn).toHaveBeenCalledTimes(1);
    const [cmd, args, options] = spawnFn.mock.calls[0];
    // POSIX spawns `bash <repo>/server/tts-sidecar/start.sh`, not powershell.
    expect(cmd).toBe('bash');
    expect(args).toEqual([expect.stringMatching(/start\.sh$/)]);
    // detached → own process group so killTree reaps the uvicorn grandchild
    // that `bash start.sh` spawns.
    expect(options.detached).toBe(true);
    expect(options.windowsHide).toBe(true);
    // The env contract is platform-agnostic — same kokoro preload as Windows.
    expect(options.env.PRELOAD_COQUI).toBe('0');
    expect(options.env.PRELOAD_KOKORO).toBeUndefined();
  });

  it('lets an explicit PYTORCH_CUDA_ALLOC_CONF override the default', async () => {
    const prev = process.env.PYTORCH_CUDA_ALLOC_CONF;
    process.env.PYTORCH_CUDA_ALLOC_CONF = 'expandable_segments:True,max_split_size_mb:256';
    try {
      await spawnSidecar({
        autoStart: true,
        modelKey: 'kokoro-v1',
        repoRoot,
        spawnFn: spawnFn as unknown as typeof import('node:child_process').spawn,
        probeFn,
        log,
        warn,
      });
      const [, , options] = spawnFn.mock.calls[0];
      expect(options.env.PYTORCH_CUDA_ALLOC_CONF).toBe(
        'expandable_segments:True,max_split_size_mb:256',
      );
    } finally {
      if (prev === undefined) delete process.env.PYTORCH_CUDA_ALLOC_CONF;
      else process.env.PYTORCH_CUDA_ALLOC_CONF = prev;
    }
  });

  it('spawns with PRELOAD_COQUI=1 when default model is coqui-xtts-v2', async () => {
    const handle = await spawnSidecar({
      autoStart: true,
      modelKey: 'coqui-xtts-v2',
      repoRoot,
      spawnFn: spawnFn as unknown as typeof import('node:child_process').spawn,
      probeFn,
      log,
      warn,
    });

    expect(handle).not.toBeNull();
    expect(spawnFn).toHaveBeenCalledTimes(1);
    const [, , options] = spawnFn.mock.calls[0];
    expect(options.env.PRELOAD_COQUI).toBe('1');
  });

  it('leaves PRELOAD_QWEN / PRELOAD_QWEN_BASE17 / PRELOAD_KOKORO unset (sidecar default) regardless of modelKey — the preload-toggle dedup dropped the old modelKey coupling', async () => {
    for (const modelKey of ['qwen3-tts-0.6b', 'qwen3-tts-1.7b', 'kokoro-v1'] as const) {
      spawnFn.mockClear();
      const handle = await spawnSidecar({
        autoStart: true,
        modelKey,
        repoRoot,
        spawnFn: spawnFn as unknown as typeof import('node:child_process').spawn,
        probeFn,
        log,
        warn,
      });
      expect(handle, `modelKey=${modelKey}`).not.toBeNull();
      const [, , options] = spawnFn.mock.calls[0];
      expect(options.env.PRELOAD_QWEN, `modelKey=${modelKey}`).toBeUndefined();
      expect(options.env.PRELOAD_QWEN_BASE17, `modelKey=${modelKey}`).toBeUndefined();
      expect(options.env.PRELOAD_KOKORO, `modelKey=${modelKey}`).toBeUndefined();
    }
  });

  it('hands the child inherited log-file descriptors as stdout/stderr (survives parent death)', async () => {
    /* Regression for the orphaned-sidecar [Errno 22] bug: a `tsx watch` dev
       reload restarts the Node server but leaves the long-lived sidecar
       running. If the sidecar's stdout/stderr were Node PIPES owned by the
       (now-dead) parent, its next write — the huggingface from_pretrained
       tqdm progress bar during a model /load — raised
       "OSError: [Errno 22] Invalid argument", surfacing as an opaque /load
       500 and a TTS pill that reverts to idle. Handing the child raw FILE
       descriptors (its own OS handles) instead keeps logging alive
       regardless of the parent's lifetime. */
    const handle = await spawnSidecar({
      autoStart: true,
      modelKey: 'kokoro-v1',
      repoRoot,
      spawnFn: spawnFn as unknown as typeof import('node:child_process').spawn,
      probeFn,
      log,
      warn,
    });

    expect(handle).not.toBeNull();
    const [, , options] = spawnFn.mock.calls[0];
    expect(options.stdio[0]).toBe('ignore');
    /* stdout + stderr are raw integer fds, NOT the string 'pipe' the old
       WriteStream-piping path used. */
    expect(typeof options.stdio[1]).toBe('number');
    expect(typeof options.stdio[2]).toBe('number');
    /* The log files were actually created under repoRoot/logs ... */
    expect(readdirSync(join(repoRoot, 'logs')).sort()).toEqual(['tts.err.log', 'tts.log']);
    /* ... with no "log file open failed" fallback-to-discard warning. */
    expect(warn).not.toHaveBeenCalledWith(expect.stringContaining('log file open failed'));
  });

  it('parks tts.pid + logs under APP_RUN_DIR / APP_LOG_DIR when set (fs-1 versioned-dir)', async () => {
    /* A versioned-dir install points logs/.run at a shared sibling OUTSIDE the
       per-release tree, so tts.pid (which stop-app + the upgrade restarter
       reap) survives a release swap. With the env set, NOTHING lands under
       repoRoot. */
    const sharedRun = mkdtempSync(join(tmpdir(), 'wt-run-'));
    const sharedLog = mkdtempSync(join(tmpdir(), 'wt-log-'));
    const prevRun = process.env.APP_RUN_DIR;
    const prevLog = process.env.APP_LOG_DIR;
    process.env.APP_RUN_DIR = sharedRun;
    process.env.APP_LOG_DIR = sharedLog;
    try {
      const handle = await spawnSidecar({
        autoStart: true,
        modelKey: 'kokoro-v1',
        repoRoot,
        spawnFn: spawnFn as unknown as typeof import('node:child_process').spawn,
        probeFn,
        log,
        warn,
      });
      expect(handle).not.toBeNull();
      expect(readdirSync(sharedLog).sort()).toEqual(['tts.err.log', 'tts.log']);
      expect(readdirSync(sharedRun)).toContain('tts.pid');
      /* repoRoot stays clean — no logs/ or .run/ created inside the release. */
      expect(() => readdirSync(join(repoRoot, 'logs'))).toThrow();
      expect(() => readdirSync(join(repoRoot, '.run'))).toThrow();
    } finally {
      if (prevRun === undefined) delete process.env.APP_RUN_DIR;
      else process.env.APP_RUN_DIR = prevRun;
      if (prevLog === undefined) delete process.env.APP_LOG_DIR;
      else process.env.APP_LOG_DIR = prevLog;
      rmSync(sharedRun, { recursive: true, force: true });
      rmSync(sharedLog, { recursive: true, force: true });
    }
  });

  it('passes KOKORO_MODEL_PATH / KOKORO_VOICES_PATH through to the sidecar (fs-1 shared weights)', async () => {
    /* The versioned-dir launcher points the ~330 MB Kokoro weights at a shared
       models/kokoro sibling via these env vars; the spawn must forward them so
       the sidecar doesn't re-resolve to its __file__-relative (per-release)
       default. Carried by the `...process.env` spread — this pins it so a
       future allowlist refactor can't silently drop them. */
    const prevModel = process.env.KOKORO_MODEL_PATH;
    const prevVoices = process.env.KOKORO_VOICES_PATH;
    process.env.KOKORO_MODEL_PATH = join('/shared', 'models', 'kokoro', 'kokoro-v1.0.onnx');
    process.env.KOKORO_VOICES_PATH = join('/shared', 'models', 'kokoro', 'voices-v1.0.bin');
    try {
      await spawnSidecar({
        autoStart: true,
        modelKey: 'kokoro-v1',
        repoRoot,
        spawnFn: spawnFn as unknown as typeof import('node:child_process').spawn,
        probeFn,
        log,
        warn,
      });
      const [, , options] = spawnFn.mock.calls[0];
      expect(options.env.KOKORO_MODEL_PATH).toBe(process.env.KOKORO_MODEL_PATH);
      expect(options.env.KOKORO_VOICES_PATH).toBe(process.env.KOKORO_VOICES_PATH);
    } finally {
      if (prevModel === undefined) delete process.env.KOKORO_MODEL_PATH;
      else process.env.KOKORO_MODEL_PATH = prevModel;
      if (prevVoices === undefined) delete process.env.KOKORO_VOICES_PATH;
      else process.env.KOKORO_VOICES_PATH = prevVoices;
    }
  });

  it('logs a warning when the spawned child exits unexpectedly', async () => {
    const child = makeFakeChild(54321);
    spawnFn.mockReturnValueOnce(child);

    const handle = await spawnSidecar({
      autoStart: true,
      modelKey: 'kokoro-v1',
      repoRoot,
      spawnFn: spawnFn as unknown as typeof import('node:child_process').spawn,
      probeFn,
      log,
      warn,
    });

    expect(handle).not.toBeNull();
    child.emit('exit', 1, null);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('child exited (code=1, signal=null)'),
    );
  });

  it('invokes the onExit callback on child exit so the supervisor can respawn (srv-15)', async () => {
    const child = makeFakeChild(54321);
    spawnFn.mockReturnValueOnce(child);
    const onExit = vi.fn();

    const handle = await spawnSidecar({
      autoStart: true,
      modelKey: 'kokoro-v1',
      repoRoot,
      spawnFn: spawnFn as unknown as typeof import('node:child_process').spawn,
      probeFn,
      log,
      warn,
      onExit,
    });

    expect(handle).not.toBeNull();
    child.emit('exit', 42, null); // the poison self-exit code
    expect(onExit).toHaveBeenCalledWith(42, null);
  });

  it('spawns bash start.sh on non-Windows platforms', async () => {
    const calls: Array<{ file: string; args: readonly string[] }> = [];
    const fakeSpawn = ((file: string, args: readonly string[]) => {
      calls.push({ file, args });
      const child: any = new EventEmitter();
      child.pid = 4321; child.stdout = null; child.stderr = null;
      return child;
    }) as unknown as typeof import('node:child_process').spawn;
    await spawnSidecar({
      autoStart: true, modelKey: 'kokoro-v1',
      repoRoot, spawnFn: fakeSpawn, probeFn: async () => false,
      platform: 'darwin', log: () => {}, warn: () => {},
    } as any);
    expect(calls[0].file).toBe('bash');
    expect(String(calls[0].args[0])).toMatch(/tts-sidecar[\\/]start\.sh$/);
  });

  it('does not throw when the spawned child emits an error event', async () => {
    const child: any = new EventEmitter();
    child.pid = 999; child.stdout = null; child.stderr = null;
    const fakeSpawn = (() => child) as unknown as typeof import('node:child_process').spawn;
    const handle = await spawnSidecar({
      autoStart: true, modelKey: 'kokoro-v1',
      repoRoot, spawnFn: fakeSpawn, probeFn: async () => false,
      platform: 'darwin', log: () => {}, warn: () => {},
    } as any);
    expect(() => child.emit('error', new Error('ENOENT'))).not.toThrow();
    expect(handle).not.toBeNull();
  });

  it('handle.kill() on win32 shells out to taskkill /T /F /PID', async () => {
    const originalPlatform = process.platform;
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });

    /* Two spawn calls: the first launches the sidecar, the second is the
       taskkill the handle's kill() fires. Replace the mock with a tracker
       that captures all calls so we can introspect both. */
    const calls: Array<{ cmd: string; args: string[] }> = [];
    const trackingSpawn = vi.fn((cmd: string, args: string[]) => {
      calls.push({ cmd, args });
      const child = makeFakeChild();
      /* The taskkill child needs to emit 'exit' so the kill() Promise
         resolves; trigger it synchronously on the next tick. */
      if (cmd === 'taskkill') {
        setImmediate(() => child.emit('exit', 0, null));
      }
      return child;
    });

    try {
      const handle = await spawnSidecar({
        autoStart: true,
        modelKey: 'kokoro-v1',
        repoRoot,
        spawnFn: trackingSpawn as unknown as typeof import('node:child_process').spawn,
        probeFn,
        log,
        warn,
      });

      expect(handle).not.toBeNull();
      await handle!.kill();

      expect(calls).toHaveLength(2);
      expect(calls[0].cmd).toBe('powershell.exe');
      expect(calls[1].cmd).toBe('taskkill');
      expect(calls[1].args).toEqual(['/PID', '12345', '/T', '/F']);
    } finally {
      Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
    }
  });

  /* srv-2037 (#2037) — onSpawnRefused fires on the four NON-benign `return
     null` paths (a failure) and NOT on the two benign no-spawn paths
     (nothing to do). The supervisor uses this split to decide whether to
     retry on backoff. */
  describe('onSpawnRefused', () => {
    it('fires when a listening process does not look like our sidecar', async () => {
      probeFn.mockResolvedValueOnce(true);
      const healthProbeFn = vi.fn(async () => ({
        reachable: true,
        looksLikeSidecar: false,
        protocolVersion: null,
        committedMb: null,
        recyclePending: false,
      }));
      const onSpawnRefused = vi.fn();

      const handle = await spawnSidecar({
        autoStart: true,
        modelKey: 'kokoro-v1',
        repoRoot,
        spawnFn: spawnFn as unknown as typeof import('node:child_process').spawn,
        probeFn,
        healthProbeFn,
        log,
        warn,
        onSpawnRefused,
      });

      expect(handle).toBeNull();
      expect(onSpawnRefused).toHaveBeenCalledTimes(1);
      expect(onSpawnRefused).toHaveBeenCalledWith(expect.stringContaining('does not look like our sidecar'));
    });

    /* D2 (#2037) — the not-ours refusal names the just-exited OWNED child's
       socket, rather than the generic "foreign listener" message, when the
       caller tells us which pid it just reaped AND that pid still owns the
       port. Log-only: onSpawnRefused still fires and handle is still null
       either way (recovery is unaffected — see D1's tests above). */
    describe('D2 — foreign-listener message names our own just-exited child when it matches', () => {
      it('names the just-exited child when findPidFn confirms it still owns the port', async () => {
        probeFn.mockResolvedValueOnce(true);
        const healthProbeFn = vi.fn(async () => ({
          reachable: true,
          looksLikeSidecar: false,
          protocolVersion: null,
          committedMb: null,
          recyclePending: false,
        }));
        const findPidFn = vi.fn(async () => 4242); // still bound by our own just-exited pid
        const onSpawnRefused = vi.fn();

        const handle = await spawnSidecar({
          autoStart: true,
          modelKey: 'kokoro-v1',
          repoRoot,
          spawnFn: spawnFn as unknown as typeof import('node:child_process').spawn,
          probeFn,
          healthProbeFn,
          findPidFn,
          log,
          warn,
          onSpawnRefused,
          lastOwnedPid: 4242,
        });

        expect(handle).toBeNull();
        expect(findPidFn).toHaveBeenCalledTimes(1);
        expect(onSpawnRefused).toHaveBeenCalledWith(
          expect.stringContaining('just-exited child (pid=4242)'),
        );
        expect(onSpawnRefused).not.toHaveBeenCalledWith(
          expect.stringContaining('does not look like our sidecar'),
        );
      });

      it('falls back to the generic message when the port is held by a DIFFERENT pid (genuinely foreign)', async () => {
        probeFn.mockResolvedValueOnce(true);
        const healthProbeFn = vi.fn(async () => ({
          reachable: true,
          looksLikeSidecar: false,
          protocolVersion: null,
          committedMb: null,
          recyclePending: false,
        }));
        const findPidFn = vi.fn(async () => 9999); // NOT our just-exited pid
        const onSpawnRefused = vi.fn();

        const handle = await spawnSidecar({
          autoStart: true,
          modelKey: 'kokoro-v1',
          repoRoot,
          spawnFn: spawnFn as unknown as typeof import('node:child_process').spawn,
          probeFn,
          healthProbeFn,
          findPidFn,
          log,
          warn,
          onSpawnRefused,
          lastOwnedPid: 4242,
        });

        expect(handle).toBeNull();
        expect(findPidFn).toHaveBeenCalledTimes(1);
        expect(onSpawnRefused).toHaveBeenCalledWith(
          expect.stringContaining('does not look like our sidecar'),
        );
        expect(onSpawnRefused).not.toHaveBeenCalledWith(
          expect.stringContaining('just-exited child'),
        );
      });

      it('does not call findPidFn (and uses the generic message) when no lastOwnedPid is given', async () => {
        probeFn.mockResolvedValueOnce(true);
        const healthProbeFn = vi.fn(async () => ({
          reachable: true,
          looksLikeSidecar: false,
          protocolVersion: null,
          committedMb: null,
          recyclePending: false,
        }));
        const findPidFn = vi.fn(async () => 4242);
        const onSpawnRefused = vi.fn();

        const handle = await spawnSidecar({
          autoStart: true,
          modelKey: 'kokoro-v1',
          repoRoot,
          spawnFn: spawnFn as unknown as typeof import('node:child_process').spawn,
          probeFn,
          healthProbeFn,
          findPidFn,
          log,
          warn,
          onSpawnRefused,
          // lastOwnedPid omitted — e.g. the very first boot, no prior exit.
        });

        expect(handle).toBeNull();
        expect(findPidFn).not.toHaveBeenCalled();
        expect(onSpawnRefused).toHaveBeenCalledWith(
          expect.stringContaining('does not look like our sidecar'),
        );
      });
    });

    it('fires with a parse-miss message when a stale sidecar\'s PID cannot be identified (not a timeout)', async () => {
      probeFn.mockResolvedValueOnce(true);
      const healthProbeFn = vi.fn(async () => ({
        reachable: true,
        looksLikeSidecar: true,
        protocolVersion: null, // stale
        committedMb: null,
        recyclePending: false,
      }));
      const findPidFn = vi.fn(async () => null); // returns null but NOT from deadline expiry
      const onSpawnRefused = vi.fn();

      const handle = await spawnSidecar({
        autoStart: true,
        modelKey: 'kokoro-v1',
        repoRoot,
        spawnFn: spawnFn as unknown as typeof import('node:child_process').spawn,
        probeFn,
        healthProbeFn,
        findPidFn,
        log,
        warn,
        onSpawnRefused,
      });

      expect(handle).toBeNull();
      expect(onSpawnRefused).toHaveBeenCalledTimes(1);
      // Should use the parse-miss message with manual-restart advice
      expect(warn).toHaveBeenCalledWith(
        expect.stringMatching(/could not identify the PID.*Restart the sidecar manually/s),
      );
      expect(onSpawnRefused).toHaveBeenCalledWith(expect.stringContaining('could not identify the PID'));
      // Must NOT have the timeout/supervisor-retry advice
      expect(warn).not.toHaveBeenCalledWith(expect.stringMatching(/supervisor will retry/));
    });

    it('fires with a timeout message when the PID probe deadline expires (Half B)', async () => {
      probeFn.mockResolvedValueOnce(true);
      const healthProbeFn = vi.fn(async () => ({
        reachable: true,
        looksLikeSidecar: true,
        protocolVersion: null, // stale
        committedMb: null,
        recyclePending: false,
      }));
      // Mock findPidFn to signal a deadline expiry via the callback
      const findPidFn = vi.fn(async (_port, onDeadlineExpiry) => {
        onDeadlineExpiry?.();
        return null;
      });
      const onSpawnRefused = vi.fn();

      const handle = await spawnSidecar({
        autoStart: true,
        modelKey: 'kokoro-v1',
        repoRoot,
        spawnFn: spawnFn as unknown as typeof import('node:child_process').spawn,
        probeFn,
        healthProbeFn,
        findPidFn,
        log,
        warn,
        onSpawnRefused,
      });

      expect(handle).toBeNull();
      expect(onSpawnRefused).toHaveBeenCalledTimes(1);
      // Should use the timeout message with supervisor-retry advice, NOT manual-restart
      expect(warn).toHaveBeenCalledWith(
        expect.stringMatching(/probe for the PID on.*timed out.*supervisor will retry/s),
      );
      expect(onSpawnRefused).toHaveBeenCalledWith(expect.stringContaining('timed out'));
      // Must NOT have the manual-restart advice
      expect(warn).not.toHaveBeenCalledWith(expect.stringMatching(/Restart the sidecar manually/));
    });

    it('fires when the killed stale PID still leaves the port bound', async () => {
      const originalPlatform = process.platform;
      Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
      // waitForPortFree polls on real setTimeout/Date.now for up to 5s with no
      // injectable clock — fake timers keep this test instant instead of
      // burning 5 real seconds waiting for a port that never frees.
      vi.useFakeTimers();
      try {
        // Listening at first; killTree runs, but the port NEVER frees.
        probeFn.mockResolvedValue(true);
        const healthProbeFn = vi.fn(async () => ({
          reachable: true,
          looksLikeSidecar: true,
          protocolVersion: null, // stale
          committedMb: null,
          recyclePending: false,
        }));
        const findPidFn = vi.fn(async () => 7777);
        const trackingSpawn = vi.fn((cmd: string) => {
          const child = makeFakeChild();
          if (cmd === 'taskkill') setImmediate(() => child.emit('exit', 0, null));
          return child;
        });
        const onSpawnRefused = vi.fn();

        const pending = spawnSidecar({
          autoStart: true,
          modelKey: 'kokoro-v1',
          repoRoot,
          spawnFn: trackingSpawn as unknown as typeof import('node:child_process').spawn,
          probeFn,
          healthProbeFn,
          findPidFn,
          log,
          warn,
          onSpawnRefused,
        });
        await vi.runAllTimersAsync();
        const handle = await pending;

        expect(handle).toBeNull();
        expect(onSpawnRefused).toHaveBeenCalledTimes(1);
        expect(onSpawnRefused).toHaveBeenCalledWith(expect.stringContaining('still bound'));
      } finally {
        vi.useRealTimers();
        Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
      }
    });

    it('fires when the OS-level spawn call throws', async () => {
      const throwingSpawn = vi.fn(() => {
        throw new Error('ENOENT: powershell.exe not found');
      });
      const onSpawnRefused = vi.fn();

      const handle = await spawnSidecar({
        autoStart: true,
        modelKey: 'kokoro-v1',
        repoRoot,
        spawnFn: throwingSpawn as unknown as typeof import('node:child_process').spawn,
        probeFn,
        log,
        warn,
        onSpawnRefused,
      });

      expect(handle).toBeNull();
      expect(onSpawnRefused).toHaveBeenCalledTimes(1);
      expect(onSpawnRefused).toHaveBeenCalledWith(expect.stringContaining('spawn failed'));
    });

    it('fires when the spawned child has no pid', async () => {
      const noPidChild = () => {
        const ee = makeFakeChild();
        // @ts-expect-error — simulating a spawn() result with no pid.
        ee.pid = undefined;
        return ee;
      };
      const noPidSpawn = vi.fn(() => noPidChild());
      const onSpawnRefused = vi.fn();

      const handle = await spawnSidecar({
        autoStart: true,
        modelKey: 'kokoro-v1',
        repoRoot,
        spawnFn: noPidSpawn as unknown as typeof import('node:child_process').spawn,
        probeFn,
        log,
        warn,
        onSpawnRefused,
      });

      expect(handle).toBeNull();
      expect(onSpawnRefused).toHaveBeenCalledTimes(1);
      expect(onSpawnRefused).toHaveBeenCalledWith(expect.stringContaining('no pid'));
    });

    it('does NOT fire when autoStart is false and nothing is listening', async () => {
      const onSpawnRefused = vi.fn();

      const handle = await spawnSidecar({
        autoStart: false,
        modelKey: 'kokoro-v1',
        repoRoot,
        spawnFn: spawnFn as unknown as typeof import('node:child_process').spawn,
        probeFn,
        log,
        warn,
        onSpawnRefused,
      });

      expect(handle).toBeNull();
      expect(onSpawnRefused).not.toHaveBeenCalled();
    });

    /* #3043 B1 — a refusal drives the supervisor's retry/backoff loop and
       holds isRecycling true. With autoStart off there is no spawn at the end
       of that loop for it to reach, so refusing is never the right answer
       however unadoptable the listener is. */
    it('does NOT fire when autoStart is false and a FOREIGN process holds the port', async () => {
      probeFn.mockResolvedValueOnce(true);
      const onSpawnRefused = vi.fn();

      const handle = await spawnSidecar({
        autoStart: false,
        modelKey: 'kokoro-v1',
        repoRoot,
        spawnFn: spawnFn as unknown as typeof import('node:child_process').spawn,
        probeFn,
        healthProbeFn: async () => ({
          reachable: true,
          looksLikeSidecar: false,
          protocolVersion: null,
          committedMb: null,
          recyclePending: false,
        }),
        log,
        warn,
        onSpawnRefused,
      });

      expect(handle).toBeNull();
      expect(onSpawnRefused).not.toHaveBeenCalled();
    });

    it('does NOT fire on a healthy adopt (benign)', async () => {
      probeFn.mockResolvedValueOnce(true);
      const healthProbeFn = vi.fn(async () => ({
        reachable: true,
        looksLikeSidecar: true,
        protocolVersion: 1,
        committedMb: 9000,
        recyclePending: false,
      }));
      const onSpawnRefused = vi.fn();
      const onAdoptExisting = vi.fn();

      const handle = await spawnSidecar({
        autoStart: true,
        modelKey: 'kokoro-v1',
        repoRoot,
        spawnFn: spawnFn as unknown as typeof import('node:child_process').spawn,
        probeFn,
        healthProbeFn,
        log,
        warn,
        onSpawnRefused,
        onAdoptExisting,
      });

      expect(handle).toBeNull();
      expect(onAdoptExisting).toHaveBeenCalledTimes(1);
      expect(onSpawnRefused).not.toHaveBeenCalled();
    });
  });

  it('resolves sidecar port from LOCAL_TTS_PORT env var for per-worktree isolation (#2632)', async () => {
    /* When LOCAL_TTS_PORT is set (e.g. by wt-new.mjs to 9010 for slot 1),
       spawnSidecar should probe and adopt/spawn on that port, not the hardcoded
       9000. This enables concurrent sidecars on different worktrees.
       beforeEach/afterEach already delete LOCAL_TTS_PORT, so no save/restore
       is needed here. */
    process.env.LOCAL_TTS_PORT = '9010';

    let capturedHost: string | undefined;
    let capturedPort: number | undefined;
    // The inline probeFn below is what actually captures the host/port probed;
    // spawnFnWithCapture is just a plain spawn stub (its name is historical).
    const spawnFnWithCapture = vi.fn(() => makeFakeChild());

    const handle = await spawnSidecar({
      autoStart: true,
      modelKey: 'kokoro-v1',
      repoRoot,
      spawnFn: spawnFnWithCapture as unknown as typeof import('node:child_process').spawn,
      probeFn: async (host: string, port: number) => {
        capturedHost = host;
        capturedPort = port;
        return false; // port is free
      },
      log,
      warn,
    });

    // Verify that the probe was called on port 9010, not 9000
    expect(capturedPort).toBe(9010);
    expect(capturedHost).toBe('127.0.0.1');
    expect(handle).not.toBeNull();
    expect(spawnFnWithCapture).toHaveBeenCalled();
  });
});

describe('sidecarCeilingMismatch — per-card free floor', () => {
  it('flags a card whose reported free-floor disagrees with the configured knob', () => {
    const prevFloor = process.env.SIDECAR_VRAM_FREE_FLOOR_MB;
    process.env.SIDECAR_VRAM_FREE_FLOOR_MB = '1024';
    try {
      const health = {
        memRestartMb: null, vramRestartMb: null,
        gpus: [{ idx: 0, freeFloorMb: 2048 }], // sidecar reports 2048, config expects 1024
      } as any;
      expect(sidecarCeilingMismatch(health)).toMatch(/free.*floor/i);
    } finally {
      if (prevFloor === undefined) delete process.env.SIDECAR_VRAM_FREE_FLOOR_MB;
      else process.env.SIDECAR_VRAM_FREE_FLOOR_MB = prevFloor;
    }
  });

  it('is null when every reported card free-floor matches (or no expectation is configured)', () => {
    const health = { memRestartMb: null, vramRestartMb: null, gpus: [{ idx: 0, freeFloorMb: null }] } as any;
    expect(sidecarCeilingMismatch(health)).toBeNull();
  });
});

describe('findListenerPid — bounded with a deadline', () => {
  interface HangingChild extends EventEmitter {
    pid: number;
    stdout: EventEmitter;
    stderr: null;
    kill: ReturnType<typeof vi.fn>;
  }

  /* A probe child that never emits 'exit' or 'error' — it simulates a hung
     powershell/lsof. Under fake timers the deadline setTimeout is what fires. */
  function makeHangingChild(pid = 9001): HangingChild {
    const ee = new EventEmitter() as HangingChild;
    ee.pid = pid;
    ee.stdout = new EventEmitter();
    ee.stderr = null;
    ee.kill = vi.fn(() => true);
    return ee;
  }

  afterEach(() => {
    vi.useRealTimers();
  });

  it('uses the shipped LISTENER_PID_DEADLINE_MS constant when no explicit deadline is passed (Half A coverage)', async () => {
    /* The shipped default (5000ms) is never exercised by tests that explicitly
       pass deadlineMs=1000. Verify: (1) the constant has the expected value,
       (2) calling findListenerPid without deadlineMs uses it, (3) the deadline
       fires and kills the child. */
    vi.useFakeTimers();
    const child = makeHangingChild();
    const spawnFn = vi.fn(() => child) as unknown as typeof import('node:child_process').spawn;

    // Import the constant and verify its value so a typo fails the test
    const { LISTENER_PID_DEADLINE_MS } = await import('./spawn-sidecar.js');
    expect(LISTENER_PID_DEADLINE_MS).toBe(5000);

    // Call without explicit deadlineMs — should use the constant
    const promise = findListenerPid(9000, 'win32', spawnFn);
    expect(spawnFn).toHaveBeenCalledTimes(1);
    expect(child.kill).not.toHaveBeenCalled();

    // Advance to the deadline and confirm it fires
    await vi.advanceTimersByTimeAsync(LISTENER_PID_DEADLINE_MS + 1);
    await expect(promise).resolves.toBeNull();
    expect(child.kill).toHaveBeenCalledTimes(1);
  });

  it('resolves null and kills the child when the probe never exits (deadline)', async () => {
    vi.useFakeTimers();
    const child = makeHangingChild();
    const spawnFn = vi.fn(() => child) as unknown as typeof import('node:child_process').spawn;
    const deadlineMs = 1000;

    const promise = findListenerPid(9000, 'win32', spawnFn, deadlineMs);
    expect(spawnFn).toHaveBeenCalledTimes(1);
    expect(child.kill).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(deadlineMs + 1);
    await expect(promise).resolves.toBeNull();
    expect(child.kill).toHaveBeenCalledTimes(1);
  });

  it('still resolves the pid when the probe exits before the deadline', async () => {
    vi.useFakeTimers();
    const child = makeHangingChild();
    const spawnFn = vi.fn(() => child) as unknown as typeof import('node:child_process').spawn;
    const deadlineMs = 1000;

    const promise = findListenerPid(9000, 'win32', spawnFn, deadlineMs);
    child.stdout.emit('data', '4242\n');
    child.emit('exit', 0, null);

    await expect(promise).resolves.toBe(4242);
    expect(child.kill).not.toHaveBeenCalled();
  });

  it('POSIX command must be a single simple command with no pipeline (regression: deadline kill reaches the probe process)', () => {
    /* The POSIX branch spawns `sh -c 'lsof -ti tcp:PORT -sTCP:LISTEN'`, which
       `sh -c` execs in place so child.kill() reaches lsof directly. A pipeline
       like `lsof … | head -n1` keeps sh as the parent — child.kill() signals
       sh, not the hung lsof, so the deadline orphans the real culprit. This test
       pins that the command string contains no pipe, enforcing the single-command
       shape the deadline kill depends on. */
    const calls: Array<{ file: string; args: readonly string[] }> = [];
    const spawnFn = vi.fn((file: string, args: readonly string[]) => {
      calls.push({ file, args });
      return makeHangingChild();
    }) as unknown as typeof import('node:child_process').spawn;

    // Force POSIX path by injecting platform
    findListenerPid(9000, 'linux', spawnFn, 1000);

    expect(calls).toHaveLength(1);
    expect(calls[0].file).toBe('sh');
    expect(calls[0].args).toHaveLength(2);
    expect(calls[0].args[0]).toBe('-c');
    // The command string must NOT contain a pipe — it must be a single simple
    // command that sh -c execs, not a pipeline that spawns sh as a parent.
    const commandString = calls[0].args[1];
    expect(commandString).not.toContain('|');
  });

  it('POSIX lsof with multi-line output parses the first PID correctly (regression: pipe removal must not break parsing)', async () => {
    /* Removing `| head -n1` means split(/\s+/) must handle multi-line output.
       This test feeds a fake child with multi-line lsof output (multiple PIDs
       on separate lines) and verifies that we extract the first one. This proves
       dropping the pipeline was safe — the existing split() logic already
       de-duplicates the first line. */
    vi.useFakeTimers();
    const child = makeHangingChild();
    const spawnFn = vi.fn(() => child) as unknown as typeof import('node:child_process').spawn;

    const promise = findListenerPid(9000, 'linux', spawnFn, 1000);

    // Simulate lsof output with multiple PIDs on separate lines
    child.stdout.emit('data', '111\n222\n333\n');
    child.emit('exit', 0, null);

    await expect(promise).resolves.toBe(111); // First line only
  });

  it('invokes onDeadlineExpiry callback when the deadline fires (Half B)', async () => {
    /* When the probe times out, a callback fires so the caller can distinguish
       a timeout ("may retry") from a parse miss ("structural problem"). */
    vi.useFakeTimers();
    const child = makeHangingChild();
    const spawnFn = vi.fn(() => child) as unknown as typeof import('node:child_process').spawn;
    const onDeadlineExpiry = vi.fn();
    const deadlineMs = 1000;

    const promise = findListenerPid(9000, 'win32', spawnFn, deadlineMs, onDeadlineExpiry);

    await vi.advanceTimersByTimeAsync(deadlineMs + 1);
    await expect(promise).resolves.toBeNull();
    expect(onDeadlineExpiry).toHaveBeenCalledTimes(1);
    expect(child.kill).toHaveBeenCalledTimes(1);
  });

  it('does not invoke onDeadlineExpiry when the probe exits before the deadline', async () => {
    /* The callback should only fire on timeout, not on normal exit. */
    vi.useFakeTimers();
    const child = makeHangingChild();
    const spawnFn = vi.fn(() => child) as unknown as typeof import('node:child_process').spawn;
    const onDeadlineExpiry = vi.fn();
    const deadlineMs = 1000;

    const promise = findListenerPid(9000, 'win32', spawnFn, deadlineMs, onDeadlineExpiry);

    child.stdout.emit('data', '4242\n');
    child.emit('exit', 0, null);

    await expect(promise).resolves.toBe(4242);
    expect(onDeadlineExpiry).not.toHaveBeenCalled();
  });

  it('uses LISTENER_PID_DEADLINE_MS as the default deadline when no explicit deadlineMs is passed (Mutation B coverage)', async () => {
    /* Mutation B: the "Half A coverage" test at line 1290 asserts the constant
       value but does not verify the default parameter uses it. This test
       verifies that calling findListenerPid WITHOUT passing deadlineMs uses
       the constant value. Advancing to the boundary distinguishes them: if the
       default were 1000, we'd reach it before DEADLINE; if it's 5000, we won't.

       The test MUST NOT pass an explicit deadlineMs so the default is used.
       The test MUST use the actual constant value to assert at the boundary,
       not a hardcoded 5000. */
    vi.useFakeTimers();
    const child = makeHangingChild();
    const spawnFn = vi.fn(() => child) as unknown as typeof import('node:child_process').spawn;
    const onDeadlineExpiry = vi.fn();

    // Import the constant to use the actual value, not a hardcoded number
    const { LISTENER_PID_DEADLINE_MS } = await import('./spawn-sidecar.js');

    // Call WITHOUT explicit deadlineMs — should use the constant
    const promise = findListenerPid(9000, 'win32', spawnFn, undefined, onDeadlineExpiry);

    // Advance to just before the deadline and verify nothing has fired yet
    await vi.advanceTimersByTimeAsync(LISTENER_PID_DEADLINE_MS - 1);
    expect(onDeadlineExpiry).not.toHaveBeenCalled();
    expect(child.kill).not.toHaveBeenCalled();

    // Advance just past the deadline and verify the deadline fires
    await vi.advanceTimersByTimeAsync(2); // total is now DEADLINE + 1
    await expect(promise).resolves.toBeNull();
    expect(onDeadlineExpiry).toHaveBeenCalledTimes(1);
    expect(child.kill).toHaveBeenCalledTimes(1);
  });
});
