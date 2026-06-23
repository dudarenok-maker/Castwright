// Unit tests for scripts/eval-attribution.mjs — attribution-eval harness.
// Runs under plain `node --test` (npm run test:hooks).
// Tests are pure: they import scoreAttribution() directly without spawning the CLI.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname } from 'node:path';

import { scoreAttribution } from '../eval-attribution.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const evalScript = resolve(here, '..', 'eval-attribution.mjs');

// ── Minimal ground-truth fixture (subset of Coalfall cast) ───────────────────
// Using a small subset so fixture data is readable and self-contained.
const GT = {
  allowedAnonymous: ['unknown male'],
  speakers: [
    {
      id: 'narrator',
      name: 'Narrator',
      aliases: [],
      expectedLines: 140,
      lineRange: [70, 280],
    },
    {
      id: 'coalfall',
      name: 'Coalfall',
      aliases: ['Dragón', 'Dragon', 'El Dragón'],
      expectedLines: 22,
      lineRange: [11, 44],
      entitySplitAliases: ['Dragón', 'Dragon', 'El Dragón'],
    },
    {
      id: 'oduvan',
      name: 'Oduvan',
      aliases: [],
      expectedLines: 18,
      lineRange: [9, 36],
    },
    {
      id: 'berrin-weir',
      name: 'Berrin Weir',
      aliases: ['Berrin'],
      expectedLines: 7,
      lineRange: [3, 14],
    },
  ],
};

// ── Test A: GOOD fixture — all expected speakers present, shares in range ─────
test('scoreAttribution: good cast → full recall, no spurious, PASS', () => {
  const cast = {
    characters: [
      { name: 'Narrator', lineCount: 140 },
      { name: 'Coalfall', lineCount: 22 },
      { name: 'Oduvan', lineCount: 18 },
      { name: 'Berrin Weir', lineCount: 7 },
    ],
  };

  const r = scoreAttribution(cast, GT, { minRecall: 0.85 });

  assert.equal(r.recall, 1, 'recall should be 1 (all 4 GT speakers matched)');
  assert.equal(r.matched.length, 4);
  assert.deepEqual(r.missing, []);
  assert.deepEqual(r.spurious, []);
  assert.deepEqual(r.flags.entitySplits, [], 'no entity split expected');
  assert.deepEqual(r.flags.missingExpected, []);
  assert.deepEqual(r.flags.lineShareWarnings, [], 'shares all in range');
  assert.equal(r.pass, true);
  assert.equal(r.recallFraction, '4/4');
});

// ── Test B: DEGRADED fixture — entity split, missing speaker, spurious char ──
test('scoreAttribution: degraded cast → entity-split + missing + spurious + low recall, FAIL', () => {
  const cast = {
    characters: [
      { name: 'Narrator', lineCount: 140 },
      // Dragón and Coalfall appear as SEPARATE characters → entity split
      { name: 'Dragón', lineCount: 17 },
      { name: 'Coalfall', lineCount: 5 },
      { name: 'Oduvan', lineCount: 18 },
      // Berrin Weir is entirely absent → missing
      // A spurious character the GT doesn't know about
      { name: 'Goblin', lineCount: 3 },
      // Anonymous allowed bucket — should NOT count as spurious
      { name: 'Unknown male', lineCount: 2 },
    ],
  };

  const r = scoreAttribution(cast, GT, { minRecall: 0.85 });

  // Recall: only Narrator, Oduvan matched (Dragón/Coalfall are a split — one
  // GT entry "Coalfall" matches the "Coalfall" analysis entry via name; the
  // "Dragón" alias also matches. The entity-split is flagged but the GT entry
  // is still considered "matched" (via the Coalfall part). Berrin Weir is missing.
  // So 3/4 matched → recall = 0.75.
  assert.equal(r.recall, 0.75, `recall should be 0.75, got ${r.recall}`);
  assert.equal(r.recallFraction, '3/4');
  assert.equal(r.pass, false, 'should FAIL with recall 0.75 < 0.85');

  // Berrin Weir is missing
  assert.equal(r.missing.length, 1);
  assert.equal(r.missing[0].gtName, 'Berrin Weir');
  assert.ok(r.flags.missingExpected.includes('Berrin Weir'));

  // Goblin is spurious; Unknown male is NOT
  assert.ok(r.spurious.includes('Goblin'), 'Goblin should be spurious');
  assert.ok(!r.spurious.includes('Unknown male'), 'Unknown male should not be spurious');

  // Entity split on Coalfall
  assert.equal(r.flags.entitySplits.length, 1, 'one entity-split expected');
  const split = r.flags.entitySplits[0];
  assert.equal(split.gtId, 'coalfall');
  assert.ok(split.parts.includes('Dragón') || split.parts.includes('Dragon'), 'split parts should include alias');
  assert.ok(split.parts.includes('Coalfall'), 'split parts should include canonical name');
});

// ── Test C: Line-share flag fires for a wildly-off count ─────────────────────
test('scoreAttribution: wildly-off line count triggers line-share warning', () => {
  const cast = {
    characters: [
      // Narrator has 5 lines vs expected 140 → well below 50% of 140 (70)
      { name: 'Narrator', lineCount: 5 },
      { name: 'Coalfall', lineCount: 22 },
      { name: 'Oduvan', lineCount: 18 },
      { name: 'Berrin Weir', lineCount: 7 },
    ],
  };

  const r = scoreAttribution(cast, GT, { minRecall: 0.85 });

  assert.equal(r.flags.lineShareWarnings.length, 1, 'one line-share warning expected');
  const w = r.flags.lineShareWarnings[0];
  assert.equal(w.name, 'Narrator');
  assert.equal(w.lineCount, 5);
  assert.equal(w.expectedLines, 140);
  // recall is still 4/4 because the speaker IS present
  assert.equal(r.recall, 1);
  assert.equal(r.pass, true, 'PASS because recall is above threshold despite line-share warning');
});

