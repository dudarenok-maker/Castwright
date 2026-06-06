/* Console-window-flash regression guard (windowsHide invariant).
 *
 * Symptom this locks down: on Windows, a prod app launched without an
 * attached console (the fs-1 versioned-dir launcher runs detached) gives
 * every spawned console program — ffmpeg.exe, ffprobe.exe, git.exe, the
 * Python sidecar — its OWN new console window, which flashes open and
 * vanishes. During audio generation/export the server spawns ffmpeg per
 * sentence and per chapter, so the windows flash "constantly". In dev
 * (`npm start` from a terminal) the children inherit the existing console,
 * so the bug is invisible there — which is exactly how it slipped in.
 *
 * The fix is `windowsHide: true` on EVERY child_process call. Rather than
 * unit-test each call site, this scans the whole server source tree and
 * asserts the invariant globally: any new spawn that forgets the flag
 * fails here, before it can ever ship a flashing window to a user.
 *
 * Scope: production server source only (`server/src/**`, excluding tests).
 * Launcher scripts under `scripts/*.mjs` already carry the flag and are
 * out of this suite's reach. */

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';

const SRC_ROOT = import.meta.dirname;

/* child_process entry points that launch an OS process (and therefore can
   pop a console window on Windows). Bare `exec`/`execSync` are included for
   completeness even though the codebase doesn't use them today. */
const SPAWN_NAMES = ['spawnSync', 'spawn', 'execFileSync', 'execFile', 'execSync', 'exec'];

/* Lookbehind rejects member calls and same-suffix identifiers so we never
   match `someRegex.exec(...)`, `child.spawn(...)`, or a local `respawn(...)`
   helper — only top-level `spawn(`, `spawnSync(`, `execFile(`, etc. */
const CALL_RE = new RegExp(String.raw`(?<![.\w])(${SPAWN_NAMES.join('|')})\s*\(`, 'g');

function listSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'dist') continue;
      out.push(...listSourceFiles(full));
      continue;
    }
    if (!entry.name.endsWith('.ts')) continue;
    if (entry.name.endsWith('.test.ts') || entry.name.endsWith('.spec.ts')) continue;
    if (entry.name === 'test-setup.ts') continue;
    out.push(full);
  }
  return out;
}

/* Blank out comments AND string/template literals so prose that merely
   mentions a spawn call — a doc comment, or a log line like
   "skipping spawn (current sidecar honoured)" — is never matched. Replaced
   characters become spaces (newlines kept) so byte offsets and line numbers
   stay accurate for error reporting. Single-pass lexer because regex can't
   disambiguate a `//` inside a string from a real line comment. */
function blankCommentsAndStrings(src: string): string {
  const out: string[] = [];
  let i = 0;
  const keepWhitespace = (ch: string) => (ch === '\n' ? '\n' : ' ');
  while (i < src.length) {
    const ch = src[i];
    const next = src[i + 1];
    if (ch === '/' && next === '/') {
      while (i < src.length && src[i] !== '\n') out.push(keepWhitespace(src[i++]));
      continue;
    }
    if (ch === '/' && next === '*') {
      out.push('  ');
      i += 2;
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) out.push(keepWhitespace(src[i++]));
      if (i < src.length) {
        out.push('  ');
        i += 2;
      }
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      const quote = ch;
      out.push(' ');
      i += 1;
      while (i < src.length && src[i] !== quote) {
        if (src[i] === '\\') {
          out.push('  ');
          i += 2;
          continue;
        }
        out.push(keepWhitespace(src[i++]));
      }
      if (i < src.length) {
        out.push(' ');
        i += 1;
      }
      continue;
    }
    out.push(ch);
    i += 1;
  }
  return out.join('');
}

/* Given the index of a call's opening paren, return the argument text up to
   its balanced closing paren. Nested parens (e.g. `shell: isWin()`) are
   handled by depth counting; our spawn args contain no parens inside string
   literals, so naive counting is sufficient here. */
function extractCallArgs(src: string, openParenIdx: number): string {
  let depth = 0;
  for (let i = openParenIdx; i < src.length; i += 1) {
    const ch = src[i];
    if (ch === '(') depth += 1;
    else if (ch === ')') {
      depth -= 1;
      if (depth === 0) return src.slice(openParenIdx, i + 1);
    }
  }
  return src.slice(openParenIdx); // unbalanced — treat the rest as the call
}

describe('windowsHide invariant (no flashing console windows in prod)', () => {
  const files = listSourceFiles(SRC_ROOT).filter((f) =>
    readFileSync(f, 'utf8').includes('child_process'),
  );

  it('finds at least the known ffmpeg/sidecar spawners (scan is wired up)', () => {
    /* Guard against the scan silently matching nothing (e.g. a refactor that
       moves all spawns) and giving a false green. */
    expect(files.length).toBeGreaterThanOrEqual(5);
  });

  it('every child_process spawn passes windowsHide: true', () => {
    const offenders: string[] = [];

    for (const file of files) {
      const src = blankCommentsAndStrings(readFileSync(file, 'utf8'));
      for (const match of src.matchAll(CALL_RE)) {
        const name = match[1];
        const openParenIdx = match.index + match[0].length - 1;
        const callText = extractCallArgs(src, openParenIdx);
        if (!/windowsHide\s*:\s*true/.test(callText)) {
          const rel = file.slice(SRC_ROOT.length + 1).replace(/\\/g, '/');
          const upToMatch = src.slice(0, match.index);
          const line = upToMatch.split('\n').length;
          offenders.push(`${rel}:${line} — ${name}(...) missing windowsHide: true`);
        }
      }
    }

    expect(
      offenders,
      `child_process calls missing windowsHide (would flash a console window in prod):\n${offenders.join('\n')}`,
    ).toEqual([]);
  });
});
