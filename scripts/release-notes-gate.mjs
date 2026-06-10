#!/usr/bin/env node
/* fe-37 release gate — a placeholder or wrong-version user-facing release-notes
   file must never reach a published release. Shared by two enforcement points:
   - scripts/bump-version.mjs pre-flight (refuses to create the tag), and
   - .github/workflows/release.yml (refuses to publish a hand-cut tag).

   The user-facing notes are the committed, brand-voice RELEASE_NOTES.md whose
   TOP section must lead with the release version. (The technical GitHub-body
   notes are a separate file fed to the tag annotation.) */

import { readFileSync, existsSync, realpathSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const PLACEHOLDER_RE = /See the GitHub release for details\./i;

/** Parse the top (newest) section of a RELEASE_NOTES.md string. */
export function parseTopReleaseNote(md) {
  const lines = (md ?? '').split(/\r?\n/);
  let heading = null;
  const body = [];
  for (const raw of lines) {
    const l = raw.trim();
    const h = /^#{1,2}\s+(.*)$/.exec(l);
    if (h) {
      if (heading == null) {
        heading = h[1].trim();
        continue;
      }
      break; // a second heading ends the top section
    }
    if (heading != null) body.push(l);
  }
  const version = heading ? (/(\d+\.\d+\.\d+)/.exec(heading)?.[1] ?? null) : null;
  const bullets = body.filter((l) => /^[-*]\s+/.test(l));
  return { heading, version, bullets };
}

/** True when the notes are empty, the one-line placeholder, or have no bullets. */
export function isPlaceholderNotes(md) {
  const t = (md ?? '').trim();
  if (t.length === 0) return true;
  if (PLACEHOLDER_RE.test(t)) return true;
  return parseTopReleaseNote(t).bullets.length === 0;
}

/** Check the committed notes are real and lead with `version` (a leading "v" is tolerated). */
export function checkReleaseNotes(md, version) {
  const want = String(version ?? '').replace(/^v/, '');
  if (!want) return { ok: false, reason: 'no release version supplied to the notes gate.' };
  if (isPlaceholderNotes(md)) {
    return {
      ok: false,
      reason: 'RELEASE_NOTES.md is empty or a placeholder — write the brand-voice notes for this release.',
    };
  }
  const top = parseTopReleaseNote(md);
  if (top.version !== want) {
    return {
      ok: false,
      reason: `RELEASE_NOTES.md leads with "${top.version ?? '?'}" but the release is ${want} — add the ${want} section at the top.`,
    };
  }
  return { ok: true, reason: '' };
}

function repoRootFromHere() {
  return resolve(dirname(fileURLToPath(import.meta.url)), '..');
}

// CLI: node scripts/release-notes-gate.mjs <version> [notesPath]
const invokedHref = process.argv[1] ? pathToFileURL(realpathSync(process.argv[1])).href : '';
if (invokedHref && import.meta.url === invokedHref) {
  const version = process.argv[2];
  const notesPath = process.argv[3]
    ? resolve(process.argv[3])
    : resolve(repoRootFromHere(), 'RELEASE_NOTES.md');
  if (!version) {
    process.stderr.write('usage: release-notes-gate.mjs <version> [notesPath]\n');
    process.exit(2);
  }
  const md = existsSync(notesPath) ? readFileSync(notesPath, 'utf8') : '';
  const res = checkReleaseNotes(md, version);
  if (!res.ok) {
    process.stderr.write(`[release-notes-gate] ${res.reason}\n`);
    process.exit(1);
  }
  process.stdout.write(
    `[release-notes-gate] OK — RELEASE_NOTES.md leads with ${String(version).replace(/^v/, '')}\n`,
  );
}
