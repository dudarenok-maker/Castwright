# Cline project rules (Castwright / Audiobook-Generator)

## Read these first -- they are NOT loaded for you

The canonical rules are the root **`CLAUDE.md`** and **`CONTRIBUTING.md`**.
Cline loads neither. Its rule loader reads `.clinerules` (a directory or a bare
file), `.cline/`, and workspace/global `AGENTS.md`, taking `.md` / `.markdown`
/ `.txt`. **Read both canonical files before your first edit** -- `CLAUDE.md`
for the working principles, execution model and conventions,
`CONTRIBUTING.md` for the commit / branch / PR / issue / release-notes specs.

Verified 2026-08-14, two ways: `@cline/core` (the package holding the loader)
contains zero `CLAUDE` byte sequences under a binary-safe grep, against
positive controls that do find `clinerules` and `AGENTS.md`; and a live
`cline -p` probe in this workspace reported only `Workspace AGENTS.md` +
`.clinerules/cline.md` in context. One caveat, so nobody re-derives this and
thinks the note is wrong: `cli-windows-x64/bin/cline.exe` does carry
`CLAUDE.md` literals, in a `claudeMd` / `claudeMdExcludes` settings schema
belonging to the **bundled Claude Agent SDK** that Cline vendors -- not to its
own rule loader. A vendored schema is not a loader, so those strings do not
indicate `CLAUDE.md` support and no setting flips them into it. Re-verify if
Cline's rule loader itself changes.

This file is a summary, not a substitute. It deliberately restates almost
nothing from them, carrying only rules that are **Cline-specific** or that
**fail silently**. Where the two disagree, they win -- and tell the user, so
this file gets fixed. Anything of general value belongs in `CLAUDE.md` instead.

## Cline-specific

- **Skills resolve from `~/.agents/skills/`; a workspace `.claude/skills/` is
  not read.** Both proven by probe (2026-08-13,
  `docs/testing/agent-skill-resolution-probe.md`), as is `~/.cline/skills`
  being dead. So re-run `npm run skills:sync` after any change under
  `.claude/skills/pr-review-gate/` -- a per-machine step, since the target is
  under `$HOME`, so CI cannot run it and a fresh clone has no mirror. Do not
  read that as an exhaustive list: the loader composes skill roots from its
  rule directories (`skillsPath: join(<ruleDir>, "skills")`), so workspace
  roots may also work. They are untested, and presence in the code is not
  proof -- `~/.cline/skills` sits in that same list and is dead. Treat anything
  beyond the two probed answers as unverified (#2368).
- **Model tiers are not selectable, so a Cline review pass does NOT discharge
  the merge gate.** The probe above recorded `CLINE_TIER_SELECTABLE: no`,
  observing a subagent backed by `deepseek-v4-flash`; subagents do start cold
  (`CLINE_SUBAGENT_COLD: yes`, self-reported, not independently reproduced).
  Independence is the property people check and it is the one Cline has -- the
  tier is the one it lacks. So CLAUDE.md's "Model routing" table (Haiku /
  Sonnet / Opus / Fable) and its `.claude/worktrees` + `claude/wt-*` branch
  choreography are Claude-Code mechanics I cannot reproduce. Follow the INTENT
  -- fresh cold subagents per task, per-task review, review-gated ships -- but
  record a Cline pass as a **flash-tier independent pass, never as the
  `pr-review-gate` gate itself**, and hand any decision that turns on tier
  choice to the user. Calling it "the review gate" is a false completion
  claim.
