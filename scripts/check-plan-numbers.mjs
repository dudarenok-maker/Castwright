// Mechanical checker for DUPLICATED plan numbers under docs/features/
// (parent #4582, child #4604).
//
// WHAT IT CHECKS: plan numbers are cross-reference IDs ("plan 292" in code
// comments, the register, INDEX.md, release notes). Two `docs/features/**/
// NNN-*.md` files sharing one number make every citation of it ambiguous.
// The checker reads `git ls-files -- docs/features`, keeps `.md` files whose
// BASENAME starts `^(\d+[a-z]?)-` (digits plus an optional single letter, so
// `70a-` and `70b-` are different keys; `archive/` is just a directory), and
// fails when a key has two or more files outside the frozen allowlist.
// INDEX.md, TEMPLATE.md, README.md, unnumbered plans and non-.md twins (the
// `.html` board of a plan) are ignored.
//
// WHY A LEGACY ALLOWLIST: 25 older numbers were already duplicated before
// this check existed. Their files are frozen history - renumbering them would
// rewrite citations all over the repo. LEGACY_DUPLICATES maps each such number
// to its exact file set, so a FURTHER collision on any of them still fails
// (`legacy-grew`), and an entry that no longer matches fails too
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

const PLAN_KEY_RE = /^(\d+[a-z]?)-/;

/**
 * Leading plan-number token of a tracked path, or null when the path is not a
 * numbered `.md` plan.
 */
export function extractPlanKey(path) {
  if (!path.endsWith('.md')) return null;
  const base = path.slice(path.lastIndexOf('/') + 1);
  const match = PLAN_KEY_RE.exec(base);
  return match ? match[1] : null;
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
    const added = files.filter((f) => !frozen.includes(f));
    if (added.length > 0) {
      problems.push({ kind: 'legacy-grew', key, files });
    }
  }
  for (const key of Object.keys(legacyDuplicates)) {
    const frozen = [...legacyDuplicates[key]].sort();
    const current = [...(byKey.get(key) ?? [])].sort();
    const same = frozen.length === current.length && frozen.every((f, i) => f === current[i]);
    if (same) continue;
    // A grown set was already reported as legacy-grew above.
    if (current.some((f) => !frozen.includes(f)) && current.length > 1) continue;
    problems.push({ kind: 'legacy-stale', key, files: current.length > 0 ? current : frozen });
  }
  return problems;
}

// Frozen legacy duplicates: key -> sorted repo-relative POSIX paths.
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

function gitLsFilesDocsFeatures() {
  // Same shape as check-register-citations.mjs's gitLsFiles(): pin the cwd to
  // the repo root resolved from THIS file's own location (so a copy under a
  // scratch repo scans that repo, and a junctioned worktree is handled), with
  // the repository-redirection GIT_* vars scrubbed (#2169/#2216), and resolve
  // file URLs through fileURLToPath, never a raw .pathname (#3413).
  const out = execFileSync('git', ['ls-files', '--', 'docs/features'], {
    cwd: REPO_ROOT,
    env: scrubGitEnv(),
    encoding: 'utf8',
    windowsHide: true,
  });
  return out.split('\n').filter(Boolean);
}

const REMEDIES = {
  duplicate:
    'a NEW collision - renumber the later-added plan to the next free number.',
  'legacy-grew':
    'a third plan joined a frozen legacy number - renumber the newly added plan to' +
    ' the next free number, or (only if the addition is itself history to keep)' +
    ' update the LEGACY_DUPLICATES entry for it once.',
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
  const trackedPaths = gitLsFilesDocsFeatures();
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
