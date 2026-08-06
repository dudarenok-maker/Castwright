// scripts/lib/knob-docs.mjs
//
// Pure text-extraction helpers backing the #2012 guard: every registry knob
// must have a documented row in docs/wiki/Advanced-Settings.md. Matches on
// the registry `label`, against the wiki table's FIRST COLUMN — the decision
// recorded on #2012 (measured on `main`: 101/114 knobs join exactly on label,
// zero false positives from a reworded-but-matched label).
//
// registry.ts is TypeScript; these helpers deliberately read it as raw TEXT
// (regex extraction) rather than importing it, so the guard can run under
// plain `node --test` (test:hooks) without a TS loader.

/**
 * Extract every `label: '...'` value from ONLY the `KNOBS` array literal in
 * registry.ts's source text — `GROUPS` (declared earlier in the same file)
 * also has `label:` fields on its entries, so it must be excluded.
 * @param {string} source raw registry.ts text
 * @returns {string[]}
 */
export function extractKnobLabels(source) {
  const startMarker = 'export const KNOBS';
  const startIdx = source.indexOf(startMarker);
  if (startIdx === -1) {
    throw new Error('extractKnobLabels: "export const KNOBS" not found in source');
  }
  const arrayStart = source.indexOf('[', startIdx);
  if (arrayStart === -1) {
    throw new Error('extractKnobLabels: KNOBS array opening "[" not found');
  }
  const endIdx = source.indexOf('\n];', arrayStart);
  if (endIdx === -1) {
    throw new Error('extractKnobLabels: KNOBS array closing "];" not found');
  }
  const body = source.slice(arrayStart, endIdx);

  const labels = [];
  const re = /label:\s*'((?:[^'\\]|\\.)*)'/g;
  let m;
  while ((m = re.exec(body)) !== null) {
    labels.push(m[1].replace(/\\'/g, "'"));
  }
  return labels;
}

/**
 * Extract the first cell of every markdown table data row (lines shaped
 * `| cell | cell | ... |`), skipping header rows (first cell literally
 * "Knob") and the `|---|---|` separator row. Strips surrounding backticks
 * and whitespace from each cell, per the #2012 decision.
 * @param {string} markdown
 * @returns {string[]}
 */
export function extractTableFirstCells(markdown) {
  const cells = [];
  for (const rawLine of markdown.split('\n')) {
    const line = rawLine.trim();
    if (!line.startsWith('|')) continue;
    if (/^\|[\s:|-]+\|$/.test(line)) continue; // separator row, e.g. |---|---|
    const firstCell = line.slice(1).split('|')[0].trim();
    if (!firstCell || firstCell === 'Knob') continue; // empty or header row
    cells.push(firstCell.replace(/^`+|`+$/g, '').trim());
  }
  return cells;
}
