import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sidecarCommand, launchSidecarWithRestart } from '../launch-sidecar.mjs';
import { startAppCommand } from '../start-app.mjs';

test('sidecar dispatch: windows uses powershell start.ps1', () => {
  const c = sidecarCommand('win32', 'C:/repo');
  assert.equal(c.file, 'powershell.exe');
  assert.ok(c.args.at(-1).endsWith('start.ps1'), c.args.at(-1));
});

test('sidecar dispatch: posix uses bash start.sh', () => {
  const c = sidecarCommand('darwin', '/repo');
  assert.equal(c.file, 'bash');
  assert.ok(c.args[0].endsWith('start.sh'), c.args[0]);
});

test('start-app dispatch: windows uses powershell start-app.ps1', () => {
  const c = startAppCommand('win32', 'C:/repo');
  assert.equal(c.file, 'powershell.exe');
  assert.ok(c.args.at(-1).endsWith('start-app.ps1'), c.args.at(-1));
});

test('start-app dispatch: posix runs the dev stack (not powershell)', () => {
  const c = startAppCommand('linux', '/repo');
  assert.notEqual(c.file, 'powershell.exe');
});

// Regression tests for the code-43 restart safeguard (issue #3121)
// The critical fix (C1a) was to change from splice() with a negative count to
// filter + push, which matches sidecar-supervisor.ts:590-591 exactly.
// These tests verify the fix by driving the streak tracking through realistic scenarios.

import { EventEmitter } from 'node:events';

// Mock helpers
function createMockSpawn(exitSequence) {
  let callCount = 0;

  const mockSpawn = function mockSpawn() {
    if (callCount >= exitSequence.length) {
      // Should not be called more times than provided exit codes
      throw new Error(`mockSpawn called ${callCount + 1} times but only ${exitSequence.length} exit codes provided`);
    }
    const exitCode = exitSequence[callCount];
    callCount++;

    const child = new EventEmitter();
    // Simulate async child process exit
    setImmediate(() => {
      child.emit('exit', exitCode);
    });
    return child;
  };
  mockSpawn.getCallCount = () => callCount;
  return mockSpawn;
}

// Capture process.exit calls and throw so the launcher promise rejects
function setupTestEnvironment(timeSequence = null) {
  let actualExitCode = null;
  let exitCalled = false;
  const originalNow = Date.now;
  const originalExit = process.exit;
  const originalSetTimeout = setTimeout;
  let timeIdx = 0;
  const timeoutCallbacks = [];
  let currentTime = 0;

  const mockNow = () => {
    if (timeSequence && timeIdx < timeSequence.length) {
      currentTime = timeSequence[timeIdx++];
      return currentTime;
    }
    // Default behavior: once array is exhausted, keep returning a fixed incrementing sequence
    // This preserves backward compatibility with tests that don't provide explicit times
    return 1000 + (timeIdx * 1000);
  };

  Date.now = mockNow;
  process.exit = (code) => {
    actualExitCode = code;
    exitCalled = true;
    // Throw so the launcher's promise rejects and await completes
    throw new Error(`process.exit(${code})`);
  };

  // Mock setTimeout to execute immediately (no delay) but track callbacks
  global.setTimeout = (cb, _delay) => {
    timeoutCallbacks.push(cb);
    setImmediate(cb); // Execute asynchronously but without delay
    return Symbol('timeout');
  };

  return {
    cleanup: () => {
      Date.now = originalNow;
      process.exit = originalExit;
      global.setTimeout = originalSetTimeout;
    },
    getExitCode: () => actualExitCode,
    wasExitCalled: () => exitCalled,
  };
}

test('sidecar restart: code-43 does NOT trip on first exit', async () => {
  const env = setupTestEnvironment([1000]); // Fixed time
  try {
    // First spawn exits 43 → triggers restart. Second spawn exits 0 (non-43) → calls process.exit(0).
    // We verify code 43 was not the exit code (i.e., did NOT trip the streak).
    const spawn = createMockSpawn([43, 0]);
    try {
      await launchSidecarWithRestart('linux', '/tmp', spawn);
    } catch {
      // process.exit throws to break out of the launcher logic
    }
    assert.notEqual(env.getExitCode(), 43, 'should not exit with code 43 on first code-43 (no streak trip)');
  } finally {
    env.cleanup();
  }
});