// ── Test D: Alias matching — Spanish alias resolves to GT entry ───────────────
test('scoreAttribution: Spanish alias "Dragón" matches GT entry "Coalfall"', () => {
  // Analysis uses the Spanish alias only (no "Coalfall" present separately)
  const cast = {
    characters: [
      { name: 'Narrator', lineCount: 140 },
      { name: 'Dragón', lineCount: 22 },
      { name: 'Oduvan', lineCount: 18 },
      { name: 'Berrin Weir', lineCount: 7 },
    ],
  };

  const r = scoreAttribution(cast, GT, { minRecall: 0.85 });

  // All 4 GT speakers should match (Dragón matches Coalfall via alias)
  assert.equal(r.recall, 1);
  assert.equal(r.matched.length, 4);
  // "Coalfall" GT entry matched by alias "Dragón"
  const coalfallMatch = r.matched.find((m) => m.gtId === 'coalfall');
  assert.ok(coalfallMatch, 'coalfall GT entry should be matched');
  assert.equal(coalfallMatch.analysisName, 'Dragón');
  // No entity split because Coalfall (canonical) is NOT present as a separate character
  assert.deepEqual(r.flags.entitySplits, []);
  assert.equal(r.pass, true);
});

// ── Test E: line count from `lines` array shape ───────────────────────────────
test('scoreAttribution: line count extracted from lines array', () => {
  const cast = {
    characters: [
      { name: 'Narrator', lines: new Array(140).fill('line') },
      { name: 'Coalfall', lines: 22 },    // number form
      { name: 'Oduvan', lines: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k', 'l', 'm', 'n', 'o', 'p', 'q', 'r'] },
      { name: 'Berrin Weir', lineCount: 7 },
    ],
  };

  const r = scoreAttribution(cast, GT);
  assert.equal(r.recall, 1);
  // Narrator: 140 lines (array)
  const narratorMatch = r.matched.find((m) => m.gtId === 'narrator');
  assert.equal(narratorMatch.lineCount, 140);
  // Coalfall: 22 (number in lines field)
  const coalMatch = r.matched.find((m) => m.gtId === 'coalfall');
  assert.equal(coalMatch.lineCount, 22);
  // Oduvan: 18 (array length)
  const oduMatch = r.matched.find((m) => m.gtId === 'oduvan');
  assert.equal(oduMatch.lineCount, 18);
});

// ── Test F: Precision calculation ─────────────────────────────────────────────
test('scoreAttribution: precision reflects spurious count correctly', () => {
  const cast = {
    characters: [
      { name: 'Narrator', lineCount: 140 },
      { name: 'Coalfall', lineCount: 22 },
      { name: 'Oduvan', lineCount: 18 },
      { name: 'Berrin Weir', lineCount: 7 },
      { name: 'SpuriousA', lineCount: 5 },
      { name: 'SpuriousB', lineCount: 3 },
    ],
  };

  const r = scoreAttribution(cast, GT);
  // 4 matched, 2 spurious → precision = 4/6
  assert.equal(r.spurious.length, 2);
  assert.ok(Math.abs(r.precision - 4 / 6) < 1e-9, `precision = ${r.precision}`);
  assert.equal(r.precisionFraction, '4/6');
});

// ── Test G: CLI smoke — run against a temp good cast.json, expect exit 0 ──────
test('CLI: exits 0 for a good cast.json and prints PASS', () => {
  const dir = mkdtempSync(resolve(tmpdir(), 'eval-attr-test-'));
  try {
    const castPath = resolve(dir, 'cast.json');
    const gtPath = resolve(dir, 'gt.json');
    writeFileSync(castPath, JSON.stringify({
      characters: [
        { name: 'Narrator', lineCount: 140 },
        { name: 'Coalfall', lineCount: 22 },
        { name: 'Oduvan', lineCount: 18 },
        { name: 'Berrin Weir', lineCount: 7 },
      ],
    }));
    writeFileSync(gtPath, JSON.stringify(GT));

    const out = spawnSync(process.execPath, [evalScript, castPath, gtPath], { encoding: 'utf8' });
    assert.equal(out.status, 0, `CLI should exit 0 for PASS. stderr: ${out.stderr}`);
    assert.match(out.stdout, /PASS/, 'stdout should contain PASS');
    assert.match(out.stdout, /RECALL 4\/4/, 'stdout should show recall 4/4');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── Test H: CLI smoke — exits 1 for a degraded cast.json ─────────────────────
test('CLI: exits 1 for a degraded cast.json with low recall', () => {
  const dir = mkdtempSync(resolve(tmpdir(), 'eval-attr-fail-'));
  try {
    const castPath = resolve(dir, 'cast.json');
    const gtPath = resolve(dir, 'gt.json');
    writeFileSync(castPath, JSON.stringify({
      characters: [
        { name: 'Narrator', lineCount: 140 },
        // Only Narrator present — recall = 1/4 = 0.25
      ],
    }));
    writeFileSync(gtPath, JSON.stringify(GT));

    const out = spawnSync(process.execPath, [evalScript, castPath, gtPath], { encoding: 'utf8' });
    assert.equal(out.status, 1, `CLI should exit 1 for FAIL. stderr: ${out.stderr}`);
    assert.match(out.stdout, /FAIL/, 'stdout should contain FAIL');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
