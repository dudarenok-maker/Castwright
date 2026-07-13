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
//
// Assumption: base.txt carries only plain version pins (no `-r <file>` includes
// or local-path requirements). That holds today — the layered overlays
// (nvidia-cuda.txt, …) are composed separately at install time, not `-r`-ed in
// from base.txt — so writing the sanitised copy to a temp dir can't break pip's
// relative-path resolution. If base.txt ever gains a relative include, the copy
// would need to live alongside base.txt (in requirements/) instead.

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

// One temp dir per process, reused across every call and removed on exit, so
// repeated installs/repairs (and the two flash-attn calls) don't accumulate
// orphan `castwright-constraints-*` dirs in the OS temp area.
let constraintsDir = null;
function ensureConstraintsDir() {
  if (constraintsDir === null) {
    constraintsDir = mkdtempSync(join(tmpdir(), 'castwright-constraints-'));
    process.on('exit', () => {
      try {
        rmSync(constraintsDir, { recursive: true, force: true });
      } catch {
        /* best-effort cleanup — a leftover temp dir is harmless */
      }
    });
  }
  return constraintsDir;
}

/**
 * Read a requirements file, strip extras, and write the result to a temp file
 * suitable for `pip install ... -c <path>`. Returns the temp file's path.
 *
 * If the requirements file can't be read (missing/unreadable), returns
 * `baseTxtPath` unchanged: pip then emits its own clean "Could not open
 * requirements file" error and the caller's FAIL step still prints — never a
 * raw ENOENT stack trace from this helper (which would defeat the legible-error
 * goal these installers exist to serve).
 * @param {string} baseTxtPath absolute path to the requirements file
 * @returns {string} absolute path to the sanitised constraints file, or
 *   `baseTxtPath` on read failure
 */
export function writeSanitizedConstraintsFile(baseTxtPath) {
  let text;
  try {
    text = readFileSync(baseTxtPath, 'utf8');
  } catch {
    return baseTxtPath;
  }
  const out = join(ensureConstraintsDir(), 'constraints.txt');
  writeFileSync(out, sanitizeConstraintsText(text));
  return out;
}
