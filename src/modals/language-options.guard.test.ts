/* #2511 — static guard that pins the frontend LANGUAGE_OPTIONS list to the
   server language registry.

   The defect this guards is drift: LANGUAGE_OPTIONS in edit-book-meta.tsx is a
   hand-maintained list of display labels, and the server's
   language-registry.ts marks entries with `supported: true`. If a future human
   adds a language to one list but forgets the other — or removes an entry from
   one while leaving the other stale — the guard reddens.

   Reads both files AS TEXT from disk (no module resolution, no import), extracts
   the relevant codes by regex, and asserts exact equality in both directions. */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

const MODALS_DIR = resolve(__dirname);                         // src/modals
const SERVER_TTS_DIR = resolve(__dirname, '..', '..', 'server', 'src', 'tts'); // server/src/tts

const REGISTRY_PATH = resolve(SERVER_TTS_DIR, 'language-registry.ts');
const META_PATH = resolve(MODALS_DIR, 'edit-book-meta.tsx');

/**
 * Extract codes of all entries with `supported: true` from the registry file.
 * Matches the shape `{ code: 'xx', ... supported: true, ... }` across line
 * boundaries — the block may span several lines. Returns a sorted array.
 */
function extractRegistryCodes(source: string): string[] {
  const codes: string[] = [];
  // Match a brace-delimited entry that contains `supported: true`.
  // We walk through the file looking for `{` and track brace depth to capture
  // the whole entry, then check if it contains `supported: true`.
  let i = 0;
  while (i < source.length) {
    const openBrace = source.indexOf('{', i);
    if (openBrace === -1) break;

    let depth = 1;
    let j = openBrace + 1;
    while (j < source.length && depth > 0) {
      if (source[j] === '{') depth++;
      else if (source[j] === '}') depth--;
      j++;
    }
    const entry = source.slice(openBrace, j);

    // Check if this entry has supported: true
    if (/\bsupported:\s*true\b/.test(entry)) {
      const codeMatch = entry.match(/code:\s*'(\w+)'/);
      if (codeMatch) {
        codes.push(codeMatch[1]);
      }
    }

    i = j;
  }

  return codes.sort();
}

/**
 * Extract non-null codes from LANGUAGE_OPTIONS array definition.
 * Matches `{ code: '...', label: '...' }` entries. Returns a sorted array.
 */
function extractLanguageOptionsCodes(source: string): string[] {
  const codes: string[] = [];
  // Match each object literal with a `code:` field
  const entryRe = /\{\s*code:\s*'(\w+)'/g;
  let m: RegExpExecArray | null;
  while ((m = entryRe.exec(source))) {
    if (m[1]) {
      codes.push(m[1]);
    }
  }
  return codes.sort();
}

describe('language-registry pin guard (#2511)', () => {
  it('every supported language in the server registry has an entry in LANGUAGE_OPTIONS', () => {
    const registry = readFileSync(REGISTRY_PATH, 'utf8');
    const meta = readFileSync(META_PATH, 'utf8');

    const registryCodes = extractRegistryCodes(registry);
    const optionCodes = extractLanguageOptionsCodes(meta);

    const missing = registryCodes.filter((c) => !optionCodes.includes(c));
    expect(missing, `These supported languages are missing from LANGUAGE_OPTIONS: ${missing.join(', ')}`).toEqual([]);
  });

  it('every entry in LANGUAGE_OPTIONS has a supported:true counterpart in the server registry', () => {
    const registry = readFileSync(REGISTRY_PATH, 'utf8');
    const meta = readFileSync(META_PATH, 'utf8');

    const registryCodes = extractRegistryCodes(registry);
    const optionCodes = extractLanguageOptionsCodes(meta);

    const extra = optionCodes.filter((c) => !registryCodes.includes(c));
    expect(extra, `These LANGUAGE_OPTIONS entries have no supported:true counterpart in the registry: ${extra.join(', ')}`).toEqual([]);
  });
});