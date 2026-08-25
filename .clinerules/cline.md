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
- **A commit can take longer than your 30-second command cap, so `git commit`
  has to be run detached.** Not a silent trap -- the timeout is loud -- but the
  loop it produces is not. See "Committing when a step is in scope" below.

## Committing when a step is in scope

**Your runtime kills a single command at 30 seconds. A pre-commit run that has
any test step in scope takes minutes. So a foreground `git commit` cannot
finish, and retrying it never will.** The cap is internal to Cline -- there is
no CLI flag (`-t/--timeout` is the whole-run timeout, not the per-command one).

**So commit detached ALWAYS -- do not try to work out whether this diff is one
of the slow ones.** That prediction is the bug. Three successive revisions of
this very paragraph tried to enumerate what puts a step in scope, and all three
were wrong in the same direction: they under-listed, so an agent read its own
change as exempt and took the foreground path into the 30-second kill. Detached
costs nothing when the commit is fast -- the first poll returns immediately --
and it is the only correct route when it is slow. There is no case where
predicting first helps.

If you do want to know, `STEPS[]` in `scripts/verify-cache.mjs` is the source
of truth and the only one; pre-commit runs `verify:fast:scoped` over
`test:hooks,check:budget-poll,test,test:server`, and a step runs when the staged
diff matches its `globs`, any of its `extraFiles`, or `computeShared`. Read it
there rather than trusting a summary -- including this one. What makes a
summary untrustworthy here is that the surprising members are the whole point:
`test:hooks` alone reaches `.claude/skills/**`, `.claude/agents/**`,
`CLAUDE.md`, `CONTRIBUTING.md`, and the `RELEASE_NOTES.md` /
`docs/release-notes-next.md` pair that CLAUDE.md's before-shipping step 5 makes
nearly every PR touch -- so editing the very skill files this document tells you
to edit costs 41-58 s, and "it's only docs" predicts nothing. `openapi.yaml`
runs both `test` and `test:server` while matching no `server/` path. A root
`package.json` or lockfile edit is `computeShared` and busts every leg at once,
~12 minutes, while matching no step's globs at all.

**Budget 10-15 minutes when a test step is in scope, and do not call it hung
before 20.** Recorded on this repo: `test:server` **518.8 s** and `test`
**153.3 s** in the last green `.verify-cache.json`; a contended red run of
`test:server` took **746.6 s** (`docs/testing/flaky-register.md`). A single
vitest run can report far less wall-clock on an idle box, so treat these as the
range, not a constant.

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
$T = & 'C:\Claude\Projects\wt-<your-worktree>\scripts\oe-detached-commit.ps1' `
       -Worktree 'C:\Claude\Projects\wt-<your-worktree>' `
       -Message "fix(scope): subject line, don't escape apostrophes here"
```

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
  impossible: if you see one of those errors, stop reasoning about it after
  one sentence and re-check you're actually calling the script, not a
  hand-built variant of it.

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
- `commit-msg` validates the subject. `pre-push` refuses force-push or deletion
  of `main`, re-validates every pushed subject (so bypassing `commit-msg` buys
  nothing), then runs `npm run verify:fast:branch` unless the push is
  docs-only.
- Run `npm run verify:fast:branch` before pushing, so the hooks pass on the
  first try. Do NOT rely on `verify:fast:scoped` as a pre-flight: it scopes to
  the STAGED diff, so on an empty or unrelated index every leg reports
  `(out of scope)` and it exits 0 having run no tests at all. A green from it
  proves nothing until the change is staged -- and even then only for the legs
  whose input globs the diff actually touches.
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
