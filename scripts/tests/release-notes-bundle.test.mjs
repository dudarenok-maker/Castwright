import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateReleaseNotes } from '../build-release-zip.mjs';

// fe-37: RELEASE_NOTES.md is now a committed brand-voice history. The bundler
// must ship it verbatim and NEVER regenerate it from the tag body (which would
// destroy the multi-version history and replace the brand voice with the
// technical tag annotation).

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const notesPath = resolve(repoRoot, 'RELEASE_NOTES.md');

test('generateReleaseNotes ships the committed brand history verbatim (no clobber)', () => {
  const before = readFileSync(notesPath, 'utf8');
  // Pass a bogus version + a notesFile; both must be ignored when the committed
  // file is present.
  const out = generateReleaseNotes('9.9.9', 'docs/release-notes-next.md');
  const after = readFileSync(notesPath, 'utf8');
  assert.equal(out, notesPath);
  assert.equal(after, before, 'committed RELEASE_NOTES.md must not be overwritten');
  assert.ok(after.includes('Castwright 1.7.0'), 'multi-version brand history is preserved');
});
