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
function floorMajor(range) {
  const m = /^>=?\s*(\d+)\./.exec(range);
  if (!m) throw new Error(`unrecognised engines.node range: "${range}"`);
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

test('update.js pins Node before its first node/npm step', () => {
  const pin = findCondaNodePinStep(update.run);
  const firstUse = findFirstNodeOrNpmStep(update.run);
  assert.ok(pin, 'expected update.js to pin Node at all');
  assert.ok(firstUse !== -1, 'expected update.js to have at least one node/npm step');
  assert.ok(
    pin.index < firstUse,
    `conda-install-Node step (index ${pin.index}) must come before the first node/npm step (index ${firstUse}) — ` +
      'a step that runs before the pin still runs on whatever Node was already on PATH',
  );
});

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
