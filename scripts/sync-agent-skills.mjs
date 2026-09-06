// scripts/sync-agent-skills.mjs
//
// Mirrors .claude/skills/pr-review-gate/ AND .claude/skills/model-routing/
// into the cross-agent skill store at ~/.agents/skills/ — the skill store
// Cline (and reportedly five other agents sharing that store) is known to
// resolve skills from. Not established to be the only one it resolves from —
// unverified pending a fuller probe of the loader's search list. Verified
// 2026-08-13: see
// docs/testing/agent-skill-resolution-probe.md. Cline does not read this
// repo's workspace .claude/skills/ at all, so without this mirror the
// mandated PR review runbook is invisible to it. model-routing joined the
// mirror on 2026-08-14: pr-review-gate links ../model-routing/SKILL.md three
// times in SKILL.md plus once more (one directory deeper, as
// ../../model-routing/SKILL.md) in references/findings-triage.md (four in
// total), including the link naming which tier to dispatch a reviewer at,
// and every one of those links resolved to a directory the mirror did not
// write until then.
//
// This is a PER-MACHINE step. CI cannot run it — the target lives under
// $HOME, which is absent on every fresh clone and every CI runner.
//
// #3001 — the mirror is MACHINE state, not BRANCH state: every worktree on
// the box shares one ~/.agents/skills/, so whichever content this script
// last wrote decides what every other lane's drift guard compares against.
// An earlier version of this script read its canonical source from THIS
// CHECKOUT's disk copy of .claude/skills/**, gated on the current branch
// being 'main' — but a branch name is a proxy for the property that
// actually matters (the mirror holds `main`'s *committed* content), and a
// dirty `main` checkout (trivial commits and git-ignored artifact work in
// the primary checkout are both explicitly sanctioned by CLAUDE.md) would
// still poison the mirror straight through that check. So this script now
// reads every file's content via `git show main:<path>` (readCommittedOnMain
// below) regardless of which branch or worktree invoked it — the write is
// then deterministic given `main`'s current commit, and there is no branch
// or working-tree state left that can make it wrong. A `FILES` entry that
// isn't on `main` yet (e.g. a branch that just added a newly-mirrored skill)
// is skipped with a loud log line rather than failing — the mirror provably
// cannot hold content `main` doesn't have, and it will pick it up on the
// first sync after that branch merges. See #3001 for the incident.
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
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { isDirectlyInvoked } from './lib/is-main-module.mjs';
import { scrubGitEnv } from './git-env.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..');
const MIRROR_ROOT = join(homedir(), '.agents', 'skills');

/** Skill-QUALIFIED relative paths, mirroring the store's own layout. Was a
 *  bare list under one skill root until 2026-08-14, when model-routing joined:
 *  pr-review-gate links ../model-routing/SKILL.md three times in SKILL.md
 *  plus once more (one directory deeper, as ../../model-routing/SKILL.md) in
 *  references/findings-triage.md (four in total), including the link naming
 *  which tier to dispatch at, and every one of
 *  them resolved to a directory the mirror did not write. Cline had been
 *  reading a runbook with dead routing references since the mirror was
 *  created. */
export const FILES = [
  'pr-review-gate/SKILL.md',
  'pr-review-gate/references/reviewer-brief.md',
  'pr-review-gate/references/findings-triage.md',
  'model-routing/SKILL.md',
];

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
    `     Canonical source: <repo>/.claude/skills/${rel}\n` +
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

/** Validates a canonical file's raw bytes and builds+writes its mirrored
 *  destination. Shared by syncOneFile (disk-sourced, below) and
 *  syncAgentSkills (git-sourced): both must run the exact same checks so
 *  neither path can diverge from the other. `sourceLabel` names the
 *  CANONICAL SOURCE in error messages (a disk path for syncOneFile, a
 *  `main:<path>` git ref for syncAgentSkills) — deliberately not `destPath`,
 *  since the defect being reported is always in the source, never the
 *  (not-yet-written) mirror. */
function writeMirroredFile(rawBuffer, destPath, rel, sourceLabel) {
  assertNoBom(rawBuffer, sourceLabel);
  const canonicalContent = rawBuffer.toString('utf8');
  const mirrored = buildMirrorContent(canonicalContent, rel);

  // Checked BEFORE the write, like assertNoBom above: `mirrored` already
  // exists at this point, so nothing blocks checking it first. Checking it
  // after the write let a malformed canonical source clobber a previously
  // good mirror with an unusable one before the throw ever fired.
  if (basename(rel) === 'SKILL.md' && !mirrored.startsWith('---\n')) {
    throw new Error(`${sourceLabel}: frontmatter is not the first line`);
  }

  mkdirSync(dirname(destPath), { recursive: true });
  writeFileSync(destPath, mirrored, 'utf8');

  console.log(`wrote ${destPath}`);
  return destPath;
}

