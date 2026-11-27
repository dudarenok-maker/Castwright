// scripts/deps-watch-run.mjs
// ops-17 deps-watch IO orchestrator. The sticky comment lives on #4726 (the
// dedicated deps-watch tracking issue; #790 is the KGP issue, tracked by hand).
// Pure logic lives in scripts/deps-watch.mjs (unit-tested); this file does only IO:
// read the pub-outdated JSON, fetch the existing sticky comment via
// `gh api`, write the job summary, refresh the sticky comment, set exit code.
// Exercised by the workflow_dispatch acceptance run, not by node --test.
import { readFileSync, appendFileSync } from 'node:fs';
import { gh } from './gh.mjs';
import {
  parseOutdated,
  computeBehind,
  findSticky,
  renderSticky,
  renderSummary,
  stickyRequest,
  exitCodeFor,
  stickyWriteArgs,
} from './deps-watch.mjs';

// Exit codes are a deliberate, DISJOINT signalling contract (spec):
//   0 = clean, nothing behind        1 = catch-up nudge (a direct/dev dep behind)
//   2 = TOOLING fault (bad env, gh/network/IO error) — NEVER conflated with 1.
const TOOLING_FAULT = 2;

const repo = process.env.GITHUB_REPOSITORY;
const issue = process.env.OPS17_ISSUE || '4726';
const today = new Date().toISOString().slice(0, 10);
const outdatedPath = process.argv[2] || 'outdated.json';

// `-f` (raw field) — NOT `-F`. execFileSync passes literal bytes (no shell), so
// real newlines / backticks / `|` transmit fine and gh JSON-encodes them. `-F`
// would re-escape and would interpret a leading `@mention` as a file (gh
// community #148257). Do not "fix" this to `-F`.
//
// gh() (scripts/gh.mjs, #2184) defaults `cwd` to repoRoot — this script is
// invoked by .github/workflows/app-deps-watch.yml with
// `working-directory: apps/android`, so its `gh api` calls resolve the target
// repository from the repo root rather than that subdirectory.

try {
  if (!repo) throw new Error('GITHUB_REPOSITORY is required');

  // 1. Input
  const pkgMap = parseOutdated(readFileSync(outdatedPath, 'utf8'));

  // 2. Compute (pure)
  const behind = computeBehind(pkgMap);

  // 3. The existing sticky comment (REST list -> numeric id).
  //    `--paginate` returns ONE merged JSON array; [] on a zero-comment thread.
  const raw = gh(['api', `repos/${repo}/issues/${issue}/comments`, '--paginate']).trim();
  const comments = raw ? JSON.parse(raw) : [];
  const existing = findSticky(comments);

  // 4. Job summary
  const summary = renderSummary({ behind, today });
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${summary}\n`);

  // 5. Refresh the sticky comment — edit in place, or create once (decision is pure).
  const req = stickyRequest(existing, repo, issue);
  gh(stickyWriteArgs(req, renderSticky({ behind, today })));

  console.log(`deps-watch: ${behind.length} direct/dev behind`);
  process.exit(exitCodeFor(behind)); // 0 or 1 — the clean path only
} catch (err) {
  // gh/network/IO/parse fault => exit 2, NEVER the catch-up exit 1.
  console.error(`::error::deps-watch tooling fault — ${err.message}`);
  process.exit(TOOLING_FAULT);
}
