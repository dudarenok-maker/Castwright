#!/usr/bin/env node
// pip-constraints.mjs -- build a pip *constraints* file (`-c`) from a
// requirements file.
//
// Why this exists: install-coqui.mjs and install-qwen3.mjs pin their opt-in
// installs against requirements/base.txt via `pip install ... -c base.txt`, so
// coqui-tts / qwen-tts can't drag numpy/transformers off the shared stack. But
// base.txt is a REQUIREMENTS file, and it legitimately carries extras (e.g.
// `uvicorn[standard]`). pip forbids extras in a CONSTRAINTS file and aborts the
// whole install with `ERROR: Constraints cannot have extras`.
//
// Extras are meaningless as a constraint anyway — a constraint only pins a
// VERSION, never selects optional dependency groups — so we strip the
// `[extras]` token from every line (keeping the version pin) and hand pip a
// sanitised temp copy. base.txt stays the single source of truth.

import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Strip pip "extras" (`pkg[a,b]==x` → `pkg==x`) from every requirement line.
 * The `[extras]` token is removed only from the requirement (pre-`#`) portion
 * of each line; comments and blank lines pass through verbatim. Pure — no I/O.
 * @param {string} text requirements-file contents
 * @returns {string} the same text with all extras removed
 */
export function sanitizeConstraintsText(text) {
  return text
    .split('\n')
    .map((line) => {
      const hash = line.indexOf('#');
      const code = hash === -1 ? line : line.slice(0, hash);
      const comment = hash === -1 ? '' : line.slice(hash);
      return code.replace(/\[[^\]]*\]/g, '') + comment;
    })
    .join('\n');
}

/**
 * Read a requirements file, strip extras, and write the result to a fresh temp
 * file suitable for `pip install ... -c <path>`. Returns the temp file's path.
 * @param {string} baseTxtPath absolute path to the requirements file
 * @returns {string} absolute path to the sanitised constraints file
 */
export function writeSanitizedConstraintsFile(baseTxtPath) {
  const sanitized = sanitizeConstraintsText(readFileSync(baseTxtPath, 'utf8'));
  const dir = mkdtempSync(join(tmpdir(), 'castwright-constraints-'));
  const out = join(dir, 'constraints.txt');
  writeFileSync(out, sanitized);
  return out;
}