test('sidecar restart: code-43 does NOT trip on second exit', async () => {
  const env = setupTestEnvironment([1000, 1000]); // Same time for both
  try {
    // First spawn exits 43 → restart. Second spawn exits 43 → restart. Third spawn exits 0 → process.exit(0).
    const spawn = createMockSpawn([43, 43, 0]);
    try {
      await launchSidecarWithRestart('linux', '/tmp', spawn);
    } catch {
      // process.exit throws to break out of the launcher logic
    }
    assert.notEqual(env.getExitCode(), 43, 'should not exit with code 43 on second code-43 (streak is 2, not 3)');
  } finally {
    env.cleanup();
  }
});

test('sidecar restart: code-43 DOES trip on third exit (C2 regression)', async () => {
  // Provide extra exit codes in case restart attempts continue
  const env = setupTestEnvironment([1000, 1000, 1000, 1000]);
  try {
    // Provide 4 exit codes: three code-43s that trigger restarts, and a 4th that shouldn't be reached
    const spawn = createMockSpawn([43, 43, 43, 0]);
    try {
      await launchSidecarWithRestart('linux', '/tmp', spawn);
    } catch {
      // process.exit throws to break out of the launcher logic
    }
    assert.equal(
      env.getExitCode(),
      43,
      `should exit with code 43 on third code-43 (streak cap reached), got ${env.getExitCode()}`,
    );
    assert.equal(env.wasExitCalled(), true, 'should have called process.exit(43)');
  } finally {
    env.cleanup();
  }
});

test('sidecar restart: old code-43 exit is pruned when outside window', async () => {
  const WINDOW_MS = 600_000; // 10 minutes
  // Sequence: spawn 0, exit 0 (code 43), spawn 1, exit 1 (code 43), spawn 2, exit 2 (code 43), spawn 3, exit 3 (code 0)
  // We want: exit 0 at t=0, exit 1 at t=WINDOW+1 (outside window from exit 0),
  // exit 2 at t=WINDOW+2 (outside window from exit 0 but inside from exit 1)
  // After pruning exit 0 (outside window), streak is 2 (exits 1 and 2), so should NOT trip.
  const times = [
    0,  // spawn 0
    0,  // exit 0 at t=0
    1,  // spawn 1 at t=1
    WINDOW_MS + 1,  // exit 1 at t=WINDOW+1
    WINDOW_MS + 2,  // spawn 2 at t=WINDOW+2
    WINDOW_MS + 2,  // exit 2 at t=WINDOW+2 (same as spawn, no time gap, simulating immediate exit)
    WINDOW_MS + 3,  // spawn 3 at t=WINDOW+3
  ];
  const env = setupTestEnvironment(times);
  try {
    // Spawn 1 exits 43 → restart. Spawn 2 exits 43 → restart. Spawn 3 exits 43 → restart.
    // Spawn 4 exits 0 → process.exit(0).
    // The first timestamp is pruned, so streak is 2, not 3, so code 43 was not the trip.
    const spawn = createMockSpawn([43, 43, 43, 0]);
    try {
      await launchSidecarWithRestart('linux', '/tmp', spawn);
    } catch {
      // process.exit throws to break out of the launcher logic
    }
    assert.notEqual(env.getExitCode(), 43, 'should not exit with code 43 when old exit is pruned (only 2 recent in streak)');
  } finally {
    env.cleanup();
  }
});

test('sidecar restart: non-43 exit codes propagate immediately without restart', async () => {
  const env = setupTestEnvironment([1000]);
  try {
    const spawn = createMockSpawn([0]); // Exit code 0
    try {
      await launchSidecarWithRestart('linux', '/tmp', spawn);
    } catch {
      // process.exit throws to break out of the launcher logic
    }
    assert.equal(env.getExitCode(), 0, 'should propagate exit code 0 immediately');
    assert.equal(env.wasExitCalled(), true, 'should have called process.exit(0)');
  } finally {
    env.cleanup();
  }
});

// Regression tests for the code-42 generic crash-loop retry (issue #3206).
// Code 42 (CUDA poison) must retry via its OWN counter/cap, separate from the
// code-43 streak above — these mirror that streak's test structure.

test('sidecar restart: code-42 (CUDA poison) retries via the generic crash-loop, not immediate propagation', async () => {
  const env = setupTestEnvironment([1000]);
  try {
    // First spawn exits 42 → triggers a crash-loop retry. Second spawn exits 0 → clean exit.
    const spawn = createMockSpawn([42, 0]);
    try {
      await launchSidecarWithRestart('linux', '/tmp', spawn);
    } catch {
      // process.exit throws to break out of the launcher logic
    }
    assert.equal(env.getExitCode(), 0, 'a single code-42 exit should retry, not propagate 42 immediately');
  } finally {
    env.cleanup();
  }
});

