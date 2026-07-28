// ops-35 (#1877) — regression coverage for the Pinokio ffmpeg constraint.
//
// The Pinokio conda env installed `ffmpeg` UNPINNED, so an install picked up
// whatever conda-forge shipped that day. #1876 declined to pin it because no
// validated floor existed to pin to; now one does (package.json
// castwright.ffmpeg.minimum), so install.js constrains ffmpeg to it and
// update.js re-asserts the constraint — otherwise an env created before this
// change would never have it applied.
//
// A `>=` constraint, not an equality pin: it excludes versions below the
// support floor while leaving security updates free to flow, which is exactly
// what #1876 wanted and could not express.
//
// Structured after node-pin.test.js: require the launchers as modules and
// inspect run[], rather than regexing the source text.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const install = require('../install.js');
const update = require('../update.js');
const pkg = require('../../package.json');

// Extract the conda-forge `ffmpeg>=<major>` constraint from a shell.run step's
// message, if present. Tolerates the surrounding quotes conda needs for `>=`.
function condaFfmpegMajor(message) {
  const m = /\bffmpeg\s*>=\s*(\d+)/.exec(message);
  return m ? Number(m[1]) : null;
}

function findCondaFfmpegStep(run) {
  const index = run.findIndex((step) => condaFfmpegMajor(step.params.message) !== null);
  return index === -1 ? null : { index, major: condaFfmpegMajor(run[index].params.message) };
}

// The declared floor's major. Read from package.json rather than hardcoded so
// this guard cannot pass while the launchers and the floor have drifted apart
// — #1876's acceptance required the pin be PARSED from the source of truth,
// not restated as a second literal.
function declaredFloorMajor() {
  const min = pkg.castwright && pkg.castwright.ffmpeg && pkg.castwright.ffmpeg.minimum;
  if (min === null) return null; // floor deliberately disabled
  if (typeof min !== 'string' || !/^\d+\.\d+$/.test(min)) {
    throw new Error(
      `unrecognised castwright.ffmpeg.minimum: ${JSON.stringify(min)} — expected "MAJOR.MINOR" or null`,
    );
  }
  return Number(min.split('.')[0]);
}

for (const [name, script] of [
  ['install.js', install],
  ['update.js', update],
]) {
  test(`${name} constrains ffmpeg via conda install`, () => {
    const pin = findCondaFfmpegStep(script.run);
    assert.ok(
      pin,
      `expected a \`conda install … "ffmpeg>=<major>"\` step in ${name}. ` +
        'update.js needs it as much as install.js: without it, an env created before ' +
        'this change never has the constraint applied.',
    );
  });
}

test('install.js and update.js constrain ffmpeg to the same major', () => {
  const installPin = findCondaFfmpegStep(install.run);
  const updatePin = findCondaFfmpegStep(update.run);
  assert.ok(installPin && updatePin, 'both launchers must carry the ffmpeg constraint');
  assert.equal(
    updatePin.major,
    installPin.major,
    'install.js and update.js drifted onto different ffmpeg majors',
  );
});

test('the ffmpeg constraint satisfies package.json castwright.ffmpeg.minimum (drift guard)', () => {
  const floor = declaredFloorMajor();
  if (floor === null) return; // check disabled; nothing to assert
  const pin = findCondaFfmpegStep(install.run);
  assert.ok(pin, 'expected install.js to constrain ffmpeg at all');
  assert.ok(
    pin.major >= floor,
    `conda ffmpeg constraint ">=${pin.major}" no longer satisfies the declared floor ` +
      `"${pkg.castwright.ffmpeg.minimum}" (major ${floor}) — bump the constraint in ` +
      'install.js AND update.js alongside any future floor raise',
  );
});
