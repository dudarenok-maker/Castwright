#!/usr/bin/env node
// Derive per-step CI scope from verify-cache.mjs's STEPS[] — the single
// source of truth for "which files does this step depend on".
//
// Emits ONE json output rather than one output per step. GitHub requires
// every consumed output to be re-declared in the detect job's static
// `outputs:` map (there is no wildcard), so per-step outputs would make that
// map a THIRD artifact in the derivation chain: a key emitted here and
// consumed by an `if:` but missing from that map evaluates to the empty
// string, silently disabling a leg while both wiring directions still pass.
// One json output makes that map a single static line.

import { STEPS, stepTouchedByDiff, computeShared } from './verify-cache.mjs';
import { isDirectlyInvoked } from './lib/is-main-module.mjs';

export function slugFor(stepName) {
  return `step_${stepName.replace(/[:-]/g, '_')}`;
}

// openapi gates the CI-only "OpenAPI types up to date" drift check and has no
// cache step. shared is the root-manifest global override. lockfile_touched
// (#2867, fixing #2853) is a hazard flag, not a leg gate: neither lockfile is
// in either vitest config's forceRerunTriggers, so a lockfile-only diff can
// select ZERO tests via `--changed` in both the server-tests and frontend-tests
// CI jobs even though `stepTouchedByDiff`'s includeLockfiles branch already
// routes it there — consumed by verify.yml to force a full (non-`--changed`)
// run instead of widening `shared`, which was explicitly rejected (#2853) as
// too broad a fix for this narrow hazard. Note: lockfile_touched fires on
// (shared || lockfile-specific-match), so it also triggers on non-lockfile
// shared-scope diffs like .github/actions/**.
const CI_ONLY = {
  openapi: (files) => files.some((f) => f === 'openapi.yaml'),
  shared: (files) => computeShared(files),
  lockfile_touched: (files) =>
    files.some((f) => f === 'package-lock.json' || f === 'server/package-lock.json'),
};

export function computeScopes(files, { eventName } = {}) {
  const keys = [...STEPS.map((s) => slugFor(s.name)), ...Object.keys(CI_ONLY)];

  // A manual dispatch has no PR base to diff against, so `files` is empty —
  // which is NOT an error and therefore does not trip the fail-safe. Run the
  // full battery, matching the behaviour the bash detector had.
  if (eventName === 'workflow_dispatch') {
    return Object.fromEntries(keys.map((k) => [k, true]));
  }

  const shared = computeShared(files);
  const scopes = {};
  for (const step of STEPS) {
    // `shared` is a disjunct on EVERY step: stepTouchedByDiff has a lockfile
    // branch for server/package-lock.json only — a ROOT lockfile diff touches
    // zero steps, so without this a dependency bump would run nothing.
    scopes[slugFor(step.name)] = shared || stepTouchedByDiff(step, files);
  }
  for (const [key, fn] of Object.entries(CI_ONLY)) {
    scopes[key] = key === 'shared' ? shared : shared || fn(files);
  }
  return scopes;
}

export function render(scopes) {
  return `scopes=${JSON.stringify(scopes)}\nok=true\n`;
}

function allTrue() {
  const keys = [...STEPS.map((s) => slugFor(s.name)), ...Object.keys(CI_ONLY)];
  return Object.fromEntries(keys.map((k) => [k, true]));
}

export function main(argv = process.argv.slice(2), env = process.env) {
  let output;
  try {
    const files = (argv.find((a) => a.startsWith('--files='))?.slice('--files='.length) ?? '')
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean);
    output = render(computeScopes(files, { eventName: env.GITHUB_EVENT_NAME }));
  } catch (err) {
    // FAIL SAFE: degrade to "run the whole battery", never to "skip
    // everything". A crash here must not be able to produce a green required
    // check that ran nothing.
    process.stderr.write(`ci-scope: FAILED (${err?.message}) — emitting all-true\n`);
    output = render(allTrue());
  }
  process.stdout.write(output);
  return 0;
}

// See scripts/lib/is-main-module.mjs. Here the consequence of a guard miss
// is worse than silence: the detect job would emit nothing, every `if:`
// would be false, and only the `ok` sentinel (Task 9) would catch it — as a
// confusing red rather than a clear one.
if (isDirectlyInvoked(import.meta.url)) {
  process.exit(main());
}