/** Syncs a single canonical file, read from DISK, to its mirrored
 *  destination. Exported so tests can exercise the real read/check/write
 *  path against fixture paths, without touching the actual $HOME mirror or
 *  shelling out to git. Production syncing (syncAgentSkills below) does NOT
 *  use this — it reads from `main`'s committed git blob instead, since a
 *  disk read is exactly the bug #3001 fixed (see the module header). */
export function syncOneFile(srcPath, destPath, rel) {
  return writeMirroredFile(readFileSync(srcPath), destPath, rel, srcPath);
}

/** Reads a skills-root-relative path (e.g. 'pr-review-gate/SKILL.md') as it
 *  is COMMITTED ON `main` — never as it sits on whatever branch is currently
 *  checked out. Returns `null` (rather than throwing) when the path doesn't
 *  exist on `main`, so a caller can distinguish "not there yet" (a branch
 *  that just added a new mirrored file — not an error, see #3001) from a
 *  real failure. `git show` reads a worktree's shared `.git`, so this
 *  resolves correctly regardless of which branch this checkout has out. */
export function readCommittedOnMain(rel, repoRoot = REPO_ROOT) {
  const gitPath = `.claude/skills/${rel}`;
  try {
    return execFileSync('git', ['show', `main:${gitPath}`], {
      cwd: repoRoot,
      windowsHide: true,
      env: scrubGitEnv(),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch {
    return null;
  }
}

// Guards the one input the commit-time guard (the exact-list assert in
// review-gate-mechanism.test.mjs) cannot reach: `npm run skills:sync` is a
// PER-MACHINE step run by hand, on machines and at moments that test isn't
// watching. Without this, an accidentally emptied FILES would make the loop
// below iterate nothing, and the script would still print its success hint
// and exit 0 — reporting "mirror is up to date" to the operator when nothing
// was written at all. Exported so the check can be exercised directly,
// mirroring assertNoBom above.
export function assertFilesNonEmpty(files) {
  if (files.length === 0) {
    throw new Error('sync-agent-skills: FILES is empty — nothing would be written, refusing to report success');
  }
}

/**
 * Syncs every mirrored skill file from `main`'s committed content.
 *
 * `files` and `mirrorRoot` default to the real FILES/MIRROR_ROOT but are
 * overridable so tests can exercise the real end-to-end read-from-git/write
 * path (including the "not on main yet" skip below) without ever touching
 * the actual $HOME mirror.
 *
 * Returns `{ written, skipped }`: `written` are destination paths actually
 * written; `skipped` are FILES entries whose content isn't on `main` yet
 * (see readCommittedOnMain) — not an error, just nothing to sync yet.
 */
export function syncAgentSkills(files = FILES, mirrorRoot = MIRROR_ROOT) {
  assertFilesNonEmpty(files);
  const written = [];
  const skipped = [];
  for (const rel of files) {
    const raw = readCommittedOnMain(rel);
    if (raw === null) {
      console.log(`[skip] ${rel} is not on 'main' yet — it will sync once that change merges`);
      skipped.push(rel);
      continue;
    }
    written.push(writeMirroredFile(raw, join(mirrorRoot, rel), rel, `main:.claude/skills/${rel}`));
  }
  return { written, skipped };
}

if (isDirectlyInvoked(import.meta.url)) {
  try {
    const { written, skipped } = syncAgentSkills();
    console.log(
      `\nWrote ${written.length}, skipped ${skipped.length} (not yet on 'main'). This is a ` +
        'per-machine step — CI cannot run it (the target lives in $HOME and is absent on ' +
        'every fresh clone). Re-run after a change under .claude/skills/pr-review-gate/ or ' +
        ".claude/skills/model-routing/ has merged to `main` — content is always read from " +
        "main's committed git blob, never from this checkout's disk, so it's safe to run " +
        'from any branch or worktree (see #3001).',
    );
  } catch (err) {
    console.error(`skills:sync failed: ${err.message}`);
    process.exitCode = 1;
  }
}
