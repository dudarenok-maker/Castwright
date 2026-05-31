// Shared test-concurrency knobs. The single env switch `LOW_CONCURRENCY`
// throttles the vitest worker pools so a co-running TTS generation / analyzer
// load on the same box can't starve a test run into "Worker exited
// unexpectedly" crashes or 250s+ environment-setup stalls.
//
// It is set two ways:
//   1. Manually: `LOW_CONCURRENCY=1 npm run verify` when you know the box is busy.
//   2. Automatically: scripts/verify-cache.mjs detects a busy GPU (nvidia-smi)
//      and flips it on for the child test runs.
//
// When unset, pools stay at their tuned defaults (plan 45) — idle-box runs are
// unaffected. The vitest configs inline the same check (they can't import this
// module: tsconfig.node.json typechecks them with allowJs:false), so the
// formulas below are the canonical, unit-tested copy and the configs MUST
// mirror them. See docs/features/156-precommit-scope-contention.md.

export function lowConcurrency(env = process.env) {
  const v = env.LOW_CONCURRENCY;
  return v === '1' || v === 'true';
}

// Frontend pool cap. `undefined` → leave vitest's default in place (plan 45:
// the jsdom suite is CPU-bound and intentionally uncapped). Under low
// concurrency, cap to half the logical cores (min 1) to leave headroom for the
// competing GPU workload.
export function frontendPoolCap(env = process.env, cpus = 4) {
  if (!lowConcurrency(env)) return undefined;
  const n = typeof cpus === 'number' && cpus > 0 ? cpus : 4;
  return Math.max(1, Math.floor(n / 2));
}

// Server forks cap. 2 normally (plan 45), 1 under low concurrency.
export function serverMaxForks(env = process.env) {
  return lowConcurrency(env) ? 1 : 2;
}
