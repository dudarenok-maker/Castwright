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
const { engines } = require('../../package.json');

// Extract the conda-forge `nodejs=<major>` pin from a shell.run step's message,
// if present.
function condaNodePinMajor(message) {
  const m = /\bnodejs=(\d+)\b/.exec(message);
  return m ? Number(m[1]) : null;
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

// Pull the leading major version out of an `engines.node` range like
// ">=22.22.0" — good enough for the single ">=" floor this repo writes, not a
// general semver-range parser.
//
// It deliberately REFUSES anything more complex rather than reading the floor
// and ignoring the rest: on ">=22.22.0 <24.0.0" a floor-only read returns 22,
// the pin (24) clears it, and the test passes green while the declared ceiling
// actually EXCLUDES the pinned major. A guard that quietly stops guarding is
// worse than no guard, so an unparseable range is a loud failure telling the
// reader to check the pin by hand.
function floorMajor(range) {
  const m = /^>=?\s*(\d+)\./.exec(range);
  if (!m) throw new Error(`unrecognised engines.node range: "${range}"`);
  const rest = range.slice(m[0].length);
  if (/[<|]/.test(rest)) {
    throw new Error(
      `engines.node "${range}" carries an upper bound or union this floor-only guard cannot reason about — ` +
        'verify the conda `nodejs=` pin in install.js/update.js against it by hand, then teach floorMajor() the new form',
    );
  }
  return Number(m[1]);
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

test('the pinned Node major satisfies package.json engines.node (drift guard)', () => {
  const pin = findCondaNodePinStep(install.run);
  const floor = floorMajor(engines.node);
  assert.ok(
    pin.major >= floor,
    `pinned Node major ${pin.major} no longer satisfies engines.node "${engines.node}" (floor major ${floor}) — ` +
      'bump the conda `nodejs=` pin in install.js/update.js alongside any future engines.node floor raise',
  );
});
