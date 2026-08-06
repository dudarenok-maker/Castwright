#!/usr/bin/env node
/* #2137 — the published GitHub release body and the guarded release-notes
   file were two different strings with nothing checking they agree.

   `.github/workflows/release.yml`'s "Guard — committed release notes are
   real" step (scripts/release-notes-gate.mjs) validates RELEASE_NOTES.md and
   docs/release-notes-next.md as committed at the tag ref — but the string
   that actually gets PUBLISHED is `git tag -l --format='%(contents)'`, the
   annotated tag's own message. Nothing checked the two agree, and #1956/
   #2018/#2114's BOM / conflict-marker / mojibake checks never ran against
   the annotation at all.

   Measured facts (re-derived on `main` @ f31da8c2, do not re-derive):
   - `%(contents)` appends exactly one trailing newline — a normalised
     (CRLF -> LF, trailing-whitespace-stripped) comparison is required; raw
     byte-equality would fail on every release.
   - Across the last 10 tags, 9 are byte-equal after normalising. v1.8.0
     genuinely diverges: its annotation is the bare placeholder
     `Castwright v1.8.0\n` (bump-version.mjs's --notes-file-less fallback),
     while docs/release-notes-next.md at that ref was 3,060 bytes of the
     PREVIOUS cycle's stale notes (still headed `# Castwright v1.7.0`).
     Preferring the file there would have published v1.7.0's notes as the
     v1.8.0 body — so neither source is preferred automatically; a genuine
     divergence fails closed instead.

   The rule:
     1. Validate the annotation with the same BOM / conflict-marker /
        mojibake checks release-notes-gate.mjs already runs against the
        notes files — labelled as the annotation, not a file. Fail closed.
     2. docs/release-notes-next.md absent -> body = the annotation
        (the placeholder-tag path, unchanged).
     3. Present and normalised-equal to the annotation -> body = the FILE.
        This is the point of the change: the published artifact becomes the
        guarded one, not a second, unchecked copy of the same text.
     4. Present and differs -> fail closed, naming both sources and their
        sizes. Every hazard (a --notes-file pointing elsewhere, a hand-
        amended annotation, the real v1.8.0 stale-file shape) collapses into
        this one branch rather than getting its own heuristic; bump-
        version.mjs's release-notes-next-version: pre-flight owns staleness
        detection at cut time, not this script. */

import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import {
  checkBOM,
  checkConflictMarkers,
  checkMojibake,
  formatHonouredEcho,
} from './release-notes-gate.mjs';

export const DEFAULT_NOTES_FILE = 'docs/release-notes-next.md';
export const ANNOTATION_LABEL = 'the tag annotation';

/** Normalise for the divergence comparison: CRLF -> LF, then strip trailing
 *  whitespace from the whole string. `%(contents)` appends exactly one
 *  trailing newline that the source file never had — a raw byte comparison
 *  would fail on every release, per the measured facts above. */
export function normalise(text) {
  return String(text ?? '')
    .replace(/\r\n/g, '\n')
    .replace(/\s+$/, '');
}

/** `git tag -l --format='%(contents)' <tag>` — the exact string
 *  release.yml's "Create GitHub Release" step publishes as the body. */
