import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  rotationValue, parseNaturalLandscape, buildDartDefines, parseHalfOpenedState, SURFACE_PASSES,
} from '../capture-companion.mjs';

test('rotationValue: natural-portrait device (phone/Nexus 7) — landscape=1, portrait=0', () => {
  assert.equal(rotationValue('landscape', false), 1);
  assert.equal(rotationValue('portrait', false), 0);
  assert.equal(rotationValue('seam', false), 0); // fold half-open captured in natural rotation
  // default (no naturalLandscape arg) preserves the historical phone behaviour
  assert.equal(rotationValue('landscape'), 1);
  assert.equal(rotationValue('portrait'), 0);
});

test('rotationValue: natural-landscape device (Pixel Tablet) — landscape=0, portrait=1', () => {
  // Regression: the Pixel Tablet is natural-landscape, so rotation 1 rotates it
  // INTO portrait (800dp → the app-side `expanded` guard rejects it). Landscape
  // must be rotation 0 on this device.
  assert.equal(rotationValue('landscape', true), 0);
  assert.equal(rotationValue('portrait', true), 1);
  assert.equal(rotationValue('seam', true), 0); // seam is posture-defined, rotation stays natural
});

test('parseNaturalLandscape reads Physical size and compares W vs H', () => {
  assert.equal(parseNaturalLandscape('Physical size: 2560x1600'), true); // Pixel Tablet
  assert.equal(parseNaturalLandscape('Physical size: 800x1280'), false); // Nexus 7
  assert.equal(parseNaturalLandscape('Physical size: 1080 x 2340'), false); // phone, spaced
  assert.equal(parseNaturalLandscape('unexpected output'), false); // safe fallback → portrait
});

test('buildDartDefines threads surface/orient and omits scenes when absent', () => {
  assert.deepEqual(buildDartDefines({ surface: 'tablet7', orient: 'landscape', scenes: ['a', 'b'] }),
    ['--dart-define=surface=tablet7', '--dart-define=orient=landscape', '--dart-define=scenes=a,b']);
  assert.deepEqual(buildDartDefines({ surface: 'phone', orient: 'portrait', scenes: null }),
    ['--dart-define=surface=phone', '--dart-define=orient=portrait']);
});

test('SURFACE_PASSES: tablet has landscape+portrait, fold has seam only', () => {
  assert.equal(SURFACE_PASSES.tablet7.length, 2);
  assert.deepEqual(SURFACE_PASSES.tablet7.map((p) => p.orient), ['landscape', 'portrait']);
  assert.deepEqual(SURFACE_PASSES.fold, [{ orient: 'seam', scenes: ['library-home'] }]);
});

test('parseHalfOpenedState finds the index by name in either field order', () => {
  const out = `Supported states: [
    DeviceState{identifier=0, name='CLOSED'},
    DeviceState{identifier=1, name='HALF_OPENED'},
    DeviceState{identifier=2, name='OPENED'},
  ]`;
  assert.equal(parseHalfOpenedState(out), 1);
  assert.equal(parseHalfOpenedState("name='HALF_OPENED', identifier=3"), 3);
  assert.equal(parseHalfOpenedState('no folds here'), null);
});
