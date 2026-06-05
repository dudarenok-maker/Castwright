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
//   --bless                record the Kokoro baseline (GOLDEN_BLESS=1) instead
//                          of asserting (Suite A only). To re-capture the Suite B
//                          recorded-PCM fixture, run
//                          server/tts-sidecar/tests/golden/capture_assembly_fixture.py.
//   --engine=<kokoro|coqui|qwen>   narrow Suite A via pytest `-k <engine>`
//
// Cross-engine sanity (Coqui/Qwen) additionally needs its own opt-in env:
//   GOLDEN_COQUI=1   GOLDEN_QWEN_VOICE=<designed voiceId>

import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

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
  run('assembly (Suite B)', 'npm', ['--prefix', 'server', 'run', 'test:golden'], { shell: true });
}

if (!assemblyOnly) {
  // Suite A — real-model golden (SKIP+exit0 without venv/weights).
  const pytestArgs = engine ? ['-k', engine] : [];
  run(
    'sidecar (Suite A)',
    process.execPath,
    ['scripts/run-powershell.mjs', 'server/tts-sidecar/run-golden-tests.ps1', ...pytestArgs],
    { env: bless ? { GOLDEN_BLESS: '1' } : {} },
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
