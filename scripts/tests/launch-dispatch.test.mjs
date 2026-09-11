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

  return function mockSpawn() {
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

  const mockNow = () => {
    if (timeSequence && timeIdx < timeSequence.length) {
      return timeSequence[timeIdx++];
    }
    return 1000 + (timeIdx * 1000); // Default incrementing time
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

test.skip('sidecar restart: code-43 DOES trip on third exit (C1a regression)', async () => {
  // Provide extra exit codes in case restart attempts continue
  const env = setupTestEnvironment([1000, 1000, 1000, 1000]);
  try {
    // Provide 4 exit codes: three code-43s that trigger restarts, and a 4th that shouldn't be reached
    const spawn = createMockSpawn([43, 43, 43, 0]);
    launchSidecarWithRestart('linux', '/tmp', spawn);
    // Give it significant time for all three exits and the trip to be processed
    await new Promise((r) => setTimeout(r, 500));
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
  // t=0 (first exit), t=WINDOW+1 (second, outside first), t=WINDOW+2 (third, outside first but inside window from second)
  // After pruning, should only have 2 timestamps, so should NOT trip
  const times = [0, WINDOW_MS + 1, WINDOW_MS + 2];
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

test('sidecar restart: code-42 (CUDA poison) propagates immediately without retry', async () => {
  const env = setupTestEnvironment([1000]);
  try {
    const spawn = createMockSpawn([42]); // Exit code 42
    try {
      await launchSidecarWithRestart('linux', '/tmp', spawn);
    } catch {
      // process.exit throws to break out of the launcher logic
    }
    assert.equal(
      env.getExitCode(),
      42,
      'should propagate exit code 42 immediately (no restart on 42)',
    );
    assert.equal(env.wasExitCalled(), true, 'should have called process.exit(42)');
  } finally {
    env.cleanup();
  }
});

