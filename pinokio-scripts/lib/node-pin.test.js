// Regression coverage for the Pinokio Node pin (chore/scripts-pinokio-node-pin).
// install.js conda-installs a pinned `nodejs` major so every later node/npm step
// runs on a known Node instead of whatever Pinokio's own bundled kernel happens
// to ship; update.js re-asserts the same pin so an install that predates this
// change picks it up on its next Update instead of staying on the bundled Node
// forever. See install.js's step-1 comment for the full rationale.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const install = require('../install.js');
const update = require('../update.js');
const pkg = require('../../package.json');
const { engines } = pkg;

// Parse the conda-forge Node spec out of a shell.run step's message, if present.
// The accepted form is `"nodejs>=A.B.C,<M"` (a floor plus a next-major ceiling).
// A bare major (`nodejs=24`) is REFUSED with a throw: conda resolves it to any 24.x
// build, affected ones included, and that is the exact regression #4443 closes.
function condaNodeSpec(message) {
  if (/\bnodejs=\d+/.test(message)) {
    throw new Error(
      `bare-major conda Node pin in "${message}" — it admits releases carrying the Windows loopback crash (#4443); ` +
        'use "nodejs>=A.B.C,<M"',
    );
  }
  const m = /"?\bnodejs>=(\d+\.\d+\.\d+),<(\d+)"?/.exec(message);
  if (!m) return null;
  return { spec: m[0].replace(/\u0022/g, ''), lower: m[1], major: Number(m[1].split('.')[0]), upperMajor: Number(m[2]) };
}
function condaNodePinMajor(message) {
  const spec = condaNodeSpec(message);
  return spec ? spec.major : null;
}

// Compare dotted versions numerically: negative, zero or positive.
function cmp(a, b) {
  const x = a.split('.').map(Number);
  const y = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i];
  return 0;
}
// The last version inside a [from, toExclusive) range: one patch below `v`. When the
// patch is already 0 the true predecessor is unknowable here, so step to a patch high
// enough (999) in the previous minor/major to stand in for it.
function patchBefore(v) {
  const [a, b, c] = v.split('.').map(Number);
  if (c > 0) return `${a}.${b}.${c - 1}`;
  if (b > 0) return `${a}.${b - 1}.999`;
  return `${a - 1}.999.999`;
}

// The first run step (if any) that conda-installs a pinned Node.
function findCondaNodePinStep(run) {
  const index = run.findIndex((step) => condaNodePinMajor(step.params.message) !== null);
  return index === -1 ? null : { index, major: condaNodePinMajor(run[index].params.message) };
}

// Index of the first run step that actually invokes `node` or `npm` (as opposed
// to a step that merely mentions "nodejs" while installing it — `\bnode\b` does
// not match inside "nodejs").
function findFirstNodeOrNpmStep(run) {
  return run.findIndex((step) => /\b(node|npm)\b/.test(step.params.message));
}

// Pull the floor version out of an `engines.node` range like ">=24.16.0" — a plain
// single ">=" floor, not a general semver-range parser (the owner dropped Node 22,
// so no union is needed; see #4493's amendment).
//
// It deliberately REFUSES anything more complex rather than reading the floor
// and ignoring the rest: on ">=24.16.0 <25" a floor-only read returns 24, the
// pin clears it, and the test passes green while the declared ceiling might
// EXCLUDE the pinned major. A guard that quietly stops guarding is worse than
// none, so an unparseable range is a loud failure telling the reader to check
// the pin by hand.
function floorVersion(range) {
  const m = /^>=\s*(\d+\.\d+\.\d+)$/.exec(range);
  if (!m) {
    throw new Error(
      `engines.node "${range}" is not a plain ">=A.B.C" floor (an upper bound, union or partial version?) — ` +
        'verify the conda `nodejs` pin in install.js/update.js against it by hand, then teach floorVersion() the new form',
    );
  }
  return m[1];
}
function floorMajor(range) {
  return Number(floorVersion(range).split('.')[0]);
}

test('install.js pins a Node major via conda install', () => {
  const pin = findCondaNodePinStep(install.run);
  assert.ok(pin, 'expected a `conda install … nodejs=<major>` step in install.js');
});

test('update.js pins a Node major via conda install', () => {
  const pin = findCondaNodePinStep(update.run);
  assert.ok(pin, 'expected a `conda install … nodejs=<major>` step in update.js');
});

