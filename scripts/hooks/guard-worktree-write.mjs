#!/usr/bin/env node
// PreToolUse guard for a dispatched fix-agent's Write/Edit/Bash calls
// (Castwright#3044, option 2 — see #3044's "Decision (2026-09-06)" comment).
//
// Wired via the `hooks:` frontmatter key on `.claude/agents/fix-agent.md`,
// per #3246's empirical findings (docs/ops/3044-hook-mechanism-findings.md):
// that mechanism fires for a subagent dispatched through the Agent tool,
// delivers the PreToolUse JSON payload on stdin (tool_name, tool_input, cwd),
// and a confirmed-working deny is exit code 2 with a stderr message.
//
import { readdirSync, readFileSync } from 'node:fs';
import { win32 } from 'node:path';
import { isDirectlyInvoked } from '../lib/is-main-module.mjs';

// PRIMARY_CHECKOUT_ROOT / PROJECTS_ROOT are hardcoded Windows paths regardless
// of what OS this hook runs on (CI runs the test suite on Ubuntu). The
// platform-default `node:path` export resolves to `path.posix` there, which
// treats a `C:\...` string as a non-absolute path and silently prepends
// `process.cwd()` to it — breaking both the containment check and the Bash
// substring match. Pin to `path.win32` so the logic is identical on every OS.
const { join, resolve, sep } = win32;

// The primary checkout — never itself a valid target for a dispatched
// fix-agent's writes, whatever tree it was assigned.
export const PRIMARY_CHECKOUT_ROOT = 'C:\\Claude\\Projects\\Audiobook-Generator';

// Sibling worktrees live directly under this directory, named `wt-*`.
export const PROJECTS_ROOT = 'C:\\Claude\\Projects';

/** Enumerate every known checkout root: the primary checkout plus every
 *  `wt-*` sibling directory that currently exists under PROJECTS_ROOT.
 *  Returns just PRIMARY_CHECKOUT_ROOT if PROJECTS_ROOT cannot be read
 *  (missing, permissions) — a guard that cannot see other worktrees still
 *  protects the one root it knows about for certain. */
export function listKnownCheckoutRoots(projectsRoot = PROJECTS_ROOT) {
  let siblings = [];
  try {
    siblings = readdirSync(projectsRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name.startsWith('wt-'))
      .map((entry) => join(projectsRoot, entry.name));
  } catch {
    siblings = [];
  }
  return [PRIMARY_CHECKOUT_ROOT, ...siblings];
}

function isUnderRoot(absPath, root) {
  const normPath = resolve(absPath).toLowerCase();
  const normRoot = resolve(root).toLowerCase();
  return normPath === normRoot || normPath.startsWith(normRoot + sep);
}

/** Pure decision function. Never throws — a hook that crashes on a payload
 *  shape it did not expect must fail OPEN (allow), not open a window where a
 *  parse bug blocks every tool call from every subagent.
 *
 *  Write/Edit: resolve tool_input.file_path against cwd and deny anything
 *  that does not fall under the assigned worktree (cwd). Precise — this is a
 *  real path containment check, not a heuristic.
 *
 *  Bash: COARSE by design (per #3044's "Decision (2026-09-06)" comment — a
 *  precise Bash check does not exist yet, and shipping the coarse one is the
 *  documented decision rather than deferring). Flags a command whose text
 *  contains an absolute path belonging to a DIFFERENT known checkout root
 *  while cwd is a different root. FALSE-NEGATIVE RISK, stated per the issue's
 *  requirement: a command that references a foreign path indirectly — via a
 *  shell variable, a relative path resolved elsewhere, an environment
 *  expansion, or a path assembled at runtime — is not caught. Only a literal
 *  absolute path substring is detected. */
export function decideGuardVerdict({ toolName, toolInput, cwd, knownRoots = listKnownCheckoutRoots() }) {
  try {
    if (toolName === 'Write' || toolName === 'Edit') {
      const filePath = toolInput?.file_path;
      if (!filePath) return { deny: false };
      const abs = resolve(cwd, filePath);
      if (!isUnderRoot(abs, cwd)) {
        return {
          deny: true,
          reason: `guard-worktree-write: ${toolName} target "${abs}" is outside the assigned worktree "${cwd}".`,
        };
      }
      return { deny: false };
    }

    if (toolName === 'Bash') {
      const command = String(toolInput?.command ?? '').toLowerCase();
      const ownRoot = knownRoots.find((root) => isUnderRoot(cwd, root));
      for (const root of knownRoots) {
        if (ownRoot && resolve(root).toLowerCase() === resolve(ownRoot).toLowerCase()) continue;
        if (command.includes(resolve(root).toLowerCase())) {
          return {
            deny: true,
            reason: `guard-worktree-write: Bash command references a foreign checkout root "${root}" while cwd is "${cwd}".`,
          };
        }
      }
      return { deny: false };
    }

    return { deny: false };
  } catch {
    // Fail open — see the doc comment above.
    return { deny: false };
  }
}

if (isDirectlyInvoked(import.meta.url)) {
  let raw = '';
  try {
    raw = readFileSync(0, 'utf8');
  } catch {
    // No stdin (e.g. invoked by hand with no payload) — nothing to guard, allow.
    process.exit(0);
  }

  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    // Unparseable payload is not positive evidence of a violation. Fail open.
    process.exit(0);
  }

  const verdict = decideGuardVerdict({
    toolName: payload.tool_name,
    toolInput: payload.tool_input,
    cwd: payload.cwd,
  });

  if (verdict.deny) {
    process.stderr.write(`${verdict.reason}\n`);
    process.exit(2);
  }
  process.exit(0);
}
