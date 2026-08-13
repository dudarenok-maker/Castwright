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

import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDirectlyInvoked } from './lib/is-main-module.mjs';

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

/* How many of a match's characters are actually double-encoded, measured at
   match time from the reversed bytes themselves (#1982). Each chunk character
   maps to exactly one windows-1252 byte, so walking the leading multi-byte
   sequences byte-by-byte — 0xC2-0xDF spans 2, 0xE0-0xEF spans 3, 0xF0-0xF4
   spans 4 — gives the length in characters exactly. The walk continues while
   the next byte is itself >= 0x80, because a greedy 4-character match can hold
   TWO mangles (`É™` + `Â©`), not one mangle plus ASCII context; stopping at the
   first sequence would let an allowlist entry covering only the first half
   drop the second half with it. */
function coreLengthOf(bytes) {
  let n = 0;
  while (n < bytes.length && bytes[n] >= 0x80) {
    n += bytes[n] >= 0xf0 ? 4 : bytes[n] >= 0xe0 ? 3 : 2;
  }
  return Math.min(n, bytes.length);
}

/**
 * Find double-UTF-8-encoded "mojibake" spans in `text`: runs of characters
 * that are exactly what you get when correct UTF-8 bytes are misread as
 * windows-1252 and re-encoded as UTF-8. Scans greedily, longest-match first
 * (up to 4 chars — the longest a UTF-8 sequence gets), and only accepts a
 * span whose windows-1252 byte values decode as *valid* UTF-8 starting with
 * a genuine multi-byte lead byte (0xC2-0xF4). Each hit carries `index` (its
 * character offset into `text`) and `coreLength` alongside `chunk` and
 * `decoded`, so a caller can reason about WHERE a span sits and how much of it
 * is actually mangled, not only what it looks like.
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
        hits.push({ index: i, chunk, decoded, coreLength: coreLengthOf(bytes) });
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
   the exact literal(s) to accept; CONTRIBUTING.md's "Release notes" section
   carries a copy-pasteable example (deliberately NOT reproduced here, since
   this file is not the one being gated but the docs it describes are — the
   gate never reads CONTRIBUTING.md, so documenting the syntax there can never
   arm it).

   Chosen over an env-var kill switch because it is span-scoped (the gate stays
   live everywhere else in the same file), it travels in the same commit as the
   text that needs it, and it is auditable in the diff. An HTML comment renders
   as nothing on the releases page, which matters because docs/release-notes-
   next.md ships verbatim into the tag annotation. Literals are exact strings —
   no wildcards, no regex — and must each be a single whitespace-free word (see
   allowedRanges).

   A marker is legal ONLY in docs/release-notes-next.md (#1985). It is cleared
   by hand in the first PR after a cut, which happens to drop any marker in it
   along with the rest of the body — so a marker there self-expires. A marker
   in RELEASE_NOTES.md would not: that file is cumulative and never reset, so
   it would keep that literal excused for every future release with nothing to
   remove it. checkMojibake below refuses outright (does not merely warn) when
   it finds a marker in RELEASE_NOTES.md.

   One fail-closed bound remains (#1982): a marker must be self-contained on
   ONE line. Scanning to the next `-->` anywhere in the file let a marker
   missing its terminator swallow the prose after it and harvest every
   unrelated `"…"` in it as a literal.

   There is deliberately NO fence-awareness (#1990). An earlier version skipped
   markers inside a backtick-fenced code block, on the theory that documenting
   the syntax in a gated file could not then arm it. In practice the skip only
   tracked ``` fences by parity: a `~~~` fence, a four-space-indented block, a
   fence inside a blockquote, or even just an earlier line merely *starting*
   with a backtick fence (flipping the parity) all left a marker armed anyway —
   proper fence tracking is a markdown-parsing problem this gate has no
   business owning, and every patch would leave another shape. Instead: every
   marker anywhere in the file is honoured, full stop, and checkMojibake makes
   that safe by echoing every marker it honours on every run (pass or fail) —
   see formatHonouredEcho — so an accidental arming is visible, never silent. */
const ALLOW_MARKER_RE = /<!--[ \t]*release-notes-gate:[ \t]*allow\b([^\n\r]*?)-->/g;
const ALLOW_LITERAL_RE = /"([^"]*)"/g;

/** Collect every literal named by an allowlist marker in `text` (markers and
    literals-per-marker are both many-per-file). A marker never spans a line
    break — see ALLOW_MARKER_RE above — but otherwise every marker in the file
    is honoured; there is no fence exemption (#1990, see the comment above). */
