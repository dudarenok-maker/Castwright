// Mechanical checker for DUPLICATED plan numbers under docs/features/
// (parent #4582, child #4604).
//
// WHAT IT CHECKS: plan numbers are cross-reference IDs ("plan 292" in code
// comments, the register, INDEX.md, release notes). Two `docs/features/**/
// NNN-*.md` files sharing one number make every citation of it ambiguous.
// The checker reads `git ls-files -- docs/features`, keeps `.md` files whose
// BASENAME starts `^(\d+[a-z]?)-` (digits plus an optional single letter, so
// `70a-` and `70b-` are different keys; `archive/` is just a directory).
// Keys are normalised: leading zeros stripped (`07-` = `7-`), suffix letter and
// `.md` extension case-folded, and `-z` listing keeps non-ASCII names intact. It
// fails when a key has two or more files outside the frozen allowlist.
// INDEX.md, TEMPLATE.md, README.md, unnumbered plans and non-.md twins (the
// `.html` board of a plan) are ignored.
//
// WHY A LEGACY ALLOWLIST: 25 older numbers were already duplicated before
// this check existed. Their files are frozen history - renumbering them would
// rewrite citations all over the repo. LEGACY_DUPLICATES maps each such number
// to its set of file BASENAMES (directories are ignored, so moving a file into
// or out of `archive/` is transparent), so a FURTHER collision on any of them
// still fails (`legacy-grew`), and an entry that no longer matches fails too
// (`legacy-stale`). The allowlist may only ever shrink or tighten; never add
// an entry for a new collision - renumber the later-added plan instead.
//
// WIRING STATUS: wired (#4605). It runs as the unconditional `Plan number
// check` step in .github/workflows/verify.yml and via
// UNCONDITIONAL_LOCAL_CHECK_SCRIPTS in scripts/verify-cache.mjs (every full
// `npm run verify`).

import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { scrubGitEnv } from './git-env.mjs';
import { isDirectlyInvoked } from './lib/is-main-module.mjs';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));

const PLAN_KEY_RE = /^(\d+)([a-z]?)-/i;

const baseName = (path) => path.slice(path.lastIndexOf('/') + 1);

/**
 * Normalised leading plan-number token of a tracked path, or null when the path
 * is not a numbered `.md` plan. Leading zeros are stripped and the suffix letter
 * and extension are case-folded, so `07-` and `7-` (and `296A-` / `296a-`,
 * `.MD` / `.md`) are the same plan number.
 */
export function extractPlanKey(path) {
  if (!/\.md$/i.test(path)) return null;
  const match = PLAN_KEY_RE.exec(baseName(path));
  if (!match) return null;
  return `${match[1].replace(/^0+(?=\d)/, '')}${match[2].toLowerCase()}`;
}

/**
 * Pure check. Returns a list of `{ kind, key, files }` problems (empty = pass).
 * kind: `duplicate` | `legacy-grew` | `legacy-stale`.
 */
export function findPlanNumberProblems(trackedPaths, legacyDuplicates) {
  const byKey = new Map();
  for (const path of trackedPaths) {
    const key = extractPlanKey(path);
    if (key === null) continue;
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key).push(path);
  }
  const problems = [];
  const sortedKeys = [...byKey.keys()].sort();
  for (const key of sortedKeys) {
    const files = [...byKey.get(key)].sort();
    if (files.length < 2) continue;
    const frozen = legacyDuplicates[key];
    if (!frozen) {
      problems.push({ kind: 'duplicate', key, files });
      continue;
    }
    // Compare by BASENAME, multiset-wise: moving a frozen file between
    // docs/features/ and docs/features/archive/ changes no plan number, so it is
    // transparent; a genuine extra file (new name, or the same name in a second
    // directory) still grows the set.
    const frozenBases = frozen.map(baseName);
    const added = files.filter((f) => !frozenBases.includes(baseName(f)));
    if (added.length > 0 || files.length > frozen.length) {
      problems.push({ kind: 'legacy-grew', key, files });
    }
  }
  for (const key of Object.keys(legacyDuplicates)) {
    const frozen = [...legacyDuplicates[key]].map(baseName).sort();
    const currentFiles = [...(byKey.get(key) ?? [])].sort();
    const current = currentFiles.map(baseName).sort();
    const same = frozen.length === current.length && frozen.every((f, i) => f === current[i]);
    if (same) continue;
    // A grown set was already reported as legacy-grew above.
    if (
      current.length > 1 &&
      (current.some((f) => !frozen.includes(f)) || current.length > frozen.length)
    ) {
      continue;
    }
    problems.push({ kind: 'legacy-stale', key, files: currentFiles.length > 0 ? currentFiles : [...legacyDuplicates[key]].sort() });
  }
  return problems;
}

