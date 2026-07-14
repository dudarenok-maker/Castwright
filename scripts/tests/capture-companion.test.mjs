import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  rotationValue, buildDartDefines, parseHalfOpenedState, SURFACE_PASSES,
} from '../capture-companion.mjs';

test('rotationValue: landscape=1, portrait=0', () => {
  assert.equal(rotationValue('landscape'), 1);
  assert.equal(rotationValue('portrait'), 0);
  assert.equal(rotationValue('seam'), 0); // fold half-open captured in natural rotation
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
