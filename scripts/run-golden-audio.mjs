#!/usr/bin/env node
// Golden-audio regression orchestrator (ops-11). Runs the two-layer harness on
// demand and aggregates exit codes. NOT wired into test:all / verify — invoke
// explicitly with `npm run test:golden-audio` (or the :assembly / :sidecar
// partials).
//
//   Suite B (assembly, GPU-free, Node):  npm --prefix server run test:golden
//   Suite A (model, GPU, Python):        server/tts-sidecar/run-golden-tests.ps1
//                                        (SKIP+exit0 without venv/weights)
//
// Flags (after `--` when run via npm):
//   --assembly-only        run only Suite B
//   --sidecar-only         run only Suite A
//   --bless                bless the SELECTED suites — bless follows suite selection.
//                          Bare --bless records both baselines,
//                          `--assembly-only --bless` records only Suite B's
//                          golden-chapter.baseline.json + .decoded.pcm, and
//                          `--sidecar-only --bless` records Suite A's
//                          kokoro-baseline.json AND instruct-baseline.json
//                          (test_instruct_golden.py honours the same
//                          GOLDEN_BLESS env) — there is no narrowing to bless
//                          ONE of the two without `--engine=` below (#1995).
//                          instruct-baseline.json's `tolerances` block is a
//                          THRESHOLD, not a measurement: a bless that would
//                          move it (e.g. `rtf_max`) is REFUSED unless
//                          GOLDEN_REBLESS_THRESHOLDS=1 is also set, so an
//                          unrelated Kokoro-content bless can't silently
//                          loosen it. The same file's `identity`/
//                          `loudness_dbfs` are guarded too, but by a
//                          SEPARATE flag, GOLDEN_REBLESS_MEASUREMENTS=1 —
//                          NOT the same GOLDEN_REBLESS_THRESHOLDS=1 above
//                          (split by #2060, root-caused to the shared flag
//                          letting a legitimate identity re-bless silently
//                          re-authorise the rtf_max ceiling too). They're
//                          also noise-tolerant, unlike the quantised
//                          `tolerances`: a within-epsilon move (raw
//                          stochastic measurement noise) is ACCEPTED
//                          WITHOUT REWRITING the committed reference — the
//                          existing block is kept as-is, so repeated noise-
//                          sized re-blesses can't walk it — and echoed to
//                          stdout ("[golden-bless] identity moved ..."); a
//                          move large enough to meaningfully re-centre the
//                          window it feeds still needs GOLDEN_REBLESS_
//                          MEASUREMENTS=1, and DOES get written under the
//                          flag — see compare.bless_guard_thresholds,
//                          compare.should_rewrite_reference, and
//                          compare.describe_measurement_move.
//                          To re-capture the Suite B INPUT fixture (not its
//                          baseline), run
//                          server/tts-sidecar/tests/golden/capture_assembly_fixture.py.
//                          NOTE: `npm run test:golden-audio:assembly` bypasses
//                          this runner, so it can never bless — use the full
//                          `npm run test:golden-audio -- --assembly-only --bless`.
//   --engine=<kokoro|coqui|qwen>   narrow Suite A via pytest `-k <engine>`
//                          (e.g. `--engine=kokoro --bless` blesses only
//                          kokoro-baseline.json, leaving instruct-baseline.json
//                          untouched — the #1995 coupling workaround).
//
// Cross-engine sanity (Coqui/Qwen) additionally needs its own opt-in env:
//   GOLDEN_COQUI=1   GOLDEN_QWEN_VOICE=<designed voiceId>

import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve } from 'node:path';
import { maxNvidiaSmiUtil, GPU_BUSY_THRESHOLD } from './verify-cache.mjs';

// Re-exported for backward compatibility: scripts/tests/run-golden-audio.test.mjs
// imports maxNvidiaSmiUtil from this module. The implementation itself moved to
// verify-cache.mjs (#2164) so scripts/verify-cache.mjs's own detectGpuContention
// can use it too — see that file for the real definition and its doc comment.
export { maxNvidiaSmiUtil };

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);

const has = (flag) => args.includes(flag);
const assemblyOnly = has('--assembly-only');
const sidecarOnly = has('--sidecar-only');
const bless = has('--bless');
const engineArg = args.find((a) => a.startsWith('--engine='));
const engine = engineArg ? engineArg.split('=')[1] : null;

