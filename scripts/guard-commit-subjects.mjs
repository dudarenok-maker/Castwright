// Pre-push commit-subject guard for .husky/pre-push.
//
// Validates every commit being pushed against the Conventional-Commits subject
// rule (reusing validateCommitSubject from validate-commit-msg.mjs). This is the
// backstop for the `commit-msg` hook: a commit made with `git commit --no-verify`
// (or in a worktree whose husky hook couldn't spawn) skips `commit-msg` entirely,
// so a malformed subject — e.g. a stray "@ " leaked from a PowerShell here-string
// `@'...'@` used to build `git commit -m` — can otherwise reach `main`. Once
// merged, fixing the subject needs a history rewrite + force-push (blocked).
// Catching it at push time is the last cheap line of defense.
//
// git pipes one line per ref being pushed to the hook's stdin:
//   "<localRef> <localSha> <remoteRef> <remoteSha>"
// A zero sha (all '0') means create (remoteSha) or delete (localSha).
//
// Intentionally bypassable with `git push --no-verify` for the rare deliberate
// case. See docs/features/163-protected-push-guard.md (sibling guard).

import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { validateCommitSubject, helpMessage as subjectHelp } from './validate-commit-msg.mjs';

const isZeroSha = (sha) => /^0+$/.test(sha);
const UNIT = '\x1f'; // git log field separator

// Pure, unit-testable core. `listSubjects(remoteSha, localSha)` returns the
// new commits in the push as [{ sha, subject }] — injected in tests so this
// runs without a real repo. Each subject is validated; a deletion (zero
// localSha) contributes nothing. Returns { blocked, failures }.
export function evaluatePush(stdinText, { listSubjects }) {
  const failures = [];
  const seen = new Set();
  for (const line of String(stdinText).split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    const [, localSha, , remoteSha] = trimmed.split(/\s+/);
    if (!localSha || isZeroSha(localSha)) continue; // deletion — nothing to check
    for (const { sha, subject } of listSubjects(remoteSha, localSha)) {
      if (seen.has(sha)) continue; // a commit pushed on two refs is checked once
      seen.add(sha);
      const verdict = validateCommitSubject(subject);
      if (!verdict.ok) failures.push({ sha, subject, reason: verdict.reason });
    }
  }
  return { blocked: failures.length > 0, failures };
}

export function helpMessage(failures) {
  const lines = [
    `pre-push blocked: ${failures.length} commit subject(s) violate the Conventional Commits convention:`,
    ``,
  ];
  for (const f of failures) {
    lines.push(`  ${String(f.sha).slice(0, 9)}  ${JSON.stringify(f.subject)}  — ${f.reason}`);
  }
  lines.push(
    ``,
    subjectHelp(failures[0]?.subject ?? ''),
    ``,
    `Reword the offending commit(s) before pushing (git rebase -i / git commit --amend),`,
    `or — only if genuinely intended — bypass with: git push --no-verify`,
  );
  return lines.join('\n');
}

// Real git-backed lister for CLI mode. Best-effort: a git error returns [] so
// the guard never blocks a push because git itself hiccupped.
function gitListSubjects(remoteSha, localSha) {
  const revs =
    remoteSha && !isZeroSha(remoteSha)
      ? [`${remoteSha}..${localSha}`] // re-push: only commits since the last push
      : [localSha, '--not', '--remotes']; // new branch: commits not yet on any remote
  const res = spawnSync('git', ['log', `--format=%H${UNIT}%s`, ...revs], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  if (res.status !== 0 || typeof res.stdout !== 'string') return [];
  return res.stdout
    .split('\n')
    .filter(Boolean)
    .map((l) => {
      const idx = l.indexOf(UNIT);
      return { sha: l.slice(0, idx), subject: l.slice(idx + 1) };
    });
}

const invokedAsCli =
  typeof process !== 'undefined' &&
  Array.isArray(process.argv) &&
  /guard-commit-subjects\.mjs$/.test(process.argv[1] ?? '');

if (invokedAsCli) {
  let stdinText = '';
  try {
    stdinText = readFileSync(0, 'utf8');
  } catch {
    stdinText = ''; // no stdin (e.g. invoked manually) — nothing to check
  }
  const { blocked, failures } = evaluatePush(stdinText, { listSubjects: gitListSubjects });
  if (blocked) {
    process.stderr.write(helpMessage(failures) + '\n');
    process.exit(1);
  }
  process.exit(0);
}
