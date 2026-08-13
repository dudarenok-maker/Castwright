// scripts/sync-agent-skills.mjs
//
// Mirrors .claude/skills/pr-review-gate/ into the cross-agent skill store at
// ~/.agents/skills/pr-review-gate/ — the ONLY location Cline (and reportedly
// five other agents sharing that store) resolves skills from. Verified
// 2026-08-13: see docs/testing/agent-skill-resolution-probe.md. Cline does
// not read this repo's workspace .claude/skills/ at all, so without this
// mirror the mandated PR review runbook is invisible to it.
//
// This is a PER-MACHINE step. CI cannot run it — the target lives under
// $HOME, which is absent on every fresh clone and every CI runner. Run
// `npm run skills:sync` after any change under .claude/skills/pr-review-gate/.
//
// Three encoding/format traps bit the original hand sync this script
// replaces. Each produces a file that LOOKS fine and is broken:
//   1. The provenance header must go BELOW the YAML frontmatter, not above
//      it — `---` must stay the literal first line of SKILL.md or the skill
//      becomes undiscoverable.
//   2. Read and write UTF-8 explicitly (readFileSync(p, 'utf8') /
//      writeFileSync(p, s, 'utf8')) — never shell out to PowerShell, whose
//      5.1 Get-Content reads UTF-8 as ANSI and turns every em-dash into
//      "â€"".
//   3. No BOM. A BOM before `---` breaks frontmatter parsing.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDirectlyInvoked } from './lib/is-main-module.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..');
const SKILL_NAME = 'pr-review-gate';
const CANONICAL_ROOT = join(REPO_ROOT, '.claude', 'skills', SKILL_NAME);
const MIRROR_ROOT = join(homedir(), '.agents', 'skills', SKILL_NAME);

const FILES = ['SKILL.md', 'references/reviewer-brief.md', 'references/findings-triage.md'];

// The provenance header's closing line, WITH its trailing newline. Module-local:
// it was briefly exported so the guard test could split a mirrored file on it,
// but the guard now compares against buildMirrorContent's own output instead,
// so nothing outside this file needs the marker.
const PROVENANCE_END = "     this file's location. Some point at sibling skills. -->\n";

function header(rel) {
  // <repo> is deliberately left as a literal placeholder, not the absolute
  // path of the machine that ran this sync: the header travels with the
  // mirror into every repo Cline reviews, but the body's relative links only
  // resolve inside a CASTWRIGHT checkout (they point at this repo's own
  // docs/skills, not at whatever repo the mirror happens to be read from) —
  // so the header says so explicitly rather than implying they resolve
  // wherever Cline is currently reviewing. A baked-in absolute path to THIS
  // machine's checkout would be actively wrong on every other machine the
  // mirror is synced to; <repo> stays a literal placeholder for that reason.
  return (
    '<!-- MIRRORED COPY — do not edit here.\n' +
    `     Canonical source: <repo>/.claude/skills/${SKILL_NAME}/${rel}\n` +
    '     Regenerate with `npm run skills:sync` from that repo.\n' +
    '     Relative links below resolve against a CASTWRIGHT CHECKOUT, not against\n' +
    PROVENANCE_END
  );
}

/**
 * Builds the mirrored file's full content: the canonical file with the
 * provenance header spliced in, placed so it never displaces a leading YAML
 * frontmatter block (trap 1).
 *
 * For a frontmatter-bearing file (SKILL.md) the header goes immediately AFTER
 * the closing `---`, so the frontmatter stays the literal first line (required
 * for the skill to be discoverable) and the rest of the document follows once.
 * An earlier version emitted the frontmatter, the header, and then the FULL
 * canonical content — duplicating the frontmatter block — purely so the guard
 * could compare `split(PROVENANCE_END)[1]` against the canonical file. That
 * put a repeated metadata block into the very file a reviewing agent reads, to
 * save the test one line. The guard now compares against this function's own
 * output instead (see review-gate-mechanism.test.mjs), which costs the test
 * nothing and keeps the artifact clean.
 */
export function buildMirrorContent(canonicalContent, rel) {
  const h = header(rel);
  if (canonicalContent.startsWith('---\n')) {
    const closeIdx = canonicalContent.indexOf('\n---\n', 4);
    if (closeIdx === -1) {
      throw new Error(`${rel}: starts with '---' but has no closing frontmatter delimiter`);
    }
    const frontmatterEnd = closeIdx + '\n---\n'.length;
    return canonicalContent.slice(0, frontmatterEnd) + '\n' + h + canonicalContent.slice(frontmatterEnd);
  }
  return h + canonicalContent;
}

// Checks the CANONICAL SOURCE, not the mirrored output: the output always
// begins with either the frontmatter delimiter '---' or the provenance
// header's '<!--', so a check against the written file can never fire — a
// BOM on the source is silently relocated into the middle of the mirrored
// file (still there, just no longer at byte 0, and now past the point where
// a frontmatter parser looks for it) rather than caught.
function assertNoBom(buf, path) {
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    throw new Error(
      `${path}: canonical source has a UTF-8 BOM — syncing would relocate it into ` +
        'the middle of the mirrored file instead of removing it, breaking frontmatter parsing there',
    );
  }
}

/** Syncs a single canonical file to its mirrored destination. Exported (in
 *  addition to syncAgentSkills) so tests can exercise the real read/check/
 *  write path against fixture paths, without touching the actual $HOME
 *  mirror. */
export function syncOneFile(srcPath, destPath, rel) {
  assertNoBom(readFileSync(srcPath), srcPath);
  const canonicalContent = readFileSync(srcPath, 'utf8');
  const mirrored = buildMirrorContent(canonicalContent, rel);

  // Checked BEFORE the write, like assertNoBom above: `mirrored` already
  // exists at this point, so nothing blocks checking it first. Checking it
  // after the write let a malformed canonical source clobber a previously
  // good mirror with an unusable one before the throw ever fired.
  if (rel === 'SKILL.md' && !mirrored.startsWith('---\n')) {
    throw new Error(`${srcPath}: frontmatter is not the first line`);
  }

  mkdirSync(dirname(destPath), { recursive: true });
  writeFileSync(destPath, mirrored, 'utf8');

  console.log(`wrote ${destPath}`);
  return destPath;
}

export function syncAgentSkills() {
  const written = [];
  for (const rel of FILES) {
    const srcPath = join(CANONICAL_ROOT, rel);
    const destPath = join(MIRROR_ROOT, rel);
    written.push(syncOneFile(srcPath, destPath, rel));
  }
  return written;
}

if (isDirectlyInvoked(import.meta.url)) {
  try {
    syncAgentSkills();
    console.log(
      '\nThis is a per-machine step — CI cannot run it (the target lives in ' +
        '$HOME and is absent on every fresh clone). Re-run `npm run skills:sync` ' +
        'after any change under .claude/skills/pr-review-gate/.',
    );
  } catch (err) {
    console.error(`skills:sync failed: ${err.message}`);
    process.exitCode = 1;
  }
}