if (assemblyOnly && sidecarOnly) {
  console.error('run-golden-audio: --assembly-only and --sidecar-only are mutually exclusive.');
  process.exit(2);
}

// #1995: a ceiling blessed while the GPU is contended (another generation
// running, a code-review agent loading the box, ...) reflects that
// contention, not steady-state performance — the exact way instruct-
// baseline.json's rtf_max was observed jumping 1.0 -> 1.31. This flags (does
// NOT block) a `--bless` attempted under load, reusing the same nvidia-smi
// parser verify-cache.mjs's own `[contention] GPU busy` warning is built on,
// rather than standing up a second contention probe.
//
// #2036 acceptance bullet 2: a single PRE-run sample is deliberately
// sufficient, not periodic sampling during the run. A bless run's dominant
// cost is the model synth itself, which is exactly when an operator would
// notice and abort a badly-contended run by hand; the failure mode this
// warning exists to catch (#1995) was contention already present when the
// bless STARTED, not contention that begins mid-run. Sampling throughout
// would need a background timer/interval this deliberately one-shot script
// doesn't otherwise carry, to catch a narrower case with no reported incident
// behind it — file a follow-up if that changes.
//
// GPU_BUSY_THRESHOLD is imported from verify-cache.mjs (above), not
// redeclared — #2164 review finding 4: two independent `= 40`s meant raising
// one could silently leave the bless-time warning here firing at the old
// value while a comment merely claimed they mirror.

// #2164: maxNvidiaSmiUtil moved to verify-cache.mjs (imported above) so
// scripts/verify-cache.mjs's own GPU-contention probe can share it instead of
// keeping a second copy — see that file for the implementation and comment.

// #2036 review round 2: an absent/unparseable/failed probe used to return
// `null` from `gpuBusyWarningFor` — indistinguishable at the console from "GPU
// checked, idle". On a `--bless` run that permanently re-records thresholds,
// "I could not tell" is materially different information from "it was idle",
// so it gets its own message rather than silently reading as the good case.
export const CONTENTION_UNKNOWN_MESSAGE =
  '[contention] GPU utilization could not be read (nvidia-smi missing, errored, ' +
  'or gave no parseable line) — contention during this bless is unknown, not ruled out.';

// Pure: given raw nvidia-smi stdout, returns the message to print, or null
// when the GPU was successfully read AND is under threshold (the one case
// with nothing to say). Split out from `warnIfGpuBusyForBless` so the
// decision logic is testable without spawning a real `nvidia-smi`.
export function gpuBusyWarningFor(stdout) {
  const util = maxNvidiaSmiUtil(stdout);
  if (util === null) return CONTENTION_UNKNOWN_MESSAGE;
  if (util < GPU_BUSY_THRESHOLD) return null;
  return (
    `[contention] GPU busy (~${util}% util) while blessing — a measurement recorded now ` +
    '(e.g. instruct-baseline.json rtf_max) may reflect contention, not steady-state ' +
    'performance. Consider re-blessing on a quiet box.'
  );
}

function warnIfGpuBusyForBless() {
  if (!bless) return;
  const r = spawnSync(
    'nvidia-smi',
    ['--query-gpu=utilization.gpu', '--format=csv,noheader,nounits'],
    { encoding: 'utf8', timeout: 5000 },
  );
  // A failed spawn (no GPU / nvidia-smi absent / errored) is routed through
  // the same pure function as an empty read, rather than duplicating the
  // "unknown" decision here — one code path, already covered by the tests on
  // `gpuBusyWarningFor` itself.
  const warning = gpuBusyWarningFor(r.error || r.status !== 0 ? '' : r.stdout);
  if (warning) console.log(warning);
}

const results = [];

function run(label, cmd, cmdArgs, { env, shell } = {}) {
  console.log(`\n=== golden-audio: ${label} ===`);
  const r = spawnSync(cmd, cmdArgs, {
    stdio: 'inherit',
    cwd: ROOT,
    env: { ...process.env, ...env },
    // npm is a `.cmd` shim on Windows; Node refuses to spawn `.cmd` directly
    // (EINVAL) unless routed through a shell.
    shell: shell ?? false,
  });
  const code = r.status ?? (r.error ? 1 : 0);
  if (r.error) console.error(`run-golden-audio: failed to spawn ${cmd}: ${r.error.message}`);
  results.push({ label, code });
  return code;
}

