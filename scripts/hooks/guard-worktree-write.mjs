#!/usr/bin/env node
// PreToolUse guard for a dispatched fix-agent's Write/Edit/NotebookEdit/
// Bash/PowerShell calls (Castwright#3044, option 2 — see #3044's "Decision
// (2026-09-06)" comment). Castwright#3263's transcript-derived assignment
// signal (see decideGuardVerdict's doc comment) has landed — the assigned
// root is now the one a transcript scan finds, falling back to `cwd` when
// the scan finds nothing. That is a correction, not an enhancement: `cwd`
// alone named the right root in 6.7% of 715 measured dispatches.
// REMAINING GAPS, both real: a wrong-but-confident extraction (measured
// 0.9%) still protects the wrong tree and can ALLOW a write to it, and the
// Bash/PowerShell check stays coarse. Separately still open: whether a
// denial should be terminal (#3263's 2026-09-21 design-pass comment, parked,
// tracked as its own issue). So this guard remains a layer, NOT a full
// replacement for the manual before/after `git status --porcelain` check.
//
// Wired via the `hooks:` frontmatter key on `.claude/agents/fix-agent.md`,
// per #3246's empirical findings (docs/ops/3044-hook-mechanism-findings.md):
// that mechanism fires for a subagent dispatched through the Agent tool,
// delivers the PreToolUse JSON payload on stdin (tool_name, tool_input, cwd),
// and a confirmed-working deny is exit code 2 with a stderr message.
//
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { win32 } from 'node:path';
import { isDirectlyInvoked } from '../lib/is-main-module.mjs';
import { scrubGitEnv } from '../git-env.mjs';

// PRIMARY_CHECKOUT_ROOT is a hardcoded Windows path regardless of what OS
// this hook runs on (CI runs the test suite on Ubuntu). The platform-default
// `node:path` export resolves to `path.posix` there, which treats a `C:\...`
// string as a non-absolute path and silently prepends `process.cwd()` to it
// — breaking both the containment check and the Bash/PowerShell substring
// match. Pin to `path.win32` so the logic is identical on every OS.
const { resolve, sep } = win32;

// The primary checkout — never itself a valid target for a dispatched
// fix-agent's writes, whatever tree it was assigned.
export const PRIMARY_CHECKOUT_ROOT = 'C:\\Claude\\Projects\\Audiobook-Generator';

/** Enumerate every known checkout root: the primary checkout plus every real
 *  worktree `git worktree list` reports for it. Sourced from git itself
 *  rather than a directory-name convention (`wt-*` under a single hardcoded
 *  parent) — this repo has real worktrees that violate both assumptions
 *  (`scratch-*` prefixes, and trees under the OS temp dir entirely), and a
 *  naming/location guess misses them. Returns just PRIMARY_CHECKOUT_ROOT if
 *  `git worktree list` fails (not a repo, git absent) — a guard that cannot
 *  see other worktrees still protects the one root it knows about for
 *  certain. Over-inclusion (a stale/prunable worktree entry) is harmless:
 *  the only consumer (Bash detection, below) only ever widens what counts as
 *  "foreign", never narrows it. */
export function listKnownCheckoutRoots({ cwd = PRIMARY_CHECKOUT_ROOT, spawn = spawnSync } = {}) {
  try {
    const result = spawn('git', ['worktree', 'list', '--porcelain'], {
      cwd,
      encoding: 'utf8',
      env: scrubGitEnv(),
      windowsHide: true,
    });
    if (result.error || result.status !== 0 || !result.stdout) return [PRIMARY_CHECKOUT_ROOT];
    const roots = result.stdout
      .split('\n')
      .filter((line) => line.startsWith('worktree '))
      .map((line) => line.slice('worktree '.length).trim())
      .filter(Boolean)
      // git emits forward-slash paths on Windows even for a backslash
      // PRIMARY_CHECKOUT_ROOT; normalize through win32.resolve so a plain
      // `.includes(PRIMARY_CHECKOUT_ROOT)` membership check (not just the
      // slash-tolerant isUnderRoot comparison) can rely on this list.
      .map((p) => resolve(p));
    return roots.length > 0 ? roots : [PRIMARY_CHECKOUT_ROOT];
  } catch {
    return [PRIMARY_CHECKOUT_ROOT];
  }
}

