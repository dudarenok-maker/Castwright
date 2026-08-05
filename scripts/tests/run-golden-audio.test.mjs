// Runs under `npm run test:hooks` (node --test over scripts/tests/*.test.mjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, symlinkSync, rmdirSync, unlinkSync, mkdtempSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import {
  maxNvidiaSmiUtil,
  gpuBusyWarningFor,
  CONTENTION_UNKNOWN_MESSAGE,
} from '../run-golden-audio.mjs';

// Resolve relative to THIS file, not the process cwd — `node --test` can be
// invoked from a different working directory than the repo root (e.g. a
// worktree helper, or an editor's test runner), and a bare relative path
// would then silently read the wrong file or throw ENOENT.
const HERE = dirname(fileURLToPath(import.meta.url));
const SRC_PATH = join(HERE, '..', 'run-golden-audio.mjs');
const REPO_ROOT = join(HERE, '..', '..');
const src = readFileSync(SRC_PATH, 'utf8');

// The exact non-leaking shape both Suite calls must use: `undefined` (not
// `{}`) on the non-bless arm, so `run()`'s `{ ...process.env, ...env }`
// spread actually clears an ambient GOLDEN_BLESS instead of leaving it to
// leak through. Anchored on the `'1'` / `undefined` ORDER, so an inverted
// ternary (`bless ? undefined : '1'`) fails this regex — it would silently
// bless on every non-bless run and assert on every bless run.
const BLESS_ENV_SHAPE = /GOLDEN_BLESS:\s*bless\s*\?\s*'1'\s*:\s*undefined/;

// #2036 review round 2, finding R2: a previous version of this test sliced
// the source text from `run('assembly (Suite B)'` to the next `\n  }`,
// anchoring on the wrapper's exact nesting depth (two spaces). De-indenting
// that closing brace by even one level — which the #2036 `isDirectInvocation`
// wrapper did in passing — let the slice run past Suite B's call entirely and
// swallow Suite A's env object too, so a mutated Suite B call (env: {} —
// reintroducing the exact ambient-bless leak this test exists to prevent)
// still matched somewhere inside the widened slice and stayed green. Counting
// occurrences instead of slicing is depth-independent: it can't be widened by
// a reindent, because there is no window to widen.
test('GOLDEN_BLESS is cleared (not left ambient) on the non-bless path for BOTH suites', () => {
  const occurrences = [...src.matchAll(/GOLDEN_BLESS:[^\n,}]*/g)].map((m) => m[0]);
  assert.equal(
    occurrences.length,
    2,
    `expected exactly 2 "GOLDEN_BLESS:" occurrences (Suite A's run() + Suite B's), ` +
      `found ${occurrences.length}: ${JSON.stringify(occurrences)} — a suite's env object ` +
      'was removed, duplicated, or no longer sets GOLDEN_BLESS at all',
  );
  for (const occurrence of occurrences) {
    assert.match(
      occurrence,
      BLESS_ENV_SHAPE,
      `"${occurrence}" must set GOLDEN_BLESS to exactly \`1\` when blessing and ` +
        '`undefined` (which clears an ambient value) otherwise — an inverted ternary, ' +
        'or a bare `env: {}`, must fail this test',
    );
  }
});

test('the header documents that --bless follows suite selection', () => {
  assert.match(src, /--bless[\s\S]{0,400}suite selection/i);
});

// #2036: the GPU-contention warning used to read only the FIRST GPU line
// (`parseNvidiaSmiUtil`), which on a dual-GPU box misses a busy SECOND card —
// the exact scenario it exists to catch. `maxNvidiaSmiUtil` / `gpuBusyWarningFor`
// take a local max() over every parsed line instead.

test('maxNvidiaSmiUtil takes the max across a two-GPU output, not just the first line', () => {
  // cuda:0 (4070) idle at 3%, cuda:1 (5070 Ti) busy at 97% — the second line
  // is the busy one, mirroring this dev box's real dual-GPU shape.
  assert.equal(maxNvidiaSmiUtil('3\n97\n'), 97);
  // Order shouldn't matter.
  assert.equal(maxNvidiaSmiUtil('97\n3\n'), 97);
});

test('maxNvidiaSmiUtil returns null on empty / unparseable output', () => {
  assert.equal(maxNvidiaSmiUtil(''), null);
  assert.equal(maxNvidiaSmiUtil('\n'), null);
  assert.equal(maxNvidiaSmiUtil('N/A\nN/A\n'), null);
});

test('maxNvidiaSmiUtil ignores unparseable lines but keeps the max of the rest', () => {
  assert.equal(maxNvidiaSmiUtil('N/A\n85\n'), 85);
});

test('gpuBusyWarningFor fires when the SECOND GPU (not the first) is over threshold', () => {
  // cuda:0 idle (3%), cuda:1 busy (97%) — a first-line-only read (the pre-#2036
  // behaviour) would see 3% and stay silent, missing exactly this case.
  const warning = gpuBusyWarningFor('3\n97\n');
  assert.notEqual(warning, null);
  assert.match(warning, /\[contention\] GPU busy \(~97% util\)/);
});

test('gpuBusyWarningFor stays silent when every GPU is under threshold', () => {
  assert.equal(gpuBusyWarningFor('3\n12\n'), null);
});

// #2036 review round 2, finding R4: an absent/unparseable probe used to
// return `null` here — indistinguishable at the console from "checked, GPU
// idle". On a `--bless` run that permanently re-records thresholds, "I could
// not tell" is materially different information from "it was idle", so it
// now gets its own message instead of silently reading as the good case.
test('gpuBusyWarningFor reports CONTENTION_UNKNOWN, not silence, on empty/unparseable nvidia-smi output', () => {
  assert.equal(gpuBusyWarningFor(''), CONTENTION_UNKNOWN_MESSAGE);
  assert.equal(gpuBusyWarningFor('N/A\n'), CONTENTION_UNKNOWN_MESSAGE);
});