export function parseMojibakeAllowlist(text) {
  const literals = [];
  for (const marker of String(text ?? '').matchAll(ALLOW_MARKER_RE)) {
    for (const lit of marker[1].matchAll(ALLOW_LITERAL_RE)) {
      if (lit[1].length > 0) literals.push(lit[1]);
    }
  }
  return literals;
}

/** The one file a marker is refused in outright (#1985): RELEASE_NOTES.md is
    cumulative and never mechanically reset, so a marker there would excuse
    its literal for every future release with nothing to expire it. Matched by
    basename so a caller passing a full path (as the CLI below does for a
    custom notesPath) is still recognised when the case matches exactly.
    The comparison is case-SENSITIVE (PR #2007 review, Minor 8): on a
    case-insensitive filesystem (Windows), a caller passing e.g.
    `./release_notes.md` reads the real cumulative file's bytes but is
    labelled with the lowercase spelling, so this refusal would not fire for
    it. Accepted as-is rather than lowercasing the comparison: neither real
    call site can produce that shape — release.yml passes no path (the CLI
    default resolves the exact `RELEASE_NOTES.md` spelling) and
    bump-version.mjs hardcodes the literal `'RELEASE_NOTES.md'` label for its
    own check — so it takes a deliberate, non-canonical invocation to reach. */
function isCumulativeReleaseNotesFile(label) {
  return basename(String(label ?? '')) === 'RELEASE_NOTES.md';
}

/** Whether `text` contains a release-notes-gate allow marker AT ALL, even one
    naming no literal (found by the PR #2007 review, Minor 6). The refusal
    below must cover "any marker" — that is what CONTRIBUTING.md's "Release
    notes" section and the header comment above both promise — not merely
    "any marker that happens to parse a quoted literal." Reuses
    ALLOW_MARKER_RE via matchAll rather than a bare regex.test(), which would
    mutate the shared, module-level regex's lastIndex (it carries the `g`
    flag) and could make a later call silently start mid-string. */
function hasAnyAllowMarker(text) {
  return [...String(text ?? '').matchAll(ALLOW_MARKER_RE)].length > 0;
}

/** The "how to get out" tail for any RELEASE_NOTES.md mojibake failure —
    shared by the outright marker refusal below and the no-marker-yet hits
    branch in checkMojibake, so the two wordings can't drift (same rationale
    as formatHonouredEcho). Re-encoding is named FIRST and --force is scoped
    to bump-version.mjs (PR #2007 review, Minor 5): `--force` is a
    bump-version.mjs flag, but release.yml's own "Guard — committed release
    notes are real" step invokes this gate's CLI directly with no bypass of
    its own, which is where a hand-cut tag's failure most often actually
    lands. */
function reencodeOrForceAdvice(label) {
  return (
    `Re-encode the offending text in ${label} so it no longer flags. bump-version.mjs's own copy ` +
    `of this check additionally accepts --force to downgrade it to a warning for one release — ` +
    `but that flag is bump-version.mjs-only; release.yml invokes this gate directly with no ` +
    `bypass, so re-encoding is the only way out there.`
  );
}

/* #2114 — a UTF-8 byte-order mark (U+FEFF, encoded EF BB BF) must never lead
   a published release-notes file. `readFileSync(path, 'utf8')` does NOT strip
   a BOM — it survives as the literal first character of the string — and
   docs/release-notes-next.md is fed verbatim into the annotated tag message,
   which release.yml publishes as the public GitHub release body. The file's
   opening ~39 lines are an internal maintainer HTML comment whose invisibility
   depends on `<!--` starting the line per CommonMark's HTML-block start
   condition; a leading BOM may defeat that condition and leak the comment
   into the published body. Not hypothetical: a branch in the #2040 follow-up
   wave committed exactly this (`3c 21 2d 2d` → `ef bb bf 3c`) and every gate
   at the time — including this one, pre-fix — was green.

   On Windows this is easy to introduce by accident: PowerShell's `Out-File`,
   `>` and `>>` default to UTF-8-WITH-BOM. Deliberately no allowlist and no
   --force downgrade (same posture as checkConflictMarkers below): there is no
   legitimate reason for a BOM to lead this file, so every call site treats a
   hit as unconditional. */
// Built via fromCharCode rather than an embedded literal so the character
// never appears as raw source bytes in a file that specifically exists to
// catch invisible-Unicode defects like this one.
const BOM = String.fromCharCode(0xfeff);