function isUnderRoot(absPath, root) {
  const normPath = resolve(absPath).toLowerCase();
  const normRoot = resolve(root).toLowerCase();
  return normPath === normRoot || normPath.startsWith(normRoot + sep);
}

/** Collapses every separator spelling a Windows path can appear under in a
 *  shell command down to ONE canonical form (forward slash), so a single
 *  substring check catches all of them at once instead of enumerating —
 *  enumerating already lost a round to a spelling nobody listed (pass 1 of
 *  Castwright#3261's review missed the doubled-backslash and mixed-separator
 *  forms a Bash-tool payload actually carries: `tool_input.command` is the
 *  RAW string before the shell's own escape processing runs, so a command
 *  that will resolve to a real Windows path at execution time can still
 *  arrive here as `C:\\Claude\\...` (doubled backslash) or with `/` and `\`
 *  mixed within one path). Order matters: collapse doubled backslashes to a
 *  single one FIRST, then unify every remaining run of `/`/`\` to a single
 *  `/` — reversing the order would turn `\\` into `//` instead of `/`. */
function normalizeSeparators(text) {
  return text.replace(/\\\\/g, '\\').replace(/[\\/]+/g, '/');
}

/** The two path forms that are NOT reachable by separator normalization
 *  alone — Git Bash's `/c/...` mount and WSL's `/mnt/c/...` — plus the
 *  drive-letter form itself (post-normalization). All are literal,
 *  unexpanded substrings — no shell variable or relative-path resolution is
 *  attempted (see the Bash-detection doc comment below). Non-drive-letter
 *  roots (defensive only — every real root here is `C:\...`) fall back to
 *  the single normalized, lowercased root string. */
function pathSpellings(root) {
  const normalized = normalizeSeparators(root).toLowerCase();
  const m = /^([a-z]):\/(.*)$/.exec(normalized);
  if (!m) return [normalized];
  const [, drive, rest] = m;
  return [normalized, `/${drive}/${rest}`, `/mnt/${drive}/${rest}`];
}

/** True if `needle` occurs in `haystack` at a real path-component boundary —
 *  i.e. what follows the match is a separator, quote, whitespace, or the end
 *  of the string, never another filename-continuation character. Without
 *  this, a shorter root that is a literal string prefix of a longer sibling
 *  worktree's name (e.g. `wt-3243` vs. `wt-3243-followup` — a shape
 *  `wt-new.mjs` actively mints) makes the guard deny the agent's OWN tree: a
 *  plain `.includes()` finds `wt-3243` inside `wt-3243-followup` and treats
 *  it as a reference to the wrong root. Mirrors `isUnderRoot`'s `+ sep`
 *  boundary check, adapted for scanning free-text instead of comparing two
 *  already-resolved paths. */
function containsPathAtBoundary(haystack, needle) {
  let idx = haystack.indexOf(needle);
  while (idx !== -1) {
    const next = haystack[idx + needle.length];
    if (next === undefined || !/[a-z0-9_.-]/i.test(next)) return true;
    idx = haystack.indexOf(needle, idx + 1);
  }
  return false;
}

/** Resolves `cwd` to the known checkout root it sits under, falling back to
 *  raw `cwd` when it matches none (matching listKnownCheckoutRoots' own
 *  fail-closed default: "a guard that cannot see other worktrees still
 *  protects the one root it knows about for certain"). Needed because a real
 *  dispatched agent's `cwd` for a given tool call is not always a worktree
 *  ROOT — a call issued from a subdirectory (`cwd = <worktree>\src`, an
 *  ordinary shape) must still see every other file inside that SAME
 *  worktree as in-bounds, not just siblings of the subdirectory `cwd`
 *  happens to sit in. */
function resolveAssignedRoot(cwd, knownRoots) {
  return knownRoots.find((root) => isUnderRoot(cwd, root)) ?? cwd;
}