// #2036 review round 2, finding R1: `isDirectInvocation`'s strict
// `import.meta.url` equality check silently evaluates false — and the whole
// script silently exits 0 having run nothing — whenever the invoked path
// crosses a symlink or junction. Node resolves symlinks when computing the
// entry module's own `import.meta.url`, but `pathToFileURL(argv[1])` reflects
// the raw, unresolved invocation path, so the two sides disagree even for a
// perfectly ordinary `node scripts/run-golden-audio.mjs`. Verified directly:
//   import.meta.url             file:///…/real/probe.mjs
//   pathToFileURL(argv[1]).href file:///…/link/probe.mjs
// This repo junctions aggressively for worktrees, and POSIX's `/tmp` is
// itself commonly a symlink (macOS: `/tmp` -> `/private/tmp`), so this is not
// a hypothetical shape. Reproduces it for real: a link stands in for a
// worktree root, and the script is invoked THROUGH it via a real subprocess
// (an in-process import can't reproduce an argv[1]-vs-import.meta.url
// mismatch — argv[1] would just be the test runner's own path). That real
// subprocess is what proves the guard, not the pure exports.
//
// #2036 review round 2, finding R2: an earlier version of this test invoked
// `--assembly-only` for real, reaching the real Suite B — real ffmpeg, real
// `synthesiseChapter`, real two-pass loudnorm — inside `npm run test:hooks`,
// which runs in pre-commit, pre-push, `test:all` AND `verify.yml`'s
// `lint-and-checks` job (which does not install ffmpeg). So this test spawns
// with `RUN_GOLDEN_AUDIO_PROBE_GUARD_ONLY=1`, an internal, undocumented test
// hook (see its call site in run-golden-audio.mjs) that proves the guard
// resolved TRUE and exits before either suite is spawned — no ffmpeg, no
// weights, no venv needed, and it still goes red if the guard reverts to
// strict-only (mutation-verified: reverting `computeIsDirectInvocation` to
// the strict-only check left the probe line unprinted and this test red).
test('a junction/symlink earlier in the invoked path does not silently no-op the guard', (t) => {
  const tmpRoot = mkdtempSync(join(tmpdir(), 'rga-junction-'));
  const linkPath = join(tmpRoot, 'repo-link');
  let linkCreated = false;
  try {
    try {
      // 'junction' is honoured on Windows; POSIX ignores the type argument
      // and creates an ordinary symlink to the directory — both reproduce
      // the same import.meta.url-vs-argv[1] mismatch, so no OS branch is
      // needed for creation. #2036 review round 2, finding R4: a restricted
      // container, a hardened Windows policy, or a filesystem without
      // reparse-point support can make this throw (EPERM and friends) — skip
      // rather than fail the whole suite over an environment that can't
      // exercise this scenario at all.
      symlinkSync(REPO_ROOT, linkPath, 'junction');
      linkCreated = true;
    } catch (err) {
      t.skip(`cannot create a symlink/junction in this environment: ${err.message}`);
      return;
    }

    const target = join(linkPath, 'scripts', 'run-golden-audio.mjs');
    const r = spawnSync(process.execPath, [target, '--assembly-only'], {
      encoding: 'utf8',
      timeout: 30000,
      env: { ...process.env, CUDA_VISIBLE_DEVICES: '', RUN_GOLDEN_AUDIO_PROBE_GUARD_ONLY: '1' },
    });
    assert.equal(
      r.status,
      0,
      `expected a clean exit through the junction; got status=${r.status}, ` +
        `error=${r.error}, stderr=${r.stderr}`,
    );
    assert.match(
      r.stdout,
      /direct-invocation guard resolved TRUE/,
      'the guard must have resolved TRUE through the junction — empty/silent stdout ' +
        `means it silently no-op'd. stdout was: ${JSON.stringify(r.stdout)}`,
    );
    // The probe hook exits before either suite's own `run()` call, so its
    // "=== golden-audio: …" label must never appear — if it does, the probe
    // didn't actually pre-empt a real suite spawn, and this test would no
    // longer be proving what its own name claims.
    assert.doesNotMatch(r.stdout, /=== golden-audio:/);
  } finally {
    // Remove the link FIRST, and only proceed to the recursive delete once
    // that succeeded — never a recursive delete while the link might still
    // be present, which would follow it straight into the real repo this
    // test points at (the exact worktree-teardown hazard CLAUDE.md warns
    // about). #2036 review round 2, finding R3: `rmdirSync` removes just the
    // reparse point on Windows (a junction OR a symlink-to-directory), but
    // throws ENOTDIR for an ordinary symlink on POSIX — `unlinkSync` is the
    // POSIX-correct non-recursive removal for a symlink there.
    let junctionRemoved = !linkCreated;
    if (linkCreated) {
      try {
        if (process.platform === 'win32') rmdirSync(linkPath);
        else unlinkSync(linkPath);
        junctionRemoved = true;
      } catch (cleanupErr) {
        console.error(
          'run-golden-audio test: failed to remove the junction at',
          linkPath,
          '— leaving the temp dir in place rather than risk a recursive delete ' +
            'through a still-live link:',
          cleanupErr,
        );
      }
    }
    if (junctionRemoved) rmSync(tmpRoot, { recursive: true, force: true });
  }
});