/** Whether `text`'s first character is a UTF-8 byte-order mark. A plain
    string comparison is exact here (not a normalisation that could paper
    over the defect): `readFileSync(path, 'utf8')` decodes the `EF BB BF`
    byte sequence to the single code point U+FEFF and does not strip it, so
    `text[0] === BOM` is checking the same bytes the published artifact would
    carry. */
export function hasBOM(text) {
  return String(text ?? '').startsWith(BOM);
}

/** Strip a single leading BOM, if present. Used defensively at the point a
    file's content becomes a published artifact (bump-version.mjs's tag
    message), independent of whether a gate already refused to reach there —
    belt-and-suspenders so a future change to (or bypass of) the gate still
    can't let a BOM through. */
export function stripBOM(text) {
  const s = String(text ?? '');
  return hasBOM(s) ? s.slice(BOM.length) : s;
}

/** Check that `label`'s text does not begin with a UTF-8 byte-order mark.
    No allowlist, no --force override — see the header comment above. */
export function checkBOM(text, label) {
  if (!hasBOM(text)) return { ok: true, reason: '' };
  return {
    ok: false,
    reason:
      `${label} begins with a UTF-8 byte-order mark (U+FEFF / EF BB BF). This can defeat the ` +
      `CommonMark HTML-block start condition that keeps ${label}'s internal maintainer comment ` +
      `invisible on the published release, and there is no allowlist or --force override for this ` +
      `check (#2114) — a BOM has no legitimate reason to lead this file. Re-save it as UTF-8 ` +
      `WITHOUT a BOM: on Windows, PowerShell's Out-File / > / >> default to UTF-8-with-BOM, so a ` +
      `plain redirect reintroduces this easily — write via Node (fs.writeFileSync(path, text, ` +
      `'utf8') never emits one) or an editor's explicit "UTF-8" (no BOM) save option instead.`,
  };
}

/* #2018 — unresolved git conflict markers must never reach a published
   release. Not hypothetical: a `git merge origin/main` on the branch for PR
   #2010 left three markers inside RELEASE_NOTES.md's own v1.15.0 section, and
   every gate that existed at the time — including this one — was green; it
   was caught only because a reviewer read the merge commit's diff by hand.

   Anchored on the `<<<<<<< ` / `>>>>>>> ` PAIR (each with its mandatory
   trailing space) rather than also trying to match a bare `=======`: a lone
   `=======` line is a legitimate markdown setext heading underline, but git
   always appends a ref label after the space on its two outer markers, so
   `<<<<<<< ` and `>>>>>>> ` are never legitimate release-note prose. Matching
   only the pair that can never false-positive is enough to catch every real
   conflict — git never emits one marker without the other. */
const CONFLICT_START_RE = /^<{7} /;
const CONFLICT_END_RE = /^>{7} /;

/** Find every unresolved git conflict marker line in `text`. Returns one
    `{ line, text }` per hit, `line` 1-indexed to match an editor's line
    numbers. */
export function findConflictMarkers(text) {
  const lines = String(text ?? '').split(/\r?\n/);
  const hits = [];
  lines.forEach((line, i) => {
    if (CONFLICT_START_RE.test(line) || CONFLICT_END_RE.test(line)) {
      hits.push({ line: i + 1, text: line });
    }
  });
  return hits;
}

/**
 * Check that `label`'s text contains no unresolved git conflict markers.
 *
 * Deliberately no allowlist and no downgrade path (#2018): unlike
 * checkMojibake, there is no legitimate reason for one of these two lines to
 * appear in a shipped release-notes file, so every call site treats a
 * failure here as unconditional — see this file's CLI and
 * bump-version.mjs's pre-flights 5d/6a, all of which refuse regardless of
 * --force or --dry-run.
 */
export function checkConflictMarkers(text, label) {
  const hits = findConflictMarkers(text);
  if (hits.length === 0) return { ok: true, reason: '' };
  const lines = hits.map((h) => h.line).join(', ');
  return {
    ok: false,
    reason:
      `${label} contains ${hits.length} unresolved git conflict marker(s) at line(s) ${lines}. ` +
      `Resolve the conflict and remove the markers before this can ship — there is no allowlist ` +
      `or --force override for this check (#2018).`,
  };
}

/** Render the "an armed marker is never silent" echo line (#1990) for a file
    that honoured at least one marker literal, or `null` when it honoured none
    — the caller should print the line only when it is non-null. Shared by
    every call site (this file's CLI and bump-version.mjs) so the wording
    can't drift between them. */