test('sidecar restart: code-42 crash loop gives up after exhausting its cap (mutation probe)', async () => {
  // CRASH_LOOP_MAX_CONSECUTIVE_FAILURES = 5, so the 6th consecutive code-42
  // exit trips the give-up branch. The trailing 0 should never be reached.
  const codes = [42, 42, 42, 42, 42, 42, 0];
  const env = setupTestEnvironment(codes.map(() => 1000));
  try {
    const spawn = createMockSpawn(codes);
    try {
      await launchSidecarWithRestart('linux', '/tmp', spawn);
    } catch {
      // process.exit throws to break out of the launcher logic
    }
    assert.equal(
      env.getExitCode(),
      42,
      `should give up and exit with code 42 after exhausting the crash-loop cap, got ${env.getExitCode()}`,
    );
    assert.equal(env.wasExitCalled(), true, 'should have called process.exit(42) on give-up');
    assert.equal(
      spawn.getCallCount(),
      6,
      'should have actually retried through all 6 spawns (5 retries + the give-up exit) before giving up, not exited on the first 42',
    );
  } finally {
    env.cleanup();
  }
});

test('sidecar restart: code-42 exits do not count toward the code-43 streak cap', async () => {
  // Interleaved 42s and 43s: only two code-43 exits occur, which must not trip
  // the 3-in-window streak cap even though four total crash exits happened.
  const spawn = createMockSpawn([42, 43, 42, 43, 0]);
  const env = setupTestEnvironment([1000, 1000, 1000, 1000, 1000]);
  try {
    try {
      await launchSidecarWithRestart('linux', '/tmp', spawn);
    } catch {
      // process.exit throws to break out of the launcher logic
    }
    assert.equal(
      env.getExitCode(),
      0,
      'interleaved code-42 exits must not contribute to the code-43 streak count',
    );
  } finally {
    env.cleanup();
  }
});

test('sidecar restart: non-42, non-0, non-43 exit codes propagate immediately', async () => {
  // Code 1 (e.g., missing venv) should propagate immediately without retry
  const env = setupTestEnvironment([1000]);
  try {
    const spawn = createMockSpawn([1]); // Exit code 1 (not 42, not 43, not 0)
    try {
      await launchSidecarWithRestart('linux', '/tmp', spawn);
    } catch {
      // process.exit throws to break out of the launcher logic
    }
    assert.equal(env.getExitCode(), 1, 'should propagate exit code 1 immediately without retry');
    assert.equal(spawn.getCallCount(), 1, 'should not have retried a non-42, non-43 exit');
  } finally {
    env.cleanup();
  }
});

test('sidecar restart: code-42 fresh incidents reset the crash-loop counter', async () => {
  // Simulate 6 code-42 exits spread across time (each lived > QUICK_DEATH_MS).
  // QUICK_DEATH_MS = 30000 milliseconds = 30 seconds, so we need lifetimes > 30000 ms.
  // Iteration 0: spawn@0, exit@1 (lifetime=1ms, quick death, failures=1)
  // Iteration 1: spawn@100, exit@61100 (lifetime=61000ms > 30000ms, fresh incident, reset to 0 then 1)
  // Iteration 2: spawn@61200, exit@122200 (lifetime=61000ms, fresh incident, reset to 0 then 1)
  // ... repeat for all 6 iterations. Counter resets on each fresh incident, never exceeds 5.

  const times = [];
  // Build time sequence: spawn at t, exit at t + 61 seconds (61000ms > 30000ms QUICK_DEATH_MS)
  const LIFETIME_MS = 61000; // Longer than QUICK_DEATH_MS (30000)
  times.push(0); // spawn 0
  times.push(1); // exit 0 (lifetime=1ms, NOT a fresh incident)

  for (let i = 1; i < 6; i++) {
    const spawnTime = i * 100000; // 100 seconds apart to space out spawns
    const exitTime = spawnTime + LIFETIME_MS;
    times.push(spawnTime);
    times.push(exitTime);
  }

  // Final spawn and clean exit
  const finalSpawnTime = 6 * 100000;
  times.push(finalSpawnTime);
  times.push(finalSpawnTime + 1);

  const spawn = createMockSpawn([42, 42, 42, 42, 42, 42, 0]); // 6 code-42s followed by clean exit
  const env = setupTestEnvironment(times);
  try {
    try {
      await launchSidecarWithRestart('linux', '/tmp', spawn);
    } catch {
      // process.exit throws to break out of the launcher logic
    }
    assert.equal(
      env.getExitCode(),
      0,
      'six code-42 exits, each with 61-second lifetime (> 30s threshold), should NOT trigger the crash-loop cap; fresh-incident resets prevent it',
    );
  } finally {
    env.cleanup();
  }
});