// Absolute Windows path literal, same shape the #3263/#3340 measurement
// parser matched — no shell expansion, both separator spellings.
// Quote/backtick chars in the exclusion set are \uXXXX-escaped, not literal,
// so this regex literal doesn't desync spawn-windows-hide.test.ts's own
// comment/string scanner (#2747).
const TRANSCRIPT_PATH_RE = /[A-Za-z]:[\\/][^\s\u0022\u0027\u0060<>|*?\r\n]+/g;

/** The user/prompt text of one transcript entry, for either message.content
 *  shape — mirrors the measurement parser's `promptText()`. */
function transcriptPromptText(entry) {
  const content = entry && entry.message ? entry.message.content : undefined;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter((block) => block && block.type === 'text' && typeof block.text === 'string')
      .map((block) => block.text)
      .join('\n');
  }
  return '';
}

/** Transcript-derived assignment signal (#3263 direction (a)). Walks prompt
 *  turns newest-first — turns sourced from `sdk` or `user`, skipping later
 *  `system` turns (e.g. task_notification) — and returns the first absolute
 *  Windows path that resolves to a known checkout root OTHER THAN the
 *  primary checkout, or `null` when no turn yields one.
 *
 *  TWO RULES DO THE WORK, and both were established by measurement rather
 *  than by inspection (`docs/ops/3263-transcript-signal-measurement.md`,
 *  715 real subagent transcripts scored against an independent ground truth
 *  — the checkout root each agent actually wrote to):
 *
 *  1. POLARITY: a path under `PRIMARY_CHECKOUT_ROOT` is never an assignment,
 *     so it is skipped rather than returned. This is not a tuning constant —
 *     it is the invariant this file already asserts at PRIMARY_CHECKOUT_ROOT's
 *     own declaration, and omitting it is what made the first cut of this
 *     function (#3355) unsafe. This repo's briefing convention LEADS with the
 *     prohibition ("primary checkout `C:\Claude\Projects\Audiobook-Generator`
 *     — do NOT edit files in the primary checkout…"), so a first-path-wins
 *     rule reads the explicitly forbidden root as the assigned one: measured
 *     123 of 523 picks (23.5%), every one of them naming the primary. With
 *     the skip, precision goes from 76.5% to 99.1% and wrong-primary picks to
 *     zero.
 *  2. KEEP SCANNING: every candidate in a turn is tested, and every earlier
 *     turn is tried, instead of returning on the first syntactically-clean
 *     candidate. Without this, rule 1 would merely convert those 123 wrong
 *     picks into no-picks. Requiring `knownRoots` membership inside the loop
 *     also discards the literal `C:\Claude\Projects\wt-*` glob the fix-agent
 *     brief itself contains, which resolves under no real root.
 *
 *  RESIDUAL RISK, measured and accepted: 6 of 658 picks (0.9%) named a
 *  live-but-wrong worktree — a later turn (a skill preamble, another PR's
 *  review brief) mentioning a tree the agent was not assigned. In that shape
 *  the guard both wrongly denies the true tree and wrongly allows the
 *  mis-extracted one; fail-open covers "found nothing", not "found the wrong
 *  known root". Three further apparent misses were the heuristic being RIGHT
 *  and the agent being wrong (it wrote to the primary against its brief —
 *  #3044's own incident shape), and are counted as errors above only because
 *  the ground truth is "where the agent wrote".
 *
 *  Throws only on an unreadable file (`readFileSync`); a malformed one does
 *  NOT throw — malformed JSON lines are skipped individually, so a wholly
 *  malformed transcript simply yields no entries and returns `null`. The
 *  caller wraps the call in its own try/catch either way, so a bad transcript
 *  falls back to the `cwd`-derived root rather than failing the guard open. */