// Frozen legacy duplicates: key -> sorted repo-relative POSIX paths
// (recorded in full, but only their basenames are compared).
// Generated from `git ls-files -- docs/features` on the #4582 branch head
// (after #4603 renumbered 292 -> 295). May only shrink.
export const LEGACY_DUPLICATES = {
  "32": [
    "docs/features/archive/32-audiobook-export.md",
    "docs/features/archive/32-sticky-analysis.md"
  ],
  "95": [
    "docs/features/archive/95-alias-edit.md",
    "docs/features/archive/95-analysing-multi-model-ui.md"
  ],
  "96": [
    "docs/features/archive/96-cross-book-voice-compare.md",
    "docs/features/archive/96-recover-missing-character.md"
  ],
  "101": [
    "docs/features/archive/101-cross-book-duplicate-review.md",
    "docs/features/archive/101-docs-only-ci-skip.md"
  ],
  "118": [
    "docs/features/118-ci-cost-round-2.md",
    "docs/features/archive/118-analyzer-per-phase-wiring-fix.md"
  ],
  "120": [
    "docs/features/archive/120-status-pill-popover.md",
    "docs/features/archive/120-tts-load-error-surface-and-sidecar-pipe.md"
  ],
  "122": [
    "docs/features/archive/122-rebaseline-name-alias-collapse.md",
    "docs/features/archive/122-shared-user-settings.md"
  ],
  "127": [
    "docs/features/127-generation-rtf-telemetry.md",
    "docs/features/archive/127-release-cross-os-gate.md"
  ],
  "137": [
    "docs/features/137-sidecar-fetch-timeout.md",
    "docs/features/archive/137-reopen-never-auto-enqueues.md"
  ],
  "148": [
    "docs/features/148-recycle-inflight-recovery.md",
    "docs/features/148-skip-nonnarration-chapters.md"
  ],
  "153": [
    "docs/features/153-stuck-queued-failure-status.md",
    "docs/features/archive/153-sidecar-variable-shape-host-leak.md"
  ],
  "158": [
    "docs/features/158-sidecar-soft-recycle-boundary.md",
    "docs/features/archive/158-tts-index-cycle-mock-flake.md"
  ],
  "161": [
    "docs/features/161-sidecar-vram-reload-recycle.md",
    "docs/features/161-voice-design-compare.md"
  ],
  "167": [
    "docs/features/archive/167-coqui-in-app-installer.md",
    "docs/features/archive/167-fe-react-cluster-upgrade.md"
  ],
  "197": [
    "docs/features/197-not-queued-held-chapter.md",
    "docs/features/archive/197-asr-verifying-phase.md"
  ],
  "221": [
    "docs/features/221-dynamic-analyzer-models.md",
    "docs/features/221-multilingual-attribution-gemma-and-cast-merge.md"
  ],
  "228": [
    "docs/features/228-batch-qa-rerecords.md",
    "docs/features/archive/228-fe-40-series-memory.md"
  ],
  "229": [
    "docs/features/229-regen-model-override.md",
    "docs/features/archive/229-fs50-fr-de-language-packs.md"
  ],
  "236": [
    "docs/features/236-multi-gpu-per-model-safety.md",
    "docs/features/236-prosody-review-progress-detail.md"
  ],
  "238": [
    "docs/features/238-fs54-audiobookshelf-export-status-pill.md",
    "docs/features/238-preload-toggle-dedup.md"
  ],
  "240": [
    "docs/features/archive/240-cast-first-landing-and-voice-readiness-gate.md",
    "docs/features/archive/240-setup-checker-defense-in-depth.md"
  ],
  "256": [
    "docs/features/256-lan-pair-from-friendly-hostname.md",
    "docs/features/256-ops28-cert-hardening.md"
  ],
  "263": [
    "docs/features/263-analyzer-eval-rate-telemetry.md",
    "docs/features/263-per-model-keepalive.md"
  ],
  "269": [
    "docs/features/269-ffmpeg-version-floor.md",
    "docs/features/archive/269-react-router-v8-node-floor.md"
  ],
  "283": [
    "docs/features/283-aligner-dash-invariance.md",
    "docs/features/archive/283-castwright-local-rebind.md"
  ]
};