export function formatHonouredEcho(label, honoured) {
  if (!honoured || honoured.length === 0) return null;
  const list = honoured.map((l) => JSON.stringify(l)).join(', ');
  return `[allow] ${label} honoured ${honoured.length} literal(s): ${list}`;
}

/** Half-open [start, end) character ranges of every real occurrence of every
    allowlisted literal. A literal naming text that isn't in the file yields no
    range, and so suppresses nothing.

    A literal containing ANY whitespace yields no range either (#1982 round 2).
    isExcused only requires the occurrence to extend one CHARACTER past the
    span, but the rule it is meant to encode — and the one the docs and the
    failure message both state — is that it extends into the surrounding WORD.
    Those differ by exactly one space, and the dominant #1956 shape is a mangle
    standing between spaces: measured on the real 242-span file, a literal of
    `" —"` (a space plus the flagged pair) excused 155 spans on its own, all
    242 were suppressible, and 31 hand-written markers reached green. Requiring
    a whitespace-free token closes that: the only literals that can excuse
    anything are the ones suggestLiteral already emits, which is what makes a
    standalone span genuinely un-allowlistable. Filtering here rather than in
    parseMojibakeAllowlist keeps the parser's return shape (every literal a
    marker names) intact.

    suggestLiteral applies the SAME predicate, so the gate can never print a
    marker line this loop would then throw away. Keep them sharing hasWhitespace
    rather than each spelling the test out — a producer/consumer pair that
    drifts is how a printed-but-inert suggestion gets back in. */
const hasWhitespace = (literal) => [...literal].some((c) => c.trim() === '');

function allowedRanges(text, literals) {
  const ranges = [];
  for (const literal of literals) {
    if (hasWhitespace(literal)) continue;
    for (let at = text.indexOf(literal); at !== -1; at = text.indexOf(literal, at + 1)) {
      ranges.push([at, at + literal.length]);
    }
  }
  return ranges;
}

/**
 * A literal excuses the span at [start, end) only when its range COVERS the
 * span and EXTENDS STRICTLY BEYOND it on at least one side (#1982).
 *
 * That rule is not a heuristic — it encodes why a false positive is legitimate
 * in the first place. The detector only fires when a Latin-1 letter sits
 * immediately adjacent to punctuation, so genuinely-legitimate text always
 * carries the surrounding characters that made it legitimate (`CAFÉ` in front
 * of the flagged `É™`, `gro` in front of the flagged `ß—`). A span with nothing
 * around it is, by construction, a real mangle — and must not be allowlistable
 * at all. Merely COVERING the span was the earlier rule, and it let a marker
 * naming the two flagged characters alone excuse them at every occurrence in
 * the file, which is exactly the file-wide blindness #1956 needs to stay
 * impossible.
 *
 * "Standalone is not allowlistable" only actually holds because allowedRanges
 * drops any literal containing whitespace. This function alone asks for one
 * CHARACTER of extension; the property above needs one WORD of it, and the
 * difference is exactly the adjacent space a standalone span sits between.
 * The two halves of the rule live apart — read them together.
 */
function isExcused(ranges, start, end) {
  return ranges.some(([from, to]) => from <= start && to >= end && (from < start || to > end));
}

/**
 * The whitespace-delimited token around a hit, IF that token would be a valid
 * allowlist literal for it — i.e. it strictly extends past the span (see
 * isExcused) and would not break the marker's own syntax.
 *
 * Returns `{ literal }` when one exists, and otherwise `{ literal: null,
 * why }` naming WHICH of three very different reasons applies (#1982 round 2).
 * They are not interchangeable and the advice differs:
 *
 * - `'standalone'` — the span IS the whole token. There is no surrounding
 *   context, no legal literal exists for it at all, and that is itself the
 *   evidence it is a genuine mangle.
 * - `'unquotable'` — context exists, but the token carries a `"` or a `-->`,
 *   either of which would terminate the marker's own quoting. The right advice
 *   is to reword, not "there's nothing around it".
 * - `'straddles'` — the span itself contains a whitespace character, so EVERY
 *   literal containing it contains whitespace and allowedRanges drops them all.
 *   This is not hypothetical: a doubly-encoded NBSP is `Â` + NBSP, and a
 *   doubly-encoded Cyrillic `Р` is `Ð` + NBSP, so the shape shows up in exactly
 *   the corrupted files this gate was built for. Without this branch the gate
 *   would print a marker line that its own allowlist then throws away.
 */
