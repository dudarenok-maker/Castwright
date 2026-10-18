// Behavioural runPipeline per-step-budget-widened-under-LOW_CONCURRENCY test
// (Castwright#3361). Its own file: it spends ~35 s on two real hanging steps.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  runHangingStepSpanMs,
} from './verify-cache-test-support.mjs';


test('runPipeline: the per-step budget IS widened under LOW_CONCURRENCY for a vitest-backed step (Castwright#3361, behavioural)', async () => {
  // Mirror image: the run budget is huge, the step floor small, so the step's
  // own budget binds. Correct code: throttled ~ 2x control (diff ~ +FLOOR_MS).
  // stepContentionMultiplier forced to 1: diff ~ 0.
  const FLOOR_MS = 10000;
  const env = {
    CASTWRIGHT_RUN_TIMEOUT_MIN: '10',
    CASTWRIGHT_STEP_TIMEOUT_MIN: String(FLOOR_MS / 60000),
  };
  const throttled = await runHangingStepSpanMs({ ...env, LOW_CONCURRENCY: '1' });
  const control = await runHangingStepSpanMs(env);
  const throttledMs = throttled.spanMs;
  const controlMs = control.spanMs;
  const gaps = `(max heartbeat gap: throttled ${throttled.maxGapMs}ms, control ${control.maxGapMs}ms)`;
  assert.ok(
    controlMs < 2 * FLOOR_MS,
    `control run must be bounded by the ${FLOOR_MS}ms step floor, was alive ${controlMs}ms ${gaps}`,
  );
  assert.ok(
    throttledMs - controlMs >= FLOOR_MS / 2,
    `step budget must widen under throttle: throttled alive ${throttledMs}ms vs control ${controlMs}ms ${gaps}`,
  );
});