// --- CLI --------------------------------------------------------------------

class CliExitError extends Error {
  constructor(code) {
    super(`CLI exit ${code}`);
    this.code = code;
  }
}

export function listDocsFeaturesFiles(cwd = REPO_ROOT) {
  // Same shape as check-register-citations.mjs's gitLsFiles(): pin the cwd to
  // the repo root resolved from THIS file's own location (so a copy under a
  // scratch repo scans that repo, and a junctioned worktree is handled), with
  // the repository-redirection GIT_* vars scrubbed (#2169/#2216), and resolve
  // file URLs through fileURLToPath, never a raw .pathname (#3413).
  // `-z`: NUL-separated, never C-quoted, so a non-ASCII basename (core.quotepath)
  // reaches the `.md` / key match intact.
  const out = execFileSync('git', ['ls-files', '-z', '--', 'docs/features'], {
    cwd,
    env: scrubGitEnv(),
    encoding: 'utf8',
    windowsHide: true,
  });
  return out.split('\0').filter(Boolean);
}

const REMEDIES = {
  duplicate:
    'a NEW collision - renumber the later-added plan to the next free number.',
  'legacy-grew':
    'a file beyond the frozen two now carries a legacy plan number (files are matched' +
    ' by basename, so moving a frozen file into or out of archive/ is fine) - renumber' +
    ' the newly added plan (the one NOT listed in LEGACY_DUPLICATES for this number) to' +
    ' the next free number. Never add a file to the LEGACY_DUPLICATES entry.',
  'legacy-stale':
    'a LEGACY_DUPLICATES entry no longer matches the tracked files - shrink or' +
    ' update the entry in scripts/check-plan-numbers.mjs. The allowlist may only' +
    ' ever tighten.',
};

function renderProblem(problem) {
  const fileLines = problem.files.map((file) => `    ${file}`).join('\n');
  return (
    `  plan number \`${problem.key}\` - ${problem.kind} (${problem.files.length} file(s)):\n` +
    `${fileLines}\n` +
    `    Remedy: ${REMEDIES[problem.kind]}`
  );
}

function runPlanNumbersCli() {
  const trackedPaths = listDocsFeaturesFiles();
  const problems = findPlanNumberProblems(trackedPaths, LEGACY_DUPLICATES);
  if (problems.length > 0) {
    console.log(`check:plan-numbers: ${problems.length} problem(s) in docs/features:`);
    for (const problem of problems) {
      console.log(renderProblem(problem));
    }
    throw new CliExitError(1);
  }
  const planFiles = trackedPaths.filter((p) => extractPlanKey(p) !== null);
  const numberCount = new Set(planFiles.map((p) => extractPlanKey(p))).size;
  console.log(
    `check:plan-numbers: OK. ${planFiles.length} tracked plan files under docs/features` +
      ` carry ${numberCount} distinct plan numbers. No duplicate outside the frozen` +
      ` legacy allowlist (${Object.keys(LEGACY_DUPLICATES).length} entries) and no` +
      ` allowlist drift.`,
  );
}

if (isDirectlyInvoked(import.meta.url)) {
  try {
    runPlanNumbersCli();
  } catch (err) {
    if (err instanceof CliExitError) {
      process.exitCode = err.code;
    } else {
      throw err;
    }
  }
}