- **This is a Windows box running PowerShell 5.1.** No `&&` / `||` chaining
  (use `;` or `if ($?) { ... }`), no ternary / `??` / `?.`. `head`, `tail`,
  `which`, and `touch` do not exist -- use `Get-Content -TotalCount N` /
  `-Tail N` and `(Get-Command x).Source`. A here-string's closing `'@` must sit
  at column 0, and an em dash inside a `.ps1` is a parse terminator.

## Never do these

- **Never commit to `main`.** Every change -- including a one-line doc fix --
  reaches `main` through a branch and a PR; `main`'s required status checks
  reject anything else. Branches are `<type>/<scope>-<slug>`.
- **Never hand-edit a generated file:** `src/lib/api-types.ts` (regenerate via
  `npm run openapi:types`) and `docs/BACKLOG.md` (`npm run backlog:sync`) are
  generated whole. `server/.env.example` is only PARTLY generated -- the block
  between the `BEGIN`/`END generated config knobs` markers is owned by
  `npm run config:sync`, and the ~460 lines outside it (including
  `GEMINI_API_KEY=`) are hand-authored and safe to edit. `config:check` never
  looks outside the block, so it will not catch a mistake there.
- **Never bypass a hook with `--no-verify` to get unstuck.** Triage instead:
  caused by my change -> fix it in the same commit; pre-existing (the same test
  fails on `main`) -> surface it to the user and do NOT fold the fix in;
  suspected flake -> re-run that test alone once and name it. CLAUDE.md
  "Working practice" states the rule flatly: do not use `--no-verify` to
  bypass. Two narrow exceptions are documented, neither of them "the hook is
  red": a `git commit --no-verify` in a genuine emergency, where the commit
  still needs fixing before review (CONTRIBUTING.md "Enforcement"), and a
  `git push --no-verify` when the force-push or branch deletion
  `guard-protected-push` is refusing is the thing you actually intend
  (CLAUDE.md "Commit gate", `.husky/pre-push`). **"I already ran the tests" is
  not a third**: that hook also runs `guard-protected-push` and
  `guard-commit-subjects`, and `verify:fast:branch` runs neither, so bypassing
  drops the backstop that catches a malformed subject when `commit-msg` did
  not fire -- exactly the fresh-worktree case below, and the leak that shipped
  on #856.
- **Never treat hook output in a fresh worktree as proof of verification** --
  see the first trap below.

## Traps that fail silently

- **A fresh worktree's git hooks do nothing, and say nothing.**
  `core.hooksPath` is inherited but resolves per-worktree, and `.husky/_` is
  git-ignored, so a new checkout gives git no hook to run: commit-msg
  validation and the whole pre-push battery vanish, silently. Fix it before the
  first commit with `npx husky`, then junction BOTH `node_modules` and
  `server/node_modules` from the primary checkout (missing the second fails the
  server legs with "vitest not found"). Simplest path is
  `node scripts/wt-new.mjs <type>/<scope>-<slug>`, which does all of it plus
  non-clashing ports.
- **Tearing that worktree down in the wrong order guts the primary checkout.**
  `git worktree remove` (and `Remove-Item -Recurse`) will follow a junction and
  delete the REAL `node_modules` it points at, so every npm script in the
  primary checkout breaks until you reinstall. (Hooks themselves survive --
  `.husky/_` is a real repo-root directory, not a link -- so they keep firing
  and fail loudly; it is the *ordering* requirement and the two checks below
  that are silent.) Drop the junctions first -- `(Get-Item $j -Force).Delete()`
  removes the link only -- gating on
  `$i.Attributes -band [IO.FileAttributes]::ReparsePoint`, never on
  `.LinkTarget`, which reads empty on PowerShell 5.1 even for a real junction
  and so silently skips the delete. `cmd /c rmdir` no-ops and still returns 0,
  so confirm with `Test-Path` rather than an exit code. Full recipe: CLAUDE.md
  "Worktree teardown".
- **`.claude/` is git-ignored wholesale** -- `.gitignore` has `.claude/*` with
  only `!.claude/skills/` re-included -- so a new file under it is silently
  skipped by `git add` and never reaches the PR. Confirm with
  `git status --short` after adding one.
- **Git-ignored artifacts (`brand/`, `mockups/`, marketing captures) are
  produced in the primary checkout**, never in a worktree: they do not travel
  with the branch and worktree teardown destroys them.
- **A `git push` can take longer than your 30-second command cap whenever the
  branch diff touches `server/tts-sidecar/**`, so that push has to be run
  detached.** Not a silent trap -- the timeout is loud -- but the loop it
  produces is not. See "Committing when a step is in scope" below.

## Committing when a step is in scope

**Commits are instant now; a sidecar-touching push is not.** As of ops-2997,
pre-commit is one ESLint process over the staged JS/TS files -- the
`verify:fast:scoped` battery is gone -- so a foreground `git commit` finishes
well inside a 30-second command cap. Pre-push is its guard scripts plus
`node scripts/verify-cache.mjs --steps test:sidecar --scope-branch`. That is
seconds when `test:sidecar` is out of scope or cached, and **~6.85 minutes**
when it actually runs pytest. Your runtime kills a single command at 30
seconds; the cap is internal to Cline and there is no CLI flag for it
(`-t/--timeout` is the whole-run timeout, not the per-command one).

**The rule -- it applies to every agent lane, not just this one:**

> **Launch `git push` detached and poll whenever the branch diff touches
> `server/tts-sidecar/**`.** Every `git commit`, and every push whose branch
> diff does not touch that path, may run in the foreground.

Evaluate that mechanically before you push. Do not substitute a judgement about
whether this diff "looks slow":

```powershell
git -C $W diff --name-only origin/main...HEAD -- 'server/tts-sidecar/**'
```

Non-empty output means detached. **The mechanical test is the point.** Three
successive revisions of this paragraph tried instead to *predict* which diffs
were slow, and all three under-listed in the same direction: the agent read its
own change as exempt, took the foreground path into the 30-second kill,
diagnosed a *slow* command when what it actually had was a *capped* one, and
reached for `--no-verify`. On 2026-08-19 an agent did precisely that and
produced correct, well-tested code that never left the box. The rule is stated
unconditionally for the same reason: an instruction scoped by lane name is read
as an exemption by every lane it does not name.

Two further things push a `git push` over the cap, and the path test above
catches neither -- so if a foreground push is still running at ~25 s, relaunch
it detached rather than retrying it in the foreground:

- a root `package.json` / `package-lock.json` / `.github/actions/**` change,
  which `computeShared` in `scripts/verify-cache.mjs` puts **every** step in
  scope for, `test:sidecar` included, whatever the step's own globs say;
- a cold verify cache, which makes an in-scope `test:sidecar` actually execute
  instead of reporting `[cached]`.

`STEPS[]` in `scripts/verify-cache.mjs` is the source of truth for what pre-push
selects and what each step costs. Read it there rather than trusting a summary
-- including this one.

**Call `scripts/oe-detached-commit.ps1` -- do not freelance your own inline
Start-Process variant.** It lives in every worktree (it's a tracked file, so
`git worktree add` brings it along) and does what the old inline recipe did,
but as a real script instead of a copy-pasted snippet a model can misremember:
writes the message to a BOM-less file, launches `git commit` via
`Start-Process -WindowStyle Hidden`, and hands back the scratch dir to poll.
Because `-Message` is a bound **parameter** rather than text interpolated into
a command string, **no apostrophe escaping is needed** -- pass the message
exactly as written, single quotes and all:

```powershell
$W = 'C:\Claude\Projects\wt-<your-worktree>'
$T = & "$W\scripts\oe-detached-commit.ps1" -Worktree $W `
       -Message "fix(scope): subject line, don't escape apostrophes here"
```

**Keep `$W` around** -- the poll steps below and the tiebreaker
(`git -C $W log --oneline -1`) both use it.

Two failure modes this script exists to close, both hit by freelanced
variants in the past -- **do not rebuild either by hand**:

- **Dropping `-WindowStyle Hidden`.** A `cline-free` lane on `Castwright#2659`
  (2026-08-26) wrote its own launcher without it, popping a visible
  PowerShell window per commit -- and per pre-commit hook run that commit
  triggers. The script always passes the flag; if a window is still showing,
  something bypassed the script rather than a flag being missing from it.
- **Quoting the message by hand.** On `Castwright#2520` a local-model run
  built the git command as an interpolated string with an unescaped `'`, hit
  `The string is missing the terminator` / `Missing type name after '['` /
  `Exception calling "Create" with "1" argument(s)` across four
  self-invented variants, spent its whole turn reasoning line-by-line about
  *why* each one broke, and died on the output-token cap with no commit, no
  push, and no receipt -- while the two-file edit it was committing was
  already correct. Passing `-Message` as a parameter makes this class of bug
  impossible. **If you see one of those errors anyway, stop reasoning about
  it after one sentence and re-check you're actually calling the script, not
  a hand-built variant of it -- and if a retry produces the identical error
  even after confirming that, stop retrying** and say so once with the exact
  command and the error, per "Do not end your turn while it runs" below.

Then poll until it resolves. Each poll returns instantly, so the output-token
cap stops mattering. **Check the process as well as the sentinel** --
those two disagreeing is how you learn the child died at parse time instead of
waiting on it forever:

```powershell
$id    = Get-Content "$T\commit.pid"
$alive = [bool](Get-Process -Id $id -ErrorAction SilentlyContinue)
$done  = (Test-Path "$T\commit.log") -and (Select-String -Path "$T\commit.log" -Pattern '^EXIT=' -Quiet)
"alive=$alive done=$done"
if ($alive)          { 'still running -- keep polling, and IGNORE any EXIT= you can see' }
elseif ($done)       { Get-Content "$T\commit.log" -Tail 40 }
else                 { "child gone with no EXIT= -- check whether HEAD moved before assuming nothing happened" }
```

**While it is alive, a sentinel you can see is from an earlier attempt** -- keep
polling rather than reading it as this run's result. Once the process is gone
the sentinel is yours. The one thing that settles any disagreement is the repo
itself: `git -C $W log --oneline -1`. Check that before acting on a surprising
verdict, because a pid can be reused and a log line can be stale, while a
commit either exists or does not.

`EXIT=0` means the hook passed; confirm with `git -C $W log --oneline -1`.
Anything else is a real failure in the log and is yours to fix.

**Two ways the log misleads on the way out.** The child redirects with `*>&1`,
so a *successful* run's tail can still be full of `NativeCommandError` and
`CategoryInfo` -- that is PowerShell rendering git's stderr progress chatter,
not a failure; read `EXIT=` and `git log`, not the shape of the text. And if
the child vanished without a sentinel, **check `git -C $W log --oneline -1`
before concluding it never ran**: it may have been killed after the commit
landed, which is exactly what happened on #2382.

### Pushing detached (the `server/tts-sidecar/**` case)

`oe-detached-commit.ps1` only commits. When the rule above says this push must
go detached, launch it the same way -- hidden window, output redirected into a
**freshly named** scratch dir, an `EXIT=` sentinel appended last:

```powershell
$W = 'C:\Claude\Projects\wt-<your-worktree>'
$T = Join-Path $env:TEMP ('cw-push-' + [Guid]::NewGuid().ToString('N').Substring(0, 8))
New-Item -ItemType Directory -Path $T -Force | Out-Null
$child = @'
param([string]$Dir, [string]$Worktree)
$ErrorActionPreference = 'Continue'
git -C $Worktree push *>&1 | Out-File -FilePath (Join-Path $Dir 'push.log') -Encoding utf8
"EXIT=$LASTEXITCODE" | Out-File -FilePath (Join-Path $Dir 'push.log') -Append -Encoding utf8
'@
Set-Content -Path (Join-Path $T 'push.ps1') -Value $child -Encoding utf8
$p = Start-Process powershell -WindowStyle Hidden -PassThru -ArgumentList @(
    '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "`"$T\push.ps1`"",
    '-Dir', "`"$T`"", '-Worktree', "`"$W`"")
$p.Id | Set-Content (Join-Path $T 'push.pid')
$T
```

**Never a fixed log name.** The GUID suffix is load-bearing, exactly as it is in
`oe-detached-commit.ps1`: two lanes -- or two attempts in one lane -- that share
a `%TEMP%\push.log` each poll the other's sentinel, and you report `EXIT=0` for
a push you never made, with no error at all.

Poll it exactly as for a commit: **process first, sentinel second**, and while
the process is alive any `EXIT=` you can see is from an earlier attempt.

```powershell
$id    = Get-Content "$T\push.pid"
$alive = [bool](Get-Process -Id $id -ErrorAction SilentlyContinue)
$done  = (Test-Path "$T\push.log") -and (Select-String -Path "$T\push.log" -Pattern '^EXIT=' -Quiet)
"alive=$alive done=$done"
if ($alive)    { 'still running -- keep polling, and IGNORE any EXIT= you can see' }
elseif ($done) { Get-Content "$T\push.log" -Tail 40 }
else           { 'child gone with no EXIT= -- check whether the upstream ref moved' }
```

`EXIT=0` means the hooks passed. **Budget ~7 minutes and do not call it hung
before 10** -- that is one pytest run, not a battery. The repo settles any
disagreement, because a pid can be reused and a log line can be stale while a
ref either moved or did not: `git -C $W status -sb` (the `ahead`/`behind`
counts), or `git -C $W rev-parse HEAD "@{u}"`.

**Do not end your turn while it runs.** Polling is active waiting and is
correct; ending the run is not -- you are headless and nothing will wake you.
If it genuinely cannot be delivered from your lane, say so once with the exact
command and the cap.

**Never `--no-verify`** (the two documented exceptions are under "Never do
these" and neither is "the hook is slow"). This cost six identical
claim-and-fail cycles and twelve commit attempts on #2382 before the cap was
recognised as the whole story.

## Findings are fixed, not filed

A defect or chore surfaced in passing is fixed in the same round, with its
paired test, and declared in the PR body ("Also fixed, found in passing: ...").
Filing an issue records the fix; it never substitutes for it. The one thing
that defers a finding is a genuine design pass -- the fix has more than one
defensible outcome and something has to choose between them -- and then the
issue names the decision that is owed. "It would expand this PR", "it's
pre-existing", "it needs its own test", and "it's only a chore" are all void.
See CLAUDE.md "Incidental findings: report, fix, record".

## Gates a PR must clear

- Commit subjects follow Conventional Commits. The exact type and scope
  vocabulary lives in CONTRIBUTING.md "Allowed types" / "Allowed scopes" and is
  enforced by `scripts/validate-commit-msg.mjs` -- read it there rather than
  copying the lists around, because they change.
- `commit-msg` validates the subject (all commits). `pre-push` refuses force-push or
  deletion of `main`, re-validates every pushed subject (so bypassing `commit-msg` buys
  nothing), then runs the three guards and scope-gated `test:sidecar` (~1-2s when that
  step is out of scope or already cached; +6.85 min when it actually runs -- which is
  any push whose branch diff touches `server/tts-sidecar/**`, and also any push that
  trips `computeShared` (root `package.json`/`package-lock.json`/`.github/actions/**`)
  on a cold cache. Launch that push detached -- see "Committing when a step is in
  scope").
- Verify locally before pushing: `npm run verify:fast:branch` for the full branch-scoped
  battery (lint, typecheck, config:check, test:hooks, test, test:server, build, audit, etc.)
  OR just the pre-push guards and sidecar check by running `git push --dry-run` first.
  Do NOT rely on `verify:fast:scoped` as a pre-flight: it scopes to the STAGED diff, so
  on an empty or unrelated index every leg reports `(out of scope)` and exits 0 having
  run no tests at all. A green from it proves nothing until the change is staged -- and
  even then only for the legs whose input globs the diff actually touches.
- The **PR title** must itself match the commit-subject format
  (`pr-title-lint.yml`), and the **PR body** must carry a literal `Closes #NN`
  or `Refs #NN` (`pr-issue-link.yml`). Both are required status checks -- a
  missing issue link blocks merge outright. File the issue if none exists.
- A non-trivial spec or plan takes an adversarial `assumption-checker` pass
  before the user is asked to approve it; present its actual output, not a
  paraphrase.
- Cloud `verify.yml` is the real enforcement gate. Every PR that is not
  docs-only also takes the `pr-review-gate` pass before merge.

## Every change owes

- **A paired automated test.** New behaviour -> a new test. Bug fix -> a
  regression test that fails before the fix and passes after. Never delete or
  `.skip` a test without a named replacement. UI changes crossing
  router/redux/layout seams land a Playwright spec under `e2e/`.
- **Both release-notes files, in the same PR:** an entry in
  `docs/release-notes-next.md` and a matching user-facing, brand-voice line in
  the in-progress section at the top of `RELEASE_NOTES.md`. Skip only when the
  change has no shippable delta, and say so explicitly rather than omitting it
  silently.
- **An on-box acceptance row** when it ships behaviour only real hardware can
  prove (a live GPU, a real sidecar, a real analyzer, a real book). Recording
  blocks the merge; running does not. All three surfaces move together -- see
  CLAUDE.md "Before-shipping checklist" step 3.

## Working style

- Surgical changes: fix what's broken, don't restyle what works. Match the
  surrounding conventions even where you would write it differently. The seam
  is defect / chore / taste -- the first two get fixed, the third is never
  touched.
- Simplicity first: the minimum code that solves the problem. No speculative
  abstractions, no unrequested configurability.
- All non-trivial work is sub-agent-executed: the main thread coordinates,
  curates context, and judges. Trivial means nothing can break and nothing
  needs review -- if you would want a review pass on it, it is not trivial.