function extractAssignedRootFromTranscript(transcriptPath, knownRoots) {
  const raw = readFileSync(transcriptPath, 'utf8');
  const entries = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      entries.push(JSON.parse(trimmed));
    } catch {
      // malformed line: skipped, same as the measurement parser's loadEntries().
    }
  }

  const primary = resolve(PRIMARY_CHECKOUT_ROOT).toLowerCase();
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (!entry || entry.type !== 'user') continue;
    const text = transcriptPromptText(entry);
    if (!text.trim()) continue;
    const source = entry.promptSource || 'user';
    if (source !== 'sdk' && source !== 'user') continue;

    for (const candidate of text.match(TRANSCRIPT_PATH_RE) ?? []) {
      // Corrected (#3340) escape-debris predicate, copied verbatim — a
      // `\[nrt]` immediately followed by a name character is separator +
      // real directory name (`\tasks`), not JSON-escape debris (`g:\n\n`).
      const cleaned = candidate.replace(/[.,;:)\]}]+$/, '');
      const seps = (cleaned.match(/[\\/]/g) || []).length;
      const escapedWs = /\\[nrt](?![A-Za-z0-9_])/.test(cleaned);
      if (cleaned.length <= 3 || seps < 2 || escapedWs) continue;

      const root = knownRoots.find((known) => isUnderRoot(cleaned, known));
      // Rules 1 and 2, in one line: unknown roots and the primary checkout
      // are SKIPPED, not returned and not terminal — the scan continues
      // through the rest of this turn and on into earlier turns.
      if (!root || resolve(root).toLowerCase() === primary) continue;
      return root;
    }
  }
  return null;
}

/** Pure decision function. Never throws — a hook that crashes on a payload
 *  shape it did not expect must fail OPEN (allow), not open a window where a
 *  parse bug blocks every tool call from every subagent.
 *
 *  ASSIGNED-ROOT RESOLUTION (Castwright#3263, filed from PR #3261's own review
 *  pass; first cut #3355, corrected in the same PR after its review).
 *  "Assigned worktree" was originally defined purely as the root `cwd`
 *  resolves to, which is NOT
 *  independently verified — it is whatever the harness happened to start this
 *  subagent process in. #3044's own incident record describes a brief that
 *  correctly named the worktree while the agent's process nonetheless ran
 *  with `cwd` pointed at the wrong root; in that shape the guard protected
 *  the wrong root, not the right one.
 *
 *  Fix: when an optional `transcriptPath` is supplied, `decideGuardVerdict`
 *  additionally runs `extractAssignedRootFromTranscript` against it and
 *  PREFERS the root that returns over the `cwd`-derived one. Preferring it
 *  outright — rather than intersecting the two — is deliberate and is what
 *  the measurement supports: across 715 real subagent transcripts the
 *  recorded `cwd` named the root the agent actually wrote to just 48 times
 *  (6.7%), while naming the primary checkout instead 626 times (87.6%). The
 *  `cwd` signal is not a conservative baseline the transcript signal is
 *  layered on top of; on this box it is the WRONG answer in the large
 *  majority of dispatches, which is precisely the #3263 inversion. The same
 *  corpus scores the transcript signal at 652/658 (99.1%) with zero picks
 *  naming the primary. Full method, corpus and per-variant scores:
 *  `docs/ops/3263-transcript-signal-measurement.md`.
 *
 *  Fail-open is unchanged and total for the "no signal" case: `transcriptPath`
 *  absent, unreadable, wholly malformed, or yielding no known non-primary
 *  root all land on exactly today's `cwd`-derived behaviour, byte for byte.
 *
 *  What fail-open does NOT cover, stated plainly because the first cut of
 *  this change (#3355) claimed a safety property it did not have: a
 *  WRONG-BUT-CONFIDENT pick. When extraction names a live known worktree that
 *  is not the assigned one (measured at 6/658, 0.9% — a later turn naming
 *  another PR's tree), the guard both wrongly DENIES a write to the true tree
 *  and wrongly ALLOWS one to the mis-extracted tree. That is a real, accepted
 *  residual risk, not an impossibility; it is the reason the manual
 *  before/after `git status --porcelain` check stays in CLAUDE.md as a
 *  backstop rather than being retired by this change. Still open, separately:
 *  whether a denial should be terminal (raised in #3263's 2026-09-21
 *  design-pass comment, now tracked as #3369, not addressed here).
 *
 *  Write/Edit/NotebookEdit: resolve the target path (tool_input.file_path
 *  for Write/Edit, tool_input.notebook_path for NotebookEdit) against the
 *  root `resolveAssignedRoot` resolves `cwd` to (pass 3 of #3261's review,
 *  C7 — comparing against raw `cwd` instead denied a legitimate write from
 *  any tool call issued outside the worktree's own root, invisible to the
 *  guard's own suite because every test set `cwd` to a root already) and
 *  deny anything that does not fall under it. Precise — this is a real path
 *  containment check, not a heuristic.
 *
 *  Bash/PowerShell: COARSE by design (per #3044's "Decision (2026-09-06)"
 *  comment — a precise shell-command check does not exist yet, and shipping
 *  the coarse one is the documented decision rather than deferring). Flags a
 *  command whose text contains, AT A REAL PATH-COMPONENT BOUNDARY (see
 *  `containsPathAtBoundary` — otherwise a root that is a string prefix of a
 *  sibling worktree's name denies the agent's own tree), an absolute path
 *  belonging to a DIFFERENT known checkout root while cwd is a different
 *  root — checked after normalizing every separator spelling a Windows path
 *  can appear under in a shell command to one canonical form (native
 *  backslash, doubled/escaped backslash, forward-slash, and any mix of
 *  those; see `normalizeSeparators`), plus Git Bash's `/c/...` and WSL's
 *  `/mnt/c/...` mount forms (see `pathSpellings`). FALSE-NEGATIVE RISK,
 *  stated per the issue's requirement: a command that references a foreign
 *  path indirectly — via a shell variable, a relative path resolved
 *  elsewhere, an environment expansion, or a path assembled at runtime — is
 *  not caught. Only a literal absolute path substring, in one of its known
 *  spellings, is detected. */
