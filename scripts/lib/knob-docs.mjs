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
 * Index of the `]` that closes the array literal opening at `openIdx`, found
 * by bracket balance rather than by scanning for a column-0 `\n];`.
 *
 * The end-marker heuristic this replaces (PR #2159 review, finding 5) took the
 * FIRST `\n];` after the opening `[`, so any nested literal that happened to
 * close at column 0 truncated the body — silently dropping every knob after
 * it, with the guard still green on the surviving subset. A count assertion
 * cannot catch that, because the count is computed over the already-truncated
 * body.
 *
 * Skips brackets inside strings, template literals and comments, which is
 * what makes the balance meaningful on real source.
 *
 * @param {string} src
 * @param {number} openIdx index of the opening `[`
 * @returns {number} index of the matching `]`
 */
export function findArrayEnd(src, openIdx) {
  let depth = 0;
  for (let i = openIdx; i < src.length; i++) {
    const c = src[i];
    const next = src[i + 1];
    if (c === '/' && next === '/') {
      const nl = src.indexOf('\n', i);
      i = nl === -1 ? src.length : nl;
      continue;
    }
    if (c === '/' && next === '*') {
      const close = src.indexOf('*/', i + 2);
      i = close === -1 ? src.length : close + 1;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') {
      const quote = c;
      i++;
      for (; i < src.length; i++) {
        if (src[i] === '\\') {
          i++;
          continue;
        }
        if (src[i] === quote) break;
      }
      continue;
    }
    if (c === '[') depth++;
    else if (c === ']') {
      depth--;
      if (depth === 0) return i;
    }
  }
  throw new Error('extractKnobLabels: KNOBS array closing "]" not found (unbalanced brackets)');
}

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
  /* Anchor on the `=`, not on `startIdx`: the declaration is
     `export const KNOBS: ConfigKnob[] = [`, so the first `[` after the NAME is
     the one in the TYPE ANNOTATION, not the array literal. The old `\n];`
     end-marker tolerated that by accident (it scanned forward to a column-0
     `];` regardless of where it started); a bracket-balanced scan does not —
     it matches `ConfigKnob[]` immediately and yields an empty body. */
  const eqIdx = source.indexOf('=', startIdx);
  if (eqIdx === -1) {
    throw new Error('extractKnobLabels: KNOBS assignment "=" not found');
  }
  const arrayStart = source.indexOf('[', eqIdx);
  if (arrayStart === -1) {
    throw new Error('extractKnobLabels: KNOBS array opening "[" not found');
  }
  const endIdx = findArrayEnd(source, arrayStart);
  const body = source.slice(arrayStart, endIdx);

  /* BOTH quote styles, deliberately. .prettierrc sets singleQuote: true, but
     Prettier picks whichever quote needs FEWER escapes — so a label containing
     an apostrophe ("Don't preload Kokoro") is emitted DOUBLE-quoted and a
     single-quote-only pattern skips it silently, leaving the knob
     undocumented with the guard still green (PR #2159 review, finding 1). */
  const labels = [];
  const re = /label:\s*(?:'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)")/g;
  let m;
  while ((m = re.exec(body)) !== null) {
    const raw = m[1] !== undefined ? m[1] : m[2];
    labels.push(raw.replace(/\\(['"])/g, '$1'));
  }

  /* A regex that silently matches a SUBSET is the failure mode this whole
     guard exists to prevent, so cross-check the count against a far simpler
     signal: how many `label:` properties the body contains at all. A mismatch
     means the pattern above missed one — a quoting style it does not cover, or
     a template literal. (Body TRUNCATION is a different failure and is not
     caught here, because the count would be computed over the already-
     truncated body; `findArrayEnd`'s bracket balance is what closes that one.) */
  const declared = (body.match(/(^|[\s{,])label:/g) ?? []).length;
  if (declared !== labels.length) {
    throw new Error(
      `extractKnobLabels: found ${declared} \`label:\` properties in the KNOBS body but ` +
        `extracted only ${labels.length} values. The extractor is seeing a subset, so its ` +
        'verdict would be unsound — check for a label using a quoting style or a template ' +
        'literal this pattern does not cover, or a nested literal closing at column 0 and ' +
        'truncating the body early.',
    );
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