function suggestLiteral(text, hit) {
  const start = hit.index;
  const end = hit.index + hit.coreLength;
  let left = start;
  let right = end;
  while (left > 0 && !/\s/.test(text[left - 1])) left--;
  while (right < text.length && !/\s/.test(text[right])) right++;
  if (left === start && right === end) return { literal: null, why: 'standalone' };
  const token = text.slice(left, right);
  if (hasWhitespace(token)) return { literal: null, why: 'straddles' };
  if (token.includes('"') || token.includes('-->')) return { literal: null, why: 'unquotable' };
  return { literal: token, why: null };
}

/**
 * Check that `label`'s text contains no double-UTF-8-encoded mojibake.
 *
 * Suppression is POSITIONAL, not by substring (#1973): a span is dropped only
 * when it sits inside a real occurrence of an allowlisted literal in this same
 * text. Suppressing every span whose characters merely appear somewhere in an
 * allowlisted literal would let a genuinely corrupted `É™` elsewhere in the
 * file go unreported — quietly reintroducing #1956, which is the whole reason
 * this gate exists. And the occurrence must extend beyond the span (#1982, see
 * isExcused), so a marker naming only the flagged characters excuses nothing.
 * The marker line contains the literal with its own quotes around it, so the
 * marker's own occurrence still excuses itself; that falls out of the rule
 * rather than being special-cased.
 *
 * The return also carries `honoured`: every literal parseMojibakeAllowlist
 * found in `text` (empty when `label` is the refused RELEASE_NOTES.md case
 * below). A caller prints it via formatHonouredEcho on EVERY run, pass or
 * fail (#1990) — the property that replaces fence-awareness is "an armed
 * marker is never silent," not "some markers don't count."
 */
