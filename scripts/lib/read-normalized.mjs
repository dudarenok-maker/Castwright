// scripts/lib/read-normalized.mjs
//
// Reads a tracked repo file as text and normalises CRLF -> LF.
//
// Git for Windows defaults to core.autocrlf=true, which GitHub's
// windows-latest runner inherits. .gitattributes pins only a handful of
// paths (.husky/*, *.sh, *.mjs, *.cjs, a few generated files) to LF — every
// other tracked file (.md, .yml, .ts, ...) materialises with CRLF line
// endings on that runner. A reader that assumes LF — a literal '\n' in a
// regex or an `indexOf('\n---\n')`/`indexOf('\n## ')` scan — silently misses
// on Windows CI while staying green on every LF-native dev box, because
// nothing there reproduces the runner's line endings by default (#2291).
//
// Reach for this instead of a bare `readFileSync(..., 'utf8')` whenever the
// text is then parsed with a pattern that assumes LF line endings.

import { readFileSync } from 'node:fs';

/**
 * @param {string} text
 * @returns {string} `text` with every `\r\n` collapsed to `\n`
 */
export function normalizeEol(text) {
  return text.replace(/\r\n/g, '\n');
}

/**
 * @param {import('node:fs').PathLike} path
 * @returns {string} the file's utf8 text with every `\r\n` collapsed to `\n`
 */
export function readNormalized(path) {
  return normalizeEol(readFileSync(path, 'utf8'));
}
