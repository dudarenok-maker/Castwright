#!/usr/bin/env node
// PreToolUse guard for a dispatched fix-agent's Write/Edit/NotebookEdit/
// Bash/PowerShell calls (Castwright#3044, option 2 — see #3044's "Decision
// (2026-09-06)" comment). Castwright#3263's transcript-derived assignment
// signal (see decideGuardVerdict's doc comment) has landed — the assigned
// root is the one a scan of THE SUBAGENT'S OWN TRANSCRIPT finds, falling back
// to `cwd` when the scan finds nothing. That is a correction, not an
// enhancement: `cwd` alone named the right root in 6.7% of 715 measured
// dispatches. Which file is scanned is load-bearing and is NOT the payload's
// `transcript_path` — see resolveOwnTranscriptPath.
//
// REMAINING GAPS, all real and all measured: the scan finds nothing on ~8% of
// dispatches and falls back to `cwd`, which is usually wrong, so the old
// failure mode still reaches ~7.7% of them; a wrong-but-confident extraction
// still protects the wrong tree and can ALLOW a write to it; a brief that
// assigns the primary checkout directly is skipped by the polarity rule; and
// the Bash/PowerShell check stays coarse. Separately still open: whether a
// denial should be terminal (#3263's 2026-09-21 design-pass comment, parked,
// tracked as #3369). So this guard remains a layer, NOT a full
// replacement for the manual before/after `git status --porcelain` check.
//
// Wired via the `hooks:` frontmatter key on `.claude/agents/fix-agent.md`,
// per #3246's empirical findings (docs/ops/3044-hook-mechanism-findings.md):
// that mechanism fires for a subagent dispatched through the Agent tool,
// delivers the PreToolUse JSON payload on stdin (tool_name, tool_input, cwd),
// and a confirmed-working deny is exit code 2 with a stderr message.
//
import { readFileSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { win32, join as platformJoin } from 'node:path';
import { isDirectlyInvoked } from '../lib/is-main-module.mjs';
import { scrubGitEnv } from '../git-env.mjs';

// PRIMARY_CHECKOUT_ROOT is a hardcoded Windows path regardless of what OS
// this hook runs on (CI runs the test suite on Ubuntu). The platform-default
// `node:path` export resolves to `path.posix` there, which treats a `C:\...`
// string as a non-absolute path and silently prepends `process.cwd()` to it
// — breaking both the containment check and the Bash/PowerShell substring
// match. Pin to `path.win32` so the logic is identical on every OS.
const { resolve, sep } = win32;

// The primary checkout. It is the root a brief names in order to FORBID it
// ("do NOT edit files in the primary checkout"), which is why the transcript
// scan below skips it as an assignment candidate.
//
// It is NOT, however, never-assignable — that stronger claim stood here until
// PR #3358's review pass 2 falsified it. CLAUDE.md's trivial-bar carve-out
// sanctions working in the primary directly, and a real brief in the measured
// corpus does exactly that ("This branch is currently checked out in the
// primary checkout at C:\Claude\Projects\Audiobook-Generator — work there
// directly … not worth a worktree"). Such a dispatch is rare — 1 of ~1,594
// real transcripts — and the scan handles the observed one correctly, because
// a brief that assigns the primary names no other checkout root for the scan
// to find, so it returns null and `cwd` (also the primary) stands. The hazard
// it leaves is narrow and real: a primary-assigned brief that ALSO mentions a
// live worktree in passing would have that worktree returned instead. See the
// residual-risk paragraph on extractAssignedRootFromTranscript.
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

/** The PreToolUse payload's `transcript_path` names the DISPATCHING SESSION's
 *  transcript, NOT the subagent's own — `…\<project>\<session-id>.jsonl`. Both
 *  real `fix-agent` payloads ever captured say so verbatim
 *  (`docs/ops/3263-dispatch-cwd-findings.md`,
 *  `docs/ops/3263-guard-assignment-signal-findings.md`), and their
 *  `session_id` matches that filename while `agent_id` does not appear in it
 *  at all.
 *
 *  **Reading that file is not a weaker version of reading the right one — it
 *  is actively harmful**, and PR #3358's review pass 3 is where this was
 *  caught, after two passes and a 715-transcript measurement had scored the
 *  wrong file. Scored over 626 ground-truthed dispatches, the same scan gets
 *  99.1% on the subagent's own transcript and **17.8% on the dispatching
 *  session's, with 25.9% naming a wrong WORKTREE** — the one error class
 *  fail-open does not cover, because it converts a loud false denial into a
 *  silent false allow into a live sibling checkout. The reason is structural,
 *  not statistical: in the dispatcher's transcript the subagent's brief is not
 *  a candidate at all (it lives inside an `Agent` tool_use on an `assistant`
 *  turn, which the scan correctly refuses to read), so every turn the scan CAN
 *  see is about some other piece of work.
 *
 *  So the subagent's own transcript is derived instead, from two fields the
 *  payload does carry. The layout is `<session-transcript-minus-.jsonl>\
 *  subagents\agent-<agent_id>.jsonl`, verified present with the matching
 *  `agent_id` for both recorded payloads. Deriving it this way also answers
 *  "does this transcript belong to THIS dispatch?" by construction rather than
 *  by trust.
 *
 *  Returns `null` — never the session transcript as a fallback — when either
 *  field is missing, when `transcriptPath` is not a `.jsonl` path, or when
 *  `agentId` is not a bare token. That last check is a path-traversal guard:
 *  `agent_id` is interpolated into a filesystem path, so anything carrying a
 *  separator or `..` is refused rather than normalised. A `null` here means
 *  the caller falls back to `cwd`, i.e. exactly the pre-#3263 behaviour. */
export function resolveOwnTranscriptPath(transcriptPath, agentId, join = platformJoin) {
  if (!transcriptPath || !agentId) return null;
  if (!/^[A-Za-z0-9_-]+$/.test(String(agentId))) return null;
  const raw = String(transcriptPath);
  if (!/\.jsonl$/i.test(raw)) return null;
  // PLATFORM join, not the `win32` pin this module uses everywhere else. That
  // pin exists so the Windows path LITERALS and the containment comparisons
  // behave identically on every OS (see the note at `const { resolve, sep }`).
  // This return value is different in kind: it is handed straight to
  // `statSync`/`readFileSync`, so it has to be a path the running OS can
  // actually open. Composing it with `win32.sep` made the whole thing one
  // long basename on POSIX — `\` is an ordinary filename character there —
  // so every lookup ENOENT'd and 16 of this file's tests went red on the
  // Ubuntu `test:hooks` leg while staying green on Windows (PR #3358 review
  // pass 4, N10). On Windows both separators are `\`, so production is
  // unchanged.
  //
  // `join` is injectable for ONE reason: this defect is invisible to a test
  // running on Windows, where `win32.sep === platformSep`, so a Windows-only
  // suite cannot fail on it however it is written. That is what let it
  // through four review rounds. The parameter lets the suite drive the
  // `posix` arm explicitly and assert forward slashes, on any OS. Production
  // never passes it.
  return join(raw.slice(0, -'.jsonl'.length), 'subagents', `agent-${agentId}.jsonl`);
}

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

/** Transcript-derived assignment signal for #3263 — note this is NOT that
 *  issue's "direction (a)", which named a coordinator-set per-dispatch signal
 *  (an env var or an `agent_id`-keyed marker file). Walks prompt
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
 *  1. POLARITY: a path under `PRIMARY_CHECKOUT_ROOT` is skipped rather than
 *     returned. Not because the primary can never be an assignment — it can,
 *     rarely, and an earlier revision of this comment wrongly said otherwise
 *     (PR #3358 review pass 2; see PRIMARY_CHECKOUT_ROOT's own declaration) —
 *     but because it is overwhelmingly named in order to be FORBIDDEN, and
 *     omitting the skip is what made the first cut of this function (#3355)
 *     unsafe. This repo's briefing convention LEADS with the
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
 *  RESIDUAL RISK, in two shapes, both measured and both accepted:
 *
 *  (a) A WRONG-BUT-CONFIDENT pick — a later turn (a skill preamble, another
 *      PR's review brief) naming a live tree the agent was not assigned, and
 *      the scan takes it. 0–2 of ~630 picks depending on whose root
 *      reconstruction you use; the review's independent re-derivation put it
 *      at 0–1, i.e. an earlier revision of this comment claiming "6 of 658
 *      (0.9%)" OVER-stated it. The itemisations differ because the two passes
 *      scored different residual sets against differently-reconstructed root
 *      lists — this comment's own 6, and the review's 8 — so rather than
 *      reproduce either breakdown here and have it drift again, see
 *      `docs/ops/3263-transcript-signal-measurement.md` (Result 3 and the
 *      re-derivation note) for both, side by side. What BOTH agree on: no
 *      pick ever named the primary checkout, and most of the apparent misses
 *      were the scan being RIGHT while the agent wrote somewhere it should
 *      not have — #3044's own incident shape.
 *  (b) A PRIMARY-ASSIGNED dispatch whose brief also mentions a live worktree
 *      in passing. Rule 1 skips the real assignment and the scan returns the
 *      incidental tree. Zero observed in ~1,594 transcripts — the one real
 *      primary-assigned brief names no other root, so the scan correctly
 *      returns null — but it is reachable, and unlike (a) it is a REGRESSION
 *      against the pre-#3263 `cwd` behaviour rather than a failure to
 *      improve on it.
 *
 *  In either shape the guard both wrongly denies the true tree and wrongly
 *  allows the mis-extracted one: fail-open covers "found nothing", never
 *  "found the wrong known root". Both are pinned by `KNOWN LIMIT` tests so
 *  that closing one is a deliberate act rather than an accident.
 *
 *  Throws only on a file it cannot inspect or read — `statSync` first (it is
 *  the size guard's probe, so it is the first thrower, not `readFileSync`),
 *  then `readFileSync`. A MALFORMED file does
 *  NOT throw — malformed JSON lines are skipped individually, so a wholly
 *  malformed transcript simply yields no entries and returns `null`. The
 *  caller wraps the call in its own try/catch either way, so a bad transcript
 *  falls back to the `cwd`-derived root rather than failing the guard open. */
function extractAssignedRootFromTranscript(transcriptPath, knownRoots) {
  // Size guard: this runs before EVERY guarded tool call, and a transcript is
  // an append-only log with no upper bound. Subagent transcripts on this box
  // run to ~10 MB at the top end (median ~750 KB, ~4 ms), so 32 MB is far
  // above anything observed — it exists to stop a pathological file turning
  // the guard into a per-call stall, not to filter real ones. Over the bound,
  // fail open to `cwd` like any other unreadable transcript.
  if (statSync(transcriptPath).size > 32 * 1024 * 1024) return null;
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
      // Only the escape-debris term survives from #3340's three-part
      // predicate. The other two — a minimum length and a two-separator floor
      // — existed to stop a fragment being RETURNED as a path, which this
      // function no longer does: it returns a known checkout root, so the
      // membership check below already rejects anything a length or separator
      // floor would have. Keeping them meant carrying two branches no test
      // could make fail (PR #3358 review pass 3, N6). The debris term is not
      // redundant: a `wt-A\nwt-B`-style candidate's HEAD does resolve to a
      // known root, so without it the scan returns the wrong one.
      const escapedWs = /\\[nrt](?![A-Za-z0-9_])/.test(cleaned);
      if (escapedWs) continue;

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
 *  Fix: given `transcriptPath` and `agentId`, `decideGuardVerdict` derives the
 *  subagent's OWN transcript (`resolveOwnTranscriptPath` — never the
 *  dispatching session's, which is what `transcript_path` actually names and
 *  which scores 17.8% with 25.9% wrong-worktree picks), runs
 *  `extractAssignedRootFromTranscript` against that, and PREFERS the root it
 *  returns over the `cwd`-derived one. Preferring it
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
 *  is not the assigned one (0–2 of ~630 picks, ≤0.3% — a later turn naming
 *  another PR's tree; see the residual-risk paragraph on
 *  extractAssignedRootFromTranscript for why the range rather than a single
 *  number), the guard both wrongly DENIES a write to the true tree
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
export function decideGuardVerdict({ toolName, toolInput, cwd, transcriptPath, agentId, knownRoots = listKnownCheckoutRoots() }) {
  try {
    const cwdRoot = resolveAssignedRoot(cwd, knownRoots);

    // `transcriptPath` is the payload's `transcript_path`, which names the
    // DISPATCHING SESSION's transcript. Never scan that file — see
    // resolveOwnTranscriptPath, which derives the subagent's own transcript
    // from it plus `agentId`, and returns null rather than falling back to it.
    const ownTranscript = resolveOwnTranscriptPath(transcriptPath, agentId);

    // Local try/catch, not just the outer one: an unreadable/malformed
    // transcript must fall back to the cwd-derived root, not blanket-allow
    // (or blanket-deny) whatever the cwd-only logic below would have decided.
    // A subagent transcript the harness has not written (or not yet flushed)
    // at the time of the first tool call lands here as ENOENT, which is the
    // benign case: fall back to `cwd`, i.e. the pre-#3263 behaviour.
    let extractedRoot = null;
    if (ownTranscript) {
      try {
        extractedRoot = extractAssignedRootFromTranscript(ownTranscript, knownRoots);
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
    // Both are needed: `transcript_path` alone names the dispatching
    // session's transcript, which must never be scanned.
    transcriptPath: payload.transcript_path,
    agentId: payload.agent_id,
  });

  if (verdict.deny) {
    process.stderr.write(`${verdict.reason}\n`);
    process.exit(2);
  }
  process.exit(0);
}
