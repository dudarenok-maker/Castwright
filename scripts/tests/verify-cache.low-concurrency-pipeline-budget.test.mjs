// Behavioural runPipeline pipeline-budget-under-LOW_CONCURRENCY test
// (Castwright#3361). Its own file: it spends ~25 s on a real hanging step.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  runHangingStepSpanMs,
} from './verify-cache-test-support.mjs';


test('runPipeline: the pipeline budget is not widened under LOW_CONCURRENCY (Castwright#3361, behavioural)', async () => {
  // Pipeline deadline is the binding constraint in both runs: the step's own
  // budget (10 min, x2 under throttle) dwarfs the run floor, so the step is
  // clamped to the deadline and its live span is the pipeline budget itself.
  // Correct code: throttled - control ~ 0 (startup jitter only). A 2x widening
  // of the pipeline budget: ~ +FLOOR_MS.
  const FLOOR_MS = 10000;
  const env = {
    CASTWRIGHT_RUN_TIMEOUT_MIN: String(FLOOR_MS / 60000),
    CASTWRIGHT_STEP_TIMEOUT_MIN: '10',
  };
  const throttled = await runHangingStepSpanMs({ ...env, LOW_CONCURRENCY: '1' });
  const control = await runHangingStepSpanMs(env);
  const throttledMs = throttled.spanMs;
  const controlMs = control.spanMs;
  const gaps = `(max heartbeat gap: throttled ${throttled.maxGapMs}ms, control ${control.maxGapMs}ms)`;
  // The control ceiling stops a never-clamped control from passing vacuously.
  assert.ok(
    controlMs < 2 * FLOOR_MS,
    `control run must be clamped near the flat ${FLOOR_MS}ms floor, was alive ${controlMs}ms ${gaps}`,
  );
  assert.ok(
    Math.abs(throttledMs - controlMs) <= FLOOR_MS / 2,
    `pipeline budget must not widen under throttle: throttled alive ${throttledMs}ms vs control ${controlMs}ms ${gaps}`,
  );
});