export function checkMojibake(text, label) {
  const s = text ?? '';
  const literals = parseMojibakeAllowlist(s);

  // #1985 — RELEASE_NOTES.md is cumulative and never mechanically reset, so a
  // marker there would excuse its literal forever with nothing to expire it.
  // Refuse outright rather than silently honouring or merely reporting it —
  // an ignored marker would read to the author as "my marker worked". Gated
  // on hasAnyAllowMarker, not literals.length, so a marker naming no literal
  // at all is refused too (PR #2007 review, Minor 6).
  if (hasAnyAllowMarker(s) && isCumulativeReleaseNotesFile(label)) {
    const named = literals.length > 0 ? ` naming ${literals.map((l) => JSON.stringify(l)).join(', ')}` : '';
    return {
      ok: false,
      honoured: [],
      reason:
        `${label} contains a release-notes-gate allowlist marker${named}, but markers are refused ` +
        `in ${label} (#1985): it is cumulative and never reset, so a marker there would keep any ` +
        `literal it names excused for every future release with nothing to remove it. ` +
        reencodeOrForceAdvice(label),
    };
  }

  const ranges = allowedRanges(s, literals);
  const hits = findMojibake(s).filter((h) => !isExcused(ranges, h.index, h.index + h.coreLength));
  if (hits.length === 0) return { ok: true, reason: '', honoured: literals };
  const sample = hits
    .slice(0, 5)
    .map((h) => `${JSON.stringify(h.chunk)} (should be ${JSON.stringify(h.decoded)})`)
    .join(', ');
  const more = hits.length > 5 ? `, +${hits.length - 5} more` : '';

  // PR #2007 review, Major 1 — this label can never legally take a marker
  // (#1985), so never dangle a paste-able "add this line to RELEASE_NOTES.md"
  // suggestion here either: following it verbatim would just hit the refusal
  // above on the very next run. Short-circuit before the suggestion logic
  // below, which exists only to build that paste-able line.
  if (isCumulativeReleaseNotesFile(label)) {
    return {
      ok: false,
      honoured: literals,
      reason:
        `${label} contains ${hits.length} double-UTF-8-encoded mojibake span(s): ${sample}${more}. ` +
        `A release-notes-gate allowlist marker cannot be used to excuse this, even for a ` +
        `genuinely legitimate span (#1973): markers are refused outright in ${label} (#1985). ` +
        reencodeOrForceAdvice(label),
    };
  }

  let suggestion = null;
  const why = new Set();
  for (const h of hits) {
    const s2 = suggestLiteral(s, h);
    if (s2.literal) {
      suggestion = s2.literal;
      break;
    }
    why.add(s2.why);
  }
  /* When nothing is suggestible, say WHICH reason applies rather than
     defaulting to the standalone sentence for all of them (#1982 round 2, F4):
     "no surrounding context to name" is plainly false of `He said "CAFÉ™"`,
     where the context exists and simply cannot be quoted. */
  const REASON = {
    standalone: 'stand alone between spaces, with no surrounding word to name',
    unquotable:
      'sit inside a word carrying a double-quote or "-->", which would terminate the ' +
      "marker's own quoting",
    straddles:
      'straddle a whitespace character themselves, so no literal containing them is ' +
      'whitespace-free',
  };
  const advice = suggestion
    ? `add this line to ${label}: <!-- release-notes-gate: allow "${suggestion}" --> — it excuses ` +
      `only the span inside that literal, at every occurrence of the literal in this file.`
    : `none of the spans above can be allowlisted at all — they ` +
      `${[...why].map((w) => REASON[w]).join('; and they ')}. ` +
      `Re-encode the file${why.has('unquotable') ? ', or reword the offending word' : ''}.`;
  return {
    ok: false,
    honoured: literals,
    reason:
      `${label} contains ${hits.length} double-UTF-8-encoded mojibake span(s): ${sample}${more}. ` +
      `Re-encoding the file is the ordinary fix (see #1956). If a span is legitimate text and not ` +
      `a mangle (#1973), allow it by naming a literal that is a SINGLE WHITESPACE-FREE WORD ` +
      `CONTAINING the span and extending past it on at least one side — a literal that contains ` +
      `whitespace, or that names only the flagged characters, suppresses NOTHING ` +
      `(#1982), because a literal is excused at every occurrence and a span with nothing around ` +
      `it is by construction a real mangle. To do that here, ${advice}`,
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
if (isDirectlyInvoked(import.meta.url)) {
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

  // Mojibake guard (#1956) + conflict-marker guard (#2018): both cover
  // RELEASE_NOTES.md (this run's notesPath) AND docs/release-notes-next.md —
  // the technical notes bump-version.mjs feeds verbatim into the tag
  // annotation / GitHub release body.
  const gatedTargets = new Map([
    [notesPath, notesPath === resolve(repoRootFromHere(), 'RELEASE_NOTES.md') ? 'RELEASE_NOTES.md' : notesPath],
    [resolve(repoRootFromHere(), 'docs/release-notes-next.md'), 'docs/release-notes-next.md'],
  ]);
  for (const [targetPath, label] of gatedTargets) {
    if (!existsSync(targetPath)) continue;
    const text = readFileSync(targetPath, 'utf8');

    // #1990 — compute the mojibake check and echo any honoured marker BEFORE
    // either failure branch below (#2018's conflict check included), so "an
    // armed marker is never silent" holds even on a run that fails for a
    // DIFFERENT reason. This ordering is load-bearing, not incidental (PR
    // #2049 review, F5): #2018 added the conflict check as a new early exit
    // in this same PR, and it originally sat ahead of this block — a file
    // carrying both a conflict marker and an armed marker died naming only
    // the conflict, with the armed marker never echoed that run.
    // "Reaches" matters (PR #2007 review, Minor 3): this loop exits the
    // whole process on the first failing target, so a marker armed in a
    // LATER target on a run where an earlier one fails is never echoed on
    // that run — publication is blocked either way, so this doesn't
    // reintroduce a silent arming, but it does mean "every run" is not
    // literally every run.
    const mojibakeRes = checkMojibake(text, label);
    const echo = formatHonouredEcho(label, mojibakeRes.honoured);
    if (echo) process.stdout.write(`${echo}\n`);

    // #2018 — unconditional: no allowlist, no --force, markers are never
    // legitimate content.
    const conflictRes = checkConflictMarkers(text, label);
    if (!conflictRes.ok) {
      process.stderr.write(`[release-notes-gate] ${conflictRes.reason}\n`);
      process.exit(1);
    }

    // #2114 — unconditional, same posture as the conflict-marker check above:
    // no allowlist, no --force, a BOM is never legitimate here.
    const bomRes = checkBOM(text, label);
    if (!bomRes.ok) {
      process.stderr.write(`[release-notes-gate] ${bomRes.reason}\n`);
      process.exit(1);
    }

    if (!mojibakeRes.ok) {
      process.stderr.write(`[release-notes-gate] ${mojibakeRes.reason}\n`);
      process.exit(1);
    }
  }

  process.stdout.write(
    `[release-notes-gate] OK — RELEASE_NOTES.md leads with ${String(version).replace(/^v/, '')}\n`,
  );
}