export function decideGuardVerdict({ toolName, toolInput, cwd, transcriptPath, knownRoots = listKnownCheckoutRoots() }) {
  try {
    const cwdRoot = resolveAssignedRoot(cwd, knownRoots);

    // Local try/catch, not just the outer one: an unreadable/malformed
    // transcript must fall back to the cwd-derived root, not blanket-allow
    // (or blanket-deny) whatever the cwd-only logic below would have decided.
    let extractedRoot = null;
    if (transcriptPath) {
      try {
        extractedRoot = extractAssignedRootFromTranscript(transcriptPath, knownRoots);
      } catch {
        extractedRoot = null;
      }
    }
    const assignedRoot = extractedRoot ?? cwdRoot;

    if (toolName === 'Write' || toolName === 'Edit' || toolName === 'NotebookEdit') {
      const filePath = toolName === 'NotebookEdit' ? toolInput?.notebook_path : toolInput?.file_path;
      if (!filePath) return { deny: false };
      const abs = resolve(cwd, filePath);
      if (!isUnderRoot(abs, assignedRoot)) {
        return {
          deny: true,
          reason: `guard-worktree-write: ${toolName} target "${abs}" is outside the assigned worktree "${assignedRoot}".`,
        };
      }
      return { deny: false };
    }

    if (toolName === 'Bash' || toolName === 'PowerShell') {
      const command = normalizeSeparators(String(toolInput?.command ?? '').toLowerCase());
      const ownRoot = assignedRoot;
      for (const root of knownRoots) {
        if (ownRoot && resolve(root).toLowerCase() === resolve(ownRoot).toLowerCase()) continue;
        if (pathSpellings(root).some((spelling) => containsPathAtBoundary(command, spelling))) {
          return {
            deny: true,
            reason: `guard-worktree-write: ${toolName} command references a foreign checkout root "${root}" while cwd is "${cwd}".`,
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
    transcriptPath: payload.transcript_path,
  });

  if (verdict.deny) {
    process.stderr.write(`${verdict.reason}\n`);
    process.exit(2);
  }
  process.exit(0);
}
