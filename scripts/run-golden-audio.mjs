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
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { parseNvidiaSmiUtil } from './verify-cache.mjs';

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
const GPU_BUSY_THRESHOLD = 40; // % utilization -- mirrors verify-cache.mjs's own threshold

function warnIfGpuBusyForBless() {
  if (!bless) return;
  const r = spawnSync(
    'nvidia-smi',
    ['--query-gpu=utilization.gpu', '--format=csv,noheader,nounits'],
    { encoding: 'utf8', timeout: 5000 },
  );
  if (r.error || r.status !== 0) return; // no GPU / nvidia-smi absent -- nothing to flag
  const util = parseNvidiaSmiUtil(r.stdout);
  if (util !== null && util >= GPU_BUSY_THRESHOLD) {
    console.log(
      `[contention] GPU busy (~${util}% util) while blessing — a measurement recorded now ` +
        '(e.g. instruct-baseline.json rtf_max) may reflect contention, not steady-state ' +
        'performance. Consider re-blessing on a quiet box.',
    );
  }
}

warnIfGpuBusyForBless();

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
