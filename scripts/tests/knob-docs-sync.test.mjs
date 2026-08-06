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

/* PR #2159 review, finding 1. .prettierrc sets singleQuote: true, but Prettier
   emits DOUBLE quotes when they need fewer escapes — so a label containing an
   apostrophe is double-quoted in registry.ts. A single-quote-only pattern
   skipped it silently and the knob shipped undocumented with the guard green. */
test('extractKnobLabels reads double-quoted labels (Prettier emits these for apostrophes)', () => {
  const src = [
    'export const KNOBS = [',
    "  { key: 'a', label: 'Plain label' },",
    '  { key: \'b\', label: "Don\'t preload Kokoro" },',
    '];',
  ].join('\n');
  assert.deepEqual(extractKnobLabels(src), ['Plain label', "Don't preload Kokoro"]);
});

test('extractKnobLabels reads an escaped apostrophe inside single quotes', () => {
  const src = ["export const KNOBS = [", "  { key: 'a', label: 'Don\\'t preload' },", '];'].join(
    '\n',
  );
  assert.deepEqual(extractKnobLabels(src), ["Don't preload"]);
});

/* Findings 1 and 5 share one backstop: if the extractor ever sees a SUBSET of
   the labels — an unhandled quoting style, a template literal, or a nested
   literal closing at column 0 and truncating the body — it must refuse rather
   than report a verdict on a partial list. */
test('extractKnobLabels THROWS rather than returning a subset when a label is unreadable', () => {
  const src = [
    'export const KNOBS = [',
    "  { key: 'a', label: 'Readable' },",
    '  { key: \'b\', label: `Template literal ${x}` },',
    '];',
  ].join('\n');
  assert.throws(() => extractKnobLabels(src), /extracted only 1 values|seeing a subset/);
});

/* Finding 5 — the old `\n];` end-marker took the FIRST column-0 `];` after the
   opening bracket, so a nested literal closing at column 0 truncated the body
   and silently dropped every knob after it. A count assertion cannot catch
   this (the count is computed over the already-truncated body), so the fix is
   a bracket-balanced scan. Both labels must survive. */
test('extractKnobLabels survives a nested literal closing at column 0', () => {
  const src = [
    'export const KNOBS = [',
    "  { key: 'a', label: 'Before', choices: [",
    "    'x',",
    '];',
    "  { key: 'b', label: 'After' },",
    '];',
  ].join('\n');
  assert.deepEqual(extractKnobLabels(src), ['Before', 'After']);
});

test('a bracket inside a string or comment does not end the array early', () => {
  const src = [
    'export const KNOBS = [',
    "  { key: 'a', label: 'Has a ] bracket' },",
    '  // a stray ] in a comment',
    '  /* and ] in a block comment */',
    "  { key: 'b', label: 'After' },",
    '];',
  ].join('\n');
  assert.deepEqual(extractKnobLabels(src), ['Has a ] bracket', 'After']);
});

test('extractKnobLabels throws on genuinely unbalanced brackets', () => {
  const src = ['export const KNOBS = [', "  { key: 'a', label: 'Never closed' },"].join('\n');
  assert.throws(() => extractKnobLabels(src), /unbalanced brackets/);
});

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

/* #2012 acceptance item 4, and the owner's "reasonable to fold in" comment.
   The intro paragraph states the knob total in PROSE, hand-maintained — the
   exact figure this PR itself had to hand-edit (112 -> 114). Nothing kept it
   honest, so it would silently rot the first time a knob landed with its table
   row but without a prose edit. Guarded rather than derived: the sentence
   reads better written by a human, and an assertion costs one line. */
test('the intro prose knob count matches the real registry count (#2012 acceptance 4)', () => {
  const registrySrc = readFileSync(REGISTRY_PATH, 'utf8');
  const wikiSrc = readFileSync(WIKI_PATH, 'utf8');
  const actual = extractKnobLabels(registrySrc).length;

  const m = /—\s*(\d+)\s+knobs across\s+(\d+)\s+groups in total/.exec(wikiSrc);
  assert.ok(
    m,
    'Advanced-Settings.md intro no longer contains an "— N knobs across M groups in total" ' +
      'sentence. If it was reworded, update this pattern; do not delete the assertion — an ' +
      'unguarded hand-maintained count is exactly what #2012 acceptance item 4 asked for.',
  );
  assert.equal(
    Number(m[1]),
    actual,
    `Advanced-Settings.md's intro says ${m[1]} knobs but registry.ts declares ${actual}. ` +
      'Update the prose in the same commit as the knob.',
  );
});
