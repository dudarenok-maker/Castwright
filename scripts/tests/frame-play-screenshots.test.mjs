import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SURFACES, dimsForTemplate, DIMS, rawRelPath } from '../lib/play-frames/surfaces.mjs';

const PLAY_MIN = 320, PLAY_MAX = 3840, PLAY_MAX_RATIO = 2;

test('every framed output dimension is Play-valid', () => {
  for (const surface of SURFACES) {
    for (const scene of surface.scenes) {
      const { w, h } = dimsForTemplate(scene.template ?? surface.template);
      const lo = Math.min(w, h), hi = Math.max(w, h);
      assert.ok(lo >= PLAY_MIN && hi <= PLAY_MAX, `${surface.id}/${scene.id} out of px range`);
      assert.ok(hi / lo <= PLAY_MAX_RATIO, `${surface.id}/${scene.id} ratio > 2:1`);
    }
  }
});

test('phone surface config is unchanged (6 scenes, portrait, captioned)', () => {
  const phone = SURFACES.find((s) => s.id === 'phone');
  assert.equal(phone.scenes.length, 6);
  assert.deepEqual(
    phone.scenes.map((s) => s.id),
    ['library-home', 'player', 'book-detail', 'library-offline', 'pairing', 'settings'],
  );
  assert.deepEqual(dimsForTemplate('phone'), DIMS.phone);
});

test('every scene has a non-empty caption', () => {
  for (const surface of SURFACES) {
    for (const scene of surface.scenes) {
      assert.ok(scene.caption && scene.caption.trim().length > 0, `${surface.id}/${scene.id} caption`);
    }
  }
});

test('rawRelPath: phone is flat, and never throws for any surface/scene', () => {
  const phone = SURFACES.find((s) => s.id === 'phone');
  assert.equal(rawRelPath(phone, phone.scenes[0], 'light'), 'library-home.light.png');
  for (const surface of SURFACES) {
    for (const scene of surface.scenes) {
      const p = rawRelPath(surface, scene, 'dark');
      assert.equal(typeof p, 'string');
      assert.ok(p.endsWith('.dark.png'));
    }
  }
});
