// scripts/deps-watch-run.mjs
// ops-17 deps-watch IO orchestrator (#790). Pure logic lives in
// scripts/deps-watch.mjs (unit-tested); this file does only IO:
// read pubspec + the pub-outdated JSON, fetch/refresh the sticky comment via
// `gh api`, write the job summary, post the A2 transition comment, set exit code.
// Exercised by the workflow_dispatch acceptance run, not by node --test.
import { readFileSync, appendFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import {
  KGP_PLUGINS,
  parseOutdated,
  parsePins,
  computeBehind,
  computePluginStatus,
  extractState,
  computeTransitions,
  findSticky,
  stickyRequest,
  renderSticky,
  renderSummary,
  renderTransitionComment,
  exitCodeFor,
} from './deps-watch.mjs';

// Exit codes are a deliberate, DISJOINT signalling contract (spec):
//   0 = clean, nothing behind        1 = A1 catch-up nudge (a direct/dev dep behind)
//   2 = TOOLING fault (bad env, gh/network/IO error) — NEVER conflated with A1.
const TOOLING_FAULT = 2;

const repo = process.env.GITHUB_REPOSITORY;
const issue = process.env.OPS17_ISSUE || '790';
const today = new Date().toISOString().slice(0, 10);
const outdatedPath = process.argv[2] || 'outdated.json';

// `-f` (raw field) — NOT `-F`. execFileSync passes literal bytes (no shell), so
// real newlines / backticks / `|` transmit fine and gh JSON-encodes them. `-F`
// would re-escape and would interpret the transition body's leading `@mention`
// as a file (gh community #148257). Do not "fix" this to `-F`.
const gh = (args) => execFileSync('gh', args, { encoding: 'utf8' });

try {
  if (!repo) throw new Error('GITHUB_REPOSITORY is required');

  // 1. Inputs (path resolves from this file: scripts/ -> repo-root/apps/android)
  const pubspec = readFileSync(new URL('../apps/android/pubspec.yaml', import.meta.url), 'utf8');
  const pins = parsePins(pubspec, KGP_PLUGINS);
  const pkgMap = parseOutdated(readFileSync(outdatedPath, 'utf8'));

  // 2. Compute (pure)
  const behind = computeBehind(pkgMap);
  const pluginStatus = computePluginStatus(pkgMap, pins);

  // 3. Prior state from the existing sticky comment (REST list -> numeric id).
  //    `--paginate` returns ONE merged JSON array; [] on a zero-comment thread.
  const raw = gh(['api', `repos/${repo}/issues/${issue}/comments`, '--paginate']).trim();
  const comments = raw ? JSON.parse(raw) : [];
  const existing = findSticky(comments);
  const transitions = computeTransitions(pluginStatus, extractState(existing?.body));

  // 4. Job summary
  const summary = renderSummary({ pluginStatus, behind, today });
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${summary}\n`);

  // 5. Sticky comment — edit in place, or create once (decision is pure)
  const stickyBody = renderSticky({ pluginStatus, behind, today });
  const req = stickyRequest(existing, repo, issue);
  gh(['api', req.path, '--method', req.method, '-f', `body=${stickyBody}`]);

  // 6. A2 transition notification (a NEW comment => a real GitHub notification)
  const transitionComment = renderTransitionComment(transitions, pluginStatus);
  if (transitionComment) {
    gh(['api', `repos/${repo}/issues/${issue}/comments`, '--method', 'POST', '-f', `body=${transitionComment}`]);
  }

  console.log(`deps-watch: ${behind.length} direct/dev behind; transitions: ${transitions.join(',') || 'none'}`);
  process.exit(exitCodeFor(behind)); // 0 or 1 — the clean path only
} catch (err) {
  // gh/network/IO/parse fault => exit 2, NEVER the A1 exit 1.
  console.error(`::error::deps-watch tooling fault — ${err.message}`);
  process.exit(TOOLING_FAULT);
}