// Both launchers carry the same ordering constraint, and it is declared as a
// durable invariant in docs/features/218-pinokio-installer.md (invariant 2).
// Asserting it for update.js alone let a reorder of install.js's run[] — which
// reintroduces the whole bug on every FRESH install — ship with all tests green.
for (const [name, script] of [
  ['install.js', install],
  ['update.js', update],
]) {
  test(`${name} pins Node before its first node/npm step`, () => {
    const pin = findCondaNodePinStep(script.run);
    const firstUse = findFirstNodeOrNpmStep(script.run);
    assert.ok(pin, `expected ${name} to pin Node at all`);
    assert.ok(firstUse !== -1, `expected ${name} to have at least one node/npm step`);
    assert.ok(
      pin.index < firstUse,
      `${name}: conda-install-Node step (index ${pin.index}) must come before the first node/npm step (index ${firstUse}) — ` +
        'a step that runs before the pin still runs on whatever Node was already on PATH',
    );
  });
}

test('install.js and update.js pin the same Node major', () => {
  const installPin = findCondaNodePinStep(install.run);
  const updatePin = findCondaNodePinStep(update.run);
  assert.equal(updatePin.major, installPin.major, 'install.js and update.js drifted onto different Node majors');
});

function pinSpec(script) {
  const step = script.run.find((st) => condaNodeSpec(st.params.message));
  return condaNodeSpec(step.params.message);
}
const installSpec = () => pinSpec(install);
const ranges = () => pkg.castwright.node.windowsLoopbackCrash;

test('the pinned Node major satisfies package.json engines.node (drift guard)', () => {
  const pin = findCondaNodePinStep(install.run);
  const floor = floorMajor(engines.node);
  assert.ok(
    pin.major >= floor,
    `pinned Node major ${pin.major} no longer satisfies engines.node "${engines.node}" (floor major ${floor}) — ` +
      'bump the conda `nodejs` pin in install.js/update.js alongside any future engines.node floor raise',
  );
});

test('the refusal of a bare-major pin is loud', () => {
  assert.throws(() => condaNodeSpec('conda install -y -c conda-forge nodejs=24'), /bare-major/);
  assert.throws(() => floorVersion('>=22.22.0 <23 || >=24.16.0'), /not a plain/);
});

test('(a) the pin excludes every crashing range: each is below its lower bound or at/above its ceiling', () => {
  const { lower, upperMajor } = installSpec();
  const upper = `${upperMajor}.0.0`;
  for (const r of ranges()) {
    const below = cmp(r.toExclusive, lower) <= 0;
    const above = cmp(r.from, upper) >= 0;
    assert.ok(below || above, `pin >=${lower},<${upperMajor} admits part of crashing range ${r.from}→${r.toExclusive}`);
  }
});

test('(b) no version in a crashing range that sits below the engines floor satisfies engines.node', () => {
  const floor = floorVersion(engines.node);
  const below = ranges().filter((r) => cmp(r.from, floor) < 0);
  assert.ok(below.length > 0, 'expected at least one crashing range below the engines floor');
  for (const r of below) {
    for (const v of [r.from, patchBefore(r.toExclusive)]) {
      assert.ok(cmp(v, floor) < 0, `${v} (in crashing range ${r.from}→${r.toExclusive}) satisfies engines.node "${engines.node}"`);
    }
  }
});

test('accepted gap: the 25.0.0→26.1.0 range DOES satisfy engines.node (owner-accepted, #4493 amendment)', () => {
  // The owner's 2026-11-20 amendment fixed engines.node as a plain ">=24.16.0" floor and
  // explicitly accepted that it admits Node 25.0–25.9 and 26.0.0. On Windows the server
  // startup guard (#4492) still refuses them. If engines is ever tightened, update this test.
  const floor = floorVersion(engines.node);
  const gap = ranges().find((r) => r.from === '25.0.0');
  assert.ok(gap, 'expected the 25.0.0 range in castwright.node.windowsLoopbackCrash');
  assert.ok(cmp(gap.from, floor) >= 0 && cmp(patchBefore(gap.toExclusive), floor) >= 0);
});

test('(c) the pinned lower bound equals the engines.node floor (drift check)', () => {
  assert.equal(installSpec().lower, floorVersion(engines.node), 'conda pin lower bound drifted from engines.node floor');
});

test('(d) install.js and update.js carry the same Node spec', () => {
  assert.equal(pinSpec(update).spec, pinSpec(install).spec, 'install.js and update.js pin different Node specs');
});
