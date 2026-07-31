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
 * a genuine multi-byte lead byte (0xC2-0xF4). Each hit carries `index` (its
 * character offset into `text`) alongside `chunk` and `decoded`, so a caller
 * can reason about WHERE a span sits and not only what it looks like.
 *
 * Two bounds on the heuristic, both measured in #1973. Neither is a defect in
 * the reverse-decode approach, but do not over-trust a result in either
 * direction:
 *
 * - **It false-positives on legitimate text.** The acceptance rule fires
 *   whenever a Latin-1 letter mapping to 0xC2-0xF4 (`Â Ã Ä Å Æ Ç È É … ß à á
 *   … ï ð ñ ò ó ô`) sits immediately adjacent — no space between — to one to
 *   three characters mapping to 0x80-0xBF (`— – … ™ • ‘ ’ “ ” § ° © « » ¡ ¿ ±
 *   µ ¶ ·`, and NBSP). Realistic shapes: `CAFÉ™`, a `groß—` construction,
 *   `Ålesund` beside punctuation. That is what checkMojibake's in-file
 *   allowlist marker exists for — see parseMojibakeAllowlist below.
 * - **It silently misses a LOSSY double-encode.** If the corrupting round-trip
 *   normalised a mojibake character away — `Â` + NBSP flattened to `Â` + a
 *   plain space — the reverse bytes are `C2 20`, which is not valid UTF-8, so
 *   the span never decodes and is never reported. A green gate is therefore
 *   evidence, not proof, that a file is clean.
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
        hits.push({ index: i, chunk, decoded });
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

/* #1973 — the allowlist marker. An HTML comment in the notes file itself names
   the exact literal(s) to accept:

     <!-- release-notes-gate: allow "CAFÉ™" -->

   Chosen over an env-var kill switch because it is span-scoped (the gate stays
   live everywhere else in the same file), it travels in the same commit as the
   text that needs it, it self-expires when docs/release-notes-next.md is reset
   at the next cut, and it is auditable in the diff. An HTML comment renders as
   nothing on the releases page, which matters because that file ships verbatim
   into the tag annotation. Literals are exact strings — no wildcards, no
   regex. */
const ALLOW_MARKER_RE = /<!--\s*release-notes-gate:\s*allow\b([\s\S]*?)-->/g;
const ALLOW_LITERAL_RE = /"([^"]*)"/g;

/** Collect every literal named by an allowlist marker in `text` (markers and
    literals-per-marker are both many-per-file). */
export function parseMojibakeAllowlist(text) {
  const s = text ?? '';
  const literals = [];
  for (const marker of s.matchAll(ALLOW_MARKER_RE)) {
    for (const lit of marker[1].matchAll(ALLOW_LITERAL_RE)) {
      if (lit[1].length > 0) literals.push(lit[1]);
    }
  }
  return literals;
}

/** Half-open [start, end) character ranges of every real occurrence of every
    allowlisted literal. A literal naming text that isn't in the file yields no
    range, and so suppresses nothing. */
function allowedRanges(text, literals) {
  const ranges = [];
  for (const literal of literals) {
    for (let at = text.indexOf(literal); at !== -1; at = text.indexOf(literal, at + 1)) {
      ranges.push([at, at + literal.length]);
    }
  }
  return ranges;
}

/**
 * Extract the whitespace-delimited token containing the mojibake span at `hit.index`.
 * If the token contains a double-quote, returns the bare core instead (to avoid
 * breaking the marker's literal syntax). If the span is already standalone (whitespace
 * on both sides), returns the span itself.
 */
function widenToToken(text, hit) {
  const core = hit.chunk.slice(0, mojibakeCoreLength(hit));
  let left = hit.index;
  let right = hit.index + core.length;

  // Expand left to the start of the token (stop at whitespace)
  while (left > 0 && !/\s/.test(text[left - 1])) {
    left--;
  }

  // Expand right to the end of the token (stop at whitespace)
  while (right < text.length && !/\s/.test(text[right])) {
    right++;
  }

  const token = text.slice(left, right);

  // If the token contains a double-quote, it would break the marker's literal syntax.
  // Fall back to the core to degrade safely.
  if (token.includes('"')) {
    return core;
  }

  return token;
}

/** Characters of a hit that are actually the double-encoded sequence.
    findMojibake matches greedily up to 4 characters, so a hit routinely carries
    trailing single-byte characters (a space, a quote) that are mere context —
    containment has to be judged on the sequence, not on that tail. Each chunk
    character maps to exactly one windows-1252 byte, so the decoded lead code
    point's UTF-8 byte length IS the sequence's length in characters. */
function mojibakeCoreLength(hit) {
  const lead = hit.decoded.codePointAt(0);
  if (lead < 0x800) return 2;
  if (lead < 0x10000) return 3;
  return 4;
}

/**
 * Check that `label`'s text contains no double-UTF-8-encoded mojibake.
 *
 * Suppression is POSITIONAL, not by substring (#1973): a span is dropped only
 * when it sits wholly inside a real occurrence of an allowlisted literal in
 * this same text. Suppressing every span whose characters merely appear
 * somewhere in an allowlisted literal would let a genuinely corrupted `É™`
 * elsewhere in the file go unreported — quietly reintroducing #1956, which is
 * the whole reason this gate exists. The marker line contains the literal, so
 * the marker's own occurrence suppresses itself; that falls out of the
 * positional rule rather than being special-cased.
 */
export function checkMojibake(text, label) {
  const s = text ?? '';
  const ranges = allowedRanges(s, parseMojibakeAllowlist(s));
  const hits = findMojibake(s).filter((h) => {
    const end = h.index + mojibakeCoreLength(h);
    return !ranges.some(([from, to]) => h.index >= from && end <= to);
  });
  if (hits.length === 0) return { ok: true, reason: '' };
  const sample = hits
    .slice(0, 5)
    .map((h) => `${JSON.stringify(h.chunk)} (should be ${JSON.stringify(h.decoded)})`)
    .join(', ');
  const more = hits.length > 5 ? `, +${hits.length - 5} more` : '';
  const literal = widenToToken(s, hits[0]);
  return {
    ok: false,
    reason:
      `${label} contains ${hits.length} double-UTF-8-encoded mojibake span(s): ${sample}${more}. ` +
      `Re-encode before tagging (see #1956). If a span is legitimate text and not a mangle ` +
      `(#1973), allow it by adding this line to ${label}: ` +
      `<!-- release-notes-gate: allow "${literal}" --> — this literal matches exactly, so it ` +
      `suppresses that span everywhere it occurs in this file. Widen to the surrounding word ` +
      `(e.g. "CAFÉ™" instead of "É™") to stay scoped to the legitimate use.`,
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
