// #2012: guard that every registry knob (server/src/config/registry.ts's
// KNOBS array) has a documented row in docs/wiki/Advanced-Settings.md.
// Matches on the registry `label` against the wiki table's FIRST COLUMN —
// the decision recorded on #2012 (measured on `main`: 101/114 knobs join
// exactly on label; zero of the 13 misses were a reworded label, so label
// matching has zero false positives on the current corpus).
//
// Run via `npm run test:hooks` (node --test). registry.ts and
// Advanced-Settings.md are both `extraFiles` on the `test:hooks` step in
// scripts/verify-cache.mjs so a diff touching either file busts that step's
// cache and actually re-runs this test, rather than reporting [cached].

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { extractKnobLabels, extractTableFirstCells } from '../lib/knob-docs.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..', '..');
const REGISTRY_PATH = join(REPO_ROOT, 'server', 'src', 'config', 'registry.ts');
const WIKI_PATH = join(REPO_ROOT, 'docs', 'wiki', 'Advanced-Settings.md');

test('extractKnobLabels pulls only KNOBS[].label, not GROUPS[].label', () => {
  const src = `
export const GROUPS: ConfigGroup[] = [
  { id: 'g1', label: 'Group One', help: 'x', risk: 'low', collapsedByDefault: false },
];

export const KNOBS: ConfigKnob[] = [
  {
    key: 'a',
    label: 'Knob A',
  },
  {
    key: 'b',
    label: 'Knob B',
  },
];
`;
  assert.deepEqual(extractKnobLabels(src), ['Knob A', 'Knob B']);
});

test('extractKnobLabels throws if the KNOBS array cannot be located', () => {
  assert.throws(() => extractKnobLabels('export const NOT_KNOBS = [];'), /KNOBS/);
});

test('extractTableFirstCells strips backticks/whitespace and skips header + separator rows', () => {
  const md = `
## 1. Some group

| Knob | What it does | Default | Range | Apply | Risk |
|---|---|---|---|---|---|
| \`Foo bar\` | does a thing | 1 | int | live | low |
| Baz | does another | 2 | int | live | low |
`;
  assert.deepEqual(extractTableFirstCells(md), ['Foo bar', 'Baz']);
});

test('extractTableFirstCells ignores non-table prose lines', () => {
  const md = 'Just some prose with a | pipe character in it, not a table row.\n';
  assert.deepEqual(extractTableFirstCells(md), []);
});

test('every registry KNOBS[].label has a matching Advanced-Settings.md table row (#2012)', () => {
  const registrySrc = readFileSync(REGISTRY_PATH, 'utf8');
  const wikiSrc = readFileSync(WIKI_PATH, 'utf8');
  const labels = extractKnobLabels(registrySrc);
  const cells = new Set(extractTableFirstCells(wikiSrc));
  const missing = labels.filter((label) => !cells.has(label));
  assert.deepEqual(
    missing,
    [],
    `knob(s) missing an Advanced-Settings.md row (first cell must equal the ` +
      `registry label exactly): ${missing.join(', ')}`,
  );
});