export function readTagAnnotation(repoRoot, tag) {
  return execFileSync('git', ['tag', '-l', '--format=%(contents)', tag], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
}

/**
 * Decide the release body and validate it. Pure — takes the already-read
 * annotation and (maybe) file text so it's testable without a real git tag
 * or filesystem read.
 *
 * Returns `{ ok: true, body, echo, source }` or `{ ok: false, reason, echo }`.
 * `echo` (possibly null) is the "an armed mojibake-allowlist marker is never
 * silent" line (#1990) — a caller should print it whenever non-null,
 * regardless of `ok`, matching release-notes-gate.mjs's own CLI. `source` is
 * `'annotation'` (Rule 2) or `'file'` (Rule 3) — an explicit label rather
 * than something a caller re-derives by comparing `body` against `annotation`
 * by value, which would mislabel itself in the near-unreachable case where
 * the file and annotation happen to be byte-identical.
 */
export function resolveReleaseBody({ annotation, fileExists, fileText, notesLabel = DEFAULT_NOTES_FILE }) {
  // #2168 review, Important 1 — compute the mojibake check + echo FIRST,
  // before either check below that can exit early, so "an armed marker is
  // never silent" holds even on a run that fails for a DIFFERENT reason
  // (BOM or a conflict marker). Mirrors release-notes-gate.mjs's own CLI
  // ordering, which states this is load-bearing, not incidental (PR #2049
  // review, F5): a file carrying both a conflict marker and an armed marker
  // must not die naming only the conflict with the armed marker never
  // echoed. This script is the ONLY place an armed marker in an annotation
  // can ever be surfaced — the gate never reads the annotation at all, and
  // the Rule-2 (file-absent) path has no file to echo from either. Which
  // check FAILS the run is unchanged (BOM, then conflict, then mojibake) —
  // only the echo's computation moves earlier.
  const mojibakeRes = checkMojibake(annotation, ANNOTATION_LABEL);
  const echo = formatHonouredEcho(ANNOTATION_LABEL, mojibakeRes.honoured);

  // Rule 1 — validate the annotation itself, unconditionally, before either
  // source is even compared. Labelled as the annotation so a failure never
  // reads as if a file was the problem.
  const bomRes = checkBOM(annotation, ANNOTATION_LABEL);
  if (!bomRes.ok) return { ok: false, reason: bomRes.reason, echo };

  const conflictRes = checkConflictMarkers(annotation, ANNOTATION_LABEL);
  if (!conflictRes.ok) return { ok: false, reason: conflictRes.reason, echo };

  if (!mojibakeRes.ok) return { ok: false, reason: mojibakeRes.reason, echo };

  // Rule 2 — no file to compare against: the placeholder-tag path.
  if (!fileExists) {
    return { ok: true, body: annotation, echo, source: 'annotation' };
  }

  // Rule 3 — the normal case: file and annotation agree, publish the
  // guarded file rather than the unchecked annotation copy.
  if (normalise(fileText) === normalise(annotation)) {
    return { ok: true, body: fileText, echo, source: 'file' };
  }

  // Rule 4 — genuine divergence. Fail closed; name both sources and sizes,
  // prefer neither (see the v1.8.0 measured fact above).
  const fileBytes = Buffer.byteLength(fileText ?? '', 'utf8');
  const annotationBytes = Buffer.byteLength(annotation ?? '', 'utf8');
  return {
    ok: false,
    echo,
    reason:
      `${notesLabel} and ${ANNOTATION_LABEL} disagree after normalising (CRLF -> LF, trailing ` +
      `whitespace stripped) — ${notesLabel} is ${fileBytes} byte(s), ${ANNOTATION_LABEL} is ` +
      `${annotationBytes} byte(s). The published release body must match the guarded release ` +
      `notes exactly, and neither source is preferred automatically (a stale file has shipped as ` +
      `the release body before — v1.8.0). Re-cut the tag with --notes-file pointing at the current ` +
      `${notesLabel}, or reconcile whichever side is stale before publishing.`,
  };
}

function repoRootFromHere() {
  return resolve(dirname(fileURLToPath(import.meta.url)), '..');
}

// CLI: node scripts/release-body.mjs <tag> <outputPath>
const invokedHref = process.argv[1] ? pathToFileURL(realpathSync(process.argv[1])).href : '';
if (invokedHref && import.meta.url === invokedHref) {
  const tag = process.argv[2];
  const outPath = process.argv[3];
  if (!tag || !outPath) {
    process.stderr.write('usage: release-body.mjs <tag> <outputPath>\n');
    process.exit(2);
  }

  const repoRoot = repoRootFromHere();
  const annotation = readTagAnnotation(repoRoot, tag);
  const notesPath = resolve(repoRoot, DEFAULT_NOTES_FILE);
  const fileExists = existsSync(notesPath);
  const fileText = fileExists ? readFileSync(notesPath, 'utf8') : '';

  const res = resolveReleaseBody({
    annotation,
    fileExists,
    fileText,
    notesLabel: DEFAULT_NOTES_FILE,
  });
  if (res.echo) process.stdout.write(`${res.echo}\n`);
  if (!res.ok) {
    process.stderr.write(`[release-body] ${res.reason}\n`);
    process.exit(1);
  }

  writeFileSync(resolve(outPath), res.body, 'utf8');
  // #2168 review, Minor 4 — label from resolveReleaseBody's own explicit
  // `source`, not re-derived by comparing res.body === annotation, which
  // would mislabel itself if the file ever happened to be byte-identical to
  // the annotation. Minor 5 — the operator's only way to sanity-check the
  // published body against `git show <tag>:docs/release-notes-next.md`
  // (on-box register row G2) without a full `cat` of a body that can run to
  // tens of KB.
  const sourceLabel = res.source === 'annotation' ? ANNOTATION_LABEL : DEFAULT_NOTES_FILE;
  const bodyBytes = Buffer.byteLength(res.body, 'utf8');
  process.stdout.write(
    `[release-body] OK — wrote ${outPath} from ${sourceLabel} (${bodyBytes} bytes)\n`,
  );
}