// Guard the actual run (spawns real suites / real nvidia-smi) so a test file
// can `import` this module for its pure exports (`maxNvidiaSmiUtil`,
// `gpuBusyWarningFor`) without triggering a full golden-audio run — same
// pattern as verify-cache.mjs's `isDirectInvocation`.
//
// Two-tier, not strict-only (#2036 review round 2). The strict `import.meta.url`
// equality check gets every ordinary invocation shape right, INCLUDING an 8.3
// short path — Node applies the same resolution to both sides in that case.
// What it gets wrong is a symlink or junction ANYWHERE in the invoked path:
// Node resolves symlinks when computing the entry module's own
// `import.meta.url`, but `pathToFileURL(argv[1])` reflects the raw, unresolved
// invocation path, so the two sides disagree for a perfectly ordinary `node
// scripts/run-golden-audio.mjs`. Verified with a real junction:
//   import.meta.url             file:///…/real/probe.mjs
//   pathToFileURL(argv[1]).href file:///…/link/probe.mjs
// This repo junctions aggressively for worktrees, and the strict check alone
// silently exits 0 having run nothing through one — the exact failure mode a
// guard must not have. The fallback mirrors check-onbox-register.mjs's laxer,
// symlink-immune detector (a basename/suffix match rather than URL equality);
// it stays a FALLBACK, not a replacement, because it can't tell an 8.3 short
// path (already handled correctly above) from a genuine non-invocation.
function computeIsDirectInvocation() {
  const arg1 = process.argv[1];
  if (!arg1) return false;
  try {
    if (import.meta.url === pathToFileURL(arg1).href) return true;
  } catch {
    // fall through to the laxer, symlink-immune check below
  }
  return arg1.replace(/\\/g, '/').endsWith('scripts/run-golden-audio.mjs');
}
const isDirectInvocation = computeIsDirectInvocation();

if (isDirectInvocation) {
  // Internal, undocumented test hook (#2036 review round 2, R2) — NOT a
  // documented flag, not in the header's Flags list, and no npm script sets
  // it. The regression test for the guard's symlink/junction fix needs to
  // spawn this script through a REAL junction to genuinely exercise the
  // argv[1]-vs-import.meta.url resolution — a mock or an in-process import
  // can't reproduce that — but must not thereby execute a real golden-audio
  // suite (ffmpeg, real synth, real weights) inside `npm run test:hooks`,
  // which runs in the pre-commit/pre-push/CI hot path. This proves the guard
  // resolved TRUE and exits before either suite is spawned; the only caller
  // is scripts/tests/run-golden-audio.test.mjs.
  if (process.env.RUN_GOLDEN_AUDIO_PROBE_GUARD_ONLY === '1') {
    console.log('golden-audio: direct-invocation guard resolved TRUE (probe-only, no suites run)');
    process.exit(0);
  }

  warnIfGpuBusyForBless();

  if (!sidecarOnly) {
    // Suite B — GPU-free assembly golden (real ffmpeg, recorded PCM fixture).
    run('assembly (Suite B)', 'npm', ['--prefix', 'server', 'run', 'test:golden'], {
      shell: true,
      // Explicit `undefined` (not `{}`) so an ambient GOLDEN_BLESS=1 exported in
      // the shell can't leak through on the non-bless path and silently turn an
      // ordinary assert run into a bless that overwrites committed fixtures —
      // `run()`'s `{ ...process.env, ...env }` spread only clears an inherited
      // key when this object explicitly sets it to `undefined`.
      env: { GOLDEN_BLESS: bless ? '1' : undefined },
    });
  }

  if (!assemblyOnly) {
    // Suite A — real-model golden (SKIP+exit0 without venv/weights).
    const pytestArgs = engine ? ['-k', engine] : [];
    run(
      'sidecar (Suite A)',
      process.execPath,
      ['scripts/run-powershell.mjs', 'server/tts-sidecar/run-golden-tests.ps1', ...pytestArgs],
      // Same ambient-leak guard as the Suite B call above.
      { env: { GOLDEN_BLESS: bless ? '1' : undefined } },
    );
  }

  const failed = results.filter((r) => r.code !== 0);
  console.log('\n=== golden-audio summary ===');
  for (const r of results) console.log(`  ${r.code === 0 ? 'OK  ' : 'FAIL'} ${r.label}`);
  if (failed.length) {
    console.error(`golden-audio: ${failed.length} suite(s) failed.`);
    process.exit(1);
  }
  console.log('golden-audio: all selected suites passed (SKIPs are clean).');
  process.exit(0);
}
