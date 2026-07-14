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

test('tablet + fold surfaces present with expected scene sets', () => {
  const byId = Object.fromEntries(SURFACES.map((s) => [s.id, s]));
  for (const id of ['tablet7', 'tablet10', 'fold']) {
    assert.ok(byId[id], `missing surface ${id}`);
  }
  const two = ['library-home', 'player', 'book-detail', 'library-offline'];
  for (const id of ['tablet7', 'tablet10']) {
    const scenes = byId[id].scenes;
    for (const s of scenes.filter((x) => two.includes(x.id))) assert.equal(s.orientation, 'landscape');
    for (const s of scenes.filter((x) => ['settings', 'pairing'].includes(x.id))) assert.equal(s.orientation, 'portrait');
  }
  // Fold: 4 unfolded (reuse tablet10 raws) + 1 half-open seam (own raw).
  const seam = byId.fold.scenes.find((s) => s.id === 'library-home-seam');
  assert.ok(seam && seam.rawSubdir === 'fold' && seam.rawId === 'library-home');
  const unfolded = byId.fold.scenes.find((s) => s.id === 'library-home');
  assert.equal(unfolded.rawSubdir, 'tablet10');
});

test('rawRelPath resolves fold per-scene subdirs (the N-NEW1 regression)', () => {
  const fold = SURFACES.find((s) => s.id === 'fold');
  const unfolded = fold.scenes.find((s) => s.id === 'library-home');
  const seam = fold.scenes.find((s) => s.id === 'library-home-seam');
  // Unfolded reuses the tablet10 raw; seam reads its own fold raw (rawId).
  assert.equal(rawRelPath(fold, unfolded, 'light'), 'tablet10/library-home.light.png');
  assert.equal(rawRelPath(fold, seam, 'light'), 'fold/library-home.light.png');
  // Distinct output stems avoid collision.
  assert.notEqual(unfolded.id, seam.id);
});

test('no two scenes in one surface collide on output stem', () => {
  for (const surface of SURFACES) {
    const ids = surface.scenes.map((s) => s.id);
    assert.equal(new Set(ids).size, ids.length, `${surface.id} has duplicate scene ids`);
  }
});
