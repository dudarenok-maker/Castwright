#!/usr/bin/env node
/* fe-37 release gate — a placeholder or wrong-version user-facing release-notes
   file must never reach a published release. Shared by two enforcement points:
   - scripts/bump-version.mjs pre-flight (refuses to create the tag), and
   - .github/workflows/release.yml (refuses to publish a hand-cut tag).

   The user-facing notes are the committed, brand-voice RELEASE_NOTES.md whose
   TOP section must lead with the release version. (The technical GitHub-body
   notes are a separate file fed to the tag annotation.)

   #1956 — the same two enforcement points also gate on a mojibake check
   (checkMojibake/findMojibake below), covering both RELEASE_NOTES.md and the
   technical docs/release-notes-next.md: the latter is fed verbatim into the
   annotated tag and IS the public GitHub release body, so a double-UTF-8
   encoding mangle there ships straight to the releases page. */

import { readFileSync, existsSync, realpathSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const PLACEHOLDER_RE = /See the GitHub release for details\./i;

// Reverse map: windows-1252 byte -> the character it decodes to. Windows
// PowerShell 5.1's Out-File/Set-Content default to the system ANSI codepage
// (cp1252 on this box), which is the likely source of #1956's corruption —
// reading correct UTF-8 bytes as cp1252 and re-encoding them as UTF-8 is
// exactly the "double-encoding" mangle this map lets us detect and reverse.
const CP1252_CHAR_TO_BYTE = (() => {
  const dec = new TextDecoder('windows-1252');
  const map = new Map();
  for (let b = 0; b < 256; b++) {
    const ch = dec.decode(Uint8Array.of(b));
    if (!map.has(ch)) map.set(ch, b);
  }
  return map;
})();
const UTF8_STRICT_DECODER = new TextDecoder('utf-8', { fatal: true });

/**
 * Find double-UTF-8-encoded "mojibake" spans in `text`: runs of characters
 * that are exactly what you get when correct UTF-8 bytes are misread as
 * windows-1252 and re-encoded as UTF-8. Scans greedily, longest-match first
 * (up to 4 chars — the longest a UTF-8 sequence gets), and only accepts a
 * span whose windows-1252 byte values decode as *valid* UTF-8 starting with
 * a genuine multi-byte lead byte (0xC2-0xF4); ordinary ASCII or already-correct
 * Unicode text never satisfies that, so this doesn't false-positive on real
 * accented characters or emoji.
 */
export function findMojibake(text) {
  const s = text ?? '';
  const hits = [];
  let i = 0;
  while (i < s.length) {
    let matched = false;
    for (let len = 4; len >= 2; len--) {
      if (i + len > s.length) continue;
      const chunk = s.slice(i, i + len);
      const bytes = [];
      let ok = true;
      for (const ch of chunk) {
        if (!CP1252_CHAR_TO_BYTE.has(ch)) {
          ok = false;
          break;
        }
        bytes.push(CP1252_CHAR_TO_BYTE.get(ch));
      }
      if (!ok || bytes[0] < 0xc2) continue;
      try {
        const decoded = UTF8_STRICT_DECODER.decode(Uint8Array.from(bytes));
        hits.push({ chunk, decoded });
        i += len;
        matched = true;
        break;
      } catch {
        // Not a valid UTF-8 byte sequence under this reinterpretation —
        // not mojibake, leave it alone.
      }
    }
    if (!matched) i++;
  }
  return hits;
}

/** Check that `label`'s text contains no double-UTF-8-encoded mojibake. */
export function checkMojibake(text, label) {
  const hits = findMojibake(text);
  if (hits.length === 0) return { ok: true, reason: '' };
  const sample = hits
    .slice(0, 5)
    .map((h) => `${JSON.stringify(h.chunk)} (should be ${JSON.stringify(h.decoded)})`)
    .join(', ');
  const more = hits.length > 5 ? `, +${hits.length - 5} more` : '';
  return {
    ok: false,
    reason:
      `${label} contains ${hits.length} double-UTF-8-encoded mojibake span(s): ${sample}${more}. ` +
      `Re-encode before tagging (see #1956).`,
  };
}

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

  // Mojibake guard (#1956): covers RELEASE_NOTES.md (this run's notesPath)
  // AND docs/release-notes-next.md — the technical notes bump-version.mjs
  // feeds verbatim into the tag annotation / GitHub release body.
  const mojibakeTargets = new Map([
    [notesPath, notesPath === resolve(repoRootFromHere(), 'RELEASE_NOTES.md') ? 'RELEASE_NOTES.md' : notesPath],
    [resolve(repoRootFromHere(), 'docs/release-notes-next.md'), 'docs/release-notes-next.md'],
  ]);
  for (const [targetPath, label] of mojibakeTargets) {
    if (!existsSync(targetPath)) continue;
    const mojibakeRes = checkMojibake(readFileSync(targetPath, 'utf8'), label);
    if (!mojibakeRes.ok) {
      process.stderr.write(`[release-notes-gate] ${mojibakeRes.reason}\n`);
      process.exit(1);
    }
  }

  process.stdout.write(
    `[release-notes-gate] OK — RELEASE_NOTES.md leads with ${String(version).replace(/^v/, '')}\n`,
  );
}
