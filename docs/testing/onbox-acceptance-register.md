# On-box acceptance register

Shipped behaviour that can only be proven on real hardware — a live GPU, a real
sidecar, a real analyzer, a real book, a real phone — and that was **not** proven
at PR time.

A row here is a debt: the code is merged and users have it, but nobody has
watched it work. Empty register = done.

`npm run check:onbox-register` (CI: `.github/workflows/onbox-register-check.yml`,
ops-43) mechanically checks this file's own internal arithmetic — glance-table
counts against body row headings, and the stated total against the glance
table — on every PR that touches it. It cannot tell you a row is missing,
only that the ones already here don't add up.

This exists because complex work routinely cannot be accepted inside its own PR.
The box is often contended, an acceptance run can take hours, and a PR should not
sit open waiting for one. **Owed acceptance never blocks a merge — it converts
into a row here.** What is not acceptable is the debt evaporating silently, which
is exactly what happened before this file existed: the sweep that produced this
register found debt going back to **2026-06-01** recorded nowhere but in plan-doc
prose.

## Live view (update this, never re-publish)

<!-- CANONICAL ARTIFACT — do not mint a new one. -->

**https://claude.ai/code/artifact/adf22b7b-12dd-49fe-874c-4a340585b26a**

The page at that URL is rendered from **one specific file in this repo**:

> ### [`onbox-acceptance-register-live-view.html`](onbox-acceptance-register-live-view.html)
>
> Publish **that** file, with the URL above passed as `url`.

Artifact URLs are server-assigned UUIDs — they cannot be renamed, aliased, or
re-slugged — so **that exact URL is the artifact's identity**. Publishing
without it mints a *second*, competing register and orphans this one.

**The live view is a hand-authored HTML page, not a rendering of this file —
never publish this `.md` to that URL.** Passing the right `url` is *not*
sufficient. Publishing this markdown keeps the URL and destroys the page,
replacing the styled register with default markdown rendering: no summary strip,
a self-referential "Live view" section, and dead relative links. **Nothing errors
when this happens.** It happened four times between 2026-07-31 and 2026-08-01, to
four different PR-shipping agents that each read a paragraph like the one above
and concluded they had complied. The live view is tracked in this repo — rather
than living in whichever session scratchpad last built it — precisely so the
right file is always to hand.

### The publish token — never hand-edit it

The live view carries a **publish token** just under its `<h1>`:

```html
<div hidden data-published-as="<counter>" data-publish-id="<nonce>"></div>
```

The counter orders publishes; the id says *which branch produced this one*. Both
are machine-written. **Do not type either value.** Run:

```
npm run stamp:publish-token              # bumps the counter AND mints a fresh id
npm run stamp:publish-token -- --check   # report only, changes nothing
```

**Stamp, then commit, then publish** — in that order. An uncommitted stamp
cannot be found in git history, which is where its freshness is verified.

Why a command rather than an instruction to bump the number: a token that a
human maintains goes stale, and a stale one fails in the **green** direction —
a competing lane whose value happens to match yours reads as your *own* earlier
publish, so the check waves through exactly the overwrite it exists to stop.
Bumping the counter without minting a new id is that same failure with an extra
step. Two of the eight designs considered for this token died on precisely that,
which is why the stamper does both halves or neither.

The token is inert today: nothing reads it yet. The check that does — a
comparison against the live page's own token, to catch a lane publishing over
work it never saw — lands separately (#2599). It is seeded first and on its own
because a guard cannot ship in the same change as the data it requires: the
checker validates `origin/main`'s copy, so the data has to be on `main` already
or the guard's first run fails on its own delivery. That is the same
data-then-guard split the stable row IDs needed (#2629).

**One more thing has to happen before that check can pass, and it is easy to
miss because it is not a code change: the live view must be PUBLISHED at least
once with a token on it.** The comparator reads three copies — the tracked file,
`origin/main`'s, and the *saved live page* — and the live page only acquires a
token when someone publishes after this change merged. Until then the check
reports that the published page carries none while `origin/main` does, and
names the transition explicitly rather than guessing. So the first publish after
this merges clears it, and the wording of that error is written for exactly that
window.

The live view carries derived figures — owed count, per-group counts, oldest
debt — that must be **recomputed** on every edit. Rows can be right while the
summary strip lies. `npm run check:onbox-register` verifies the owed total, the
per-group counts and the row IDs across both files, so **adding or removing a
row here and missing the live view fails CI**. Know its edges, because two of
them are wide:

- **A wording-only edit does not fail.** Rewording a row, recording a run
  result, changing a hardware note or a criteria link — the most common edit
  this register gets — changes nothing the check compares. The live view mirrors
  that prose in its own row bodies and will silently fall behind.
- **The rest of the summary strip is unchecked** — oldest debt, and the
  group/blocked/unconfirmed tallies. Recompute those by hand.
- **The published page is invisible to `check:onbox-register`'s no-flag run.**
  It only ever reads the two TRACKED files, so "was it published at all, and
  was it the right file?" is procedure, not that gate — see the merge step
  below, which gives the specific stale-snapshot race mechanical teeth via a
  second, explicit mode, but still can't verify by itself that someone ran it.

**The concurrency hazard this closes (#1931).** Before the live view was
tracked here, on 2026-07-28 two concurrent sessions each correctly added a
different row (A20, E8) and republished from their own hand-built snapshot —
the second republish was built from a snapshot taken *before* the first
session's row had landed, so the surviving page had one row present and the
other silently gone, with nothing to notice. That was possible because the
live view lived nowhere but a session's own build of it. Tracking both files
in git and gating their agreement via `npm run check:onbox-register` on every
PR closes the git-side half: the live view a PR merges is no longer a
hand-built snapshot racing another session's, it is the file *inside* the
merge, checked against this register before either can land.

**The residual hazard, and the merge step that closes it.** Git-side safety
does not by itself close the ORIGINAL incident, because publishing is a step
that happens *after* merge, outside git — so the same race reopens one level
up. Two lanes can each merge a correct, agreeing live-view edit: git resolves
both rows into the tracked `.html`, and `check:onbox-register` is green on
both PRs. Lane A publishes its merge. Lane B, having fetched/built its own
copy of the *published* page before A's merge landed, publishes from a build
that is now stale relative to what's live — and the artifact loses A's row
again, invisibly, exactly like 2026-07-28, because the no-flag
`check:onbox-register` run only ever compares the two TRACKED files; the
published page itself is outside its reach (no network access from a required
CI check — the same call this design already made for the tracked-pair
comparison, see the edge list above). The merge step that closes this, run
**immediately before every publish**, not only after a suspected race:

0. **If your change touched the live view, stamp it and commit the stamp** —
   `npm run stamp:publish-token`, then commit. It goes *before* step 2, not
   after step 4, for two reasons: the check reads the token, and an
   **uncommitted** stamp cannot be found in git history, which is where its
   freshness is verified. See "The publish token" above for why this is a
   command rather than an instruction to edit a number.
1. Fetch the page currently live at the canonical URL above and save it to a
   local file — this is the CURRENTLY-published register, which may be ahead
   of what you are about to publish.
2. Run
   `npm run check:onbox-register -- --against-published <saved-file>`. Unlike
   `check:onbox-register`'s no-flag run, this comparison is deliberately
   ONE-DIRECTIONAL: your register having rows the live page doesn't have yet
   is the normal reason you're publishing, not a defect, so it is never
   reported here. A row (or group) the live page has that your register
   lacks is reported ONLY when `origin/main`'s own copy of this register
   still has it too — the signature of another lane having already
   published ahead of you. When `origin/main` also lacks it, the row was a
   deliberate discharge (by this change or an already-merged one), not a
   race, and is not reported: discharging a row always makes the
   still-live page look "ahead" of your working copy in this exact shape,
   and that is expected. **The command fetches `origin/main` itself, fresh,
   every run — you do not need to `git fetch` by hand first.** It then reads
   `FETCH_HEAD`, deliberately NOT the local `origin/main` ref: `git fetch
   origin main` only guarantees it writes `FETCH_HEAD` — whether it also
   updates `refs/remotes/origin/main` depends on this checkout's
   `remote.origin.fetch` refspec actually mapping `refs/heads/main`, which a
   narrowed refspec can skip while the fetch still exits 0, leaving
   `origin/main` silently stale even though the fetch just "succeeded". If
   you ever need to reproduce this baseline by hand for debugging, run
   `git fetch origin main` followed by `git show FETCH_HEAD:<path>` — NOT
   `git show origin/main:<path>`, which can read stale (or, in a narrowly-
   configured clone, entirely unresolvable) content even immediately after a
   successful fetch. It follows that this step needs network access to
   `origin`, with no offline fallback: you're about to publish to a remote
   URL anyway, so an operator who can't reach the network here can't
   complete step 4 either.
3. **If it fails**, do NOT publish. There are two distinct failure shapes,
   named in the error text:
   - **A row/group named as already live and BEHIND** — this message has TWO
     different causes, and they need opposite fixes; check which one applies
     before you act:
     - **Another lane's row, already merged into `main`.** Pull the latest
       `main` (the row that's already live should already be merged there
       via its own PR), confirm `npm run check:onbox-register` (no flag) is
       green, and re-run step 2 against the SAME saved copy from step 1 to
       confirm it now passes. It should — `main` pulling in the missing row
       is what resolves this, not another fetch of the live page.
     - **Your OWN change discharged this row, and it just hasn't merged
       yet.** Publishing (step 4) happens BEFORE this PR merges to `main` —
       that is the normal order, not a mistake — so `origin/main` cannot yet
       know your branch removed the row: the baseline can only recognise a
       discharge that has already landed there. Every pre-merge discharge
       therefore trips this exact same message, and pulling `main` will not
       help (there's nothing to pull yet). Instead, re-run step 2 with
       `--discharging <ID>[,<ID>...]` naming the row(s) you deliberately
       removed, e.g. `npm run check:onbox-register -- --against-published
       <saved-file> --discharging E10` or `--discharging E10,E11` for more
       than one.

       **The rule for which IDs to name is arithmetic, never trial-and-error:
       name exactly as many IDs from a group as rows you actually discharged
       from that group — never "whichever IDs the error message lists," and
       never "keep adding IDs until the command goes green."** Padding
       `--discharging` until the check passes is the exact failure mode this
       check exists to catch (the #1931/A44 incident this whole mechanism was
       built to close): a group with one genuine competing-lane addition on
       top of your own discharge will always leave one leftover ID after you
       have named your true count, and appeasing that leftover — naming it
       too, just because the check is still red — silently deletes another
       lane's live row at publish time. **If, after naming your true count
       for a group, the check still reports a leftover for that group, STOP.
       Do not name that ID too.** It is not yours to discharge: another lane
       published a row into that same group, and the fix is to merge it in
       (see "Another lane's row, already merged into `main`," above) before
       you publish — not to add its ID to `--discharging`. The tool's own
       error text already says this ("merge it in before publishing"); when
       the doc and the tool disagree, trust the tool, not the instinct to
       make it stop complaining.

       Under stable IDs there is one shape, not two: nothing renumbers, so
       the ID(s) that vanish from the live page are always exactly the ones
       you discharged — never a shifted survivor. This holds whether or not
       the group has survivors left, whether you discharged a single-row
       group's only row or a middle row of a group with plenty still in it.
       Name exactly the rows you discharged: for a true count of 1, name
       that one ID; for N, name those N IDs. A live-only ID surviving after
       you've named your true count is proof another lane independently
       published into that same group, not evidence you discharged more
       rows than you did.

       Naming an ID that turns out not to be live-only at all (a typo, or
       copied from the wrong discharge) is itself a refusal, not a silent
       no-op — the point is to keep a genuinely competing-lane row from
       slipping through unreported, not to mute the check wholesale.
   - **"Cannot verify"** — the check refuses to guess whether an extra row
     is a discharge or a race, and fails closed instead. This is NOT the
     same as the register being behind: pulling `main` on your own machine
     doesn't fix it, in either of the two shapes below.
     - **A git call failed** — the command's own `git fetch origin main`, or
       the `git show FETCH_HEAD:<path>` that reads what it just fetched,
       failed (network unreachable, no credentials, `origin` misconfigured
       or unresolvable, a timeout). The error names which one
       (`fetch` or `show`) — run that command by hand to see the underlying
       error, fix whatever it reports (network, auth, the remote), then
       re-run step 2.
     - **No git call failed, but the baseline is malformed** — `origin/main`'s
       OWN copy of this register is internally inconsistent (a count
       mismatch, a reused row ID, a group missing its allocation marker, a
       duplicate group letter, a sub-lettered row heading, a glance-table row
       with no matching body section, ...),
       so the fetch and the read both succeeded but the content they got
       back can't be trusted. The error names no `fetch`/`show` failure in
       this shape — that absence is itself the signal. Run
       `npm run check:onbox-register` against a checkout of `main` (not your
       branch) to see which specific check fails, then fix THAT on `main`
       first (its own PR) before retrying step 2 here — this can't be fixed
       from your branch, only from `main`.

   **Known limitation:** a row that's live and still genuinely owed but was
   never actually merged into `main` at all (e.g. published straight from a
   branch that never merged, or from a PR later reverted) is not
   distinguishable from a deliberate discharge — it silently reads as
   discharged rather than being flagged. Accepted trade-off, not an
   oversight; see `checkLiveView`'s own header comment in
   `scripts/check-onbox-register.mjs` (#2199 review round 3, A3).

   **A live version of this same limitation: the Artifact tool's own publish
   loop (2026-08-26).** This whole procedure assumes the race is between PRs
   landing at different *times* — you fetch, reconcile, publish, done. It does
   not cover two worktrees publishing this same canonical URL at the same
   *moment*: your `action: "read"` (required before every publish) fetches
   version N, but by the time your publish request lands, the other lane has
   already pushed N+1, so your publish is rejected as based on an unviewed
   version; you re-read, get N+1, and by the time you publish again the other
   lane is on N+2 — a "not viewed → view fully → identical, already refused"
   loop that never clears on its own because the target keeps moving. The
   tool's own suggested escape hatch, `force:true`, is wrong here: it
   discards whatever the other lane just landed, which — per the known
   limitation just above — is very often the newer, correct content (a
   pre-merge publish from a branch that hasn't landed on `main` yet). Do not
   force. Instead: find the other lane (`git branch --contains <sha>` for the
   commit touching `docs/testing/onbox-acceptance-register-live-view.html` you
   don't recognise, or `git log <branch> --oneline -- <that path>` across
   `git worktree list`'s branches) and let it finish publishing; then pull
   `main`, confirm your local copy of both tracked files matches what's now
   live, and only then run the four-step procedure above from that synced
   copy. Two lanes should never be mid-publish on this URL at once — if you
   find one, that is the thing to fix, not the loop.
4. Only once step 2 passes, publish the tracked `.html`, with the canonical
   URL above as `url` **and `favicon` set to 📋**.

   **Provenance, so you can weigh it:** 📋 is the value the 2026-08-23 publish
   set, recorded here at that moment. It is **not** a recovered original — if
   earlier publishes used something else, that value is gone. So this is the pin
   going forward, not an archaeological finding; treat a mismatch with your
   memory of the tab icon as this line being newer than your memory, and change
   the line only alongside a deliberate publish that changes the icon.

   The favicon is pinned here because it is otherwise **unrecoverable**. The
   publisher keeps it as artifact metadata, not in the page: it is absent from
   this repo, absent from the published HTML, and returned by neither
   `action: "read"` nor `action: "list"`. So an operator who does not know it
   has no way to look it up and must guess — and a changed favicon reads as a
   different page to anyone who keeps this register open in a tab. Publishing
   is the one step here that cannot be undone by editing a file, so the value
   lives in the runbook rather than in an agent's memory of the last publish.

This is deliberately a MANUAL procedure with mechanical support, not a fully
automatic gate: CI cannot run it (no credentials to fetch the published
artifact, and a network dependency inside a required status check is its own
failure mode). `--against-published` exists so step 3's "does the live page
have something I don't?" judgement is a command's exit code, not an
eyeballed diff — it does not, and cannot, make the four steps happen on
their own. An early version of this check compared both directions
symmetrically, which inverted the diagnosis (failed on every ordinary
publish and told the operator to delete the rows they were about to ship) —
fixed before this landed. A later version still fired on every legitimate
row discharge, because removing a row is invisible in that same direction
too: the still-live page always looks "ahead" of a register that just
discharged a row from it. It now disambiguates the two by checking whether
`origin/main`'s own copy of the register also lacks the row before reporting
it (#2199); see the `checkLiveView` function's own header comment in
`scripts/check-onbox-register.mjs` for the reasoning. The `origin/main` copy
that comparison reads is fetched fresh by the command itself immediately
before reading it, not taken from whatever the local `origin/main` ref
already happened to point at — an operator whose local ref predated a merge
would otherwise see that merge's row as absent from both their own register
and their stale baseline, which reads identically to a deliberate discharge
and would have let the exact #1931 race straight back through. See
`resolveBaselineText`'s own header comment in
`scripts/check-onbox-register.mjs` for that half of the reasoning.

The governing rule lives in [`CLAUDE.md`](../../CLAUDE.md) under "Testing
discipline" and as Before-shipping checklist step 3. In short:

- **Add a row** in the same PR that ships the unverified behaviour. Not later.
- **Remove a row** only when one of two things has actually happened:
  1. the acceptance was **run on the box** and the result recorded, or
  2. **the repo owner explicitly confirms** it was exercised on a live book or
     books during normal use.
- Either way, record *what was observed*, by whom, and when — in the plan's Ship
  notes, the run sheet, or the issue. "Tests pass, so it's presumably fine" is
  never a reason to remove a row.
- **All three surfaces move in the same PR** — this file, the per-feature run
  sheet, and the live view above. Recording the state is a merge gate even
  though *running* the acceptance is not.

Rows are grouped by **hardware prerequisite**, not by feature, because the point
is to batch: one uncontested session should discharge everything that shares a
setup rather than repeatedly loading and evicting models.

> **Adding a new `## Group <Letter>` section? Give it a `next-id` marker in
> the same commit.** Every group heading is immediately followed by
> `<!-- next-id: <Letter>101 -->` (101 is the shared allocation floor —
> see Global Constraints in the design plan if you're wondering why). A
> group with no marker fails `npm run check:onbox-register` outright — but
> the consequence reaches further than your own branch: `--against-published`
> resolves its baseline by running the checker over `origin/main`'s own copy
> of this register, so a markerless new group that merges to `main` breaks
> `--against-published` for every lane, everywhere, with
> `CANNOT_VERIFY_BASELINE_ERROR`, until a follow-up PR adds the marker on
> `main`. Copy an existing group's bare `<!-- next-id: X101 -->` line — no
> extra caveat comment needed.

> **Adding a new row to an existing group? Allocate from its `next-id`
> marker.** Take the marker's current value as the new row's ID, then bump
> the marker by one in the same commit (e.g. `<!-- next-id: A101 -->` becomes
> `<!-- next-id: A102 -->` after you mint `A101`). **Never reuse an ID that has
> been used before, even one whose row is long gone** — a discharged or
> removed row's ID stays retired forever. Re-minting a retired ID silently
> re-points every existing citation to it at the *old* row, which is exactly
> the failure this stable-ID design exists to end. **This register's own
> checker never catches it** — it only verifies uniqueness and the allocation
> floor, not history, so a re-minted ID looks identical to a fresh one. And
> `check-register-citations.mjs` does not close the gap reliably either, and
> can make things worse when it fires: Check C's fatal `wrongId` half only
> triggers when the stale citation sits on one of its two surfaces (an
> anchored `### <ID> · …` heading or a `Criteria source:` line) with the
> subject on that *same* line, **and** the subject still owns at least one
> other live row — a subject can span several rows (e.g. `#2040` →
> A22/A23/A34), so discharging just one of them leaves the subject in the
> map, and re-minting that row's old ID trips `wrongId` on the survivors'
> citations. Discharge a subject's *last* row and nothing fatal fires; a
> prose-idiom `row A22` citation fires nothing either way, since Check C
> doesn't read that surface at all. Widening `wrongId` to catch the
> last-row-discharge case too is deliberately deferred (see #2721). **You
> cannot rely on a check to stop you.** If `wrongId` does fire after a
> re-mint, the fix is to undo the re-mint — never to edit the cited heading
> to match the new ID, which is exactly the corruption this design exists to
> prevent. The rule above is the only guard.

> **How this register goes stale, and how to check.** Its first version was built
> by reading plan headers and issue bodies at face value, and three entries were
> wrong within a day — a prerequisite named as a blocker that was already
> satisfied, a "still draft" PR that had merged six weeks earlier, and a step
> count out of date since before the register was written. Plan prose and issue
> bodies are frequently **not updated after later work discharges them**. Before
> scheduling a session, spot-check each row against closed issues and merged PRs
> touching the same subject. A stale row is worse than a missing one: it sends
> you to run something already done.

> **A precondition missing from an isolated worktree is not a missing
> precondition, 2026-08-21.** Worktrees deliberately carry no secrets and no
> pre-seeded fixtures by design — a `GEMINI_API_KEY` absent from a worktree's
> `server/.env`, or a workspace with 0 books, says nothing about whether the
> credential or fixture exists elsewhere. Recording a row as "blocked: no
> such credential/fixture exists" from inside an isolated worktree is a
> category error (B1 and C1 both carried exactly this error before being
> corrected the same day). The honest record from an isolated run is "not
> available **to this run**," never "does not exist" — leave the actual
> existence question to whoever runs from an environment that can see it.

---

## At a glance

| Group | Setup | Rows |
|---|---|---|
| **A** | The GPU box (single 8 GB for most; the 2-card boot for a few) | 39 |
| **B** | Local Ollama analyzer only, no TTS sidecar | 2 |
| **C** | One *Ночной дозор* re-analysis session | 4 |
| **D** | Multi-language TTS render + ASR | 3 |
| **E** | Not the GPU box (a phone, a Mac, a browser) | 13 |
| **G** | GitHub Actions itself (no physical hardware — the runner IS the prerequisite) | 2 |
| **H** | No hardware — needs a real CJK manuscript (all-kana, and full-length Han), not yet in this repo's corpus | 2 |
| — | **Blocked** (hardware absent) | 5 |
| — | **Unconfirmed** (not debts until substantiated) | 2 |

**65 owed.** Oldest: **2026-06-01** (plan 161) — A14/A16 (plans 160/165, tied for oldest)
were owner-confirmed and dropped in wave 7; the sole surviving 2026-06-01 row is plan
161's A/B audition check, now **A11**.

> **Last change: 2026-08-29 (PR #2754 review), 62 → 63**, adding row **E101**
> (#2641 — port-keyed TTS owner notes) — documents the case where two server
> instances on different ports SHARE ONE `.run/` directory, the mechanism #2641
> fixes to prevent collision. E10 already mentions port keying but covers a
> different scenario (two separate checkouts with separate `.run/` dirs, where
> collision never occurred even before the fix); E101 covers the actual shared-run
> case now locked down. `next-id: E101` bumped to `E102` in the same change.
>
> **Prior change: 2026-08-29, merging two independent A102 additions.**
> This branch had added row **A102** (analyzer GPU-split warning + expected-device
> mismatch, #2367, Castwright#2734); `origin/main` had independently added row
> **A102** (CUDA fallback self-test #2582, PR #2719). Both started from the same
> post-#2704 state. Reconciled: kept `main`'s CUDA A102; during the merge resolution
> **A103** (the next-free id) was mistakenly treated as unavailable and skipped,
> so this branch's analyzer row was allocated **A104** instead. A103 remains
> permanently unused — a gap in the numbering that allocate-once rules prevent
> from being filled later. Combined: 61 (from `main`, post-A101-discharge via PR #2739)
> + 1 (this branch's A104, analyzer GPU-split) = **62**. Group A: 38 (main's A102) + 1 (this
> branch's A104) = 39. `next-id` bumped from A103 → A105 (skipping the permanent gap) in this merge.
>
> **Prior change: 2026-08-28 (Castwright#2734), 61 → 62**, adding row **A102**
> (analyzer GPU-split warning + expected-device mismatch, #2367) — mocked
> `execFile`/nvidia-smi covers every automated test, so the real two-GPU
> split, the once-per-signature server warning, the UI row, and the
> `expectedDevice` mismatch wording all still need a genuine 2-card boot.
> Minted from Group A's `next-id` floor; marker bumped `A102` → `A103` in
> the same change.
>
> **Previous change: 2026-08-28, merging `origin/main` into `fix/sidecar-cuda-fallback-detection`.**
> Two independent branch tips reconciled: this branch had added row **A102** (CUDA
> fallback self-test #2582, PR #2719, 61 → 62); `main` had since discharged row
> **A101** (PR #2739, 61 → 60) — the two changes started from the same post-#2704
> state and never saw each other. Combined: 60 (post-A101-discharge) + 1 (A102,
> still live) = **61**. Group A likewise nets to 38 (37 + A102). `next-id: A102`
> bumped to `A103` in the same change (unaffected by A101's discharge, since IDs
> are allocated once and never reused).
> ([#2719](https://github.com/dudarenok-maker/Castwright/pull/2719))
>
> **Prior change: 2026-08-28, 61 → 62 via PR #2719**, adding row **A102** (CUDA
> fallback self-test #2582) — minted from the next-id floor; an earlier commit on
> this branch briefly mis-minted this as A38, a dangling ID reserved by
> `onbox-sitting-plan.md`, corrected before merge.
> ([#2719](https://github.com/dudarenok-maker/Castwright/pull/2719))
>
> **Prior change: 2026-08-28 (PR #2739), 61 → 60.** Row **A101** (Qwen duration golden baseline
> bless, #1994) fully discharged and dropped: measured the real per-line duration
> spread on this box (RTX 5070 Ti, `QWEN_DEVICE=cuda:1`) via a new ad-hoc script
> (`server/tts-sidecar/tests/golden/measure_qwen_duration_spread.py`), voice
> `cw_gpu_17b`, N=10 repeated syntheses per `qwen-duration-fixture.json` line.
> Observed per-line max fractional deviation from its own mean: `narrator-plain`
> 9.0% (mean 2.936s, stdev 0.143s), `numbers-and-year` 12.2% (mean 5.192s, stdev
> 0.309s), `abbreviations` 22.4% — the observed max — (mean 4.184s, stdev 0.385s),
> `quotes-and-punctuation` 13.0% (mean 3.752s, stdev 0.321s), `multi-sentence-group`
> 19.9% (mean 4.696s, stdev 0.498s). Hand-set `qwen-duration-baseline.json`'s
> `tolerance` to **0.30** (measured max 22.4% plus ~34% headroom) from this
> measurement. `_bless` (`test_qwen_duration_golden.py`) blesses the MEAN of
> `BLESS_REPS=5` repeated real syntheses per line as the reference, not a
> single draw, so the blessed value is a stable estimate of the true mean —
> matching what `tolerance` was derived to bound. Raw N=10 spread measurement
> retained at `server/tts-sidecar/tests/golden/spread-report.json`. Per this
> file's own "record what was observed, by whom, and when" policy: observed
> by Claude Code (dudarenok-maker), 2026-08-28. **A101 is retired, not
> reused** (above).
>
> **Known limitation, accepted 2026-08-28 (repo owner, ship-as-is decision).**
> Independent verification during PR #2739's review found the real duration
> distribution can drift beyond what this single on-box measurement session
> characterized: a second, separate on-box run (23 fresh syntheses, same GPU
> and voice) measured every line's fresh mean **6.8%–21% above** the
> committed `spread-report.json`'s means, all five lines shifted the same
> direction. That is between-session drift, not the within-session noise
> `tolerance`'s derivation accounted for, and it raises this opt-in check's
> spurious-failure rate above the ~2% within-session-only estimate by an
> amount that is itself session-dependent — a fixed point estimate here goes
> stale on every re-bless (review-round-3 finding: an earlier version of
> this note quoted a fixed ~3.65%/run figure computed against `entries`
> this same PR round then re-blessed). Re-derive the estimate from the
> CURRENT `qwen-duration-baseline.json` entries and `spread-report.json` if
> a precise number is needed. `tolerance` ships unchanged rather than
> widened further or re-measured across multiple sessions — see
> [#2742](https://github.com/dudarenok-maker/Castwright/issues/2742) for the
> related but distinct open design decision (assert-time averaging to
> tighten the gate's power against a real regression, which a wider
> tolerance alone would make worse, not better).
>
> **Prior change: 2026-08-27 (PR #2704), 60 → 61**, adding row **A101** (Qwen duration
> golden baseline bless, #1994) — minted from the `next-id` floor per this
> file's own allocate-once convention (above), NOT the old high-water+1 slot
> (`A38`) this row was originally cut against before that convention shipped.
> `A38` is deliberately left dangling: `onbox-sitting-plan.md` already uses
> that citation to mean something else, and re-issuing it here is exactly the
> silent-wrong-row-resolution failure mode the stable-ID design (above) was
> built to prevent. `next-id: A101` bumped to `A102` in the same change.
>
> **Prior change: 2026-08-27, 60 → 60 (no count change).** The **Blocked** section's
> two ffmpeg rows no longer carry row IDs. They had borrowed **E6** and **E8** from
> the live Group E sequence, so each of those IDs named *two* rows — one live Group
> E row and one Blocked row — and Group E renumbers underneath the Blocked section
> whenever a row is discharged, so the pairing drifted silently. Both Blocked
> headings now carry their title alone (`ops-35 ffmpeg floor`, `ops-36
> golden-assembly`), matching the section's other three rows, and the live view
> renders their `num` cells as `—`. **Cite them by title from now on** — one
> features-doc citation was re-pointed in the same change. Nothing was renumbered,
> renamed or discharged. Also added: a per-group `<!-- next-id: <Letter>101 -->`
> allocation marker, inert until the contiguity check is replaced
> ([#2629](https://github.com/dudarenok-maker/Castwright/issues/2629)) — do not
> allocate from it yet; Group A's marker carries the same caveat inline.
> ([#2634](https://github.com/dudarenok-maker/Castwright/issues/2634),
> [#2653](https://github.com/dudarenok-maker/Castwright/issues/2653))
>
> **(#2629 has since shipped: the contiguity check is gone, replaced by
> allocation-floor checks, and Group A's inline caveat comment was removed —
> every group's `next-id` marker allocates normally now.)**
>
> **Prior change: 2026-08-27, 59 → 60 via PR #2688**, adding row **A37** (#2059's
> audible effect, not yet run).
>
> **Prior change: 2026-08-27 (on-box wave 9c), 58 → 59.** One row split in two.
> **Old A34** (voice reassignment vs. persisted audition centroid, #1969/PR #2402)
> had two criteria: (1) a reassignment discards the stale old-voice reference
> rather than silently reusing it; (2) a rebuilt reference — not a failed-to-build
> flag — is what a real render produces for the new voice. Wave 9's on-box run
> (below) proved (1) but not (2): Ivo's cloned-voice sample was too short for
> `auditionCentroid()` to build a real centroid, so the run produced
> `referenceKind: "too-short"` — the row's own named failure outcome, not its
> pass condition. Criterion (1) stays discharged (below); criterion (2) is
> **not** discharged — it is split out as new row **A36**, so the owed total
> returns to 59 rather than silently dropping. See A36 for the still-owed
> criteria and [#2700](https://github.com/dudarenok-maker/Castwright/issues/2700)
> for the full acceptance text.
>
> **Prior change: 2026-08-27 (on-box wave 9b), 59 → 58.** One row fully discharged and
> dropped: **old A8** (GPU residency safety + coexistence, plan 222) — owner-confirmed
> as proven, per this file's "record what was observed, by whom, and when" policy.
> Group A renumbered contiguously (old A9–A36 → A8–A35).
>
> **Prior change: 2026-08-27 (on-box wave 9), 60 → 59.** Criterion (1) above
> discharged: with the owner's explicit go-ahead, reassigned **Ivo** (the
> wave-8-identified correctly-shaped candidate: thin on in-book anchors, one
> line long enough to clear `MIN_DURATION_SEC`) from his designed voice to a
> cloned one on the real *The Coalfall Commission* book, then re-rendered
> chapter 4. All 8 of Ivo's lines came back `qa.status: 'ok'`, `reasons: []` —
> zero `voice-mismatch` flags. Traced this against `resolveCharacterReference`
> (`server/src/audio/render-integrity/aggregate.ts`) rather than trusting the
> output shape alone: before reassignment, `persisted` read
> `referenceKind: "audition"` built from the OLD voice (`cleanMean≈0.873`,
> `pSevere≈0.673`, `pBand≈0.737`). `voiceInfoByChar` population (`aggregate.ts:532`) requires all three of
> `snap.voiceEngine` truthy, `snap.resolvedVoiceName` truthy, and
> `STOCHASTIC_ENGINES.has(snap.voiceEngine)`. All three hold for Ivo: the
> reassignment named a concrete cloned Coqui/XTTS voice, so his chapter-4
> snapshot carries a resolved voice name (only omittable when no voice is
> assigned at all, per `character-snapshots.ts:73` — not this case) on an
> engine in `STOCHASTIC_ENGINES` (`aggregate.ts:91`). So `voiceInfoByChar`
> was populated for him, i.e.
> `voiceInfo` was non-null at this render, which rules out the early
> `if (!voiceInfo) return { status: 'too-short', ... }` branch (`:262-263`) that
> never attempts a rebuild. With `voiceInfo` non-null, `matchesCurrentVoice(persisted,
> voiceInfo)` against the NEW voice was therefore actually evaluated and correctly
> returned false, so the stale reference was **not** reused — it fell to a genuine
> `auditionCentroid()` rebuild attempt using the new voice, which is the exact code
> path PR #2402 added, and *that* attempt is what returned `too-short` (`:273`).
> **What this confirms:** reassignment is detected and the stale old-voice reference
> is discarded rather than silently scored against — criterion (1) above. **What
> this does NOT confirm:** criterion (2) — split to A36. Group A
> renumbered contiguously (old A35–A37 → A34–A36).
>
> **Prior change: 2026-08-27 (on-box wave 8), 61 → 60.** One row fully discharged and
> dropped: **old A34** (respawn-budget deadline timer, Scenario 2) — with a chapter's
> sidecar killed and a manually-started, unowned bare sidecar left listening on the
> TTS port, restarting the server with `SIDECAR_NEVER_ADOPT=1` produced the exact
> expected sequence: `[sidecar] UNFIT sidecar on :9180 (prod policy: spawning a fresh
> owned sidecar instead of adopting a pre-existing one) — replacing it...` followed by
> `replaced stale sidecar (killed pid=...); spawning current build.` The new sidecar
> came up owned (`.run/tts.pid` recorded its PID) and ready, with no deadline-timeout
> message (resolved in ~3.4s, well under the 5000ms ceiling) — combined with Scenario 1
> already confirmed in wave 7, both scenarios are now done. Group A renumbered
> contiguously (old A35–A38 → A34–A37). Three rows advanced without discharging (new
> numbers): **A34** (voice reassignment) — root-caused wave 7's non-scoring failure to
> `MIN_DURATION_SEC` (3.0s per-group floor), found a correctly-shaped test character
> (Ivo) but the reassignment call itself was refused by a permission gate, still owed;
> **A35** (Kokoro fallback alarm) — 3 of 5 checks confirmed (genuine fallback, API-drift
> simulation, the #2643 real-`/synthesize`-path bullet), 2 checks (contended-admission
> vs. idle-GPU-placement) not testable on this box since Kokoro's CUDA path is
> structurally broken here regardless of contention; **A37** (stranded VRAM) — a real
> post-unload diff was taken (Qwen Base 0.6B: ~1974 MB → ~137 MB allocated after
> explicit unload, consistent with CUDA-context baseline, not a leak) but only for one
> of the row's three models (Whisper/Qwen 1.7B-Base weren't concurrently resident in
> this run), so the full three-model scenario stays owed. **A36** (cast-id drift,
> renumbered from old A37) — ran a real full re-analysis of *Заказ Коалфолла*; the
> book's `cast.json` id still comes back Cyrillic, but root-caused why: the fix only
> guards a *future* corruption of an established-ASCII id, and this book's corruption
> predates the fix, so there was never a fresh retirement event for the guard to
> intercept. Did not hand-edit the real `cast.json` to force the guarded precondition —
> correctly blocked by a permission classifier, not worked around.
>
> **Prior change: 2026-08-26 (on-box wave 7), 69 → 61.** Referring to the pre-that-change
> (old) row numbers throughout — eight rows fully discharged and dropped this wave.
> Three via real on-box measurement: **old A19** (mixed Qwen+Coqui evict fails soft,
> #1893) — the outstanding pause-during-a-stalled-evict sub-bullet was exercised: a real
> pause landed within ~300ms of hitting a permanently-stalled `/unload` call, nowhere
> near the 10-minute ceiling; **old A31** (supervisor respawn survives a refused spawn,
> #2037) — the chapter completion this row's own criteria asks for was confirmed clean
> this time, in an isolated worktree with no cross-session interference; **old A43**
> (voice-design language gate, #2246) — all three design surfaces (bulk `cast/design`,
> single JSON `design-voice`, `design-voice/stream`) confirmed blocking cleanly with no
> sidecar connection when a book's language is unset, and none of the three
> false-positive when it's set. Five via explicit repo-owner confirmation of a live
> observation, per this file's own "record what was observed, by whom, and when" policy:
> **old A12** (post-synthesis audio QA gate, plan 174) — the amber "Suspect" badge on a
> deliberately degraded (near-silent/clipped/truncated) render, confirmed on both the
> Generate and Listen rows; **old A13** (per-run resource telemetry, plan 175) —
> `#/admin` → "Resource trends" confirmed showing RTF/QA/VRAM/wall-time rows with a
> sparkline that tracks RTF after a real multi-chapter run; **old A14** (Qwen VoiceDesign
> persona-prompt rewrite, plan 160, the prior "oldest debt here") — confirmed the
> rewritten pitch/purpose-clause wording changes the rendered voice on a real audition;
> **old A16** (fe-16 Qwen auto-load on a Russian book, plan 165) — confirmed the Qwen
> banner and auto-load-with-analyzer-evicted behaviour on a real Russian book; **old A17**
> (emotion-chip preview from the manuscript, plan 180/fe-31) — confirmed the audible
> delta between a designed variant and the base voice on a real sidecar. Several dangling
> cross-references into now-deleted rows were caught and rewritten inline rather than
> renumbered. Group A renumbered contiguously throughout.
>
> Also advanced without discharging (from the same wave-7 GPU session, old numbers):
> **old A33** (now A26, ASR warm-reservation) — a real measurement answered its own open
> question: the `asr.warm` learned estimate structurally can never move off its 128MB
> seed for a `base`/`int8_float16` model, filed as
> [#2682](https://github.com/dudarenok-maker/Castwright/issues/2682) (needs a design
> decision); **old A41** (now A34, respawn budget exhaustion) — Scenario 1 fully
> confirmed (monotonic refusal counter, clean exhaustion, clean recovery via `/restart`),
> Scenario 2 (deadline timer) still owed; **old A42** (now A35, voice reassignment) —
> attempted but inconclusive, the chosen test character never accrued an
> audition-reference row at all, still owed with a better test character.
>
> **Prior change: 2026-08-26 (#2656, successor to closed #1976/#1996), 68 → 69.**
> New row **A46** added — the 2026-08-25 idle-gated VRAM measurement narrowed
> the "stranded" pool to look like the Qwen Base 0.6B + Whisper resident-model
> floor, but never captured `allocated` right after an explicit unload to
> confirm that, so it can't rule out a genuine leak underneath. #1976 and
> #1996 were closed as `not planned` (superseded, not fixed) to declutter
> their accreted measurement history; #2656 carries the actual remaining
> work and this row.
>
> **Prior change: 2026-08-26 (#2584/#2570 fix, PR #2640), 67 → 68.** New row
> **A45** added — PR #2640's `stripEstablishedAsciiRewrites` fix is proven at the
> unit/route level but still owes a real re-analysis of *Заказ Коалфолла*
> against its existing `cast-id-history.json`; see
> [`cast-id-drift-onbox-acceptance.md`](cast-id-drift-onbox-acceptance.md)
> §10.2. Numbered A45, not A44 — #2647 claimed A44 for an unrelated Kokoro
> finding independently and concurrently; this row is the later of the two to
> land.
>
> **Prior change: 2026-08-26 (#2643), 67 → 67 (no count change).** **A44**'s
> own text is corrected, not discharged: #2647's fix compared this load's
> intent against `_device`, but nothing ever resolved the string `"auto"`
> into a concrete card before that comparison, so `fell_back` stayed
> structurally dead on every REAL generation path (`synthesize`, the
> `PRELOAD_KOKORO` warm path, the admission-off `/load` branch) — none of
> which ever pass a `device=` argument or need `KOKORO_DEVICE` set. #2643
> resolves `"auto"` to the concrete device the load is actually attempting
> (derived from the same provider list that builds the ORT session, so
> placement itself is unchanged) before publishing it as intent. A44's
> acceptance criteria gain a fourth bullet for this unpinned/no-admission
> path — the first two existing bullets only ever exercised an explicit
> `KOKORO_DEVICE` pin or a VRAM-ledger admission, neither of which the actual
> regression lived on.
>
> **Prior change: 2026-08-25 (#2647), 66 → 67.** Added **A44** — Kokoro's
> silent-CPU-fallback alarm (`fell_back`) was structurally dead code on every
> default install before this fix (the regression #2636 introduced); nothing
> on real hardware has yet confirmed it fires on a genuine CUDA→CPU fallback,
> stays quiet on a ledger-admitted CPU placement, or reads `unknown` (rather
> than a false `cpu`) under kokoro-onnx API drift.
>
> **Prior change: 2026-08-25 (#2632, PR #2635), 65 → 66.** Added **E10** — the
> sidecar-sweep worktree fix ships behaviour that only two live checkouts can
> prove (that `npm run stop` sweeps the RIGHT checkout's sidecar, not the
> primary's); nothing in that PR exercises `stop-app.mjs`/`.ps1` end to end
> against a real listener.
>
> Before that: 2026-08-23 (fold step, #2625), 66 → 65. One row discharged
> live (A38, "ORT marker refuses — not repairs — a clobbered venv") and
> dropped, per the owner's remove-outright ruling — the refuse-and-log branch
> fired exactly as designed against a real copy of the live sidecar venv.
> Group A renumbered contiguously (old A39–A44 → A38–A43). Evidence:
> `docs/testing/onbox-wave5-results/step-ort-b-a39.md`. Before that: wave 5,
> #2606 step 6, 69 → 66 (A27, A45, B2 discharged). Full change-by-change
> history is in this file's git log, not here — this section tracks the
> current count, not how it got here.

---

## Group A — the GPU box

<!-- next-id: A105 -->

Most rows need only a **single GPU with Qwen resident**. A few specifically need
the **2-card boot** (8 GB RTX 4070 + 16 GB RTX 5070 Ti over OcuLink) — and the
eGPU is **not hot-pluggable**, so do all 2-card work in one sitting and all
single-card work in another rather than interleaving.

### A1 · fs-38 Wave 3 — voice cloning (now incl. 3c) · **20 of 60 run (2026-07-29, 2026-07-31) · ~40 still owed · 3 run-2 results retracted**
<!-- stat:a1-still-owed 40 -->
<!-- stat:a1-subtotal 60 -->

**Partially discharged.** First execution 2026-07-29 by Claude Code on the
dual-GPU box, SHA `2503bca6`, clean tree, real sidecar + real Qwen weights, no
mock mode. **16 tests executed: 15 pass, 1 blocked.** Results are recorded in
the run sheet `docs/testing/fs38-wave3-onbox-acceptance.md` (§2 preconditions
filled, per-test `Result:` lines and §7.1 completed for the tests run). PR #1837
shipped the template (3a/3b1/3b2, 51 tests); Wave 3c added **Section E** (9
tests) — 6 of 9 now run across runs 2 and 3, E-03/E-06/E-07 still owed; see
below.

**The run found one Critical defect, now fixed.** Every freshly cloned Qwen
voice returned HTTP 500 on its first synthesis until the sidecar restarted —
including the clone wizard's own completion-screen audition, i.e. the first
thing a user does after cloning. `clone_voice` cached a bare prompt where
`_load_voice_prompt` unpacks a `(prompt, language)` tuple
(`ValueError: not enough values to unpack`). Filed as **#1941**, fixed in
**PR #1942**, verified live on-box (clone → immediate synth in the same process
now returns 200). *This is the case for this register existing:* the feature's
central path was broken on shipped `main`, and no automated suite could see it
because unit tests mock the engine and no pytest exercised clone→synth in one
process against the real cache.

**Discharged (do not re-run):** A-01…A-06 (ingest + the full quality-gate tier
set — including the 60s truncation landing at 2,880,044 bytes, delta 0), A-10
(write-time consent guard: 422/400/404, nothing written), A-11 (`/revoke`
stamps `revokedAt`, rest of consent intact, entry survives), A-12 (sample route
403s a revoked clone, healthy control 200), B-01 (route + on-disk half —
UI assertions still owed), B-04 (ECAPA cosine is real: three distinct finite
values, two clones of the same fixture gave 0.8914 vs 0.8813 — not a mock
constant), B-07 (assign writes both qwen **and** coqui slots per Task 24, drops
the stale `variants` map, leaves `voiceUuid` untouched; all 13 characters
diffed, only the target changed), **C-10** ⭐ (total erasure on revoke — 7
artifacts across 3 locations all gone including both cached mp3s and the
original recording; wildcard sweep 0 files; entry + `voice.json` survive with
`revokedAt`), **C-11** (409-with-usage then `{deleted:true}`, entry dir removed,
both cast slots cascade-cleared), C-19 first half (1.7B tier renders a cloned
voice; its erasure is covered by C-10).

**Also proven — the wave's central claim, measured not asserted.** A cloned
voice renders inside a real book: `wren`'s segments re-recorded into Coalfall
ch.3, `characterSnapshots.wren.resolvedVoiceName` = the clone's storage key,
segments carrying `asr.verdict: ok` / **WER 0**. Speaker identity via the
production `/embed`: 20s audition vs human source **0.822**; in-book segments
**0.564** and **0.706**; designed-voice control **0.158**. The by-ear
confirmation (B-03, E-06) is still owed — a human must listen.

**Resolved without on-box acceptance — B-06 (#1945, 2026-07-30).** B-06's own
measurement was already conclusive: the clone-fidelity cosine scores
clone-vs-source *faithfulness*, so degrading the source degrades the clone
equally and the number does not fall (measured: clean 0.891, band-limited
0.881, two speakers overlaid 0.773; a genuinely different speaker measured
0.158). **Disposition:** `CLONE_FIDELITY_MIN = 0.3` is kept as a documented
catastrophe-only backstop, not recalibrated or deleted — see
`server/src/tts/clone-fidelity.ts`'s header comment. B-06's manual step (which
could never pass as written) is retired in favour of an automated test,
`server/src/routes/voice-library.clone-fidelity.test.ts`, which stubs the
`/embed` boundary directly and asserts both sides of the threshold in CI. No
further on-box run is owed for this item — it no longer needs real hardware
to prove.

**Run 2 — 2026-07-31, SHA `b5479e9c`, clean tree.** Four more discharged, all in
Section E: **E-01** ⭐ (clone → Coqui-routed Russian book → generate: the first
`voices\xtts\xtts-$U.{pt,json}` ever written on this box, `resolvedVoiceName` =
`xtts-$U`, Whisper auto-detect **`ru`** at `avg_logprob` **−0.368**), **E-02** ⭐
(sample 200 → revoke → sample **403** with the exact copy, and the
previously-cached audition URL now **404**), **E-08** (re-confirmed on two more
assigns), and **E-09** — which run 1 could only mark `N/A` because no XTTS
artifact had ever existed. Its first real exercise: 5 files across 3 locations
pre-revoke, **0 remaining** after, both `voices\xtts\` paths included, entry dir
left holding only `voice.json`.

**Run 2 found two defects, both open.**
[**#1967**](https://github.com/dudarenok-maker/Castwright/issues/1967) is the
serious one and it **blocks Section E on any stock box**: every XTTS clone
derive fails because `torchcodec` cannot load without *shared* FFmpeg libraries,
and the normal Windows install (`winget install Gyan.FFmpeg`) is a static build
shipping `ffmpeg.exe` alone. The install docs assert the sidecar "never calls
`torchaudio.load`" — it does, on exactly this path — which is why the installer
drops `torchcodec` in with `--no-deps` and never provisions its native
dependency. Section E above was only reachable after staging PyAV's own bundled
FFmpeg set into the `torchcodec` package directory; that workaround is still in
place on this box (run sheet §7.3).
[**#1969**](https://github.com/dudarenok-maker/Castwright/issues/1969) is why
A16 below is not fully discharged.

**RETRACTED — three run-2 results were wrong, and the cause is
[#1972](https://github.com/dudarenok-maker/Castwright/issues/1972).** A
per-character re-record picks its target segments from `segments.json` but
resolves their sentences — and so the voice — from the **analysis cache**, by
sentence id. Once analysis has run since the render the two disagree, and the
re-record renders another character's line in the requested character's voice.
`resolvedVoiceName` still reports the assigned voice, because it was re-derived
from the cast record rather than recorded from the render.

Every retracted result had been read from that field:

- **A16** — identity half withdrawn. Its German chapter measured **0.949**
  against the chapter's own narrator. The **language** claim stands: it was
  measured from the audio by Whisper, which does not consult the cast, and is
  independently confirmed at the `/synthesize` boundary.
- **E-01** — identity half withdrawn (13 of 21 targeted segments divergent).
  The derive, the artifacts and the language all stand.
- **C-17** — its `F` is withdrawn entirely. The self-heal was never *reached*,
  so the test was never exercised. It is not-run, not failing.

Reproduced with a **healthy** designed voice, and on two books that diverged for
unrelated reasons — one from pre-#1598 attribution damage, one from ordinary
re-segmentation. **The precondition is only "analysis has run since the last
render."** Full chapter generation is unaffected. No test caught it because none
asserts which voice reached the provider.

**Still owed (~40), and why:**
- **Browser/mic (4):** A-07 (recorder webm/opus), A-08 (mic-denial fallback),
  A-09 (consent gates Continue), B-02 (record-path clone). Need a real browser
  with a real microphone.
- **By ear (2):** B-03, E-06. No instrument substitutes; ECAPA cosines above are
  the objective half only.
- **Section E — 6 of 9 now run (2026-07-31/08-01, across runs 2 and 3);
  E-03, E-06 and E-07 still owed, but no longer blocked.**
  **Run 3 (2026-08-01)** added E-01's first genuine exercise — **P**
  (mechanism), **by-ear NEGATIVE**. Owner: *"2 does not sound like 4 much,
  cross language is not working well."* Mechanism passes, perceptual
  identity does not: a controlled experiment isolated the cause to the
  **source clip's language**, not XTTS cloning — a clone built from a
  Russian clip scored **0.7824** against its own source in the same chapter
  where the English-sourced clone scored **0.2321** (caveat: the RU floor is
  contaminated, narrator vs RU source already 0.577, because Qwen Russian
  voices cluster). It also passed **E-05** (audition vs render **0.5515**
  against floors of 0.105 / 0.051), and reproduced **E-04** (**F**)
  deliberately: same cloned voice/engine/`language: ru`, only length
  differs — a 46-char line returned 200, a 245-char line 500. Cause: `spacy`
  absent from the sidecar venv and undeclared in every `requirements/*.txt`,
  while `main.py` hardcodes `enable_text_splitting=True`. Filed
  [#2017](https://github.com/dudarenok-maker/Castwright/issues/2017), fixed
  in [PR #2039](https://github.com/dudarenok-maker/Castwright/pull/2039).
  Run 3 also produced [#2023](https://github.com/dudarenok-maker/Castwright/issues/2023)
  (an orphaned `characterId` renders silently in the narrator's voice) and
  [#2026](https://github.com/dudarenok-maker/Castwright/issues/2026)
  (Russian XTTS quality — register row A31). The #1944 blocker below is
  genuinely
  gone — Coqui loaded cleanly in a post-`/embed` process during run 2, logging
  `Coqui ready — 58 speakers in manifest`. A *second*, separate blocker sat
  behind it — the clone **derive** failed without shared FFmpeg libraries
  (#1967) — and that is now fixed and merged (PR #1978, 2026-07-31), so
  E-03…E-07 are runnable on a stock static-FFmpeg box without any hot patch.
  **E-04 specifically is no longer blocked on a fix** — the code-level fix for
  its `ImportError` shape (#2017) landed in PR #2039 — so what remains of its
  debt is a re-run of the reproduction (46-char control, 245-char Russian
  line) on real Coqui weights, not an outstanding bug. Their first run doubles as A18 item 1. History of the
  first blocker follows, kept because it is what the run-2 result confirms:
  Coqui/XTTS could not load in a
  sidecar that had already served ECAPA `/embed`, and cloning always calls
  `/embed` for the fidelity check. **Acceptance run on the dev box**, both
  halves on `cuda:1` on a dedicated port so the live sidecar was untouched,
  and with `COQUI_PIN_IMPORT_ORDER=0` throughout so the `sys.modules` disarm —
  not the boot-order pin — was the thing under test:

  | Tree | `/embed` | `POST /load {coqui}` |
  |---|---|---|
  | `main` @ `0edde146` (before) | 200 | **500** — `ImportError: Lazy import of LazyModule(… speechbrain.integrations.k2_fsa …) failed` |
  | `fix/sidecar-speechbrain-lazy-proxies` @ `d6af415d` (after) | 200 | **200** — `{"status":"ready"}`, `Coqui ready — 58 speakers in manifest` |

  The after-run's log records the pin explicitly skipped and names all 7
  evicted proxies, so the disarm is what carried it. `coqui_import_ok` went
  `null → true` on the real import.

  **What this does NOT discharge:** Section E's nine tests themselves — they
  are now runnable and remain owed. Nor the pin's own default-on path, which
  was deliberately disabled for this run; it is covered by unit tests only,
  and since PR #1962 it is additionally gated on the XTTS weights being
  present, so Qwen-only and Kokoro-only installs never exercise it at all.

  **Superseded advice:** the old note here said to treat
  `coqui_package_installed: true` with suspicion when planning, because that
  `find_spec` probe never imports and is how this row was once mis-scoped as
  unblocked. Still true of that field — but `/health` now also carries a
  sticky `coqui_import_ok` reflecting a real import attempt, which is the one
  to read. Note #1963: `models-status`'s `importable` is still the old
  find_spec value.
- **C-02, D-02 and any full-book work — BLOCKED by the side-11 host-memory
  leak.** Two full-chapter render attempts died: one at the QA gate (ASR could
  not get VRAM alongside Kokoro), one with `recycle-storm` after the sidecar
  recycled 3× (committed memory peaked at 29,395 MB). The sidecar's own log
  names it: *"expected for the variable-shape leak; the restart ceiling is the
  real guard"*. **Workaround, qualified since [#1972](https://github.com/dudarenok-maker/Castwright/issues/1972):**
  the per-character re-record (splice) path renders one character's lines
  without the full-chapter memory churn — that is how the central claim above
  was proven — but it now REFUSES on a chapter whose `segments.json` and the
  current analysis disagree (exactly the shape both fixture books in this run
  hit). It only stays usable as a workaround when the two agree; when they
  don't, re-run analysis first (so the splice becomes usable again), or fall
  back to a full chapter generation — which the side-11 leak still blocks, but
  which is at least immune to the splice's own attribution defect.
- **The rest of Section C (18) and Section D (3):** not reached. C-08/C-12
  (deliberate mid-write sidecar kills) and C-01/E-03 (revoke racing an in-flight
  derive) are untouched and remain the highest-risk unproven behaviour here.
- **C-05 (one of the 18 above) now has two recorded sub-observations owed, not
  a new row:** [#2023](https://github.com/dudarenok-maker/Castwright/issues/2023)
  / PR #2041 split it into C-05a (a healthy cloned narrator refuses an
  orphaned-characterId line) and C-05b (a designed narrator's substitution is
  recorded + surfaced) — see the run sheet's `Result (C-05a)`/`Result (C-05b)`
  lines. Sharpens what C-05 needs to test; the Section C headcount is unchanged.

**Two findings that are NOT defects, recorded so they are not re-filed.** (1)
`ASR_DEVICE` and `ASR_COMPUTE_TYPE` in `server/.env` must agree — flipping the
device to `cpu` while `ASR_COMPUTE_TYPE=int8_float16` remains pinned makes every
`/transcribe` 500. `_compute_type()` is correct; nothing enforces the pairing.
**Fixed for the Advanced Configuration path by [#2180](https://github.com/dudarenok-maker/Castwright/issues/2180):**
`PUT /api/config` rejects a `qa.asr.device` / `qa.asr.computeType` save that
would leave this pair mismatched, checked against the resulting effective
config (not just the incoming patch); `POST /api/config/reset` (every
Advanced Settings row's per-key Revert, plus a group/`qa-gates` or `all`
reset) checks the same resulting-effective-config rule before clearing
anything, so a Revert click can't reopen the pair either (independent review
of PR #2205, finding F1 — the reset path was still an open bypass when #2180
first shipped). So the UI can no longer produce this state. A hand-edited
`server/.env` still bypasses save-time validation by design and can still
reach this combination — that residue is explicitly out of scope for #2180
(belongs with #2131's sidecar-side surfacing work instead).
(2) `npm start` appears to launch two sidecars but does not — the venv
`python.exe` is a launcher that re-execs the base interpreter as a child. Only
one holds :9000. Separately, `npm run stop` repeatedly reported
`[GONE] tts pid=… (already exited)` for a pid matching neither live process, so
its pid tracking drifts across restarts — minor, unfiled.

**Also opened by this run:** #1943 (consent record cannot name the real
attester — `attestedBy` is overwritten with `personName`, which inverts
`guardian-of-minor`).

Starred, highest-risk — **C-10 is now discharged (passed 2026-07-29)**; the rest
remain: **C-01** revoke mid-derive leaves no live `.pt` and `revokedAt` survives ·
**C-08** a transient failure does not brick a voice · **C-17**
designed-voice self-heal preserves persona · **C-12** a killed mid-write leaves
no truncated `.pt` · **E-01** clone → cast on Coqui → generate · **E-02**
audition-then-revoke refuses Play on the Coqui path · **E-06** the one place
D-B's synthetic-clip-vs-catalogue quality question can actually be judged, by
ear · **E-07** a forced designed-derive failure still renders the chapter
(fail-soft, the opposite policy from cloned's fail-loud).

**E-01 was attempted and is blocked, not failed.** A Coqui splice reported
`splice_complete` but wrote no `voices\xtts\` artifacts and left
`characterSnapshots.wren.voiceEngine` as `qwen` — the character's own
`ttsEngine: 'qwen'` overrides the requested `modelKey`. To attempt Section E,
first flip the target character's engine to coqui (or use the Russian Coalfall
twin, which routes there natively), **and** start from a sidecar that has never
called `/embed` (#1944). Reassuringly, the post-splice audio still measured as
the cloned speaker (0.66 / 0.61 vs source), so **no silent substitution
occurred** — the never-substitute guarantee held even on the path that failed to
reach XTTS.

C-08 and C-12 deliberately kill the sidecar mid-write — nothing else in flight.
D-01 deliberately runs two concurrent book renders sharing one cloned voice.
E-03 deliberately races a revoke against an in-flight Coqui derive.

*Also needs:* Whisper weights, ECAPA `/embed`, the
Coalfall fixture with ≥2 speaking characters/chapter, the 9 audio fixtures in §4,
and (for Section E) a Coqui-capable sidecar plus a non-English (e.g. Russian)
book fixture that actually routes to Coqui.
*Prerequisites confirmed present on the box 2026-07-29:* Qwen 0.6B/1.7B-Base +
VoiceDesign, `faster-whisper-base`, ECAPA `spkrec-ecapa-voxceleb`, coqui-tts
0.27.5 + xtts_v2 weights, both GPUs (the eGPU was attached, so 2-card rows are
runnable), and Coalfall already imported and analysed in 7 languages incl. the
Russian twin. **The §4 audio fixtures now exist** at `C:\fixtures\fs38\` —
public-domain LibriVox, two distinct narrators, F-1…F-9 built and verified
against the `clone-quality.ts` thresholds — so a follow-up session does not need
to rebuild them. Note the box runs `LAN_HTTPS=1`, so the server is on
`https://localhost:8443`, **not** the `http://localhost:8080` the run sheet's
§3 probes assume.
*Plans:* 267, 268, 271 — all `status: active`, Ship notes now record this
partial run. *Cost:* multi-hour; the 2026-07-29 session spent roughly half its
time on the three environment blockers above rather than on tests.

**Six checks added by the post-32 follow-up campaign, same box/setup as
above — batch them into the same session:**

1. **The `preparing-voice` phase (#1813).** Render a chapter with a
   Repairable cloned voice or a self-healing designed voice (same setup as
   C-06/C-07/E-01) and confirm the Generate screen shows a "Preparing
   voice — `{character}`" step, with its own pill, *before* synthesis
   begins — mirroring the existing `recovering` phase, replacing the
   multi-second silent pause `docs/testing/fs38-wave3-onbox-acceptance.md`'s
   KL-f documents. Then render a chapter for a character with no library
   voice at all and confirm the phase never appears. Not yet folded into
   that run sheet's own step list or KL-f's now-stale "expected" text —
   update both when this is next revised.
2. **A cloned voice actually rendering on XTTS end to end** — the wave's
   central claim, already exercised by E-01 above but worth restating
   concretely: play the rendered chapter and confirm the dialogue is
   recognisably the cloned speaker, not a stock catalogue voice, and that
   `cast.json` records the character's `overrideTtsVoices.coqui.libraryUuid`
   matching the clone's uuid with `provenance: 'cloned'`.
3. **Revoke-then-render.** Revoke consent for a voice already cast on
   Coqui, then render a chapter that uses it (same shape as C-01/C-02 on
   the Qwen side, E-02/E-03 on Coqui), and confirm the chapter fails loud —
   `UnresolvableClonedVoiceError`, zero audio produced for that chapter —
   rather than silently substituting a stock catalogue voice.
4. **VRAM partitioning across a mixed chapter — no existing test names
   this explicitly.** Cast one character in a chapter to a Qwen cloned/
   designed voice and another to a Coqui cloned/designed voice in the same
   book, then watch `nvidia-smi` through the resolver pre-pass while that
   chapter renders. Qwen and Coqui must never both hold GPU memory
   resident at the same time — the pre-pass partitions cloned-voice derives
   by engine specifically to preserve this serialization (`fix(server):
   partition cloned-voice derives by engine to preserve VRAM
   serialization`). A spike showing both models resident simultaneously is
   a regression, not a variance.
5. **The `voice_language_mismatch` advisory reaches the screen on all three
   streams.** The frame is emitted by `generation.ts`, `chapter-splice.ts`,
   and (since `f879407c`) `chapter-qa-repair.ts` when a non-English book's
   reused DESIGNED voice is cleared for a baked-manifest-language mismatch.
   Only mock-mode coverage exists for the two newer frontend consumers, so
   confirm on the box: open a **non-English** book that has at least one
   reused designed voice designed for a *different* language, then (a) run a
   per-character re-record from the cast profile drawer's "Fix … audio", and
   (b) hit the repair button on a `suspect` chapter row in the Listen view.
   Each must raise ONE amber toast reading "…designed voice(s) were cleared
   because they were designed for a different language…", naming the cleared
   character — once per run, not once per chapter — and the run must still
   complete rather than fail. An English-only book must raise no such toast
   on either path. Server-side emission is already covered by
   `server/src/routes/chapter-qa-repair.test.ts`; what is owed here is that
   the real (non-mock) stream reaches the real toast stack.
6. **Preview plays on the ready engine, not always Qwen.** The My-voices card's
   Preview button used to always request the Qwen artifact; a voice whose Qwen
   copy is stale/failed but whose Coqui copy is ready 409'd on every Preview
   even though it could genuinely play. Confirm on the box: get a cloned or
   designed voice into a state where `engines.qwen.status` is not `ready` but
   `engines.xtts.status` is `ready` (e.g. a revoked-then-restored Qwen leg, or
   a Coqui-only clone with no Qwen derive yet), then press Preview on its
   My-voices card and confirm real Coqui audio plays instead of a 409 toast. A
   voice with both engines ready should still preview on Qwen (the primary
   engine, and the one carrying the session's 1.7B tier pin). Only mock-mode
   coverage exists (`voice-library-card.test.tsx`); what is owed is the real
   sidecar round trip.

*Pass/fail criteria for all six:* `docs/features/271-fs38-wave3c-xtts.md`.
*Hardware:* the same single 8 GB box as the rest of Group A, XTTS weights
installed (`install-coqui.mjs`/`.ps1`/`.sh`), no additional prerequisites
beyond what A1 already lists above.

### A2 · Capacity-aware GPU placement (plan 264) — walkthrough step 9, cross-card device steer · **2-card boot only**

**Owed:** walkthrough **step 9**, the on-box confirmation of the #1730
cross-card device-steer fix. The code merged (PR #1732, 2026-07-19) but its
confirmation never ran. The plan calls this "still owed before the
concurrent-multi-card flag flip." **2-card boot only.**

*Step 3* (eGPU fault-drop) is genuinely observe-only — yanking an OcuLink cable
is a hard crash. Mark Blocked/N-A unless it happens on its own.

*Criteria:* `docs/features/264-vram-aware-gpu-placement.md:129-179`, header `:9-22`.

> **Ruling, 2026-08-21 — rows 6–8 are NOT owed; scope narrowed.** The
> evict-under-contention rows (cold-`/load` device steer, `design_voice`
> evicts Ollama, GPU-ASR 503→evict→retry) were previously carried here as an
> ambiguous second debt. Plan 264 itself frames them as "deferred by choice,
> not blocked" — rest on automated coverage for now, runnable on demand, not
> a debt owed to this register. The repo owner confirmed this reading
> 2026-08-21. This row's scope narrows to step 9 alone; the row does not
> leave the register, since step 9 is still genuinely owed. **The prior ⚠️
> about plan 264 contradicting itself (S6 listed as both force-driven and
> not force-driven) is resolved** — Castwright#2559 fixed the plan text
> (removed `S6` from the force-driven list), see
> `docs/features/264-vram-aware-gpu-placement.md`.

### A3 · srv-57 Multi-GPU Wave 2 · **2-card boot**

Ten unchecked items in [#1230](https://github.com/dudarenok-maker/Castwright/issues/1230).
Real per-card UUIDs from torch · a starved card self-exits with code 43, `/health`
showing the breach first · `QWEN_DEVICE`/`KOKORO_DEVICE` on different cards run
concurrently, same-card pinning still blocks · three code-43 exits in ten minutes
**twice** — once card-specific (trips the streak guard), once not (manual-investigation
path).

Task 16/16.5 (auto-revert on a repeated bad pin) is designed but **unbuilt**, gated
on item 1 — it consumes the `tripEvent()` item 1 exercises.

### A4 · Audition engine + tier fidelity ([#1849](https://github.com/dudarenok-maker/Castwright/pull/1849))

Verified by tests and CI; never listened to.

- A character overridden to **Kokoro** in a **Coqui** book previews in Kokoro.
- A preview on a book set to **1.7B** renders at 1.7B, not 0.6B.
- Design a voice in **My voices**, then Play — first play is instant, no second
  synthesis (the design/play cache pairing that was made real; the two sides
  previously hashed different filenames).
- Force a capacity failure with **Coqui resident** — the error names Coqui and
  where its Stop button is, not just "free VRAM".

*Needs:* Kokoro, Coqui and both Qwen tiers, plus enough VRAM pressure for a real
capacity refusal. *Cost:* short.

### A5 · fs-60 XTTS per-language engine eligibility (plan 249)

Plan header: "**Live-GPU acceptance owed** (mock-mode e2e only)… This plan's
status stays `active`, not `stable`, until that walkthrough runs" (`:9,51`).

Five steps (`:53-66`): an undesigned character on a Russian book shows the
Coqui-fallback banner (not a hard block) · the engine picker offers Coqui · the
voice-readiness gate offers "Proceed anyway" · a **real render** shows a
"Fallback (Coqui)" pill · the same on a still-unsupported language (Chinese)
keeps the old hard block.

*Needs:* real sidecar, 8 GB-class GPU, a Russian book with an undesigned
character, and enough VRAM pressure to exercise Qwen/Coqui evict-and-reload.

### A6 · Bulk voice-design recycle resilience (plan 200)

Shipped direct-to-`main` **2026-06-10** (`274522d0`, closes bug #690). Ship notes:
"**Live-GPU acceptance … is the only remaining check.**"

On the 8 GB box with the sidecar started via `start-prod.bat` (so `.env` ceilings
are actually in effect): "Design full cast" over a multi-voice cast completes end
to end; then force a `/recycle` mid-run and confirm the pill rides through the
respawn rather than stalling.

*Note:* the flow gets exercised informally (bugs #1156, #1532, #1557, #1570 were
all found through real use) — but never this specific forced-recycle walkthrough.

### A7 · Design full cast — bulk Qwen voice design (plan 195)

Shipped 2026-06-07 (`7f0d5f4b`, PR #637); PR #638 filled the Ship-notes SHA but
left the acceptance bullet open (`:78-82`).

Pill survives navigation and a reload mid-run (resumes) · terminal summary counts
are right · series propagation reaches a sibling book · VRAM headroom holds across
a long run — **the exact combination that caused the plan-108 OOM** · a 2nd-tab
single design serialises correctly against a bulk run.

### A8 · Batch the QA re-record loops (plan 228)

"Acceptance (manual, on-box) — **OWED**" (`:95-100`). Regenerate a QA-flagging Qwen
chapter with the full gate stack on and confirm **RTF lands near ~1.2**, down from
~1.9.

*Never claimed done even at merge:* PR #1072's own body says "On-box RTF acceptance
(~1.2 target) to be confirmed on the next clean multi-chapter render."

### A9 · Per-character re-record / splice (plan 176)

"Manual (owed — live GPU + sidecar)" (`:50,55,59`). Still `status: active` as of a
2026-07-24 correction commit that says "Still owed: live-GPU re-record acceptance."

Rendered book → a character's profile → Fix audio → **+3 dB gain** across all
chapters: verify louder, duration unchanged, `.previous.*` written, A/B works,
chapter stays ≈ −16 LUFS. Then **re-record one chapter's lines** and verify timing
integrity — no seam, no doubled title. *Merged* 2026-06-03, PR #500.

### A10 · Structured failure taxonomy (plan 173, fs-19)

"Live multi-failure acceptance owed" (`:9,45`). Force **≥2 distinct real failure
modes** — stop the sidecar mid-run (`sidecar-unreachable`), oversubscribe VRAM
(`vram-spill`) — and confirm the friendly message plus remediation line on both
the row and the toast. *Shipped* 2026-06-03 (`affa489`, closes #469).

### A11 · A/B "current vs proposed" voice audition (plan 161)

"GPU audition validation owed" (`:9`). A non-destructive re-design — **Cancel must
leave the live `.pt` untouched** — plus an audible delta on approve. *First landed*
**2026-06-01**.

### A12 · Device-pin resolution survives a respawn ([#1870](https://github.com/dudarenok-maker/Castwright/pull/1870), closes [#1857](https://github.com/dudarenok-maker/Castwright/issues/1857)) · **2-card boot**

`buildSidecarEnv` now hands the sidecar the raw `cuda-uuid:` literal instead of a
translated `cuda:N`, so the sidecar re-resolves the pin against live torch
enumeration on every spawn. Verified by unit tests and CI; **never watched on real
cards.** The behaviour that matters most is the one no test can reach — a respawn
after the index actually changes.

- Pin Qwen to a specific card in Advanced settings, restart the server, and force a
  supervisor respawn (`POST /api/sidecar/restart`, or let a recycle fire). The engine
  lands on the **pinned** card both times.
- Then change the enumeration order — swap the cards, or set `CUDA_DEVICE_ORDER` —
  and confirm a respawn still finds the pinned card by UUID rather than failing
  `_validate_cuda_index` or landing on the wrong one. **This is the regression the
  change exists to prevent**, and it was previously reachable only when the user had
  opened Advanced settings during that server session.
- Pin `tts.qwen.codecDevice` to a card and confirm the codec is actually placed there.
  Before #1870 the pin was silently ignored — the literal failed inside torch's
  `.to()` and rolled back to CPU.
- Point the codec pin at a card that is **not** present and confirm the sidecar logs
  `QWEN_CODEC_DEVICE=… did not match any visible GPU` and leaves the codec on **cpu**
  — not on the model's card, which is what `auto` would have done.

*Needs:* both cards, and the ability to change enumeration order between boots (the
eGPU is not hot-pluggable, so batch this with A2 step 9 and A3). *Cost:* short.

### A13 · Idle Coqui is reclaimed under VRAM pressure ([#1894](https://github.com/dudarenok-maker/Castwright/issues/1894)) · **single 8 GB card**

The sidecar's admission path now frees a resident-but-idle XTTS before reporting
`noCapacity`. Unit tests prove the branch fires and that it never evicts for a Coqui
op; what they cannot reach is whether reclaiming ~3 GB actually admits the blocked
operation on real hardware, and whether the 30 s TTL is tuned for real chapter gaps.

- **Run pinned to ONE card** — `CUDA_VISIBLE_DEVICES=0`. This box is dual-GPU
  (`cuda:0` 4070 8 GB, `cuda:1` 5070Ti 16 GB) and `_worst_device_key` picks the card
  with the **most** headroom, so an unpinned run calls `idle_evict("cuda:1")` while
  Coqui sits on `cuda:0`, `_same_card` declines, and the row passes or fails for
  entirely the wrong reason.
- Load Coqui from the UI, then start a Qwen-only render that would not otherwise fit.
  Confirm the render **proceeds** and the sidecar log carries `Coqui model unloaded.`
  Record whether the reclaimed ~3 GB actually admitted the op, or was immediately
  taken by something else.
- Then render a mixed Qwen+Coqui book and watch the chapter boundaries. **An
  evict→reload cycle repeating across chapters means `COQUI_IDLE_TTL` is too short**
  (each reload costs ~90 s); a render that still fails `NoCapacityError` with an idle
  Coqui resident means it is too long. Record which, with the observed interval
  between the evict and the next Coqui use, so the default can be moved off 30 s with
  evidence rather than a guess.
- Also confirm the Stop-button crash fix: press **Stop** on Coqui while a chapter is rendering
  through it. The chapter must continue to completion — before #1894 this could kill
  it with `AttributeError: 'NoneType' object has no attribute 'tts'`. Also record
  what the **Stop control itself** reports: `CoquiEngine.unload()` now acquires
  `_synth_lock` before dropping the model, so it blocks for the length of the
  in-flight forward — tens of seconds to minutes. Since #1921,
  `POST /api/sidecar/unload` carries its own 90 s budget (not the 2 s probe
  budget), and the pill shows a disabled "Stopping…" state for the whole wait.
  The expected observation is now: the Stop control shows "Stopping…" with the
  button disabled, and it completes without an error banner, once the in-flight
  forward and the unload both finish. Record whether that held, and how long
  the eventual unload actually took.

> **PARTIALLY run 2026-08-26 (wave 6) — bullets 1 and 4 have real data; bullets 2–3 not
> attempted this round.** Pinned to `cuda:0` per bullet 1's own instruction. For bullet
> 4: piped a live chapter-generation SSE stream through `grep -m1` on the
> `"characterId":"одуван"` progress marker so `POST /api/sidecar/unload {"engine":
> "coqui"}` fired the instant Coqui's forward was actually in flight (confirmed via the
> raw sidecar `/health`'s `model_loaded` field, not a guess) — polling alone missed this
> window twice first, since Coqui's residency for this character is only ~5–8 s near the
> very end of a 252-line chapter. The unload call returned successfully in ~2.1 s and the
> sidecar's own `/health` immediately after showed `model_loaded: false` (Coqui genuinely
> unloaded), `poisoned: false`, `recycle_pending: true` (unrelated — approaching this
> box's own tuned `SIDECAR_RECYCLE_SOFT_MB`, expected on a long run) — no
> `AttributeError`, no poisoning. **What this round could not confirm** is "the chapter
> continues to completion": the Node orchestrator process died within ~2 s of the unload
> call. Traced afterward to `tsx watch` restarting the dev server whenever a concurrent
> Open Engine session committed/merged/checked-out branches in the SAME checkout this run
> started in (before this run moved to an isolated worktree per this wave's own setup
> note) — a coincidence of timing with an unrelated cause, not something the Stop action
> itself triggered, but not fully ruled out either since the two events landed this close
> together. Bullets 2–3 (idle-Coqui admission timing, evict→reload cadence) are still owed.

**Run this with A5** — same card, same mixed-cast book, and a mixed Qwen+Coqui
render already stages the co-residency this row's first bullet needs.

*Needs:* the 8 GB card only, pinned via `CUDA_VISIBLE_DEVICES=0`, and a mixed-cast
non-English book. *Criteria:* the spec at
`docs/superpowers/specs/2026-07-28-coqui-residency-eviction-design.md` §6; the TTL
rationale is in the comment on `_COQUI_IDLE_TTL_DEFAULT` in `tts-sidecar/main.py`.
*Cost:* short.

### A14 · Real-book QA/badge agreement after the loudness measurement hoist (plan [274](../features/archive/274-loudness-measurement-provenance.md), [#1922](https://github.com/dudarenok-maker/Castwright/issues/1922), [#1923](https://github.com/dudarenok-maker/Castwright/issues/1923))

Everything is proven in-repo with real ffmpeg (no GPU) against a recorded-PCM fixture
— what that cannot reach is a full multi-chapter render of genuinely synthesised
speech, where the hoisted `ebur128` measurement runs against real TTS output rather
than a single committed clip.

- Render a full book (any engine). For every chapter, confirm the Suspect badge's
  true-peak reason (when present) and the Listen-view loudness badge's dBTP figure
  quote the **same number** — they can no longer be two different readings of the
  same chapter.

*Needs:* a working TTS engine + a real book. *Criteria:* plan 274 §6 row 1.
*Cost:* short (rides along with any other real-book render session).

### A15 · Measurement-failure path renders as untrusted, not as a fabricated reading (plan [274](../features/archive/274-loudness-measurement-provenance.md))

T2/T6 cover the fail-soft fallback and the grandfather predicate at unit level with a
forced (mocked) `measureLoudnessFile` failure. Not yet observed: the real, hard-to-force
failure path on a live render.

- Force (or catch) a chapter whose real `ebur128` re-measurement fails on a genuine
  render. Confirm the sidecar carries `measurementSource: 'loudnorm'` and that both
  the Listen-view badge and the report-card row show "No measurement" rather than a
  fabricated figure.

*Needs:* a working TTS engine + a real book; this failure is hard to force naturally,
so treat it as opportunistic (catch one if ffmpeg genuinely fails during a render)
rather than something to engineer. *Criteria:* plan 274 §6 row 3. *Cost:* short,
opportunistic.

### A16 · A cloned voice renders a non-English book in the book's language (plan [275](../features/275-clone-voice-language.md), [#1951](https://github.com/dudarenok-maker/Castwright/issues/1951))

> **PARTIALLY evidenced 2026-07-31 — NOT discharged.** Corrected after
> [#1972](https://github.com/dudarenok-maker/Castwright/issues/1972) was
> understood; the original entry claimed a full discharge and was wrong.
>
> **What still stands — the fix works, proven at the synthesis boundary.** Three
> direct `POST /synthesize` calls on the same cloned voice, raw PCM transcribed
> with Whisper auto-detect and embedded with `/embed`:
>
> | Call | detected | `avg_logprob` | cos vs source clip |
> |---|---|---|---|
> | English text + `language: English` | `en` | −0.258 | 0.865 |
> | **German text + `language: German`** | **`de`** | −0.699 | **0.809** |
> | German text, language omitted (pre-fix) | `en` | −0.904 | 0.876 |
>
> Row 3 reproduces the shipped bug live — German in, English phonetics out,
> transcript garbage. Row 2 is the fix, with the cloned identity intact at 0.809
> against a ~0.03 different-speaker floor. This is real evidence and does not
> depend on the splice path.
>
> **What is withdrawn.** The row's actual criterion is *"render a non-English
> **chapter** with a cloned voice and transcribe the output"*. That chapter
> render used a splice re-record, so most of what was measured was **narrator**
> audio, not the clone — the rendered lines scored **0.949** against the
> chapter's own narrator. The `de` / −0.233 figure is therefore a measurement of
> the wrong audio: it shows the chapter rendered in German, not that *a cloned
> voice* did. `resolvedVoiceName` said otherwise, and that is the field #1972
> falsifies.
>
> **To finish this row:** re-run the chapter-level criterion once #1972 has
> landed, on a book whose `segments.json` and analysis agree — or via a full
> chapter generation, which is unaffected by the defect. The remaining
> sub-checks (designed self-heal → restart → identical; the QA
> `voice-mismatch` check, blocked on
> [#1969](https://github.com/dudarenok-maker/Castwright/issues/1969)) are
> unchanged.

Before this fix a cloned Qwen voice rendered **every** book, in every language, as
English — `QwenEngine.synthesize` took the caller's language and ignored it, and a
clone's manifest always said `"English"`. The unit and pytest coverage asserts the
*mechanism* (the right language reaches `generate_voice_clone`). Only a real render
proves the *outcome*, and the outcome is what the bug destroyed.

The criterion is deliberately outcome-level, because a mechanism-level assertion is
exactly what would have let the original defect ship: the batch path carries the
language separately from the title beat, and a fix covering only one of them passes
every mechanism test while leaving the whole book wrong.

- Cast a **cloned** voice onto a character with dialogue in a non-English book and
  render one chapter. Transcribe the output through the sidecar's `/transcribe` with
  Whisper **auto-detect** (send no `x-language`). **Pass = the detected language is
  the book's, and `avg_logprob` is better than ≈ −0.5.** Measured 2026-07-30 on the
  pre-fix build for reference: detected `en`, `avg_logprob` **−1.303**,
  unintelligible; with the language corrected, `de` at **−0.366**; a natively
  designed German control scored **−0.201**.
- Confirm `characterSnapshots.<id>.resolvedVoiceName` is still the clone's storage
  key — the never-substitute guarantee must hold while the language changes.
- **Check the chapter title too, not just the sentences.** The title beat is the only
  `/synthesize` call in an otherwise batched chapter, so a regression there hides
  behind correct-sounding body audio.
- Render with a **designed self-healed** voice, restart the sidecar, render again —
  the two must be audibly identical. This is the cache-vs-disk divergence half;
  before the fix the warm cache and the on-disk manifest disagreed, so a restart
  silently changed the output.
- **Then open the chapter's QA report and check the cloned character has no
  `voice-mismatch` rows.** The speaker-drift detector compares each segment against
  a reference the server renders itself (`auditionCentroid`), and that reference now
  carries the book's language too — an English reference against a German chapter
  would flag the voice as drifting when nothing is wrong. Only reachable with a
  character thin enough on in-book anchors to trigger the audition fallback (a
  few-line character is the easy way), so treat it as opportunistic within this same
  render rather than something to engineer.

*Needs:* a single GPU with Qwen resident, a non-English book, and ASR available
(`ASR_DEVICE` and `ASR_COMPUTE_TYPE` must agree — a `cpu` device with a pinned
`int8_float16` makes every `/transcribe` 500). **Run with A1's remaining Section C/D
items** — same box, same book, same sidecar session. *Criteria:* plan 275
§"On-box acceptance". *Cost:* one chapter render plus a sidecar restart.

### A17 · `/health` stays live through a contended eviction on the default Qwen path (plan [273](../features/archive/273-sidecar-lock-event-loop.md), [#1919](https://github.com/dudarenok-maker/Castwright/issues/1919)) · **single 8 GB card**

Automated tests prove each eviction step — and the reclaim that follows it — now
runs on a worker thread rather than the asyncio event loop. What they cannot reach
is whether `/health`, and every other in-flight request, actually stays responsive
when a real multi-GB `gc.collect()`/`empty_cache()` and a real contended
`_synth_lock` are in play — on the **default** Qwen path, with no opt-in env var.
Run sheet: [`sidecar-evict-latency-onbox-acceptance.md`](sidecar-evict-latency-onbox-acceptance.md).

- **Run pinned to ONE card** — `CUDA_VISIBLE_DEVICES=0` (runnable alongside
  A5/A13 in the same session). `SEG_CAPACITY_ADMISSION=1` (the default) and
  Qwen as the generation engine (also the default).
- Run a cast-review **voice design** so Qwen VoiceDesign is warm-resident
  (`QWEN_DESIGN_IDLE_TTL` keeps it ~120 s), then start a Qwen **chapter render** —
  each sentence's forward holds `_synth_lock` for its duration.
- While that render is in flight, trigger a second admission on the same card
  (`POST /load` for coqui, or `/xtts/clone-voice`). Its `qwen.design` eviction
  step's fast-out passes (nothing is *designing*), so it blocks on `_synth_lock`
  held by the in-flight Base forward — the exact race #1919 describes.
- From a second shell, poll `GET /health` every 250 ms **throughout** — from
  before the render starts until the second admission resolves — and record the
  **maximum inter-response gap, in milliseconds.** Before this fix the expected
  gap is on the order of one Qwen forward pass (seconds); after, it should stay
  under roughly 500 ms, bounded by the poll interval rather than by the render.
- Also confirm the evict **actually frees the VRAM** — the second admission
  succeeds rather than 503-ing `noCapacity`. A near-zero `/health` gap because the
  evict silently declined and did nothing would look like a pass and isn't one.
- **Optional second pass** with `SEG_ASR_ENABLED=1` + `ASR_DEVICE=cuda` to exercise
  the `asr` eviction step too. Not required for this row to clear.

*Needs:* the 8 GB card only, pinned via `CUDA_VISIBLE_DEVICES=0`, a book with a
designed Qwen voice in progress plus a second admission target (a Coqui `/load` or
an XTTS clone). *Criteria:* plan 273 §7. *Cost:* short.

> **PARTIALLY run 2026-08-26 (wave 6) — measured, but not the exact race, and caveated.**
> Pinned to `cuda:0`. Ran a simpler variant of the race: a Qwen chapter render in flight
> (no prior voice design warmed first — bullet 2's precondition was skipped) plus a
> concurrent `POST /api/sidecar/load {"engine":"coqui"}` fired mid-render from a second
> shell, while a third loop polled `GET /api/sidecar/health` every 250 ms throughout.
> **The second admission succeeded** (`{"status":"ready"}`) — bullet 4 confirmed, the
> evict genuinely freed VRAM rather than 503-ing. **Measured max single-request latency:
> 987 ms; max inter-request-start gap: 1346.9 ms** — above the ~500 ms bullet-3 target.
> Caveat: the poller spawns a fresh `curl` process per iteration via Git-Bash on Windows,
> which has its own non-trivial per-invocation overhead (observed elsewhere on this box
> to run 50–200+ ms under load), so this number cannot be cleanly attributed to
> server-side blocking alone without a lower-overhead instrument (e.g. a persistent
> Node/Python client reusing one connection). **Still owed:** the exact race (VoiceDesign
> actually warm via bullet 2 before the second admission fires) and a clean
> low-overhead re-measurement of the `/health` gap.

### A18 · Cloned-voice derive on Coqui no longer needs torchcodec ([#1967](https://github.com/dudarenok-maker/Castwright/issues/1967)) · **single 8 GB card + a real static-FFmpeg box; item 4 needs a Pinokio install**

**The hot patch was reverted on 2026-07-31 and the dev box is now a genuine static-FFmpeg box again** — `ffmpeg 8.1.1-full_build-www.gyan.dev` on PATH, and the 25 copied FFmpeg DLLs removed from `site-packages/torchcodec/`. Note the revert is *not* "delete every non-hash-suffixed `*.dll`" as first written: `libtorchcodec_core4-8.dll` and `libtorchcodec_custom_ops4-8.dll` are torchcodec's **own** extensions, have no hash-suffixed twin, and must stay. The copied set is exactly those non-hash-suffixed files that *do* have a hash-suffixed twin. With #1967 merged the hot patch is no longer needed to unblock A1's Section E.

**Partially discharged — items 1 and 3 are now DONE (2026-07-31); items 2 and 4 remain.** What ran, and what it proved:

- `import torchcodec` → `RuntimeError: Could not load libtorchcodec … FFmpeg is not properly installed`. The box is genuinely broken, so nothing below is a vacuous pass.
- `torchaudio`'s own loader on a reference WAV → same failure. This is the pre-fix path.
- **The real, installed `TTS.tts.models.xtts.load_audio`** — the exact function `get_conditioning_latents` calls — fails unpatched and returns a correct `(1, 22050)` tensor under `patched_xtts_load_audio()`. This is the seam #1967 is about, tested against the shipped upstream function rather than a fake.
- `tests/test_xtts_audio_io.py` on that box → **10 passed, 2 skipped**, the skips being the fidelity tier correctly opting out when torchaudio's loader cannot run. That skip behaviour had never been exercised on a real static-FFmpeg box before; it was only inferred.

**Still owed** is everything that needs the sidecar and a real voice — see items 1–4.

- **1. Static-FFmpeg derive — DISCHARGED 2026-07-31.** Ran on the reverted box against a sidecar the server genuinely supervised. The derive **completed** through the full `CoquiEngine.clone_voice` path and wrote both artifacts into a directory that was **empty** beforehand, so no cached `.pt` could have short-circuited it:

  ```
  18:12:59.558 [sidecar] Cloned + cached Coqui voice 'xtts-0abceba4-…' from caller clip.
  xtts-0abceba4-5eba-4d8f-8bdf-46bee14c931d.pt    135,509 B
  xtts-0abceba4-5eba-4d8f-8bdf-46bee14c931d.json      172 B
  ```

  No `derive-failed`, no `Cloned voice(s) unavailable`. The rendered audio is the clone and not a substitute — **0.229** cosine against the source clip versus a **0.014** different-speaker floor, measured through the production `/synthesize` → `/embed` path rather than read off `resolvedVoiceName`.

  **Three preconditions were verified, not assumed** — each is a way this acceptance can be faked:
  1. *The box is really static-FFmpeg.* `import torchcodec` still fails. The 25 stray hash-suffixed FFmpeg DLLs the first revert left inside `site-packages/torchcodec/` were also removed (62.6 MB); torchcodec's own 10 extensions are intact.
  2. *The sidecar is post-merge.* The running one had been orphaned by a recycle storm — `POST /api/sidecar/restart` returned **409**, i.e. nothing supervised it, so its vintage was unknown. Restarted the stack; `/restart` then returned **200**. **Treat a 409 as "this sidecar may be any age."**
  3. *No cache existed to short-circuit the derive.* `voices/xtts/` was empty.

  **Deviation, deliberate:** the hand-off brief suggests reusing E-01's splice setup. A **full chapter generation** was used instead, because [#1972](https://github.com/dudarenok-maker/Castwright/issues/1972) — found the same day — makes the splice unsafe on that book (13 of 21 targeted segments divergent), and that contamination is exactly why E-01's original identity claim had to be retracted.

  **This does NOT discharge E-01.** The chapter itself failed *after* the derive with `vram-spill` (mixed Qwen+Coqui co-residency is genuinely tight on the 8 GB card), so "the chapter renders" and the by-ear check remain owed there.

  A separate finding came out of it: a clone rendered in a language other than its source clip's loses most of its speaker identity on XTTS — 0.600 (English) → 0.229 (Russian), same derive. Filed as [#1998](https://github.com/dudarenok-maker/Castwright/issues/1998).

- **2. Latent equivalence — PARTIALLY DISCHARGED.** Decode equivalence was **measured** during PR #1978's review, on the still-hot-patched box, by running both decoders side by side against the same WAV: **max difference 0.0**, mono and stereo-downmix alike, so the replacement is bit-identical to the loader it replaces rather than merely similar. What remains is the *audible* end of it — derive the same cloned voice with and without the `patched_xtts_load_audio()` wrap on a shared-FFmpeg box and confirm the rendered output is equivalent. Cheap once item 1 can run.
- **3. Install-time verification — DISCHARGED 2026-07-31.** Both failure directions now run on a real install, and they produce **different** messages, which was the whole point of the marker line:

  | Scenario | exit | marker in stdout | branch selected |
  |---|---|---|---|
  | control — healthy | **0** | true | PASS, no failure branch |
  | **loader drift** (rebound to a wrong signature) | **1** | **true** | **MSG-1** — "patch could not be applied", names `coqui-tts 0.27.5`, points at #1967 |
  | **unrelated crash** (`import TTS` raises) | **1** | **false** | **MSG-2** — neutral "verification could not run" |

  Direction 2 correctly did **not** get MSG-1 — the specific defect this item existed to rule out. Drift message verbatim: `RuntimeError: XTTS reference-audio patch cannot be applied: unexpected load_audio signature ('some_other_name', 'and_another', 'extra') (coqui-tts 0.27.5).`

  Driven through the **real** `COQUI_VERIFY_CODE` and the **real** branch predicate from `install-coqui.mjs:222-232`; perturbations injected via `PYTHONPATH` only (a `sitecustomize.py` rebinding `load_audio`, and a shadow `TTS/__init__.py` raising `ImportError`), so the shared venv was never mutated. The guard's other drift shape (attribute missing) is already unit-covered by `test_raises_when_load_audio_missing`; the on-box-unique part was the marker-driven branch selection, which is what ran.

- **4. Pinokio's torchcodec outcome.** On a real Pinokio install, run `import torchcodec` inside the nested `.venv` that `pinokio/install.js` provisions and record whether it succeeds or fails — genuinely unknown at design time (design spec §11): conda-forge's ffmpeg is built shared, but a *nested* venv created from the conda interpreter does not automatically inherit loadable access to the conda env's `Library/bin` DLLs, so shared-ness there does not imply loadable here. #1967's fix makes the answer moot for *behaviour* either way — a Coqui clone derives correctly on Pinokio regardless — but the outcome itself is still owed as a recorded fact; see the correction note on `docs/superpowers/specs/2026-06-15-pinokio-installer-design.md:83`. **Batch with E1**, which already owns the Pinokio box.

*Needs:* items 1 and 3 want the 8 GB card with a real Coqui install — the dev box already satisfies item 1's static-FFmpeg prerequisite since the 2026-07-31 revert, so item 1 now needs only a post-merge sidecar and a consented sample; item 2's remaining half wants a box with a genuinely shared FFmpeg; item 4 wants a real Pinokio install (batch with E1). *Criteria:* [`docs/superpowers/specs/2026-07-31-xtts-clone-torchcodec-ffmpeg-design.md`](../superpowers/specs/2026-07-31-xtts-clone-torchcodec-ffmpeg-design.md) §12. *Cost:* short per item — the coordination cost of reverting the shared hot patch is now spent.

---

### A19 · Stranded VRAM pool reclaimed on the admission-failure path ([#1976](https://github.com/dudarenok-maker/Castwright/issues/1976), PR [#1993](https://github.com/dudarenok-maker/Castwright/pull/1993)) · **single 8 GB card**

Unit tests inject a fake `probe()` and a fake `reclaim` hook, proving the CALL
SEQUENCE (idle-evict first, reclaim once on failure, cooldown, the
in-use skip) — none of them touch a real CUDA allocator, so whether an actual
stranded `torch.cuda.empty_cache()` pool comes back on real hardware, and
whether the two new guards (C1, PR #1993 review) behave under real timing,
is unproven.

- Render a chapter to completion, let the engine report unloaded, and confirm
  (via `nvidia-smi` and `GET /api/sidecar/health`'s new
  `vramReservedMbByDevice`) that a reserved-but-unallocated pool is left
  behind on the render card, matching #1976's own measured shape (~3.9 GB on
  an 8 GB card).
- With that stranded pool present and nothing resident, issue an op that
  would otherwise be refused (an ASR `/transcribe`, or a voice design). It
  must be **admitted**, and `nvidia-smi` on that card must drop to
  near-baseline afterward — the #1976 acceptance criterion this row exists
  to close.
- Confirm the two C1 guards don't misfire on real hardware: (a) start a
  genuine render (so the render's engine holds a live reservation) and, from
  a second client, issue a refused op on the SAME card — the reclaim must
  NOT fire mid-render (watch for `stranded-cache reclaim` in the sidecar log;
  it must not appear while the render is in flight); (b) issue two refused
  ops on the same card within 30 s of each other and confirm the reclaim log
  line appears only once, not twice.
- This PR's `Closes #1976` was narrowed to `Refs #1976` in review (M5) — the
  render/unload-completion reclaim (#1976's other acceptance criterion) is a
  SEPARATE, not-yet-built lever tracked on its own follow-up issue. Do not
  treat this row's discharge as closing #1976 itself.

*Needs:* the 8 GB card only, a chapter render, and something to run past it
(ASR or a design) once it finishes. *Criteria:* PR #1993's description +
the C1/M3 review findings quoted above. *Cost:* short — rides along with A13,
which already stages a mixed-engine render on this same card.

> **PARTIALLY run 2026-08-26 (wave 6) — bullet 1's premise did NOT reproduce, twice.** Two
> independent clean chapter-completion measurements on a genuinely quiet
> `cuda:0` (single sidecar process, confirmed via `nvidia-smi --query-compute-apps`
> before each run):
>
> | run | post-completion `vramReservedMb` (health) | `nvidia-smi` used | ASR loaded this run? |
> |---|---|---|---|
> | 1 (fresh sidecar boot, first render) | **0** | 114 MiB (≈ idle baseline) | no |
> | 2 (same chapter re-rendered) | **243.3** | 648 MiB | yes |
>
> Neither run shows anything close to #1976's own measured **~3.9 GB** stranded shape —
> the first shows literally nothing stranded, the second a small few-hundred-MB pool. So
> bullet 1 does not currently reproduce on this box for an ordinary single-chapter render,
> and bullets 2–3 (which need a stranded pool to exist first) could not be exercised as a
> result. This does not mean #1976's underlying lever is dead — PR #1993's own reclaim
> mechanism may simply be doing its job well enough in the ordinary case that nothing gets
> a chance to strand, or the ~3.9 GB shape may need a specific trigger (recycle, a
> failed/aborted render, an ASR-QA re-record cycle) this round didn't hit. **Still owed:**
> reproduce a genuinely stranded pool first (try forcing a chapter failure or recycle
> mid-render, not just an ordinary completion), then run bullets 2–3 against it.

---

### A20 · Golden-audio bless guards don't rubber-stamp an honest bless, and `_make_kokoro` exercises a real engine (PR [#2032](https://github.com/dudarenok-maker/Castwright/pull/2032), closes [#1995](https://github.com/dudarenok-maker/Castwright/issues/1995), [#2003](https://github.com/dudarenok-maker/Castwright/issues/2003), [#1987](https://github.com/dudarenok-maker/Castwright/issues/1987)) · **Kokoro weights present; single 8 GB card is enough**

PR #2032 (hardened further by the independent pre-merge review that produced
this row) closes three "a gate that silently stopped asserting" defects in
`server/tts-sidecar/tests/golden/compare.py`'s bless guards and in
`test_golden_regression.py`'s `_make_kokoro`. All three files' pure-function
gating tests (`test_golden_compare.py`, `test_instruct_bless_gating.py`,
`test_make_kokoro_gating.py`) are mutation-verified and run in the fast
`test:sidecar` tier — but two behaviours only a real bless run against real
weights can prove, and neither was exercised on real hardware for this PR:

- **A guard that never blocks honest work.** Every guard added/hardened here
  (`bless_guard`'s G1/G2, `bless_guard_thresholds`'s tolerances check and its
  new `previously_blessed` disambiguation) is proven only against synthetic
  fixtures. The thing that would make it a *rubber stamp in the other
  direction* — refusing a bless that changed nothing real, or demanding
  `GOLDEN_REBLESS_THRESHOLDS=1`/`GOLDEN_REBLESS_CONTENT=1` on a routine,
  uncontended re-bless — has never been observed end to end.
- **`_make_kokoro` against a real `KokoroEngine`.** `test_make_kokoro_gating.py`
  pins the classifier wiring (`synthesise_or_skip` / `prereq.py`) with a
  stubbed engine; #1987's actual claim — a genuine CUDA/model-corruption
  failure during Kokoro warm-up now FAILS the test instead of reading as a
  green SKIP — has not been forced against the real engine.

- **Prerequisite:** Kokoro weights installed
  (`server/tts-sidecar/voices/kokoro/kokoro-v1.0.onnx` +
  `voices-v1.0.bin`), sidecar venv bootstrapped. A single 8 GB card is
  sufficient (Kokoro is the ~1 GB fallback engine); CUDA is not required —
  `ASR_DEVICE=cpu`/CPU Kokoro also exercises this.
- Run `npm run test:golden-audio -- --bless --sidecar-only` on a clean,
  **uncontended** box (check `nvidia-smi` first — this PR's `--bless`
  contention warning should print nothing). Confirm it completes and writes
  `kokoro-baseline.json` / `instruct-baseline.json` **without**
  `GOLDEN_REBLESS_CONTENT=1`, `GOLDEN_REBLESS_THRESHOLDS=1`, or
  `GOLDEN_REBLESS_MEASUREMENTS=1` set on a routine, uncontended re-bless.
  **Amended by #2045 F1/F2, then again by #2060/#2061/#2062/#2069** (the
  `identity`/`loudness_dbfs` guard, added by #2035 after this row was
  written, was noise-tolerant-and-WRITTEN as of #2045; #2060/D4 later
  changed the WRITE side, not the accept side): `kokoro-baseline.json`'s
  `transcript`/`text_edits`, `instruct-baseline.json`'s `tolerances` block,
  AND — since #2060/D4 — `instruct-baseline.json`'s `identity`/
  `loudness_dbfs` figures too must ALL stay BYTE-IDENTICAL on a routine
  re-bless (or the guard is broken). "Figures MAY move by run-to-run
  noise" was true before D4 and is **no longer a meaningful thing to
  check** — a within-epsilon noise-sized move is still ACCEPTED (not
  refused, no flag needed), it just no longer REWRITES the committed
  reference, so the file staying byte-identical is now the EXPECTED
  outcome for `identity`/`loudness_dbfs` too, not evidence on its own that
  anything happened. What real hardware is uniquely placed to confirm
  instead is the ECHO: the console should still print a `[golden-bless]
  identity moved within epsilon ... (noise -- reference unchanged) -- ...`
  / `[golden-bless] loudness_dbfs moved ...` line whenever this run's raw
  measurement differs AT ALL from the committed figure (real hardware
  noise makes a nonzero diff near-certain, even though the file itself
  won't change) — the echo is the part a `git diff` alone can't confirm,
  and it's the accept-path half of the guard real hardware is uniquely
  placed to exercise (both the ROUTINE-bless-doesn't-need-the-flag half
  AND the noise-gets-echoed-but-not-written half need a REAL measurement
  pair with real noise between them — a synthetic fixture can only assert
  the arithmetic, never that actual noise clears epsilon on a real box). A
  byte-identical block with an echo present is the guard working; a
  byte-identical block with NO echo at all just means this run's raw
  measurement happened to land exactly on the committed figure — don't
  read bare byte-identical output alone as proof the guard fired; the
  echo is the falsifiable signal. `blessed_at`-adjacent housekeeping
  fields may still move as before.
- **This run is also the only thing that retires the identity epsilon's
  open question** (#2066). `IDENTITY_COSINE_EPSILON` moved 0.015 → 0.005
  because 0.015 was derived from an unrelated ceiling (`identity_cosine_max`
  = 0.15) rather than from measured noise. 0.005 is ≈3.6× the **single**
  run-to-run delta recorded anywhere in the repo (`metadata.notes`' ~0.0014)
  — one observed figure, on one leaf, while the guard refuses on the `max`
  across five. Nothing in-repo measures the per-leaf distribution. So record
  the **actual per-leaf deltas** you observe here, not just pass/fail: if any
  single leaf routinely clears 0.005, the constant is too tight and this
  gate refuses honest work. That measurement is the deliverable.
- Then force one refusal for real: hand-edit a committed baseline to null out
  its `transcript` (or delete its `tolerances` key) exactly as a bad
  merge-resolution would, re-run the same `--bless` command, and confirm it
  refuses with the expected `GOLDEN_REBLESS_*` message and leaves the file
  byte-identical to before the attempt — then revert the hand-edit.
  This is the "#2003/#1995 shape, on a real file, via the real CLI entry
  point" check the unit tests can only approximate with `tmp_path` fixtures.
- **Amended by #2045 F1/F2, then #2060/D1:** also force one WINDOW-sized
  refusal on `instruct-baseline.json`'s `identity` block (hand-edit one
  committed `identity.cosine.<emotion>` figure by clearly more than
  `IDENTITY_COSINE_EPSILON`, e.g. +0.05), re-run the same `--bless`
  command, and confirm it refuses (not just accepts-and-echoes) with the
  expected `GOLDEN_REBLESS_MEASUREMENTS` message — **not**
  `GOLDEN_REBLESS_THRESHOLDS`, which the #2060 flag split now reserves for
  `tolerances` alone — and leaves the file byte-identical — then revert
  the hand-edit. This is the boundary the noise-tolerant epsilon exists to
  draw; the routine-bless bullet above only exercises the accept side.
- Run `npm run test:golden-audio -- --sidecar-only --engine=kokoro -m golden`
  (i.e. `test_golden_regression.py`'s real `_make_kokoro`-backed tests) once
  normally (expect pass), then deliberately break the engine (e.g. rename
  the `.onnx` weight file mid-run, or force a CUDA OOM by holding VRAM) and
  confirm the run now **FAILS** rather than SKIPping — the #1987 defect this
  PR closed. Restore the weights afterward.

*Needs:* Kokoro weights on disk, a box quiet enough that `--bless` measures a
stable, reproducible value (no concurrent GPU work), and permission to
hand-edit a baseline JSON for the refusal drill (revert before committing).
*Criteria:* this row; PR #2032's own mutation-verification table is the
synthetic-fixture half of the evidence, this row is the real-file half.
*Cost:* short — one clean bless, one deliberately-broken bless, one
deliberately-broken Kokoro run; well under an hour total.

---

### A21 · Cast-time clone-readiness gate — the fixes actually fix ([#1980](https://github.com/dudarenok-maker/Castwright/issues/1980), plan [276](../features/archive/276-cast-time-derivability-warning.md)) · **single 8 GB card + a real cloned voice**

The gate's *verdict* is heavily tested — a fixture table, a co-oracle contract
test binding it to the render's own oracle, an e2e walkthrough. What no suite
proves is that pressing the buttons **repairs the render**. Every automated
layer stops at the API response; none of them derives an artifact or synthesises
a line.

Two specific gaps, one of them structural:

- **`derive-failed` / "Retry derive" is unreachable in mock mode.**
  `mockCloneVoice` unconditionally stamps `engines.qwen.status: 'ready'`, and no
  exported mock mutator can move a slot to `'failed'`. So the e2e spec
  (`e2e/clone-readiness-gate.spec.ts`) covers `no-transcript` and the two silent
  controls and **cannot** cover this CTA at all. It is untested outside unit
  level by construction, not by omission.
- **"Add transcript" is only proven to persist.** The server test asserts the
  write; nothing asserts that a Qwen derive then *succeeds* against the
  corrected text — which is the entire premise of the CTA.

Run:

- Ingest a clip **without** a transcript, assign it while the session engine is
  Coqui (expect 200 + #1933's advisory), then switch the session engine to Qwen
  and press "Approve cast & start generating". The gate must name the character,
  Qwen, and the missing transcript, and offer **Add transcript**.
- Use the CTA. Then **render a chapter** and confirm the cloned voice actually
  speaks on Qwen — the derive succeeded against the user-supplied text. Capture
  the resolved voice key from `characterSnapshots`, not just the absence of an
  error.
- Force a genuine `failed` slot (a real derive failure — e.g. attempt a Qwen
  derive against an empty transcript on-box), confirm the gate reports
  **derive-failed**, press **Retry derive**, and confirm the predicate
  re-evaluates to the *underlying* cause (`no-transcript`) rather than reporting
  healthy. Plan 276 Decision 7 argues this is why the CTA cannot loop; nothing
  automated exercises it against a real stamp.
- **Control:** with the session engine switched back to Coqui, the same cast
  must produce **no** gate. Steps above pass equally well against a check that
  always warns.

*Needs:* the 8 GB card, a real sidecar, and a real cloned voice with a real
master clip. *Criteria:* the run sheet
[`clone-readiness-gate-onbox-acceptance.md`](clone-readiness-gate-onbox-acceptance.md);
walkthrough steps 1-7 in plan 276. *Cost:* short if it rides along with A1's
cloning session, which already stages a real clone on this card.

### A22 · Cast/analysis `characterId` drift — Wave 1 resolver ([#2040](https://github.com/dudarenok-maker/Castwright/issues/2040), [implementation plan](../superpowers/plans/2026-08-01-cast-character-identity.md)) · **single 8 GB card, Qwen resident**

Wave 1 ships a **read-time** fix only: `buildCastResolver` resolves a frozen
segment's `characterId` through a separator/case normaliser before the code
falls back to the narrator. It is fully unit- and route-tested against
synthetic fixtures. What no automated suite proves is the thing the feature
is *for* — that re-rendering an already-drifted chapter on the real workspace
now puts the character's own voice on their lines rather than the
narrator's. A read-only, dry-run resolver check already ran against the real
20-book workspace (design spec §6: 68 of 188 orphaned segments recover via
the normalised-id tier alone, with an empty history) — **that measured id
resolution, not a render.** This row is the render.

Real, already-affected fixture (confirmed 2026-08-02, not synthetic):
*Playing with Fire* (Derek Landy) at `C:\AudiobookWorkspace\books\Derek
Landy\Skulduggery Pleasant\Playing with Fire`. `the-torment` (67 segments,
cast id `the_torment`, a **tuned Qwen 1.7B voice**) and `lightning-dave` (1
segment, cast id `lightning_dave`) both recover under the normalised-id
tier — RC2's underscore-vs-hyphen split. `pool-player-2` (6 segments, cast id
`pool_player`) shares chapter 16 with `lightning-dave` and is the row's
built-in **negative control**: its `-2` collision suffix must still defeat
resolution, unchanged, since that needs Wave 2/3.

- Re-render chapter 19 (`the-torment`, 37 of its 67 segments) and chapter 16
  (`lightning-dave` + `pool-player-2` together). Confirm the fresh
  `segments.json` gains a `characterSnapshots` entry for `the-torment` /
  `lightning-dave` naming their own voice (Torment's tuned
  `qwen-YaC5ot82IqTLpeDbHd77F`, not `qwen-narrator`), and that
  `renderedFallbackEngine: "kokoro"` — present on every affected segment
  today — is gone from those two.
- **Listen.** Torment's line at chapter 19 `groupIndex: 25` ("Kill the
  child.") must be audibly a different voice from the narrator, not merely a
  different id in the JSON.
- Confirm `pool-player-2` is unchanged: still `renderedFallbackEngine:
  "kokoro"`, no snapshot entry. A resolution here would mean the resolver is
  matching more aggressively than designed.
- Cross-check the Cast screen's orphaned-id banner (#2023) no longer names
  `the-torment` / `lightning-dave` for this book after the two re-renders,
  while still naming `pool-player-2`.

*Needs:* the 8 GB card, a real sidecar with Qwen resident, and the real
workspace book above (back up its two affected chapter files before
re-rendering). *Criteria:* the run sheet
[`cast-id-drift-onbox-acceptance.md`](cast-id-drift-onbox-acceptance.md).
*Cost:* short — two single-chapter re-renders on an already-imported,
already-analysed book.

---

### A23 · Cast/analysis `characterId` drift — Wave 3 repair pass `--apply` run ([#2040](https://github.com/dudarenok-maker/Castwright/issues/2040), [implementation plan](../superpowers/plans/2026-08-01-cast-character-identity.md)) · **no GPU needed; real workspace + server stopped**

Wave 1 (A22) and Wave 2 (the characterId-drift re-analysis, now discharged) are proven or pending against a single already-drifted
chapter/book each. Wave 3's `scripts/repair-cast-id-drift.mjs` is the pass meant
to sweep the **whole** 20-book workspace at once.

> **PARTIALLY DISCHARGED — `--apply` was run 2026-08-05** (Claude Code session on
> the dev box, dudarenok-maker), against `main` @ `f3d6ae0f`. The write path is
> now proven; **§8.7 (does the fix reach actual audio — re-render *Заказ
> Коалфолла* ch2 and listen) and §8.8 (Cast-screen banner cross-check) are still
> owed**, so this row stays open for those two. The third item this row used
> to list as owed — a fresh dry run confirming the #2107 fix's numbers — has
> since been run (read-only, never `--apply`) and is folded into the #2107
> writeup below.
>
> **Wave-3 step 9, 2026-08-20 — OPERATOR.** Per
> `docs/testing/onbox-wave3-plan.md` §2 (itself re-deriving this row's own
> §8.7/§8.8 text above): §8.7 needs a real TTS render of *Заказ Коалфолла*
> ch2 plus human listening, and §8.8 needs a live-browser Cast-screen
> cross-check — neither is agent-runnable. This row joins
> `onbox-sitting-cloning-identity.md`'s row list alongside A22 (wave-3 step 4
> re-confirmed the verdict without new evidence; nothing else about this row
> changed). The live-view publish reflecting this move is still owed to the
> operator.
>
> **What was observed.** The liveness rail refused first, against a *real*
> `npm run dev` — which bound **LAN HTTPS 8443 only, never 8080**, so it was the
> `LAN_HTTPS_PORT` half of the probe that caught it (exit 1, nothing written; a
> probe covering only the default 8080 would have missed this server). With the
> server stopped, `--apply` recorded exactly the 3 predicted aliases across
> **2** books — `mayrin → mairin`, `coalfall → coalfall-dragon` (*Заказ
> Коалфолла*), `lady-alina → dame-alina` (*Everblaze*). No other book gained a
> `cast-id-history.json` (0 → 2 workspace-wide). All **20** `cast.json` files
> byte-unchanged (md5 before/after). The immediate dry re-run showed auto-records
> **3 → 0**, skipped **0 → 3**, report-only **93 / 161 unchanged** — the write is
> durable.
>
> **Two defects filed from the run, neither blocking the write itself:**
> [#2107](https://github.com/dudarenok-maker/Castwright/issues/2107) — **FIXED,
> then WIDENED by an independent review + owner decision**
> (`scripts/repair-cast-id-drift.mjs`, `fix/scripts-2107-rerender-rows`) — the
> re-render list dropped **17 rows / 120 segments → 13 / 93** afterwards, losing
> exactly the 27 segments the new aliases cover, whose audio is still
> narrator-substituted on disk (the list is documented as unconditional on
> auto-record status, and `120` was this row's stated damage figure at the time).
> Root cause: `collectSegmentOrphans` built its resolver WITH the on-disk
> `cast-id-history.json`, and any id that resolved via ANY successful tier hit a
> blanket `continue` — treated identically to a genuine live `'exact'` match,
> even though the `'history'`/`'normalised-history'` tiers depend on
> `supersededBy`, a table that can gain an entry (this script's own prior
> `--apply` run, here) strictly AFTER the segment's audio was frozen to disk. A
> first-round fix moved only those two tiers into `orphans`, keeping
> `'normalised-id'` exempt on the reasoning that it depends only on the CURRENT
> live cast list, never on `supersededBy`. **Independent review found that a
> non-sequitur** — it proves no *rename* happened, not that the rendered bytes
> are correct — and pointed at THIS row's own A22 evidence: *Playing with
> Fire*'s `the-torment`/`lightning-dave` both recover under `'normalised-id'`
> today, but were rendered **before Wave 1's resolver existed at all**, when
> `resolveGroup` substituted the narrator regardless of tier. There is no
> per-segment evidence on the real workspace to discriminate a genuinely-fine
> `'normalised-id'` match from a stale one — `renderedFallbackCharacterId` and
> `characterSnapshots` are absent from all 84,642 real segments, only
> `renderedFallbackEngine` (77 segments) exists — so the owner widened the fix:
> **only `'exact'` means the rendered bytes are fine; the other three tiers all
> list.** Over-reporting is the safe failure direction for a one-shot repair
> tool. This also changes what `--apply` *writes* (a related gap: the
> "already-recorded" skip compared raw strings against `supersededBy` while the
> resolver itself compares normalised — now fixed to match on the same
> footing, latent-not-live on the real workspace today). **Measured via a fresh
> dry run against the real workspace (read-only, never `--apply`):** re-render
> candidates move from 17/120 to **23 rows / 188 segments** (188 = the original
> full-workspace orphan count — the arithmetic check that this is now the
> complete set); auto-recordable aliases move from 0 (the three real aliases
> are already recorded and correctly skip) to **2 / 68 segments**
> (`the-torment`/`lightning-dave`, previously invisible under the removed
> `autoReconciled` bucket); reported-for-human-decision moves from 93/161 to
> **91 ids / 93 segments** (161 − 68 = 93 segments, 93 − 2 = 91 ids — the whole
> delta is `the-torment`/`lightning-dave` moving out of report-only). Full
> console output archived with the PR.
>
> **Fix round 2 (independent review, 2026-08-05) found two more defects in
> the #2107 fix itself, both now closed:** (1) the "already recorded" skip's
> normalised-footing fix from round 1 (`supersededByNormKey`, a hand-built
> map) was itself an instance of this wave's recurring shape — it diverged
> from the real resolver on normalised collisions, tier precedence, and dead
> alias targets, each a **false skip** that would drop an id off the
> human-decision list entirely. Deleted; the guard now asks the real,
> history-aware resolver (`historyResolver`, threaded from `main()`, not
> reconstructed) whether an id resolves via `'history'`/`'normalised-history'`
> directly. (2) the widening opened an undeclared write path: Tier A (name)
> runs before Tier B (id shape), and nothing checked a Tier A candidate
> against what the id already resolves to today — a stale cache entry naming
> a different character could repoint real segments' attribution onto the
> wrong live character, durably. A new guard withholds and reports that
> conflict instead of writing it. **Both were verified latent, not live, on
> the real workspace** — a fresh dry run (read-only, never `--apply`, same
> command as above) reports the identical **23 rows / 188 segments**,
> **2 / 68 segment** auto-recordable aliases, and **91 ids / 93 segments**
> report-only; neither real auto-record (`lightning-dave -> lightning_dave`
> Tier A, `the-torment -> the_torment` Tier B) trips the new conflict guard,
> since both already agree with their own live id-shape resolution.
>
> **Fix round 3 (independent review, 2026-08-05) found the round-2 fix
> itself defaulted fail-OPEN, closed:** `historyResolver` (threaded through
> `main()`) defaulted a missing value to `{ resolve: () => undefined }` when
> omitted — but `planBookRepairs` no longer reads `history.supersededBy`
> directly at all (that was the whole point of the round-2 fix), so a
> caller that omitted the resolver while still passing a fully populated
> `history` got **zero protection** from either guard, with no error.
> `undefined` from `.resolve()` means both "asked, nothing resolves" and
> "never asked" — the tenth instance of this wave's recurring shape, one
> level up from round 2's own fix. Measured on the round-2 conflict-guard
> probe: omitting the resolver auto-recorded a 67-segment durable repoint
> onto the wrong character; omitting it with `history.supersededBy`
> populated also went silently past the already-recorded skip. Fixed the
> same way `cacheAvailable`'s own pre-#2093 fail-open default was fixed:
> default to building the REAL resolver from the args already in scope
> (`buildCastResolver(liveCast, history)` — the identical construction
> `collectSegmentOrphans` uses), so an omitted `historyResolver` is a
> (redundant) optimisation for the production path, never a correctness
> hole for any other caller. Also printed the re-render list's segment
> total (`188`) in the summary line alongside the row count (`23`), which
> previously required an operator to sum every row by hand to get the
> figure this row's own arithmetic check depends on. **Verified latent, not
> live** — a third fresh dry run reports the identical **23 rows / 188
> segments** (now printed directly rather than hand-summed).
> [#2108](https://github.com/dudarenok-maker/Castwright/issues/2108) — **FIXED**
> (PR #2102, before this branch was cut) — a wrong `WORKSPACE_DIR` used to scan
> **0** books and still print `books missing analysis-cache evidence: 0` and
> exit **0** from `--apply`, because the script does not read `server/.env`, so
> a bare command hits an empty `<home>/AudiobookWorkspace`. `--apply` now
> refuses outright on a zero-book scan (`shouldRefuseApplyForEmptyScan`,
> `scripts/tests/repair-cast-id-drift.test.mjs`) — this note used to still
> describe it as open; corrected here.
>
> **Revision-sensitive:** the numbers above are against the **pre-#2102** global
> cache gate. **#2102 has since landed**: `books missing analysis-cache evidence`
> now reads **1** (*Unlocked* has a cache that parses and names nobody) and
> `books with an auto-record withheld: 0` is the line that actually gates
> `--apply` (see the current dry-run figures below, which already reflect
> post-#2102 code). Note for the record that *Unlocked* is not "nothing to
> repair" — it carries **34 orphaned segments** across ch63/ch67 under
> `unknown-male`; what makes withholding safe there is that a reserved
> fold-bucket **source** is never auto-recorded regardless of evidence, which
> fires before the ambiguity veto matters at all.
>
> **Four more filed issues fixed 2026-08-05
> ([#2097](https://github.com/dudarenok-maker/Castwright/issues/2097),
> [#2135](https://github.com/dudarenok-maker/Castwright/issues/2135),
> [#2130](https://github.com/dudarenok-maker/Castwright/issues/2130),
> [#2134](https://github.com/dudarenok-maker/Castwright/issues/2134)),
> after a round-2 review caught #2134's first fix backwards:**
>
> - **#2134 round 1 (guard 4/ranker inert on drifted ids) turned
>   `classifySnapshotEvidence`'s new `'no-evidence'` outcome into a VETO —
>   round 2 review found that backwards and reverted it to an annotation.**
>   `characterSnapshots` is a file-level map written ONLY for an id that was
>   LIVE in `cast.json` at render time. Every id this loop considers is, by
>   definition, NOT live today (that is what makes it an orphan) — so for
>   this population, snapshot presence/absence is not neutral: **presence**
>   means the id WAS live at render (audio already correct, drift happened
>   after) and **absence** means the narrator was substituted (the actual
>   A22 damage this pass exists to fix). A veto on absence therefore blocks
>   exactly the aliases that repair real damage and passes exactly the ones
>   that needed no repair — replayed against the real workspace with
>   `supersededBy` emptied, the round-1 veto would have blocked **two of the
>   three aliases already applied and accepted on this box**
>   (`mayrin`→`mairin`, `coalfall`→`coalfall-dragon`) while letting the
>   already-fine `lady-alina`→`dame-alina` alias through. `'no-evidence'`
>   now flows through to auto-record, carrying an honest "guard 4 not
>   evaluable" annotation on the row and console line instead of either a
>   false claim of verification (the pre-#2134 state) or a wrong block (the
>   round-1 fix). `'conflict'` (real, disagreeing snapshot evidence for a
>   named id) is unaffected and still downgrades to report-only. **Net
>   effect: the fresh dry run's figures are IDENTICAL to the pre-#2134
>   baseline** — auto-recordable **2 aliases / 68 segments**, report-only
>   **91 ids / 93 segments**, re-render **23 rows / 188 segments** — because
>   round 1's veto and round 2's fix cancel out for this real data; what
>   changed is honesty (the console line now says plainly when guard 4 had
>   nothing to verify), not the write decision.
> - **#2097 + #2135 (evidence that can't be read must count as UNKNOWN, not
>   CLEAN) — confirmed sound by round-2 review; NOT live on the real
>   workspace today, no figure change.** `collectBooks` now counts and names
>   any dropped book (`'not-yet-analysed'` vs `'unreadable'`, the latter
>   refusing `--apply`); `collectBakNameEntries` now returns `bakAvailable`,
>   gating a per-book `withheldForMissingBak` auto-record guard the same way
>   `cacheAvailable` already gates cache. Round 2 also closed five smaller
>   gaps found by review: `collectBooks`'s shape check now uses
>   `Array.isArray`, not truthiness (a truthy non-array `characters` field
>   used to be silently accepted and later crashed `planBookRepairs`); its
>   `readdirSync` calls are now guarded the same way its bak sibling's is
>   (an unreadable author/series directory used to throw out of `main()`
>   uncaught); `collectBakNameEntries`'s `characters` field is now
>   `Array.isArray`-checked too (a string silently iterated to zero entries,
>   an object threw); and a suspected (unverified — not reproducible on this
>   box) gap where `fs.existsSync` swallows `EACCES` the same as "doesn't
>   exist" is closed defensively via a tri-state file read that
>   distinguishes `ENOENT` from every other read failure. The fresh dry run
>   reports **books scanned: 20** (no drops — every book's
>   `cast.json`/`state.json` is readable), **books with unreadable
>   cast.json.bak.* evidence: 0**, and **books with an auto-record withheld
>   for missing bak evidence: 0** — matching #2135's own real-workspace scan
>   (41 bak files, 0 unparseable). **Correction (round 3 review,
>   2026-08-05): the "confirmed sound" claim above was itself wrong.**
>   `collectBooks`'s discriminator required BOTH `cast.json` AND
>   `state.json` to be genuinely missing before granting the legitimate
>   `'not-yet-analysed'` reason — but `state.json` is written at import
>   time, before any analysis, and `cast.json` is created only later, during
>   analysis stage 1 (reparse re-creates the identical shape: it deletes
>   `cast.json` and keeps `state.json`), so a book between import and first
>   analysis has `state.json` present and `cast.json` absent — misclassified
>   as `'unreadable'`, refusing `--apply` for the entire workspace over one
>   freshly-imported, otherwise-healthy book. Fixed by judging each file
>   independently: only a file that is PRESENT but unreadable or
>   wrong-shaped counts as lost evidence; a file that is genuinely missing
>   never does, whichever file it is. **Not live on the real workspace
>   today** — none of the 20 books are mid-import — so no figure moves.
> - **#2130 (a resolver tier rename would go undetected) — relocated after
>   round 2 review found the original fix couldn't fire in CI at all, for
>   two independent reasons: the job that runs it never builds the server,
>   and (separately fatal) that job's own scope condition doesn't even run
>   on a `server/src`-only diff.** The coupling test now lives at
>   `server/src/store/cast-resolve.repair-pass-contract.test.ts`, in the
>   **server** test suite — vitest transpiles `cast-resolve.ts` straight
>   from source (no `server/dist` build needed) and that suite already runs
>   on every `server/src/` change, closing both gaps at once. Proven twice:
>   renamed `'exact'` to `'exact-id'` in `cast-resolve.ts`, ran the new test
>   with `server/dist` entirely absent (confirming no build is needed) and
>   watched it go red, then reverted. Test-only, no script behaviour change,
>   no figure change.
>
> Dry run command: `WORKSPACE_DIR=C:/AudiobookWorkspace
> CACHE_DIR=<primary-checkout>/server/handoff/cache node
> scripts/repair-cast-id-drift.mjs` (no `--apply`).

> **Further revision, #2092/#2089 Task 9 (pair-scoped reject filter):** the
> `--apply` run recorded above predates this fix and involved zero rejected
> pairs — no book in the real workspace has ever had a `rejectedPairs` (or
> even legacy id-wide `rejected`) entry, since the Cast-screen "Not the same
> character" action had not shipped to a real run of the app yet. None of the
> auto-record/report-only/skipped figures above change as a result of this
> fix. What changes going forward: the repair script's own skip used to be
> id-wide (any rejection anywhere blocked that id from ever auto-recording
> again); it is now pair-scoped, so a reject against one candidate no longer
> withholds a DIFFERENT, later candidate for the same orphaned id. This only
> has real bite once a real book has an actual rejected pair on disk — a
> future `--apply` run against a workspace with a live rejection should be
> spot-checked against this row's own "3 aliases / 93 reported / 17 re-render
> rows" baseline to confirm a since-corrected reject doesn't reappear as
> withheld.

Every number below comes from the pass's dry-run mode, which writes
nothing. No automated test can substitute for the real run: the pure helpers
(candidate ranking, ambiguity/reserved-source guards, the re-render list shape)
are unit-tested against synthetic fixtures, and the liveness probe was verified
live against dummy listeners (see `task-18-report.md`) — but nothing has ever
exercised the actual `--apply` write path against the real
`C:\AudiobookWorkspace\books` tree.

**Dry-run result (independent-review Critical C1 fix applied, re-measured
2026-08-05 with `CACHE_DIR` correctly pointed at the checkout that ran this
workspace's analysis):**

- **3 auto-recordable aliases, 27 segments** — `mayrin` → `mairin` (8 segments)
  and `coalfall` → `coalfall-dragon` (13 segments), both in *Заказ Коалфолла*;
  `lady-alina` → `dame-alina` (6 segments) in *Everblaze*. Each is an
  unambiguous, non-reserved exact name or id match with real rendered damage
  behind it. Unchanged by the round-2 fixes below.
- **93 ids reported for a human decision, 161 segments** (was misreported as
  93 segments before the round-2 fix — see below) — includes the three
  reserved fold-bucket rows a pre-review-round-1 version of the script would
  have wrongly auto-recorded: *Exile*'s `unknown-male` (21 segments, spanning
  chapters 7/33/60 — the analysis cache separately names that bucket Timkin,
  Brant, Dwarf, Rex **and** Lord Cassius across the book) and `unknown-female`
  (14 segments), plus *Unlocked*'s `unknown-male` (34 segments). The remaining
  24 (`pool-player-2` 6, `sir-harding` 1, `silveny` 17) have no usable name
  signal anywhere in the cache or a `cast.json.bak.*`. Also includes *Playing
  with Fire*'s `the-torment` (67 segments) and `lightning-dave` (1 segment) —
  A22's own already-affected fixture (above): both already auto-reconcile live
  via the normalised-id tier, so a round-2 review fix corrected their reported
  reason from the misleading "zero rendered segments — no damage to repair"
  (which contradicted the Cast banner's own auto-reconciled section for the
  same ids) to "already auto-reconciles … already fixed, no separate alias
  needed" — this is the 68-segment (67+1) delta between the old 93 and the
  corrected 161. Neither is itself damage — both already render under their
  live id today — which is why the re-render/damage total below is unchanged
  at 120: the 161 report-only figure now mixes genuinely-orphaned segments
  with a couple of already-fine ones the script merely name-matched, and is
  no longer a proxy for "segments still needing repair".
- **17 re-render rows, 120 segments** — unconditional on auto-record status;
  writing an alias fixes metadata attribution, not the audio bytes already on
  disk. This, not the report-only total above, is the actual damage figure.
  **Superseded (#2107, widened by independent review + owner decision,
  2026-08-05, after the write below) — see the PARTIALLY DISCHARGED banner
  at the top of this row: the post-fix, post-`--apply` figure is 23 rows /
  188 segments, and `the-torment`/`lightning-dave` (68 of those segments)
  also move from "auto-reconciles, no alias needed" into a genuine 2-alias
  auto-record.** This bullet is left as originally measured — it was the
  pre-`--apply`, pre-#2107-fix baseline and is still accurate as that.
- **0 books modified, 0 `cast-id-history.json` files written** — confirmed by
  a workspace-wide file search before and after every dry run.
- **1 book missing analysis-cache evidence, 0 books with an auto-record
  withheld because of it** — these are now two DIFFERENT numbers (owner-
  decided policy, review round 2, 2026-08-05), and **only the second one
  gates `--apply`**. *Unlocked*'s cache file
  (`server/handoff/cache/mns_dLurz4I544.json`) exists and parses as valid
  JSON, but names **zero** characters (neither `stage1.characters` nor any
  `chapterCast` entry — both are optional per the schema, and this file
  happens to have neither populated) — found by independent review (Critical
  C1) after the #2093 residual-1 fix first shipped gating only on "exists and
  parses": the cross-source ambiguity veto doesn't consume "did it parse", it
  consumes the cache's actual name/id entries, so a validly-parsing,
  evidence-free file is exactly as blind to the veto as a missing one.
  `isCacheAvailable` now also requires at least one name/id entry that
  `buildNameIndex` itself would keep, not merely one `cacheEntriesOf` treats
  as string-shaped (pre-merge review I1 closed a further gap — an entry
  like `{id:"sandor", name:""}` used to pass the raw `cacheEntriesOf` check
  while `buildNameIndex`, what guard 2 actually reads, silently drops it;
  zero of the real workspace's 80 cache files exhibit this shape today).
  Re-measuring the SAME real cache directory (76 files parse, 0 unparseable,
  10 parse with zero character entries) surfaces this one book. **This is
  expected and does NOT block `--apply`** — but **not because *Unlocked* has
  nothing orphaned.** It does: **`unknown-male`, 34 segments across ch63/ch67**
  (confirmed both by a live pre-merge-review scan and by the real `--apply`
  run above). The reason it doesn't block: `unknown-male` is a **reserved
  fold-bucket SOURCE id**, and guard 1 refuses to auto-record from a
  reserved source unconditionally, firing *before* the cache-availability
  gate is ever reached — so *Unlocked*'s blind ambiguity veto never actually
  stood between the pass and a real candidate. `--apply` refuses only when a
  book's blind veto DID withhold a real candidate — that count is separately
  reported and currently reads `0`. The trigger that WOULD change this: a
  **non-reserved** orphaned id in *Unlocked* with a real Tier A/B name/id
  match (from a future re-render or re-analysis) — and, per pre-merge review
  I2, a match with **zero rendered segments** would NOT trigger it either
  (guard 3 refuses those regardless of cache evidence, before the cache gate
  is reached). Re-check before trusting the `0` if *Unlocked* changes.

- **Precondition: `CACHE_DIR` must point at the real analysis cache**, not a
  fresh worktree's own (git-ignored, per-checkout — see the script's module
  doc comment). Run the dry run first and confirm the summary reads `books
  with an auto-record withheld for missing cache evidence: 0` — `--apply`
  now refuses outright otherwise (round-2 review fail-closed fix for the
  cross-source ambiguity veto's blind spot when cache evidence is absent;
  #2093 residual 1, strengthened by independent-review Critical C1,
  tightened `isCacheAvailable` to require the file exist, parse, AND name at
  least one character; then re-scoped by owner-decided policy, review round
  2, so the refusal gates on an actual withheld candidate, not merely a book
  whose cache happens to be unusable). **A nonzero `books missing
  analysis-cache evidence` count is expected and does NOT by itself block
  `--apply`** — as measured today it reads `1` (*Unlocked*, see above), while
  the gating `books with an auto-record withheld…` line reads `0`, so this
  precondition IS currently satisfied. Don't stop just because the first
  number is nonzero — check the second one.
- **Precondition (#2108): `WORKSPACE_DIR` must actually point at the real
  20-book workspace.** Confirm the summary reads `books scanned: 20`
  alongside the cache-evidence lines above — a wrong `WORKSPACE_DIR` (the
  script defaults to `<home>/AudiobookWorkspace`, which does not exist)
  scans **0** books and, before this fix, printed a clean-looking `books
  missing analysis-cache evidence: 0` and exited `--apply` with code `0`
  having written nothing — an empty tree reading as a healthy one, on
  exactly the line this precondition told the operator to trust. `--apply`
  now refuses outright when `books scanned` is `0`, and the dry-run summary
  calls out a zero-book scan explicitly instead of rendering a row of clean
  zeros.
- Stop any real server bound to the configured probe port(s) (default `8080`
  and the LAN HTTPS `8443`) **or their auto-rebind range** (up to 19 ports
  above each default, matching `listenWithAutoRebind` — #2090) — `--apply`
  refuses outright while any of them answers, since the write is
  out-of-process and no in-process lock covers it. Confirm
  the refusal fires first, against the *real* dev server (not only a dummy
  listener): start `cd server && npm run dev`, run `--apply`, confirm it exits
  1 naming the reachable port and writes nothing, then stop the server.
- Run `cd server && npm run build`, then
  `node scripts/repair-cast-id-drift.mjs --apply` against the real workspace
  with the same `WORKSPACE_DIR`/`CACHE_DIR` as every prior dry run.
- Confirm `.audiobook/cast-id-history.json` now exists for *Заказ Коалфолла*
  with `supersededBy` containing `mayrin: "mairin"` and
  `coalfall: "coalfall-dragon"`, and for *Everblaze* with `supersededBy`
  containing `"lady-alina": "dame-alina"` — and that **no other book** in the
  workspace gained a `cast-id-history.json` file.
- Confirm every book's `cast.json` is byte-unchanged (mtime + diff) — the pass
  writes only the history side-table, never the cast itself.
- Re-run the script in dry-run mode immediately after. Confirm the three
  now-recorded aliases no longer appear in the auto-record list (already
  resolved through the history) and the 93 report-only ids are unchanged —
  proving the write was durable, not merely printed once.
- Re-render *Заказ Коалфолла* chapter 2 (the `mayrin`/`coalfall` orphaned
  chapter) and confirm the same shape A22 pins: the fresh `segments.json`
  gains `characterSnapshots` entries for `mayrin`/`coalfall` naming Мэйрин's
  and Коалфолл's own live voices, not the narrator — **listen** to confirm
  audibly, not only from the JSON.
- Cross-check the Cast screen for both affected books: the auto-reconciled
  section now names `mayrin`/`coalfall`/`lady-alina`; the needs-your-decision
  section still names the 93 remaining ids untouched by this run (spot-check
  `unknown-male` in *Exile* as the negative control — a reserved-bucket source
  must still refuse to auto-record, unchanged).

*Needs:* no GPU or TTS engine — the pass itself only reads the analysis cache
and any `cast.json.bak.*` files and writes `cast-id-history.json`. Needs the
real 20-book workspace, a completed `server` build, and the ability to stop any
locally-running Castwright server for the duration of the `--apply` call.
Re-rendering the confirmation chapter needs the 8 GB card + Qwen resident, same
as A22. *Criteria:* the run sheet
[`cast-id-drift-onbox-acceptance.md`](cast-id-drift-onbox-acceptance.md) §8
(Wave 3). *Cost:* short — one script invocation against an already-imported,
already-analysed workspace, then one chapter re-render.

> **Wave-4 step 5e, 2026-08-21 — §8.8 DISCHARGED live; §8.7 is now this row's
> sole remaining debt.** §8.8 (Cast-screen banner cross-check) was run in a
> real browser: *Заказ Коалфолла*'s auto-reconciled bucket names `mayrin`/
> `coalfall` exactly as expected, labelled "audio is current"; the negative
> control (*Exile*'s `unknown-male`, a reserved fold-bucket source) still sits
> in needs-your-decision, unmoved. Everblaze's `lady-alina` half is
> corroborated by the real `cast-id-history.json` file (read directly) rather
> than a live Everblaze Cast-screen render, since Everblaze was not one of
> the books copied into this pass's throwaway workspace. **§8.7 (re-render
> *Заказ Коалфолла* ch2 and listen — a real TTS render plus human audio
> judgement) is explicitly out of scope for an agent and stays owed to the
> operator** — it needs a human to listen. This is the row's sole remaining
> debt. Full evidence:
> `docs/testing/onbox-wave4-results/step-5e-cast-screen-browser-rows.md`.
> `docs/testing/onbox-sitting-cloning-identity.md` still correctly lists this
> row for §8.7.

### A24 · Design-wins VRAM contention timeout is sized against a REAL 0.6B cold load ([#2070](https://github.com/dudarenok-maker/Castwright/issues/2070)) · **single 8 GB card**

Unit tests (`server/tts-sidecar/tests/test_design_contention.py`) fully pin
the logic with a simulated `_design_in_flight` claim: `unload_design()` now
waits (bounded, 150s) for an in-flight design to clear instead of nulling it,
and raises a typed `DesignContentionTimeoutError` if the wait expires. What no
unit test can reach is whether 150s is actually the right bound against a
REAL cold 0.6B Base load plus a real VoiceDesign forward on this box — the
figure was sized off the design path's own documented ~120s server budget,
not a fresh on-box measurement of the specific race window #2064's review
flagged.

- Start a voice design (cast review → Design a new voice), and — timed to
  land mid-design, before the design's own forward completes — trigger an
  ordinary chapter render on a *different* voice from another tab/session.
  Confirm the render's synth call **waits** for the design to finish (no
  error, just a delayed start) rather than the design failing with "VoiceDesign
  model was unloaded before this design could render."
- Confirm the design itself completes normally and its audition plays.
- If practical, force a genuinely wedged design (e.g. a killed/hung sidecar
  thread while `_design_in_flight` is still claimed) and confirm the waiting
  synth times out into the new `design_in_flight` 503 rather than hanging
  forever — and that it does so somewhere in the 150s neighbourhood, not
  immediately and not never.

*Needs:* a live sidecar with Qwen VoiceDesign installed, and a way to trigger
two overlapping requests (a second browser tab/session is enough). *Criteria:*
`unload_design`'s docstring in `server/tts-sidecar/main.py`; the sizing
rationale is in the `_DESIGN_CONTENTION_WAIT_S_DEFAULT` comment immediately
above `class QwenEngine`. *Cost:* short — one overlapped request pair.

> **RUN 2026-08-26 (wave 6) — bullet 1's premise did not hold; a real gap found, filed as
> [#2678](https://github.com/dudarenok-maker/Castwright/issues/2678).** Started a real
> single-character voice design
> (`POST …/cast/hart/design-voice/stream`, `preview:true`) and confirmed via
> `/api/sidecar/health`'s `qwenDesignEverLoaded` flipping `true` that VoiceDesign was
> genuinely warm-resident (phases observed end to end: `loading-model` →
> `designing` → `distilling` → `rendering` → `preview_ready`, a real persisted preview
> artifact). **While that design was mid-flight**, fired an ordinary chapter render for a
> *different* character on the Base 0.6B engine. Bullet 1 expects the render's synth call
> to **wait** for the design to finish. What actually happened: the render did **not**
> wait — it proceeded immediately, and failed:
>
> ```
> chapter_failed  errorCode: "vram-spill"
> "The GPU ran out of video memory (VRAM) mid-render — too many models were resident at once."
> ```
>
> This is a **third outcome the row didn't anticipate**: not "the render waits" (the hoped
> outcome) and not "the design fails" (the regression #2070 guards against) — instead the
> *render* fails, while the design completes normally in the background
> (`preview_ready` did land). Confirmed clean, not a raw crash: `/api/sidecar/health`
> immediately after showed `status: reachable`, `qwenLoaded: true`,
> `vramReservedMb: 5769` (under the 8585 MB card total) — the sidecar survived intact.
> **This needs a design decision, not just a fix**: should the capacity-admission layer
> (`SEG_CAPACITY_ADMISSION=1`) account for a warm VoiceDesign's footprint before admitting
> a new Base render (make the render wait, per the row's original expectation), or evict
> VoiceDesign to make room (trading the ~120s `QWEN_DESIGN_IDLE_TTL` warm-reuse win for
> render throughput)? Both are defensible; the choice affects real UX (an operator
> mid-cast-review who starts a chapter render). Bullet 2 (design completes normally) is
> confirmed; bullet 3 (wedged-design timeout) was not reached — a separate design attempt
> on an evidence-thin character (`unknown-male`, 2 lines, no rendered audio) hung
> indefinitely with `qwenDesignEverLoaded` never flipping true and no sidecar-side log
> activity at all, which is plausibly expected (no real audio to derive a reference clip
> from) rather than the timeout bug bullet 3 is about, but wasn't root-caused this round.

### A25 · ASR warm-reservation figure vs. a real resident `/transcribe` peak ([#2094](https://github.com/dudarenok-maker/Castwright/issues/2094)) · **`ASR_DEVICE=cuda`, single 8 GB card**

Unit tests (`test_footprints.py`, `test_transcribe_embed_admission.py`,
`test_asr_footprint_measurement.py`) pin that a resident ASR reservation now
books the separate `asr.warm` key (128 MB seed) instead of the cold `asr` key
(400 MB), that `admit()`/`reservation()` agree, and that the MEASUREMENT
mechanism itself (a device-wide free-memory delta via
`PlacementController._device_free_mb`, not the torch-allocator peak
CTranslate2 sits outside of) is real and correctly guarded against
contamination — all proven with a scripted `_device_free_mb` sequence, no
real allocator. Not yet observed: whether 128 MB is actually enough headroom
for a real resident Whisper `base`/int8_float16 forward's activation memory
on a contended card (too low → a real, avoidable `noCapacity` refusal that
this fix was supposed to eliminate), and whether the learned `asr.warm` p95
converges to something sane once real device-wide-free-memory observations
accumulate on a box that ISN'T contended by a foreign process (the one
contamination vector `ledger.engines_holding` can't see, since it only knows
this process's own reservations).

- With `ASR_DEVICE=cuda` and content-QA enabled (`SEG_ASR_ENABLED=1`), render
  a chapter so ASR loads and goes resident, then trigger several more
  `/transcribe` calls back-to-back (a re-record round is the natural trigger).
  Confirm none of them 503 `noCapacity` on a card that has genuine room.
- Watch `FootprintTable`'s learned `asr.warm` p95 settle after ≥5 real
  observations (`_FOOTPRINT_MIN_SAMPLES`) — record what it converges to, so
  the 128 MB seed can be revisited with evidence rather than left as a guess
  indefinitely. A sane figure (double digits to low hundreds of MB) confirms
  the measurement mechanism is producing real signal on a clean box; a
  suspiciously large one (hundreds of MB to GB) points at contamination the
  ledger-based guard couldn't see (a process outside this sidecar).
- The device-wide contamination question #2094's own filing raised is now
  PARTIALLY addressed (the ledger-based guard discards a reading when another
  SIDECAR engine holds a concurrent reservation) but not fully closed — a
  foreign, non-sidecar process on the same card remains invisible to it. This
  row is where that residual gets its first real evidence.

*Needs:* `ASR_DEVICE=cuda`, `SEG_ASR_ENABLED=1`, a real book render with
content-QA on, ideally on an UNCONTENDED card (no other process holding VRAM)
for the cleanest read. *Criteria:* the `asr.warm` seed comment in
`SEED_FOOTPRINTS_MB` and `_device_free_mb`'s docstring (`server/tts-sidecar/main.py`)
and `docs/local-llm.md`'s footprint table. *Cost:* short — rides along with
any other GPU-ASR session (A13 already needs `ASR_DEVICE=cuda`-adjacent
capacity behaviour; batch together).

> **PARTIALLY run 2026-08-26 (wave 6) — no refusals observed across two renders, but the
> ≥5-observation `asr.warm` p95 convergence (bullet 2) was not tracked.** With
> `ASR_DEVICE=cuda`, `SEG_ASR_ENABLED=1` and content-QA on, ASR went resident
> (`asrLoaded: true`) during a chapter render on an uncontended `cuda:0` and no
> `/transcribe` call 503'd `noCapacity` across two independent full-chapter renders (252
> lines each, ASR sampling every sentence per `SEG_ASR_SAMPLE_EVERY=1`) — bullet 1
> confirmed. Bullet 2 (watch `FootprintTable`'s learned `asr.warm` p95 settle and record
> what it converges to) and bullet 3 (the residual foreign-process contamination case)
> were not exercised — this round didn't read the sidecar's internal footprint state, only
> the absence of refusals. **Still owed:** re-run reading `asr.warm`'s learned value
> directly (via whatever internal endpoint or log line exposes `FootprintTable`) after
> ≥5 real `/transcribe` observations.

> **RUN 2026-08-26 (wave 7) — bullet 1 reconfirmed; bullet 2 answered, and the answer is
> "it structurally can't converge" — filed as [#2682](https://github.com/dudarenok-maker/Castwright/issues/2682).**
> Instrumented `FootprintTable.record` directly (temporary, reverted) and drove 15 direct
> `POST /transcribe` calls against a real resident `faster-whisper` `base`/`int8_float16`
> model — 8 with Qwen still co-resident on the same card (bullet-1 contamination-guard
> check), 7 with Qwen unloaded and nothing else resident (the clean read bullet 2 asks
> for). All 15 returned `200` — zero `noCapacity` refusals, reconfirming bullet 1 a
> second time. The 8 contaminated calls recorded `observed_mb=0` every time — expected,
> since `other_engines` (Qwen) was non-empty and the guard is designed to discard exactly
> that. The 7 CLEAN calls (no other engine resident, no foreign PID) *also* recorded
> `observed_mb=0` every single time — the device-wide free-memory delta the warm key is
> measured by never comes back positive for this model/precision combination, so the
> `<= 0` guard in `record()` silently discards every one of them regardless of
> contamination. **This means `asr.warm`'s learned p95 can never move off its 128 MB seed
> in practice** — not "hasn't converged yet," but structurally can't, because the
> instrument's own noise floor exceeds a `base`/`int8_float16` forward's actual VRAM
> delta. Bullet 3 (foreign non-sidecar contamination) is now moot as originally scoped —
> the measurement never accumulates a real sample to contaminate in the first place, on
> ANY box, clean or not. This needs a design decision, not a fix: leave the seed as a
> permanent floor (harmless if `128 MB` is already generous for this model), switch the
> warm-key instrument to something with a finer noise floor (e.g. the torch allocator's
> own peak, the way every other engine's key is measured), or accept and document that
> this key is unfalsifiable for small ASR models. Filed rather than fixed under the
> "needs a design pass" carve-out — more than one defensible fix exists and nothing here
> picks one.

### A26 · Catastrophic-WER override actually catches a real Coqui language-collapse ([#2055](https://github.com/dudarenok-maker/Castwright/issues/2055)) · **Coqui/XTTS resident, ASR content-QA on**

`classifyTranscript`'s new logic is fully pinned in
`server/src/tts/segment-asr-qa.test.ts` with injected transcripts/signals — a
FLUENT, full-length, catastrophically-wrong-content transcript (WER ≥
`Math.max(catastrophicWer, maxWer)`) now overrides the "untrustworthy →
inconclusive" backstop into `drift`, while a near-empty/filler-padded
transcript, a short (<6-word) reference, and a merely-imperfect transcript are
all unaffected — each shape independently mutation-verified, including a
Russian near-silence-hallucination repro (`"Продолжение следует"`) invisible
to the English-only `HALLUCINATION_PATTERNS` list. Not yet observed: whether
this actually fires on a REAL #2026-style Coqui language-collapse (fluent
audio, wrong language, plausible duration) without a real false-positive rate
that starts re-recording perfectly good lines — `CATASTROPHIC_WER` (default
0.85, now the live registry knob `qa.asr.catastrophicWer` — retunable from
this row's own findings without a release), the 6-word reference floor, and
the 0.5 heard/expected ratio floor are all judgement calls, not
on-box-measured constants.

- With ASR content-QA on (`SEG_ASR_ENABLED=1`) and a Russian (or French/
  Spanish) book on the Coqui engine, reproduce #2026's language-collapse per
  its own repro recipe (short Russian lines, repeated synthesis — intermittent,
  not every run). Confirm a genuine collapse now gets caught and re-recorded
  (segment carries `asr.verdict: drift`, reason mentioning "catastrophically
  wrong"), where before this fix it would have read `inconclusive` and shipped
  unflagged.
- Across the same render (or a longer, healthy-content one), confirm the new
  override does **not** fire on ordinary hard-to-transcribe-but-correct lines
  — an invented character name, a foreign phrase, background noise — i.e. no
  new false-positive re-record rate versus the pre-#2055 baseline.

*Needs:* a Coqui-capable sidecar, ASR content-QA enabled, a non-English book
(Russian ideal — matches #2026's own repro). *Criteria:* the `CATASTROPHIC_WER`
comment in `server/src/tts/segment-asr-qa.ts`; #2026's own repro recipe.
*Cost:* short-to-medium — the collapse is intermittent, so budget a few
repeated renders of the same short lines, not one pass.

### A27 · Sidecar auto-scaled RAM/VRAM recycle thresholds now actually apply on a fresh install (#2179, PR #2210) · **single 8 GB card is enough**

`.env.example` used to ship `SIDECAR_RESTART_MB=0` / `SIDECAR_VRAM_RECYCLE_SOFT_MB=0`
/ `SIDECAR_VRAM_RESTART_MB=0` as literal, active env assignments — and each of the
three threshold functions in `main.py` treats a **present** `0` (or any parseable
value) as an explicit override, not as "unset." Since #2179 comments the generated
`.env.example` block out instead of emitting it active, a fresh install now leaves
all three **absent**, so the sidecar self-computes 70% of total physical RAM (hard
restart), 90% of the resident card's total VRAM (soft recycle), and 98% of the
card's total VRAM (hard restart) — three lifecycle behaviours that were silently
disabled on every install that copied `.env.example` verbatim (Pinokio, and the
documented manual/`INSTALL.md` path) until this fix, and are now live. None of this
is exercised by any pytest/vitest suite — the three threshold functions are unit-
tested for their env-present/absent MATH, not for whether a real sidecar process
ever crosses a live threshold and actually exits/recycles.

- Confirm a fresh install (a `server/.env` written from the current
  `.env.example` — i.e. all three of `SIDECAR_RESTART_MB` /
  `SIDECAR_VRAM_RECYCLE_SOFT_MB` / `SIDECAR_VRAM_RESTART_MB` absent from the
  environment) computes and uses the auto thresholds at sidecar startup (70%
  of total RAM; 90%/98% of the resident card's total VRAM) rather than
  treating them as disabled.
- Drive committed RAM up toward the ~70% ceiling (a long multi-chapter run,
  or a synthetic host-memory hog alongside the sidecar) and confirm the
  sidecar self-exits with code 43 for the supervisor to respawn, rather than
  never recycling.
- Drive reserved VRAM up toward the 90% soft threshold and confirm `/health`
  sets `recycle_pending` and a clean chapter-boundary recycle fires (not a
  mid-chapter hard exit); then, on a card where the soft recycle didn't
  already relieve the pressure, continue up toward the 98% hard threshold
  and confirm the hard self-exit fires instead of an uncontrolled OOM.
- Watch for thrash: across an ordinary render, the auto thresholds must not
  fire routinely — a card sitting in the high-80s/90s% reserved as a normal
  batch peak (see the `_TORCH_ACTIVE_RESERVED_MB` torch-managed-card
  carve-out in `main.py`) should not trip a recycle storm now that the
  ceiling is live where it was previously inert.

*Needs:* a fresh install (or a `server/.env` with the three vars removed) so
the auto path is actually reached; the single 8 GB card is enough; a way to
push committed RAM/reserved VRAM toward the thresholds (a long render, or a
synthetic memory/VRAM hog run alongside it). *Criteria:*
`_mem_restart_threshold_mb` / `_vram_recycle_soft_threshold_mb` /
`_vram_restart_threshold_mb` in `server/tts-sidecar/main.py` (`:8265-8284`,
`:8154-8185`); the #2210 PR body and `0b0e7694`'s commit message record the
before/after values. *Cost:* short-to-medium — the VRAM-pressure legs need a
way to actually saturate the card, which may need a synthetic hog rather
than a real render.

---

### A28 · ORT marker — fresh NVIDIA bootstrap ([#2192](https://github.com/dudarenok-maker/Castwright/issues/2192), plan [282](../features/282-ort-pip-consistency-marker.md)) · **no GPU needed, sidecar venv only**

Design doc §On-box acceptance, criterion 1. A from-scratch `bootstrap-venv.mjs`
run on the nvidia profile is unit-tested at the seam
(`bootstrap-venv-helpers.test.ts`'s ordering assertions), but a real pip venv's
version string, real PEP-427 directory escaping, and a real `pip check`/Kokoro
provider report have never confirmed the write actually lands correctly on a
genuinely fresh box — every other row here starts from an already-bootstrapped
venv (self-heal) or a deliberately broken one (clobbered), neither of which
exercises `installForProfile`'s write branch on a first-ever install.

- Wipe (or freshly clone into) the sidecar venv and run a genuine from-scratch
  bootstrap on the nvidia profile — not an upgrade, not the boot-time self-heal.
- Inspect `site-packages` for `onnxruntime-<version>.dist-info` at the version
  `onnxruntime-gpu` actually installed.
- Run `pip check` — expect exit 0.
- Load Kokoro and confirm it reports `CUDAExecutionProvider`.

*Needs:* the existing NVIDIA dev box, willingness to rebuild the venv from
scratch. *Criteria:* design doc §On-box acceptance item 1; run sheet §3 in
`docs/testing/ort-marker-onbox-acceptance.md`.

> **Wave-3 step 2, 2026-08-20 — STILL OWED, blocker now fixed.** Ran a genuine from-scratch
> `bootstrap-venv.mjs` on the nvidia profile against a throwaway venv (live
> venv untouched, byte-verified). Marker present at the correct version
> (`INSTALLER: castwright-ort-marker`) and `pip check` exit 0 — both
> **DISCHARGED**. The third check — Kokoro reporting `CUDAExecutionProvider`
> — **failed**: `get_available_providers()` lists it, but constructing an
> inference session with it errors (`Error 126`) and silently falls back to
> CPU. Root cause was a box-level gap: this box has only CUDA 12.4 system-wide
> while `onnxruntime-gpu` 1.27 needed CUDA 13.x/cuDNN 9.x runtime libraries.
> This blocking dependency is now resolved by PR #2576, which re-pinned
> `ONNXRUNTIME_GPU_CONSTRAINT` to `>=1.26,<1.27` (CUDA-12 line). The row
> stays STILL OWED pending the GPU-provider re-check against the fixed pin;
> see evidence doc `docs/testing/onbox-wave3-results/step-2-ort-marker.md`.

> **Wave-4 step 8, 2026-08-21 — STILL OWED, re-run after #2534's fix landed.**
> Re-ran the Kokoro GPU-provider check against `onnxruntime-gpu` 1.26.0 (the
> version #2576's re-pin resolves to), commit `6e4eac6c0129b68e8ff47db7b1503f31344248ab`
> (now on `main` via `4bb738d2`). `get_available_providers()` still lists
> `CUDAExecutionProvider`, but actual `InferenceSession` construction — both
> directly and through `kokoro_onnx.Kokoro` — still falls back to
> `CPUExecutionProvider`. **This is not the #2534 defect recurring**: the
> root cause is now confirmed as a *different*, more specific gap —
> `onnxruntime-gpu` 1.26.0's own wheel metadata requires `nvidia-cudnn-cu12~=9.0`
> only via its optional `[cudnn]` extra, which `install-ort.mjs` never
> requests (and installs with `--no-deps` besides), so no cuDNN 9 runtime is
> ever placed anywhere onnxruntime's CUDA provider will find it. A `cudnn64_9.dll`
> exists on this box only bundled inside other packages' own directories
> (`torch/lib`, `ctranslate2`), which onnxruntime does not search — confirmed
> by adding `torch/lib` to the process DLL search path as a diagnostic, which
> did not fix it either. Zero discharges this run — see evidence doc
> `docs/testing/onbox-wave4-results/step-8-a39-a40-rerun.md`. **Follow-up filed:**
> [#2600](https://github.com/dudarenok-maker/Castwright/issues/2600) — `install-ort.mjs` never requests the cuDNN 12 runtime that
> `onnxruntime-gpu 1.26.x` requires for CUDA execution, leaving Kokoro to
> silently fall back to CPU (distinct from #2534, which fixed the CUDA-13-vs-12
> mismatch itself).

> **PR #2617 note (pass-4 review P1/P2/P3/P6) — what the next run must read, and
> what it is still assuming.** #2600's fix ships `main._preload_ort_cuda_dlls()`,
> called once at lifespan startup, which forces onnxruntime's own
> `preload_dlls(directory="")` to search `<venv>/Lib/site-packages/nvidia/<pkg>/bin`
> instead of `torch/lib`, and separately measures (via onnxruntime's own private
> `_get_nvidia_dll_paths`) how many of the expected DLLs actually sit there. It
> reports one of six outcomes, each with an `[ort-preload]` prefix in the
> sidecar log — **read these lines first**, before repeating the old "still
> CPU" dead end. Quoted below is the sidecar's own log text (an earlier version
> of this note quoted `RESULT: preloaded` / `RESULT: failed`, strings the
> sidecar never emits — those were a review harness's own shorthand, not
> anything logged; fixed at pass 4, P1):
> - `onnxruntime.preload_dlls() loaded the CUDA/cudnn/cublas/cufft DLLs; all N
>   expected files were found under nvidia/<pkg>/bin.` — every DLL genuinely
>   came from the directory this installer writes to.
> - `onnxruntime.preload_dlls() loaded the CUDA/cudnn/cublas/cufft DLLs, but
>   only N of M expected files were found under nvidia/<pkg>/bin -- the rest
>   resolved via preload_dlls()'s bare-name PATH fallback (...)` — a
>   **WARNING**. An empty capture from `preload_dlls()` only means every DLL
>   loaded from *somewhere* loadable — its second internal loop retries any
>   DLL missing from `nvidia/` by bare filename off `PATH` and prints nothing
>   either way (pass-4 finding P2). This line means some (or all) of the
>   twelve resolved off `PATH` — a system CUDA toolkit or torch's own bundled
>   copy — not from this installer's ~1.30 GB runtime. **This is the single
>   most diagnostic line available; do not read it as the same success as the
>   bullet above.**
> - `onnxruntime.preload_dlls() loaded the CUDA/cudnn/cublas/cufft DLLs from
>   somewhere loadable -- this onnxruntime build does not expose enough to
>   confirm...` — the installed onnxruntime is too old/different to expose
>   the private helper the count above needs; provenance is genuinely unknown,
>   not assumed nvidia/.
> - `onnxruntime.preload_dlls() ran but at least one CUDA/cuDNN DLL failed to
>   load (see lines above)` (also reached if `preload_dlls()` itself raised) —
>   at least one DLL never loaded from anywhere; the CUDA execution provider
>   may fall back to CPU. This was the observed live-venv shape at passes 2/3
>   (12 of 12 DLLs failed) — see the two DLLs named next.
> - `onnxruntime.preload_dlls() skipped its own DLL search because torch was
>   already imported` — the torch-early-return branch fired (gated only on
>   `"torch" in sys.modules`, unaffected by `directory=""`); torch's own bundled
>   DLLs are what the provider will find, the same torch/lib-only outcome this
>   row already recorded as not fixing the bug.
> - `onnxruntime.preload_dlls() ran but this onnxruntime build has no CUDA
>   support` / `onnxruntime <version> has no preload_dlls() (older build)` — a
>   non-NVIDIA `onnxruntime` build, or one too old to have the symbol at all.
>   Not expected on this row's nvidia profile — but a from-scratch bootstrap
>   whose swap silently left a stale/wrong `onnxruntime` package installed
>   would show up as exactly this line, which is why it belongs on this row's
>   checklist (pass-4 finding P6).
>
> **`get_available_providers()` listing `CUDAExecutionProvider` proves nothing**
> (wave-3/wave-4 both saw it list the provider while actual `InferenceSession`
> construction still fell back to CPU) — a real `InferenceSession` must be
> constructed and its **actual** provider recorded, same as wave-3/wave-4 did.
>
> **Named assumption, currently unverified on this box:** `install-ort.mjs`'s
> `extraRuntimeSteps` installs `nvidia-cudnn-cu12` and `nvidia-cublas-cu12` but
> deliberately **not** `nvidia-cufft-cu12` or `nvidia-cuda-runtime-cu12` — two
> of the four CUDA DLLs `preload_dlls()` asks for on Windows
> (`cufft64_11.dll`, `cudart64_12.dll`). The assumption is that this box's
> **system CUDA 12.4 toolkit** supplies those two via `PATH`, so onnxruntime's
> fallback bare-name `LoadLibrary` still finds them even though `nvidia/` does
> not carry them. The "N of M expected files found under nvidia/<pkg>/bin"
> warning bullet above is how to check this directly — if it names fewer than
> the full count, or the failure bullet names exactly `cufft64_11.dll` /
> `cudart64_12.dll`, that assumption is false on this box — the alternative is
> installing the `[cuda]` extras (`onnxruntime-gpu[cuda]` or the two packages
> directly), not a further cuDNN/cublas change.
> - **New process-wide coupling to also confirm (N11):** the preload
>   `ctypes.CDLL`s `nvidia/cublas/bin/cublas64_12.dll` (pip-resolved to
>   `12.8.5.5`) by full path at lifespan step 1, ahead of any lazy `import torch`
>   — so any later `LoadLibrary("cublas64_12.dll")` torch issues (Qwen, XTTS,
>   Whisper) binds to that already-loaded module instead of torch's own bundled
>   `12.8.4`. Same minor line, expected benign, but **unverified** — after this
>   preload lands, confirm Qwen / XTTS / Whisper still synthesise correctly on
>   this box, not just that Kokoro reports the right provider.

> **2026-08-23 re-run (Castwright#2621, wave-5 lineage) — STILL OWED, root cause
> now identified and it is NOT `install-ort.mjs`.** Re-ran against a fresh
> throwaway venv (live venv untouched, byte-verified before/after). Marker
> mechanics and `pip check` still **DISCHARGE** cleanly. Round 1 (fix as
> shipped) reproduced the `[ort-preload]` **failed** line — `cufft64_11.dll`
> and `cudart64_12.dll` could not load from anywhere — confirming the
> "N of M expected files found under nvidia/" warning bullet above: this box's
> system CUDA 12.4 toolkit does **not** supply those two DLLs via `PATH`, so the
> named assumption is false here. Round 2, installing the `[cuda]` extras
> (`nvidia-cuda-runtime-cu12`, `nvidia-cufft-cu12`, `nvidia-curand-cu12`,
> `nvidia-nvjitlink-cu12`) into the same throwaway venv, produced a clean
> `preload_dlls()` success — all 11 expected files resolved under
> `nvidia/<pkg>/bin`, confirming **hypothesis 2 fixes the DLL-search problem
> completely**. But Kokoro **still** fell back to CPU with this clean preload,
> silently (no `[ort-preload]` warning at load time). Isolated with a bare
> Python repro: a raw `onnxruntime.InferenceSession` with
> `providers=['CUDAExecutionProvider','CPUExecutionProvider']` genuinely runs on
> CUDA on this box once `preload_dlls()` has run — but `kokoro_onnx==0.5.0`'s
> own `Kokoro.__init__` auto-detects via
> `importlib.util.find_spec("onnxruntime-gpu")`, which is **always `None`**
> (the `onnxruntime-gpu` pip distribution installs into the `onnxruntime`
> import namespace, not a separately-importable `onnxruntime-gpu` module), so
> `kokoro_onnx` always constructs with `providers=["CPUExecutionProvider"]`
> explicitly — CUDA is never even offered to onnxruntime. `main.py`'s
> `KokoroEngine._ensure_loaded` tries passing `providers=` explicitly when
> `KOKORO_ORT_PROVIDERS` is set, but this installed `kokoro-onnx` version's
> `Kokoro.__init__` has no `providers` parameter — that call raises `TypeError`
> and falls back to the broken auto-detect path. **This is a third, distinct
> root cause from both #2534 and #2600**, inside `kokoro-onnx`'s own
> provider auto-detection, not `install-ort.mjs` or `preload_dlls()`. Per the
> fold brief: reported as a finding here, not fixed. Evidence:
> `docs/testing/onbox-wave5-results/step-ort-a-a37-a38.md`. Run by: claude
> (Castwright#2621).

### A29 · ORT marker — the reported bug: in-app Qwen3 install ([#2192](https://github.com/dudarenok-maker/Castwright/issues/2192), plan [282](../features/282-ort-pip-consistency-marker.md)) · **no GPU needed, sidecar venv only**

Design doc §On-box acceptance, criterion 2 — **this is #2192 itself**, the alpha
tester's exact scenario, with the app running. Every other row for this feature
proves a mechanism; this one is the acceptance criterion the issue was actually
filed against, and it has not been separately re-confirmed since the fix landed
(the self-heal proof in §5 exercises boot, not an in-app package install).

- Start the app normally (NVIDIA profile, a bootstrapped sidecar venv).
- From the app UI, install Qwen3 (Model Manager → the Qwen engine's Install
  action) — the exact step the original report describes failing.
- Confirm the install completes with **no** `WinError 5` / `Accès refusé` on any
  `.dll` under `site-packages/onnxruntime/capi/`.
- Load Kokoro afterward and confirm it still reports `CUDAExecutionProvider` — the
  install must not have silently swapped the GPU runtime for CPU en route.

*Needs:* the existing NVIDIA dev box, the app running. *Criteria:* design doc
§On-box acceptance item 2; run sheet §4 in
`docs/testing/ort-marker-onbox-acceptance.md`.

> **Wave-3 step 2, 2026-08-20 — STILL OWED, not run, blocker now fixed.** Needs the full app
> running plus a real click-through of Model Manager → Qwen → Install
> against a throwaway copy of the sidecar venv — scoped as its own session
> rather than rushed alongside A28/A30 in the same heartbeat. The blocker that
> prevented full discharge (the CUDA13/cuDNN9 gap A28 found) is now resolved by
> PR #2576, which re-pinned `ONNXRUNTIME_GPU_CONSTRAINT` to `>=1.26,<1.27`
> (CUDA-12 line). The row remains STILL OWED because neither the app-level test
> nor the Kokoro GPU-provider check have been re-run against the fixed pin; see
> evidence doc `docs/testing/onbox-wave3-results/step-2-ort-marker.md`.

> **Wave-4 step 8, 2026-08-21 — STILL OWED, GPU-provider sub-check re-run, in-app
> install still not attempted.** Re-ran only the shared Kokoro GPU-provider
> sub-check (this row's final check) against the #2534-fixed pin
> (`onnxruntime-gpu` 1.26.0, commit `6e4eac6c0129b68e8ff47db7b1503f31344248ab`,
> now on `main` via `4bb738d2`) — same procedure and result as A28 above:
> `get_available_providers()` reports `CUDAExecutionProvider`, actual session
> construction still falls back to CPU, root cause confirmed as the missing
> `nvidia-cudnn-cu12` `[cudnn]` extra, not a #2534 recurrence. Zero discharges;
> see evidence doc `docs/testing/onbox-wave4-results/step-8-a39-a40-rerun.md`.
> The in-app Qwen3 install click-through part of this row remains untouched —
> out of scope for this re-run (see #2561) — and would hit the same cuDNN gap
> on its own Kokoro-afterward check even once attempted.

> **Wave-4 step 5c, 2026-08-21 — STILL OWED, partially run.** The core #2192
> repro — clicking Install on Qwen3-TTS Base (0.6B) in Model Manager — ran
> genuinely in a real browser, against this worktree's own bootstrapped venv,
> and completed cleanly with **no `WinError 5`**. Screenshots captured. The
> follow-on check (confirm Kokoro still reports `CUDAExecutionProvider` after
> install) could **not** be validated: this box's TTS sidecar binds a single
> hardcoded `:9000` port shared across every worktree, another live agent
> lane already held it for the whole session, and `POST /api/sidecar/restart`
> 409'd as a result — a structural box-contention limitation this run,
> distinct from the already-filed #2534 CUDA13/cuDNN9 gap. Full evidence:
> `docs/testing/onbox-wave4-results/step-5c-a40.md`.

> **2026-08-23 (Castwright#2621, wave-5 lineage) — STILL OWED, blocked by
> box-wide sidecar port contention again.** Started this worktree's own app
> (frontend/API bound the assigned `5293`/`8200` ports, confirmed from the
> server's own log). At startup the server found another process already
> listening on the hardcoded `:9000` sidecar port and adopted it instead of
> spawning its own, so `SIDECAR_VENV_DIR` never took effect for the running
> app. That pre-existing sidecar (PID 7380, actively `ESTABLISHED` with a live
> client) was identified before assuming it was safe to use; per the standing
> rule against disrupting another agent's live process, the Install action was
> **not** clicked against it — only a read-only `GET /health` was run
> (`devices: {"kokoro":"cuda","coqui":"cuda","qwen":"cuda"}`, noted only as
> context that CUDA does work for some venv on this box). Neither the Qwen3
> install click-through nor the Kokoro-afterward check could be safely run
> this session — **not attempted, not failed**, same structural class as
> wave-4 step-5c and now a third piece of evidence for it. **Worth filing
> separately:** `server/src/tts/spawn-sidecar.ts`/`sidecar-owner.ts`'s
> hardcoded `9000` vs. `LOCAL_TTS_PORT`'s per-worktree value makes any two
> worktrees' apps unable to run isolated TTS sessions simultaneously. Evidence:
> `docs/testing/onbox-wave5-results/step-ort-a-a37-a38.md`. Run by: claude
> (Castwright#2621).

### A30 · The in-app upgrade path applies the marker on a real installed release ([#2192](https://github.com/dudarenok-maker/Castwright/issues/2192), plan [282](../features/282-ort-pip-consistency-marker.md)) · **no GPU needed, sidecar venv only; not one of the design doc's six criteria**

**Not in the design doc's §On-box acceptance table.** Filed anyway: Task 8 wired
`upgrade/apply.ts`'s `pipInstall` marker handling (delete before the first
`run(...)`, write as the function's last statement, delete-then-rethrow on a
failed swap step) with a new dependency-injection seam added specifically because
the real body had zero prior test coverage
(`server/src/upgrade/apply-ort-marker.test.ts`) — but real `spawn`, a real
`venvDir`, and a real packaged release directory have never driven it. A
genuinely different consumer of the same `planOrtSwap` output than
`bootstrap-venv.mjs` (A28), so that row passing proves nothing about this one.

- Take a real installed Castwright release (not the dev checkout — the packaged
  `release/` layout `upgrade/apply.ts` targets), on NVIDIA, with a marker already
  present from a prior bootstrap or self-heal.
- Trigger the in-app upgrade (Account → Check for updates → Install, or the
  equivalent CLI path) to a release whose sidecar requirements changed enough to
  re-run `pipInstall`.
- Confirm the marker is deleted before the overlay install fires, and rewritten
  (at the freshly-installed version) only after the swap steps succeed — inspect
  `onnxruntime-<version>.dist-info`'s METADATA before/after, or watch for its
  brief absence via a log/timestamp check if the window is too fast to catch by
  hand. Confirm `pip check` is clean afterward.
- If practical, force a swap-step failure (e.g. an interrupted network mid-swap)
  and confirm the marker is deleted rather than left lying about a runtime that
  was never reinstalled.

*Needs:* a real installed release directory (not a dev worktree) and a way to
trigger its upgrade path; the existing NVIDIA dev box otherwise. *Criteria:* the
delete-first/write-last ordering invariant in
`docs/features/282-ort-pip-consistency-marker.md`, and the `pipInstall` anchors in
the design doc's §Changed files; run sheet §9 in
`docs/testing/ort-marker-onbox-acceptance.md`.

> **Wave-3 step 2, 2026-08-20 — STILL OWED, not run.** Needs a real installed
> Castwright release directory (`release/` layout).
> `docs/testing/onbox-wave3-results/step-2-ort-marker.md`.

> **2026-08-23 (Castwright#2619) — STILL OWED, BLOCKED. No packaged release
> directory available on this box.** Checked exhaustively per `paths.ts`'s own
> definition of a real release (a `vX.Y.Z` directory under a `releases/`
> parent, produced by the packaging pipeline, not a git checkout): neither the
> primary checkout nor this worktree sits under a `releases/` ancestor; no
> `*astwright*` directory anywhere under `C:\`, `Program Files`, `Program Files
> (x86)`, or `%LOCALAPPDATA%\Programs`; no running Castwright/Electron process;
> no uninstall-registry entry. Per the issue's own instruction, did not
> manufacture a fake release directory (would require a release cut, out of
> scope and forbidden by standing rules) — a hand-assembled directory would
> not exercise the real `applyUpgrade` code path against real packaging
> output. Matches the standing conclusion on record since wave-3. Evidence:
> `docs/testing/onbox-wave5-results/step-ort-c-a40.md`. Run by: claude
> (Castwright#2619).

### A31 · Russian XTTS quality — leading-dash pause by ear, Coqui degeneracy guard live, neuter -ее invariant ([#2026](https://github.com/dudarenok-maker/Castwright/issues/2026), PR #2050) · **Coqui/XTTS resident, Russian text; no clone needed**

PR #2050 fixed one of #2026's three defects (the leading dialogue em-dash) and
deliberately shipped no register row here, because concurrent PR #2039 was
actively editing this same file (annotating the E-04 row above). #2039 merged
2026-08-01; this row is that deferred debt, tracked on
[#2057](https://github.com/dudarenok-maker/Castwright/issues/2057).

The complete criteria already exist in
`docs/testing/fs38-wave3-onbox-acceptance.md`'s `#2026 — additional acceptance
criteria: Russian XTTS quality` section and are **not** restated here —
summarised below.

- **Leading em-dash pause, by ear.** `softenDashes`
  (`server/src/tts/text-normalize.ts`) rewrites a leading `—` to `... ` on the
  theory a leading ellipsis pauses where a leading comma didn't. Pinned only
  as a wire-text transform (`text-normalize.test.ts`); never confirmed on real
  audio. Compare a line opening with `—` against the same line with no
  leading punctuation, and against an interior-dash sentence — the original
  issue's own reference points: **+0.14 s** for the leading dash (i.e. no
  audible pause) versus **+1.53 s** for an interior one.
- **`tts.coqui.degenGuard` live** (`_coqui_synth_is_degenerate`,
  `server/tts-sidecar/main.py`; registry key `server/src/config/registry.ts:736`).
  Pinned only by a scripted-fake pytest, never run against the real XTTS
  model. Observe (a) it does **not** false-positive on ordinary 2–3 word
  Russian lines at normal speaking pace — its 20 ms/speakable-char floor was
  reused verbatim from Qwen's own calibration and never independently
  measured for Coqui's actual healthy short-utterance duration; (b) if a live
  repro of the original collapse can be captured, whether the retry actually
  recovers it. **A negative on (b) may be correct behaviour, not a
  failure** — the guard's own docstring is explicit that it can only catch an
  implausibly SHORT render, and both historical collapses (`Хорошее олово.` →
  Finnish, `Тёплое море.` → English) were fluent, plausible-duration
  utterances outside its detection envelope.
- **Neuter `-ее` standing invariant.** No local fix was attempted — the
  mispronunciation is baked into the trained XTTS v2 checkpoint's own Russian
  G2P, not a text-preprocessing bug. Confirm it **still reproduces** on
  `main`, so a future `coqui-tts` upgrade has a baseline to check against.
  Not a sign-off. Pairs with #2056.

**Different mechanism from A26 (#2055) — do not merge with item 2 above.** A26
covers the server-side ASR/WER override `qa.asr.catastrophicWer` in
`classifyTranscript`; this row's item 2 is the sidecar-side duration heuristic
`tts.coqui.degenGuard`. Same symptom (a Russian line collapsing into another
language), different guard, different layer of the stack. These were
conflated once already during triage.

*Needs:* a Coqui-capable sidecar with XTTS resident, a Russian book or line
(no clone needed — every #2026 defect reproduces on the stock catalogue voice
`Damien Black`). *Criteria:* `docs/testing/fs38-wave3-onbox-acceptance.md`'s
`#2026 — additional acceptance criteria: Russian XTTS quality` section.
*Cost:* short — a handful of `/synthesize` probes plus one attempt at
reproducing the degenerate collapse.

### A32 · Named-entity decode reaches the TTS engine on a real EPUB ([#2310](https://github.com/dudarenok-maker/Castwright/issues/2310), plan [`docs/superpowers/plans/2026-08-13-entity-decode-layer.md`](../superpowers/plans/2026-08-13-entity-decode-layer.md)) · **single 8 GB card**

PR shipped `decodeNamedEntities` (`server/src/parsers/html-utils.ts`), widening
`stripHtml`/`extractFirstHeading`/`epub.ts`'s `decodeEntities` from a
five-entity hand-rolled list to the complete HTML5 named set. Every layer of
the fix is proved by unit and end-to-end tests fixing the sentence text
explicitly (`html-utils.test.ts`, `entity-dialogue-e2e.test.ts`) — what those
tests cannot prove is that a real, EPUB-sourced entity survives the whole
pipeline the same way. Design spec's own "What I could not establish": whether
the stage-2 analyzer model echoes a surviving entity into its returned
sentence text, which decides whether the *body-line* symptom reproduced at all
before this fix (a second thread observed, on a live run, that the current
model sometimes strips a leading dash rather than echoing it verbatim — that
would mean the body-path symptom already didn't reproduce pre-fix on today's
model, which is a finding about the analyzer, not a failure of this fix).

- **Lead with the chapter-title beat — the only criterion no model behaviour
  can mask** (design spec Finding 0). On an EPUB whose first chapter heading
  carries named entities (e.g. `<h1>L&rsquo;&Eacute;t&eacute;</h1>`), confirm
  the spoken title beat says "L'Été" cleanly — no "ampersand … semicolon", no
  gibberish.
- **Secondary: a Spanish, French, or Russian EPUB using `&mdash;`/`&ndash;` or
  accented named entities in body text.** Confirm a dash-opened dialogue line
  renders with a pause (not spoken "ampersand n dash semicolon" or similar),
  accented words render as the correct letters (not "e acute" spoken aloud),
  and the manuscript view shows real glyphs rather than raw entity text.
  **Record whether this symptom reproduced at all pre-fix** — per the design
  spec, that is itself new information about the analyzer chain, not a gate on
  this fix.
- No real es/fr/ru EPUB with named (as opposed to numeric) HTML entities was
  available in this workspace at design time — confirm one exists among the
  on-box corpus, or construct a minimal one from a real chapter with `&mdash;`
  hand-substituted for a literal dash, if none does.

*Needs:* a real EPUB (or a hand-modified one) carrying named HTML entities in
its heading and/or body, a working analyzer + TTS pipeline. *Criteria:* the
two bullets above. *Cost:* short — one import + one chapter-title listen, plus
one body-line listen if a suitable entity-laden EPUB is available.

### A33 · Kokoro's silent-CPU-fallback alarm actually fires on a genuine CUDA→CPU fallback, and stays quiet on a ledger-admitted CPU placement and under kokoro-onnx API drift ([#2647](https://github.com/dudarenok-maker/Castwright/issues/2647)) · **single 8 GB card, live Kokoro sidecar, `KOKORO_DEVICE` settable per run**

`_engine_actual_card`'s `fell_back` flag (#2631 review B3, the silent-CPU-fallback
badge behind `/health`'s `stale_reason: 'cpu_fallback'`) compared this load's
outcome against `_requested_device` — written once at `__init__` from the
`KOKORO_DEVICE` env pin and never touched again. On the shipped default (no
`KOKORO_DEVICE` set), that field reads `"auto"` forever, even for a load the
VRAM-ledger admission itself steered onto a concrete `cuda:N` for capacity
reasons — so `fell_back` could never be `True` on any default install, the
exact regression #2636 introduced. Fixed by comparing against `_device`
instead — this load's own intent, which an admitted `device=` argument
overwrites before the load runs. A companion fix makes `_resolved_device` use
`None`, not `"cpu"`, as its "not known yet" sentinel, so a kokoro-onnx
API-drift session-read failure reports an honest `unknown` card instead of a
confident false `cpu`. **Ratified behaviour decision:** when the VRAM ledger
deliberately admits a load onto CPU under contention while
`KOKORO_DEVICE=cuda:N`, `fell_back` stays `False` — admission is compliance
with a capacity decision, not a silent fallback; `/health`'s `devices.kokoro`
still reports the real session device either way, so the operator can always
see the CPU placement even when the alarm itself stays quiet. Unit tests pin
all three branches against synthetic engine doubles; none of them can prove
the alarm against a REAL ORT session, a REAL VRAM-ledger admission, or a REAL
kokoro-onnx import.

**#2643 follow-up (still unproven on real hardware, folded into this same
row rather than a new one):** the fix above compared intent against `_device`,
but nothing ever resolved the literal string `"auto"` into a concrete card
before that comparison — so on the SHIPPED DEFAULT, `fell_back` stayed dead
on every path that actually matters: `KokoroEngine.synthesize` (every real
generation), the `PRELOAD_KOKORO` warm-up path, and the admission-off
`/load` branch, none of which ever pass a `device=` argument or need
`KOKORO_DEVICE` set. #2643 resolves `"auto"` into the concrete device the
load is actually attempting (derived from the exact provider list about to
build the ORT session, so it cannot itself change placement) and publishes
that as intent. When no usable CUDA build/device exists, the resolved
intent is `cpu` — landing on cpu is then not a fallback, since nothing ever
asked for cuda. The fourth bullet below is the acceptance criterion specific
to this path; the first three bullets above only ever drove an explicit
`KOKORO_DEVICE` pin or a VRAM-ledger admission, neither of which the actual
regression lived on.

- With `KOKORO_DEVICE=cuda` (or `cuda:0`) and a card where the CUDA execution
  provider is *listed* by `get_available_providers()` but cannot actually
  construct a session — the same missing-`nvidia-cudnn-cu12` gap A28 already
  measured on this box is a ready-made way to force this — load Kokoro and
  confirm `/health`'s `gpus[].resident[]` entry for Kokoro carries
  `stale_reason: 'cpu_fallback'`, and `devices.kokoro` reads `cpu`. Kokoro has
  no torch ordinal (`index: None`), so this entry lands in `_build_gpus_payload`'s
  synthetic `idx: -1` bucket (`"unindexed (cpu / ORT / CT2)"`), not under one
  of the numbered GPU cards — look there, not in `gpus[<n>].resident[]`.
- With the card genuinely out of headroom (load Qwen and/or Coqui first to
  consume it) and `KOKORO_DEVICE` unset (default `auto`) or pinned to `cuda`,
  trigger a Kokoro load so the VRAM ledger's `admit()` genuinely returns a CPU
  placement. Confirm the resident entry for Kokoro carries **no**
  `stale_reason: 'cpu_fallback'` — the deliberate-admission case must stay
  quiet even though the outcome is the same CPU placement as the bullet
  above. **Positive control (this observation has no failure mode without
  one):** repeat with the card genuinely idle so `admit()` places Kokoro on
  the GPU instead — confirm the resident entry now carries the real GPU
  index (not the `-1` bucket) and still no `stale_reason`. A GPU-admitted
  load ALSO shows no `stale_reason`, so the CPU-admission bullet alone can't
  tell "admission correctly chose cpu" from "admission was never actually
  exercised, and Kokoro loaded some other way" — this control is what makes
  it a real test of the admission path rather than a no-op that always
  passes.
- Force the kokoro-onnx API-drift branch. **Not** "a `kokoro-onnx` install
  with no `Kokoro.from_session`" — verified against the installed package:
  `Kokoro.__init__` (the fallback `_ensure_loaded` takes when
  `from_session` is absent) ALSO always sets `self.sess =
  rt.InferenceSession(...)`, so `_kokoro_session_device` still reads a real
  session there and `/health` reports `cpu`/`cuda`, never `unknown` — that
  repro can't produce the observation this bullet asks for, and an operator
  running it would log a false PASS. `_kokoro_session_device`
  (`main.py`) only fails when the loaded Kokoro object's ORT session isn't
  reachable at its `.sess` attribute at all — the real drift shape is a
  kokoro-onnx release that renames or drops that attribute. Force it
  directly instead of depending on such a release being installed: after a
  normal Kokoro load, drop into the sidecar process (a Python breakpoint, or
  a one-line temporary edit to `_kokoro_session_device` that returns `None`
  unconditionally, reverted immediately after this bullet) and confirm
  `/health` then reports the Kokoro card as `unknown`, not `cpu`, and
  `fell_back` reads `False`.
- **(#2643) The actual real-generation path: `KOKORO_DEVICE` UNSET and no
  admission override** — i.e. a plain `POST /synthesize` (or letting
  `PRELOAD_KOKORO` warm Kokoro up) with nothing pinning a device at all. With
  the card genuinely CUDA-capable but forced onto CPU providers by the same
  missing-`nvidia-cudnn-cu12` gap A28 uses, trigger a real Kokoro synth and
  confirm `/health` now reports `stale_reason: 'cpu_fallback'` for Kokoro
  (before #2643 this stayed silent — `_device` never left the literal string
  `"auto"` on this exact path). **Negative control:** repeat on a box with no
  CUDA build/device at all (or `KOKORO_DEVICE=cpu`-shaped hardware) and
  confirm `fell_back` stays `False` — auto-resolution's own intent is `cpu`
  there, so a cpu landing is not a fallback.

*Needs:* a single 8 GB GPU, a live Kokoro-capable sidecar, and `KOKORO_DEVICE`
settable per run. *Criteria:* the four bullets above — no existing run sheet
covers this alarm-correctness surface specifically;
[`ort-marker-onbox-acceptance.md`](ort-marker-onbox-acceptance.md) covers the
neighbouring ORT-marker/GPU-provider mechanism (A28–A30) but not this
bookkeeping. *Cost:* short — one genuine-fallback load, one contended-admission
load, one drift simulation, one unpinned-auto load with its negative control.

> **PARTIALLY run 2026-08-27 (wave 8) — bullets 1, 3 (API-drift) and the #2643
> real-generation bullet confirmed; bullets 2/3's contended-vs-idle admission
> pair is not testable on this box.** With `KOKORO_DEVICE=cuda` and this box's
> real missing-`nvidia-cudnn-cu12` gap, loaded Kokoro and confirmed the exact
> shape: `/health`'s `gpus[idx:-1].resident[]` carried
> `{"engine":"kokoro","actual_card":null,"stale_reason":"cpu_fallback"}` —
> bullet 1 confirmed. Forced the kokoro-onnx API-drift branch by temporarily
> making `_kokoro_session_device` return `None` unconditionally (reverted
> immediately after, `git diff` confirmed clean): the resident entry then
> carried `actual_card: null` and **no** `stale_reason` key at all — the alarm
> declines to claim a confident-but-wrong `cpu_fallback` when session
> introspection is unavailable, matching the safety property this bullet
> asks for. Confirmed the **#2643 real-generation-path bullet** directly via
> a genuine `POST /synthesize` call (not just `/load`) with `KOKORO_DEVICE`
> unset: `stale_reason: 'cpu_fallback'` correctly appeared afterward. **Not
> testable on this box:** bullets 2 and 3 (deliberate VRAM-ledger admission
> onto CPU under contention vs. the positive-control genuine-GPU-placement
> case) and the #2643 negative control both need a box where Kokoro's CUDA
> execution provider can actually construct a session at least sometimes —
> on this hardware it cannot, ever, regardless of contention or idle state
> (same missing-DLL condition as bullet 1/A28), so "admission chose CPU
> deliberately" and "the engine can never place on GPU here" are
> indistinguishable. **Still owed:** bullets 2/3 and the negative control,
> on a box with a working `nvidia-cudnn-cu12` install.

---

### A34 · Cast/analysis `characterId` drift — #2584/#2570 wrong-direction retirement fix ([#2584](https://github.com/dudarenok-maker/Castwright/issues/2584), [#2040](https://github.com/dudarenok-maker/Castwright/issues/2040), PR [#2640](https://github.com/dudarenok-maker/Castwright/pull/2640)) · **real analyzer (local Ollama or Gemini), no TTS needed**

Wave 2's re-analysis (§7 rerun, A22/A23's sibling campaign) surfaced a
defect PR #2640 fixed at the code level across five rounds of review:
`stripEstablishedAsciiRewrites` (`server/src/analyzer/roster-dedup.ts`)
now strips a same-run dedup rewrite that retires an established ASCII cast
id in favour of a freshly-minted non-ASCII one, gated on a direct
name-equivalence check (`normaliseForMatch`, the same "same character by
name" comparator `remapFreshToPriorIds`/`mergeAnalysisResultWithExistingCast`
already use) between the established prior row and the fresh survivor it
would be retired in favour of — not on which dedup tier produced the entry,
which round 5 found is not a sound signal (a Tier-3 alias merge can produce
the identical id shape without ever passing through Tier-1). The fix is
proven unit-level (`roster-dedup.test.ts`) at all four of `analysis.ts`'s
call sites, but only 2 of those 4 are independently asserted at route level
by real `runMainAnalyzerJob`/`runSubsetAnalyzerJob` wiring tests in
`analysis.test.ts` — the two feeding `remapFreshToPriorIds`
(`cumulativeForRemap`, main-route and subset-route). The other 2
(`cumulative`, feeding `applyRewriteToPriorCast`) execute during the same
test runs but are not independently asserted: their effect is currently
masked by an unrelated mechanism, `refuseRetirementsOfLiveIds`
(`server/src/routes/analysis.ts`), so a revert of either of those two sites
to the bare `composeRewrites(...)` call (skipping the strip) still leaves
the whole `analysis.test.ts` suite green (verified during round 5). Nothing
in the suite runs the real analyzer against the real, already-corrupted
book — that needs live hardware.

- Re-analyse *Заказ Коалфолла*
  (`C:\AudiobookWorkspace\books\Castwright\Standalones\Заказ Коалфолла`) — a
  **full** manuscript re-analysis, not a subset/chapter retry — against its
  existing `cast-id-history.json`.
- Confirm the character's `cast.json` id comes back as `oduvan` (ASCII), not
  `одуван` (Cyrillic) — the defect's exact shape.
- If the raw analyzer output still mints a different id this run, confirm
  any recorded `cast-id-history.json` entry names the correct direction
  (fresh id superseded by the established one), not the reverse.

*Needs:* the real workspace above and a real analyzer (local Ollama or
Gemini) — no GPU/TTS sidecar required, since this is an analysis-only
defect. *Criteria:*
[`cast-id-drift-onbox-acceptance.md`](cast-id-drift-onbox-acceptance.md) §10.
*Cost:* short — one full re-analysis of an already-imported book.

> **RUN 2026-08-27 (wave 8) — real re-analysis performed; criterion NOT met,
> root cause understood.** Ran a genuine full re-analysis of *Заказ Коалфолла*
> against its existing `cast-id-history.json` (confirmed real via `.audiobook/
> *.json` mtimes, all rewritten together). Result: `cast.json` still resolves
> the smith character to `одуван` (Cyrillic), not `oduvan` (ASCII) — bullet 2
> not met. This is not a regression of PR #2640's fix: `stripEstablishedAsciiRewrites`
> only strips a rewrite that would retire an *established ASCII* id in favour
> of a fresh non-ASCII one — it has no path to repair a book whose established
> id was *already* Cyrillic before the fix shipped (this book's corruption
> dates to 2026-08-21, per the unchanged `oduvan`→`одуван` `supersededBy` entry
> and its untouched `recordedAtIso`/`recordedAtSeq`). The fresh analyzer run
> also proposed `одуван` again (matching the already-established id), so no
> retirement event ever fired for the fix's guard to intercept — bullet 3
> doesn't apply either (no *different* fresh id was minted this run). Did
> **not** attempt to hand-repair the real `cast.json`'s id to force the
> guarded precondition — a permission classifier correctly declined that
> real-workspace edit, and it wasn't worked around. **Still owed:** either
> re-run against a book whose established id is currently ASCII (to test the
> fix's actual guarantee — that a *future* corruption is stopped) or accept
> that this row's criterion, as worded, cannot be satisfied by an
> already-corrupted book and needs re-scoping to "does the fix stop a *new*
> corruption" rather than "does it repair an old one."

---

### A35 · Stranded VRAM after a chapter render — resident-model floor or genuine leak? ([#2656](https://github.com/dudarenok-maker/Castwright/issues/2656), successor to closed [#1976](https://github.com/dudarenok-maker/Castwright/issues/1976)/[#1996](https://github.com/dudarenok-maker/Castwright/issues/1996)) · **single or dual GPU box, real render**

The 2026-08-25 idle-gated measurement
(`docs/testing/1996-stranded-vram-measurement.md` @ `45b913ce`, on
`fix/sidecar-1996-idle-vram-measurement`, unmerged; PR [#2655](https://github.com/dudarenok-maker/Castwright/pull/2655)) found the ~5.45 GB
`allocated` after a chapter render is byte-identical across a confirmed-idle
21 s window, and `/debug/reclaim` recovers only 6.4% of `reserved` — neither
a self-heal, nor uncollected cache, nor fragmentation. **HOWEVER, the run's
measurement carried two instrument bugs that invalidated its conclusion:**
(1) the `/debug/memory` snapshot was missing a `base17_loaded` key, so it
could not see the Qwen 1.7B-Base model (which loads during cast-design phases
and has its own 120 s idle TTL, `QWEN_BASE17_IDLE_TTL`) — the run could have
had three resident models live, not two; (2) the idle-gate poll (`_inflight_synth`)
is blind to `/transcribe`/`/embed` activity (ASR), so the "confirmed-idle" 21 s
window may have overlapped live Whisper transcription, making it not truly idle.
Both bugs are now fixed on PR #2655 (commits d4aa7a6c and 42dddeb8). The corrected
reading says: at the idle point, `qwen.base_loaded=true` (Qwen Base 0.6B has
**no idle TTL** — button-driven, evicts only on explicit `/unload`),
`qwen.base17_loaded` was unobserved (now visible), and `whisper.model_loaded=true`
(120 s TTL, only 21 s elapsed). Because the run never captured what `allocated`
looks like *after* all three models are actually unloaded, it cannot rule out
a genuine leak sitting on top of the resident floor. Nothing in any existing log
or prior measurement attempt (including the original #1976 report, predating the
`/debug/memory` diagnostics) contains this reading — it does not exist yet at any
recorded point in this repo's history.

- Reproduce P2/P3 from the linked run sheet: render a chapter, confirm the
  box idle (poll `inflight_synth`, not a fixed wall-clock; note the poll is
  ASR-blind, so verify via logs that no `/transcribe`/`/embed` was active).
- **New step:** issue `POST /unload {qwen, base17}` and confirm/force both
  Whisper and Qwen 1.7B-Base past their respective idle TTLs (120 s each,
  `ASR_IDLE_TTL` and `QWEN_BASE17_IDLE_TTL`), then read `/debug/memory` again.
- Diff that post-unload `allocated`/`reserved` against the P3 baseline
  already on record for this box's device.
  - Drops to near-zero (matching Qwen Base 0.6B + Whisper + Qwen 1.7B-Base's
    known weight sizes) → the resident floor fully explains #1976's original
    "stranded" report; no lever ever needed, close #2656 as working-as-intended
    and correct #1976/#1996's language for the record.
  - Residual gap remains → that gap is a genuine leak, needs its own
    root-cause pass in the placement/eviction code.

*Needs:* a live sidecar with all three models potentially resident (Qwen Base 0.6B,
Qwen 1.7B-Base, Whisper), and the ability to force explicit `/unload` + TTL lapse
mid-session. *Criteria:* [#2656](https://github.com/dudarenok-maker/Castwright/issues/2656)
— extend `docs/testing/1996-stranded-vram-measurement.md`, don't replace it. *Cost:*
short — one idle render, explicit unloads for all three models, one reading.

> **PARTIALLY run 2026-08-27 (wave 8) — the post-unload diff this row asks
> for was taken, but only for one of the three models; still owed for the
> full three-way scenario.** In an isolated worktree workspace (not the real
> book — this row's mechanism is engine-agnostic), rendered a full 3-chapter
> fixture book via Qwen Base 0.6B with the box otherwise idle. Confirmed via
> `/debug/memory` a real resident footprint (`cuda:1` `allocated≈1974 MB`,
> `reserved≈2024 MB`, `qwen.base_loaded=true`) — but in THIS run only Qwen
> Base 0.6B was actually resident: `whisper.model_loaded=false` throughout
> (ASR is off by default, `SEG_ASR_ENABLED` unset in this worktree) and
> `qwen.base17_loaded=false` (the transient 1.7B-Base model used during
> voice design had already idled out before the render). Issued
> `POST /api/sidecar/unload {engine: qwen}` and re-read `/debug/memory`:
> `cuda:1` `allocated` dropped to **≈137 MB**, `reserved` to **≈192 MB** — a
> ~93% reduction, landing in the range of ordinary CUDA-context baseline
> overhead, not a multi-GB residual. **This is real evidence against a
> genuine per-model leak in the unload path itself** — explicit unload of the
> only thing that was loaded reclaims almost everything. **Still owed:** the
> row's actual scenario (Qwen Base 0.6B + Qwen 1.7B-Base + Whisper all
> resident together, as in the original #1976 report) — this run's simplified
> single-model case is suggestive but doesn't rule out a leak that only shows
> up with all three models' allocators interacting.

### A36 · Voice reassignment: a rebuilt audition centroid actually scores real audio, not just discards the stale one ([#1969](https://github.com/dudarenok-maker/Castwright/issues/1969), PR [#2402](https://github.com/dudarenok-maker/Castwright/pull/2402), [#2700](https://github.com/dudarenok-maker/Castwright/issues/2700)) · **Coqui/XTTS resident, real cloned voice with enough anchor-eligible audio to clear `MIN_DURATION_SEC`**

Split out 2026-08-27 from the just-discharged A34 (voice reassignment vs.
persisted audition centroid). That row's on-box run (reassigning Ivo to a
cloned voice) proved the first of the row's two criteria — a reassignment
discards the stale old-voice reference rather than silently reusing it,
confirmed via `matchesCurrentVoice()` returning false — but it hit
`referenceKind: "too-short"` in `resolveCharacterReference`
(`server/src/audio/render-integrity/aggregate.ts:266-273`) because Ivo's
cloned-voice sample was too short for `auditionCentroid()` to build a real
centroid. The row's second, still-unmet criterion: **a rebuilt reference,
not the failed flag, is what a real render produces** — i.e. the rebuild
must actually succeed and correctly score real audio, not merely be
attempted.

- Reassign a thin-on-anchors character to a new voice with **enough**
  anchor-eligible audio that `auditionCentroid()` returns a genuine
  `resolved` outcome (not `too-short`) for the new voice.
- Confirm the new centroid's `cleanMean`/`pSevere`/`pBand` are real
  (non-zero) values, distinct from the old voice's pre-reassignment values —
  a genuine rebuild, not a stale carry-over and not an absorbing `too-short`.
- Confirm a genuinely mismatched voice against that new centroid still
  triggers `voice-mismatch`/`severe`, and the correctly-assigned new voice
  does not.

*Needs:* a working TTS engine (Coqui/XTTS) + a real book + a cloned or
designed voice with a long enough sample to clear `MIN_DURATION_SEC` (3.0s
per synthesis group). *Criteria:* full text in [#2700](https://github.com/dudarenok-maker/Castwright/issues/2700).
*Cost:* short, opportunistic — rides along with any cloned-voice reassignment
test that happens to produce a long-enough sample.

> **PARTIALLY run 2026-08-29 (claude) — the first two criteria are met for
> real on real hardware; the third (mismatch detection in both directions)
> surfaced a genuine new defect and is NOT met.** Live Coqui/XTTS resident
> on-box (RTX 4070 8GB, `cuda:0`, DeepSpeed+fp16), no mocking: a throwaway
> fixture (`mkdtemp`, never the operator's book) gave a synthetic character
> only 2 in-book anchor vectors (well below `AUDITION_POOL_TARGET_N=6`, a
> genuine deficit of 4) plus 6 real evidence quotes (~30-45 words each,
> pulled from `the-coalfall-commission.md`) and a voice assignment to the
> real catalogue voice `Claribel Dervla`. Calling `scoreBook()` unmocked
> made real network calls to the live sidecar: 6 real XTTS renders (RTF
> ~0.58-0.68, all clearing `MIN_DURATION_SEC`), each embedded for real via
> `/embed` (ECAPA, 192-d). The 2 synthetic anchors were far enough from the
> real embeddings to trigger `buildCentroid`'s bimodal check, so
> `auditionCentroid` correctly ran its Phase B (anchors dropped, synthetic-
> only pool topped up and rebuilt) — itself a real exercise of a code path
> `aggregate-audition-pool-real.test.ts` never reaches.
> — **Criterion 1 MET:** persisted `referenceKind: "audition"`, not
> `"too-short"`.
> — **Criterion 2 MET:** real, non-placeholder, non-degenerate values —
> `cleanMean=0.9629`, `pSevere=0.9409`, `pBand=0.9446`, all finite, all
> distinct from the synthetic old-voice anchors (which scored `cosine ≈
> -0.004` to `-0.005` against the new centroid — correctly discarded as
> `voice-mismatch`/`severe`, confirming the stale reference is genuinely
> gone, not silently reused).
> — **Criterion 3 mismatch direction #1 (genuinely wrong voice) MET:** a
> real render of `Damien Black` (a clearly different catalogue voice)
> against the same text scored `cosine≈0.16-0.18` and was correctly flagged
> `voice-mismatch`/`severe` in two independent probes (a generic sentence
> and a book-register narrative line neither in the evidence pool).
> — **Criterion 3 mismatch direction #2 (correctly-assigned voice) NOT
> MET — new defect found:** a real render of the CORRECT voice
> (`Claribel Dervla`) against fresh text — tried twice, once with a short
> generic sentence (`cosine=0.928`) and once with a book-register narrative
> line matched in length/style to the evidence pool but not one of the 6
> quotes that built it (`cosine=0.934`) — **both scored `voice-mismatch`/
> `severe`**, i.e. a false positive on the very voice the character is
> actually cast to. Root cause: `pSevere`/`pBand` are the 6th/10th
> percentile of the pool's OWN cosines-to-centroid (`score.ts`), which for
> a synthetic-only Phase B pool of just 6 renders — all the same engine,
> same voice, same controlled acoustic conditions — clusters far tighter
> (severe/band boundary within ~0.02 of cleanMean) than the natural
> cosine variance of a genuinely-correct NEW render on different content.
> This is a sharper version of the already-documented "thin ~0.05-wide
> over-flag band for the tightest voices" calibration caveat in
> `score.ts` (Task 16, real in-book anchors), not a new mechanism — but it
> is worse here because the audition-only pool is both smaller (N=6) and
> more homogeneous (no real recording variance) than any in-book anchor
> set the calibration was tuned against.
> **Still owed:** this criterion, and — new — a decision on whether/how
> to widen the severity band for small, synthetic-only Phase B pools (a
> calibration/design question, not fixed here: the existing percentile
> mechanism isn't wrong on its own terms, it just wasn't validated against
> a pool this tight before). Recommend a follow-up issue scoped to that
> specifically before this row can close. Full log/observation detail
> (render RTFs, per-render text, raw cosines) is in this run's session
> record; no code was changed by this run — the fixture and probe scripts
> used were throwaway and were not committed.

### A37 · Russian dash-attributed dialogue — doubled-comma collapse pause by ear ([#2059](https://github.com/dudarenok-maker/Castwright/issues/2059), PR #2688) · **Coqui/XTTS resident, Russian text; no clone needed**

PR #2688 fixed `softenDashes` (`server/src/tts/text-normalize.ts`) producing a
doubled comma in dash-attributed Russian (also French/Spanish) dialogue, e.g.
`"— Привет, — сказал Антон."` previously carried a `,,` in the TTS wire text.
The collapse to a single comma is pinned only as a wire-text transform
(`text-normalize.test.ts`); never confirmed whether removing the doubled
comma changes the audible pause/prosody on real synthesized speech — same
open shape as A31's leading-dash-to-ellipsis case.

- **Doubled-comma collapse pause, by ear.** Render a dash-attributed line
  (e.g. `"— Привет, — сказал Антон."`) and confirm collapsing the doubled
  comma to one doesn't shorten or eliminate an audible pause the doubled
  comma was incidentally providing, and doesn't introduce a new artifact.

*Needs:* a Coqui-capable sidecar with XTTS resident, a Russian line (no
clone needed — the stock catalogue voice `Damien Black` reproduces this
shape). *Criteria:* the bullet above — [#2059](https://github.com/dudarenok-maker/Castwright/issues/2059)
itself has only this one dialogue shape and no separate run sheet (unlike
A31's). *Cost:* short — one or two renders of a Russian test sentence.

---

### A102 · CUDA self-test on real ORT session detects Kokoro CPU fallback ([#2582](https://github.com/dudarenok-maker/Castwright/issues/2582), PR [#2719](https://github.com/dudarenok-maker/Castwright/pull/2719)) · **single 8 GB card, live Kokoro sidecar with real ORT session**

PR #2719's `_cuda_selftest_or_warn` method (`server/tts-sidecar/main.py`) inspects
the real ORT `InferenceSession` returned by Kokoro's first load and checks whether
CUDA was requested but the session landed on CPU instead. The verification result
(`cuda_verified`, `cuda_verification_detail`) rides the existing `_ensure_loaded`
load at the `from_session` code path and is surfaced through `/health` →
`/api/info` → the device-panel amber warning in the UI. Unit tests mock
`InferenceSession` and cannot prove the mechanism against a genuine CUDA→CPU
degradation on real hardware.

- **Self-test fires at the real load boundary.** On first Kokoro load via the
  real `_ensure_loaded`/`from_session` path (during a chapter render or
  `PRELOAD_KOKORO` warm-up), confirm `/health`'s top-level `cuda_verified`
  field is populated with one of three values: `true` (CUDA was requested and
  landed), `false` (CUDA was requested but landed on CPU), or `null` (CUDA was
  not requested for this load).
- **CUDA fallback detection on real CUDA unavailability.** Force a real CUDA→CPU
  fallback using the same missing-`nvidia-cudnn-cu12` gap A33 and A28 already use
  to force CPU-only providers. Load Kokoro and confirm `/health`'s
  `cuda_verified === false` (CUDA was requested but did not land), the log shows
  the warning *"Kokoro CUDA self-test: CUDAExecutionProvider was requested but did
  not land …"* (Castwright#2709), and `/api/info`'s `cudaVerified` field reads
  `false`. Confirm the device-panel UI renders the amber warning *"GPU
  acceleration was configured for Kokoro, but it's running on CPU instead."*
- **Silent verification when CUDA genuinely succeeds.** On a box with working
  CUDA support, load Kokoro and confirm `/health`'s `cuda_verified === true`
  (CUDA was requested and landed), that the log contains NO CUDA self-test
  warning message, and the device-panel warning stays absent. When CUDA was not
  requested for the load, `/health`'s `cuda_verified === null`; this is not a
  failure state and no warning should appear.

*Needs:* a single 8 GB GPU, a live Kokoro-capable sidecar, and a real ORT
session accessible during `_ensure_loaded`. *Criteria:* the three bullets above —
no separate run sheet; mechanism is integrated into Kokoro's existing health
reporting. *Cost:* short — one Kokoro load with CPU-forced providers, one with
CUDA working (or default unforced), and UI verification.

### A104 · Analyzer GPU-split warning fires (and stays silent) correctly on real nvidia-smi output ([#2367](https://github.com/dudarenok-maker/Castwright/issues/2367)) · **two NVIDIA GPUs of different sizes** · PR #2753

`detectOllamaGpuSplit()` (`server/src/gpu/ollama-gpu-split.ts`) shells out to
real `nvidia-smi --query-compute-apps`/`--query-gpu` and every automated test
here mocks `execFile`, so none of it has run against a real two-GPU box. Same
open shape as the rest of this register: the parse/threshold logic is pinned
in isolation, but never against genuine multi-GPU `nvidia-smi` output.

- **PREREQUISITE:** First confirm on this box whether `nvidia-smi --query-compute-apps=gpu_uuid,pid,process_name,used_memory --format=csv` returns numeric values for `used_memory` (alongside the readable `process_name` field) or `[N/A]`/`[Not Supported]` under this GPU's driver model (WDDM on Windows). If `[N/A]`, the `dataUnavailable` code path should be exercised separately instead of a real split/no-split result — until the WDDM question is settled, 'no warning fired' is not evidence of anything.
- Load a model on Ollama that is oversized for one card but fits the combined
  VRAM of both, so Ollama itself splits it across GPUs. Confirm
  `detectOllamaGpuSplit()` reports `split: true` with the correct
  `deviceIndices`, and `wouldFitSingleDevice: true`.
- Confirm the server log warns exactly once for that split's device
  signature (`server/src/analyzer/ollama.ts`), and does not repeat on
  subsequent analyzer calls with the same signature.
- Confirm the Advanced Configuration "Analyzer (Ollama) device" row
  (`src/views/advanced.tsx`) shows the matching generic-split warning line: "Model split across GPUs [indices] despite fitting on one device".
- Repeat with a model that is genuinely too big to fit on any single card
  (`wouldFitSingleDevice: false`) and confirm NO warning fires anywhere —
  server log or UI.
- With `analyzer.ollama.expectedDevice` set to a GPU index that contradicts
  the real single-device placement, confirm the server logs the mismatch
  exactly once per distinct expected/detected pair: `[ollama] analyzer GPU
  device mismatch: expected GPU N, detected on GPU M`. Confirm the UI shows
  the single-device mismatch wording: "Analyzer model is on GPU M — expected GPU N
  only" (distinct from the split-case wording above). Repeat with
  `expectedDevice` contradicting a split (model is split across multiple
  GPUs but expected on a different one) and confirm the server logs the
  mismatch and the UI shows the split-mismatch wording: "Model split across
  GPUs [indices] — expected GPU N only".

*Needs:* two NVIDIA GPUs of different sizes, a local Ollama daemon, and a
model sized to force a genuine split. *Criteria:* Castwright#2734 (the
verify child for this chain) checklist item 6; the four task briefs under
#2367 for the exact behaviour each piece owns. *Cost:* short — one oversized
load that splits, one genuinely-too-big load that doesn't, one
`expectedDevice` mismatch check.

## Group B — local Ollama analyzer only

<!-- next-id: B101 -->

A real Ollama daemon and a long (~110k-char) chapter. No TTS engine resident. B1 has a **CPU-only sub-case** — the only check here that wants the analyzer *off* the GPU (the analogous B2-step-7 CPU-only case retired to "Blocked — hardware not available" this wave). Consider folding in E4.

### B1 · Analysing view honesty for local analyzers (plan 216)

Six steps (`:124-142`). A per-phase Gemini recitation-block falls back to local Qwen
with chip, swap, ticker and log all agreeing · a ~110k-char chapter's ETA reads
realistic minutes and **tightens within ~10s** of streaming, not at chapter-end · a
dense single-paragraph chapter that used to hard-fail with "truncated the response
(length)" now completes · **CPU-only:** the first-chapter ETA seeds slow (~15 chars/s)
rather than assuming GPU speed · `LiveChapterTicker` renders every in-flight chapter
at K=4 with a monotonic per-phase bar.

> **Wave-3 step 5, 2026-08-20 — STILL OWED, not run.** Blocked on two
> verified preconditions this worktree does not have: no `GEMINI_API_KEY`
> (step 1 needs a genuine Gemini recitation-block → Qwen fallback; the
> worktree's own `.env` deliberately carries no secrets) and no ready-made
> ~110k-char / dense-single-paragraph fixture (steps 2-4's fixtures are both
> far short — 15.6k/6.2k chars — and the isolated workspace is empty).
> Nothing attempted beyond confirming these blockers. Re-resolution note:
> step 5 (`LiveChapterTicker` at K=4) is itself browser/visual-shaped, worth
> flagging back as a partial exception to this row's blanket
> "agent-runnable" framing. `docs/testing/onbox-wave3-results/step-5-group-b.md`.
>
> **Correction, 2026-08-21 — both stated blockers above are wrong; the real
> blocker is narrower.** The repo owner confirms: (1) "no `GEMINI_API_KEY`"
> was a **worktree-isolation artifact, not a missing precondition** —
> worktrees deliberately carry no secrets by design, and the key exists in
> the primary checkout where this row should actually run; (2) "no
> ready-made ~110k-char/dense-single-paragraph fixture" is false and
> backwards — ***Ночной дозор*** (Night Watch) carries a paragraph of exactly
> that size and is in fact **the book the original issue came from**. This
> row's real remaining blocker: **step 5 (`LiveChapterTicker` at K=4) is
> browser-shaped**, not agent-runnable, and belongs with the operator packs —
> added to `docs/testing/onbox-sitting-device-browser.md`'s row list (see
> that pack's own minute-total correction). **Also:** this row's criteria
> predate recent paragraph-separation/turn-taking-attribution fixes (most
> recently PR #2518, "stop the tag-clause guard eating a colon-introduced
> turn", merged 2026-08-20, design in #2426/#2334) and **must be re-derived
> against current `main` before this row is run** — a run against the
> criteria as currently written would not be trustworthy. Re-derivation is
> itself owed, not attempted here.

### B2 · An unset book hits the analysis language gate, the prompt resolves it, and analysis then selects the right conventions table (#2246, [design](../superpowers/specs/2026-08-13-language-recurrence-and-prompt-design.md), [plan](../superpowers/plans/2026-08-13-language-recurrence-and-prompt.md))

`resolveBookLanguageForManuscript` (`routes/analysis.ts:3160-3167`, the
design's site 1) is the 25,063-line path the design gives its own
three-point treatment: the gate now lives in the POST handler before the
analysis job detaches (a returnable `409`), the `located === null`
(pre-confirm, no book on disk) branch still resolves `'en'`, and the in-loop
path — if a book's language is cleared after the job starts — emits an SSE
`error` with `code: 'language_unset'` via `classifyAnalysisFailure`. Unit
tests cover the gate against a mocked analyzer and a mocked
`conventionsFor`. What they cannot prove is the full loop on a real book:
that the `409` (or the confirm-screen "Decide later" / library "unset"
affordance) actually surfaces to a user driving a real import, that setting
the language through the resulting prompt actually unblocks the same book's
analysis, and that the analyzer then picks
`conventionsFor(<the set language>).quotePairs` rather than the English
default — i.e. that a Russian (or other non-`'en'`) book's dash-opened
dialogue is recognised as dialogue rather than narration once the language
is set, which only a live analyzer run can show.

- Produce a book with `language: null` on disk (import with detection
  surrendered and "Decide later", or a bundle/restore/sample path that
  leaves it unset).
- Start analysis against it through the normal UI/API path; confirm the
  request is refused with the `language_unset` shape (`409` pre-detach)
  rather than silently analysing as English.
- Resolve the language through the prompt (library "unset" badge → Book
  settings row, or the confirm-screen re-entry), then re-start analysis on
  the same book against a live local analyzer.
- Confirm the analyzer's conventions table matches the language just set —
  for a non-`'en'` language with a `dialogueOpen` marker (e.g. Russian),
  confirm dash-opened dialogue lines are attributed as dialogue rather than
  falling to the narrator, the same distinction #2325's dialogue-collapse
  guard measures.

*Needs:* a real local Ollama (or Gemini) analyzer; no TTS/GPU rendering
required. *Criteria:*
[`language-recurrence-onbox-acceptance.md`](language-recurrence-onbox-acceptance.md)
§Analysis language gate. *Cost:* short — one import left unset, one refused
analysis attempt, one prompt resolution, one real analysis run on a short
chapter.

---

## Group C — one *Ночной дозор* re-analysis session

<!-- next-id: C101 -->

**Four rows.** The **local pass ran 2026-08-06** by Claude Code on the dual-GPU
box — 9 chapters, **15,069 sentences**, `qwen36-cw-iq4-32k` via local Ollama,
structure engine on, `analyzer.structure.escalation = 'local'`, no mock mode —
and discharged **C1** (plan 261, scene separators) and **C2** (plan 247, srv-59
attribution). Results are recorded in each plan's acceptance section, and the
headline finding is filed as
[#2187](https://github.com/dudarenok-maker/Castwright/issues/2187).

In short: **C1 passed** (24 separators, 22 flagged, median separator→opener
distance 5 chars — the `* * *` glyph itself; the ~92k forward-overshoot is
mechanically gone). **C2's targets were missed** (flagged 6,568 vs ≤~500) because
chapters 5–8 fell below the hardcoded 80% alignment floor and degraded to
flag-only; chapter 9, which aligned at 95%, ran the full engine and landed
flagged=**488, under target**. The aligner — not the engine — is the bottleneck.

Since then the #2187 aligner fix landed, adding a **new C2** — one more local
re-analysis to confirm plan 247's targets end to end — and #2253's convention
invariant added a third row. **Both ran 2026-08-12/13 and are discharged**; see
below. (Under the pre-#2599 positional-ID rule, row IDs renumbered on
discharge, so a given ID named several different rows over this group's life.
The C2 discharged in the paragraph above was the srv-59 attribution row; the
C2 discharged in the paragraph below is the post-#2187 one; the C2 that
remains is what was C3. IDs have been stable and never reused since
2026-08-27 — this paragraph is a record of the group's history under the old
rule, not current behaviour.)

**The 2026-08-12/13 run — 9/9 chapters, and it discharged two rows at once.**
Throwaway `mns_rKjCHx0vrS`, build `52a8fb97`, local Ollama `qwen36-cw-iq4-32k`,
structure engine on, `allowCloudFallback: false`, **12 h 27 m** of compute across
an overnight pause. Full per-chapter figures and the seven run-sheet gaps it
exposed are in
[`night-watch-reanalysis-onbox-acceptance.md`](night-watch-reanalysis-onbox-acceptance.md)
§4. Headline outcomes:

- **Escalation executes on all nine chapters** — the post-#2187 C2's principal
  owed item, and the thing offline replay explicitly could not prove. 61 windows
  attempted, 21 lines applied. **Discharged.**
- **Wall-clock missed target 5 by ~2.5–6×** — 12 h 27 m against +2–5 h. Cause
  identified, so this is a recorded outcome rather than a re-run: the 16 GB model
  does not fit the 5070 Ti's 14.2 GiB usable, and ~5 GB spilled over PCIe for the
  whole run. Re-testing needs different hardware or a smaller quantisation.
- **The bucket split is live** — `unresolved` populated on every chapter (670
  book-wide), `flagged` 0 throughout, i.e. under its bar rather than over it.
- **But the end-to-end outcome criterion FAILED**: 87.4% of dash-opening dialogue
  was attributed to `narrator` (4131/4725) against a 30.3% baseline. The
  dialogue-structure engine is **exonerated** by replay — today's engine over the
  2026-08-06 cached stage-2 output reproduces 30.4% — so the cause is upstream,
  filed as [#2306](https://github.com/dudarenok-maker/Castwright/issues/2306).
  That is why the row below survives with narrowed scope instead of discharging.

The cloud row remains (**C1** since the other two were discharged and the
survivors renumbered under the pre-#2599 rule; it was C3 before 2026-08-06 and
is referenced under that ID in
[#1685](https://github.com/dudarenok-maker/Castwright/issues/1685) — GitHub
issue bodies are not in `git ls-files`, so no checker here sees them, and
stable IDs stop *new* rot without reaching that existing one). It needs the
separate **cloud** pass, which the local run did not exercise. No TTS or GPU
synthesis.

Book: `C:\AudiobookWorkspace\books\Сергей Лукьяненко\The Night Watch Tetralogy\Ночной дозор`.

> **Hold the full 12-hour re-run — the in-flight speaker-separation work**
> ([#2288](https://github.com/dudarenok-maker/Castwright/issues/2288),
> [#2279](https://github.com/dudarenok-maker/Castwright/issues/2279)) **changes dialogue
> segmentation**, so a pass taken before it lands measures a moving target and has to
> be repeated. Wait for it, then take C2 and C3 in one session.
>
> **#2306's cause is still NOT identified (2026-08-13).** A strong candidate was
> raised and then refuted by measurement, and both halves are recorded here so it
> is not raised a third time.
>
> The candidate: this run was driven over the API and its confirm payload carries
> no `language` field (`book-req3.json`, on disk), so the book persisted as
> `state.language = "en"` while `POST /import` had detected `ru` seconds earlier.
> Marked `en` a book gets no `languagePreamble`, and
> `conventionsFor('en').dialogueOpen` is `null`, which makes the #2253 convention
> invariant inert. The correlation is real and verified — the 2026-08-06 book that
> attributed well is `ru`; the 2026-08-12 book that collapsed is `en`, same
> manuscript and same engine.
>
> **The mechanism does not survive testing.** Replaying the captured ch3 chunk-1
> prompt varying ONLY `StageCall.language` gives 0.0% narrated on both `ru` and
> `en`; pushing the captured raw model output through `crossExamine` with
> `dialogueOpen: undefined` (the `en` configuration) gives 5.6%, against a
> recorded 94.8%. Neither path reproduces the collapse. Every `en` book was
> created by the same harness in the same sessions as the collapsed runs, so
> `state.language` may be a marker of provenance rather than the operative
> difference.
>
> The language default is fixed anyway (#2335) — stamping a Russian book English
> is wrong on its own terms — but it is **not** recorded here as #2306's cause.
>
> The earlier roster-reconcile hypothesis is also withdrawn: the run's own logs
> record zero demotions on that path, and controlled replays of the real chunker
> attribute the collapsed chapter at 0.5%. It remains a latent hazard that did
> not fire here.
>
> **Preserve `server/handoff/outbox/*-stage2-ch*.json` before tearing down a run's
> checkout** — #2324 now numbers each call's forensics, so a chunked chapter no
> longer overwrites its own prompts and responses as it runs (which is why only
> last chunks survived this one).

### C1 · Free-tier Gemma cloud pass completes end to end ([#1685](https://github.com/dudarenok-maker/Castwright/issues/1685))

**Narrowed 2026-08-13 from three items to one** — see
[#1685](https://github.com/dudarenok-maker/Castwright/issues/1685#issuecomment-5274602285)
for the full reasoning. Two items came out:

- **429 classification — already covered offline.** `gemini.test.ts` carries four
  tests over this exact behaviour against the real payload shapes, including both
  historical misclassifications: the #1682 case (`free_tier` in the metric name
  matching the daily marker, `:551`) and the #1695 case (the free tier's 15-req/min
  cap colliding with a `\d{1,3}` heuristic, `:583`). The latter asserts the call
  happened **twice** — it proves the retry, not merely the absence of a throw. A
  live run would only detect fixture drift in those payloads, which is a far weaker
  claim than the item made.
- **`localInputFraction` calibration — obsolete.** The shipped `0.3` produced
  **one** stage-2 truncation across nine chapters of the hardest book available;
  truncation already *recovers* via the adaptive re-split (`stage2-chunk.ts`, #528)
  rather than dropping, so the knob is prevention for a cured failure; and lowering
  it means smaller chunks, more calls, longer wall-clock — pushing the wrong way on
  the one target that just missed by 2.5–6×. The value is per-model and
  per-`num_ctx` besides, so it would not survive the next model.

**What remains** is the systems property no unit test reaches: re-analyze end to end
on `gemma-4-31b-it` — **including the script-review pass**, the one that actually
429'd in the original incident (all 22 logged failures were `task: script-review`) —
and confirm the book **completes** with no dropped chapters and no hang under real
throttling, with the limiter, the retries and the fallback interacting over hours.
Uses the free-tier `GEMINI_API_KEY` **already configured** in `server/.env` — a
credential this run exercises, not a blocker.

**Its remaining draw is that it doubles as the cloud arm of
[#2306](https://github.com/dudarenok-maker/Castwright/issues/2306)'s control** — and
with #2306's cause still open and the **stage-2 output** now the leading suspect,
that A/B is the sharpest test available rather than a spare one. Two candidates have
been eliminated offline (`isConventionRescue`'s roster gate moves 0.1 points;
`reconcileSentenceCharacterIds`'s demotion is potent at 38.0% → 76.3% but logged
**zero** demotions in the actual run), which is what promoted the A/B back up.

**Two things the 2026-08-06 local pass established for this row, before anyone
sets it up again:**

- **`gemini-*` really does RECITATION-block this book — observed, not inherited.**
  Mid-run, a queued Ollama call timed out into the cloud fallback and
  `gemini-3.5-flash-lite` returned `PROHIBITED_CONTENT` on a stage-2 chapter-1
  section. That is exactly why this row specifies `gemma-4-31b-it`.
- **`server/.env` sets `GEMINI_MODEL=gemini-3.5-flash-lite`, which overrides the
  RECITATION-safe code default.** The last-resort fallback in `analyzer/index.ts`
  and `routes/analysis.ts` is already `gemma-4-31b-it`, so it is the `.env` line —
  not the code — that must change for this row, or the pass silently runs on the
  wrong model and dies on the filter.

**Run it against a throwaway re-import, not the library book.** The analysis cache
is keyed by `manuscriptId` only (`server/src/store/analysis-cache.ts` header), so
re-analyzing the existing entry would overwrite the qwen36 sentences, `cast.json`
and `state.json` that the 2026-08-06 pass produced and that the owner is keeping
for cast + generation.

> **Wave-3 step 6, 2026-08-20 — STILL OWED, not run.** Blocked on a
> genuinely missing credential: this worktree's `server/.env` has no
> `GEMINI_API_KEY` and no other channel (shell env, secrets store) supplied
> one. The primary checkout's `server/.env` was deliberately **not** read,
> opened, or copied at any point (a named secret-leak shape, #2345) — the
> honest outcome when no channel supplies the key is to record this row as
> still owed, not to route around the isolation. Nothing in the row's
> remaining scope was narrowed or dropped.
> `docs/testing/onbox-wave3-results/step-6-group-c.md`.
>
> **Correction, 2026-08-21.** The wave-3 note above is wrong to call this row
> "blocked on a missing `GEMINI_API_KEY`" — the row's own text a few
> paragraphs above already says the key is "already configured in
> `server/.env` — a credential this run exercises, not a blocker." The
> wave-3 agent ran inside an isolated worktree whose `.env` deliberately
> carries no secrets and mistook its own local absence for a property of the
> row (the same class of error B1's 2026-08-21 correction names). C1 is
> STILL OWED because the multi-hour cloud re-analysis has not been run — not
> because of a missing credential; the credential exists and the row is
> runnable at any time in an environment that has it (i.e. not an isolated
> worktree). The 2026-08-20 blocker note was a worktree-isolation artifact,
> not a property of the row. The #2345 caution above about not copying
> `server/.env` into worktrees stays correct — only the "therefore blocked"
> conclusion was wrong. **Cross-check against the recent paragraph-
> separation/turn-attribution fixes (PR #2518 etc., flagged for B1):**
> whether these change what C1's cloud re-analysis measures, given C1 is
> described as "partly the cloud arm of #2306's control," could not be
> determined from this row's own criteria text alone — flagged here as
> itself unresolved, for a human to check, rather than guessed at.

### C2 · Dialogue-convention invariant end to end ([#2253](https://github.com/dudarenok-maker/Castwright/issues/2253))

**Partially discharged 2026-08-13** — see the run summary above. Two of this
row's four criteria passed on the live run and do **not** need re-running:
`unresolved` is populated per chapter, and `flagged` sits under its bar, so the
bucket split reaches a real stage-2 output. Escalation's behaviour under the
split was also observed. What follows is the narrowed remainder.

**What is already proven, and does NOT need re-running:** the fix itself, at
corpus scale. Two offline replays over the 2026-08-06 cache
(`server/handoff/cache/replay-experiment.mts`, gitignored, throwaway) measured
`HARM TOTAL victims=41` — down from the pre-fix baseline's 879, not to 0,
because the rescue guard now also requires roster membership and 41 lines
(`борис-игнатьевич` ×17, `егор` ×24) carry off-roster ids that
`reconcileSentenceCharacterIds` demotes to `narrator` downstream regardless,
so they were never actually recoverable — at both the production 80%
alignment floor and forced to 100%, and all 17 workspace-book
structure hashes unchanged (parser untouched, confirmed by construction and by
diff). Unit and regression coverage for the invariant, the bucket split and
every `EngineReport` consumer ships in the same PR.

**What is still owed:** this PR ships engine behaviour proven only by replay
over one book's *cached* analysis. What replay cannot prove is that a real
end-to-end analysis run produces the same buckets, and that `escalated`/
`escalationAccepted` behave with the new bucket split. Re-run Ночной дозор
analysis and confirm: `[analysis:structure]` log lines show `unresolved=`
populated and `flagged=` at conflict scale (order 10²/chapter, not 10³); ch5's
dash-opening sentences are no longer rewritten to `narrator`; `state.json`'s
`analysisProvenance.report` carries a populated `unresolved`. Full criteria:
`docs/testing/night-watch-reanalysis-onbox-acceptance.md` §2A.5, and plan 247's
re-specified target 1.

**Residual risk not covered by this row:** the invariant activates for
Russian, Spanish and French (`lang/es.ts`, `lang/fr.ts` both carry a non-null
`dialogueOpen`), but Ночной дозор is Russian-only. Spanish and French ship on
unit coverage plus the identical-convention argument, not corpus measurement —
no Spanish or French book exists in the workspace to measure against. This row
does not change that; it is not blocked on acquiring one.

Same setup as C2: local Ollama, `qwen36-cw-iq4-32k`, ~14 GB VRAM free, sidecar
suppressed (`DISABLE_AUTOSTART_SIDECAR=1`), no TTS. Batches naturally with C2's
session rather than needing its own.

> **Wave-3 step 6, 2026-08-20 — STILL OWED-blocked.** The GPU itself was
> idle and not the blocker. Live-rechecked today (independent of the plan's
> same-day citation): `#2288` — "findQuoteRuns lets a gap-seeded quote run
> swallow the next dialogue turn" — is still **OPEN**, so the register's own
> hold (naming #2288 as the thing that changes dialogue segmentation) is
> still in effect. Starting the 12h27m-class local re-run now would measure
> a moving target, exactly the outcome the hold exists to prevent. Nothing
> in the row's remaining scope was narrowed.
> `docs/testing/onbox-wave3-results/step-6-group-c.md`.

### C3 · A deterministic stage-2 failure actually clears when the span is halved ([#2304](https://github.com/dudarenok-maker/Castwright/issues/2304))

**What the unit tests already prove, and does NOT need re-running:** the wiring.
A repeated failure signature stops the retry loop, the stop escalates to
`splitSpanForRetry`, and it does so on **both** chunking routes — each mutation-
verified, each with a control that reddens when the fix is made unconditional.

**What is still owed** is the premise underneath all of that: *that a real model,
degenerating deterministically on a real span, produces a different answer when
the span is halved.* Every test above uses a fake model that succeeds on smaller
input **by construction**, so they prove the split is reached, never that it
helps. If the degeneration is a property of the *content* rather than the span
length, the split re-runs twice and fails twice, and the chapter is no better off
— just slower.

The reproducer is already known and specific, which is the only reason this is
cheap: Ночной дозор **ch8**, `repeat-loop` at offset **19**, which reproduced
identically five times across two server lifetimes on 2026-08-12/13. Observe:

- the analyzer log shows the retry **halting on the repeated signature** before
  the `coverageRetries` budget is spent — *"the same attribution failure
  reproduced exactly on attempt N"*. Do **not** pin N to 2: for the ch8 shape
  (attempt 1 a plain truncation, attempts 2+ an identical repeat-loop) the stop
  lands on **attempt 3**, because the first repeat is the first thing there is
  anything to match against. Any N below the budget is a pass;
- the log then shows **`re-attributing a <N>-char section as <M> smaller ones
  (split depth D)`**. This line exists only because nothing else can see the
  split: it happens inside a recursion that fires neither `onChunk` nor
  `onSectionDone`, and `chunkCount` is fixed before any of it runs — so on a
  multi-chunk chapter, which ch8 is, **both of those counters read identically
  whether the escalation fires or is reverted outright**. An earlier draft of
  this row asked for exactly those counters and would have recorded a PASS on a
  null observation;
- **ch8's sentence count is whole**, not the partial take. This is the criterion
  that matters; the two above establish that the mechanism under test is what
  produced it, rather than luck.

Absence of the re-split line is **not** a failure on its own — the split
declines for an indivisible span or at `maxSplitDepth`, and `onExhausted` fires
either way. If the stop line appears without the split line, record that: it
means the chapter reached the depth limit, which is its own result.

Record the outcome either way. A **negative** result here is valuable and must
not be quietly dropped: it would mean the escalation costs model calls without
recovering the chapter, and that the remedy for this failure class has to be
something other than a shorter prompt.

Same setup as C1/C2, and it **batches with the C2 re-run** — that run replays
this exact book and chapter, so this row needs no session of its own. Note C2 is
itself waiting on [#2306](https://github.com/dudarenok-maker/Castwright/issues/2306);
this row is not, and can be taken on any local re-analysis that reaches ch8.

> **Wave-3 step 6, 2026-08-20 — STILL OWED-blocked.** Rides C2's session
> per this row's own text; blocked by the same live-confirmed #2288-open
> state. The ch8 `repeat-loop`-at-offset-19 reproducer and its specific
> log-line criteria are unchanged and were not exercised — no re-analysis
> ran. `docs/testing/onbox-wave3-results/step-6-group-c.md`.

---

### C4 · The dialogue-collapse guard fires on a real collapse and stays quiet on a healthy book ([#2325](https://github.com/dudarenok-maker/Castwright/issues/2325), [#2342](https://github.com/dudarenok-maker/Castwright/issues/2342))

**Why this cannot be closed by the unit tests.** The guard's whole calibration rests on **one** Cyrillic book, nine chapters, two runs — the 2026-08-06 pass (per-chapter narrated speech halves 32.4 18.0 3.8 39.3 3.2 2.0 27.6 33.8 20.8, **max 39.3%**) and the 2026-08-12/13 collapse (93.1 93.7 94.8 97.5 86.5 72.2 84.3 74.6 91.8, **min 72.2%**). The 60% threshold sits in a 33-point gap between two runs of the *same book*. Every automated test feeds the guard a fixture built to breach or not breach it; none can say whether a *different* real Russian, French or Spanish book lands in that gap. Replaying the metric over all 82 cached analyses on this box found **exactly one** with an evaluable speech population (4,240 speech halves, 19.9% narrated); the only other two Cyrillic books hold **19** and **15** speech halves, both under the 20 floor. No offline work can widen this — a second dash-language book has to be imported.

**Observe, on a real local re-analysis:**

- a **healthy** dash-convention book completes with no `attribution-collapse` chapter failure, and the per-chapter narrated-speech share logged for each chapter sits below 60%. Record the actual percentages — the distribution is worth far more than a pass/fail, because it is what says whether 60% has real headroom or got lucky;
- the guard's **retry** fires on a section that breaches, and the kept take is the *less* collapsed one (#2342 made the scoring see the collapse dimension at all — confirm the better take survived, not merely that a retry happened);
- a chapter that still breaches reports **`attribution-collapse`** with the cast-focused copy, **not** `attribution-incomplete`'s "did not cover every sentence / a retry usually fills the gaps" — that copy was factually wrong for this failure class until #2342, and this is the only place the corrected wiring is exercised end to end;
- the **marker-loss** control does not false-positive: the source's dash-opening count and the attributed speech-half count are logged for at least one chapter, and the second is well above half the first. Both real runs measured ~246→213 and ~241→209, so near-parity is expected and a ratio approaching 0.5 is what to escalate.

**Hardware prerequisite:** no GPU needed — local Ollama analyzer only, as with the rest of Group C. Best taken in the same session as C2/C3 rather than as its own long run.

**Where the criteria live:** the max-39.3%/min-72.2% per-chapter narrated-speech-half figures this row cites are stated directly above, in this row (**Why this cannot be closed by the unit tests**) — no source file duplicates them at that granularity, so this row is their canonical home, not a pointer away from it. [`server/src/analyzer/stage2-coverage.ts`](../../server/src/analyzer/stage2-coverage.ts) carries two DIFFERENT calibration figures of its own, not this row's numbers: the module header's 95.7%/67.9% (lines ~160-161) is the same book's WHOLE-BOOK, ALL-SENTENCE narrator share, not the per-chapter SPEECH-HALF share the 60% threshold actually gates — reading 67.9% as "under the 60% threshold" would be wrong, since the good run's per-chapter figure this row measured is 3.2-39.3%, comfortably clear; and the `markersLost` comment's 246→213/241→209 (lines ~389-390) is an unrelated dialogue-marker-recovery calibration, not a narrated-share number at all. There is no dedicated plan doc for #2325/#2342, and plan 247 (dialogue-structure attribution) mentions neither the issue nor this calibration, so it was never the right pointer. Related but distinct: the #1984 attribution-collapse *visibility* strand measures and surfaces collapse; this guard *acts* on it during analysis. They share a name and nothing else — do not discharge one against the other.

**Not discharged by:** a green `npm run test:server`. The guard's tests are fixture-driven by construction; that is the point of this row.

> **Wave-3 step 6, 2026-08-20 — STILL OWED-blocked.** "Best taken in the
> same session as C2/C3" — same live-confirmed #2288-open block. Both
> halves of this row's criterion (fires on a real collapse; stays quiet on
> a healthy book) remain unexercised, recorded as two separate still-owed
> observations per this row's own requirement that a guard is only proven
> by both. Re-resolution note, not acted on: even once #2288 clears, the
> healthy-book half may need a second Cyrillic/dash-convention book
> imported, since replaying the metric over this box's 82 cached analyses
> found only one with an evaluable speech population.
> `docs/testing/onbox-wave3-results/step-6-group-c.md`.

---

## Group D — multi-language TTS render + ASR

<!-- next-id: D101 -->

### D1 · Non-English ASR content-QA calibration ([#1527](https://github.com/dudarenok-maker/Castwright/issues/1527), [#1084](https://github.com/dudarenok-maker/Castwright/issues/1084))

Render real audio in es/ru (then fr/de), run the ASR content-QA gate against it,
inspect the WER distribution per language, and set `qa.asr.maxWer.{es,fr,de,ru}` from
observed data — they currently all inherit the English-tuned `0.4` default.

Two named residual risks: gendered-number mismatch rate (es/fr/ru "one", ru "two"),
and Russian oblique-case declension mismatches. Also whether Whisper's German output
matches the single-fused-token assumption for compound numbers.

*Prerequisite satisfied:* the fs-61 per-language Coalfall demo books **are**
voice-designed — PR #1568 (merged 2026-07-13) ships "a language-matched Qwen cast
designed from the same English personas" for each of the five samples, 0 `.pt`
collisions across 101 files. Largely an unattended batch: render, then inspect.

### D2 · fs-61 zh/ja placeholder voices ([#1600](https://github.com/dudarenok-maker/Castwright/issues/1600))

The Qwen VoiceDesign pipeline is merged, but the **zh/ja** Coalfall placeholder
artifacts were never produced. Run the shipped pipeline against them. Distinct from
D1's five languages, which are done.

### D3 · The re-open bound's recovered turn actually sounds right when voiced ([#2315](https://github.com/dudarenok-maker/Castwright/issues/2315), plan [`docs/superpowers/plans/2026-08-13-primary-pair-straddle.md`](../superpowers/plans/2026-08-13-primary-pair-straddle.md))

The re-open bound (`scanQuoteRuns`, `server/src/analyzer/dialogue-structure/parser.ts`)
changes run boundaries on real books in all seven supported languages — 1,231
corpus paragraphs, dominated by `zh` (744) and `fr` (232). Every test in the PR
scores the recovered span's *text* (never lost, never mid-word) and, separately,
whether the tag-clause guard keeps a speaker attached — neither measures whether
the recovered turn *sounds* acceptable once voiced, which is a judgement only a
real render + a human ear can make.

**What to observe:** generate a chapter of a `zh` or `ja` book that contains a
continuation paragraph — the design doc's worked example
(`docs/superpowers/specs/2026-08-13-primary-pair-straddle-design.md` § "What it
fixes, on real books") quotes two, one already in the Gutenberg corpus this PR's
own instruments read. Confirm the previously-swallowed inner turn now renders as
its **own** speech turn, in the character's own cast voice rather than merged
into the narration/tag reading of the turn before it, and that the boundary
doesn't land mid-word or drop a syllable. A `ru` or `de` chapter containing one
of the 3/97 `ru`/`de` corpus paragraphs this PR changes is a secondary, lower-
priority check — `zh`/`ja` carry the bulk of the real-book delta (744+75 of
1,231) and are also the two scripts with no case distinction for the CJK-blind
part of defect 2's corpus proxy, so they are the shapes least covered by any
other instrument in the PR.

No hardware prerequisite beyond a working TTS engine (Kokoro/Coqui/Qwen, any) —
listed here rather than under Group A because the debt is about *listening*
to real output, not about VRAM or a specific card.

---

## Group E — not the GPU box

<!-- next-id: E103 -->

Acceptance on machines that are not the primary GPU box — Windows installs, macOS, browser-based (E2/E3/E5/E6/E8 for front-end acceptance), or platform-independent infrastructure (E1/E7/E9/E10/E11/E12/E101). E1/E7/E11 group on the Pinokio box; E6/E9/E10 need two live checkouts.

### E1 · ops-16 Pinokio installer ([#822](https://github.com/dudarenok-maker/Castwright/issues/822)) · **macOS is the gap**

PR #821 **merged 2026-06-15** (`90bc51eb`) — shipped code with acceptance debt, not
an unmerged feature. The issue body still says "draft PR #821" because it was filed
90 seconds before the merge and never updated. The 6-item matrix is all checked.

Real Windows on-box testing has substantially happened since: four closed bugs
(#1458, #1484, #1508, #1528, closed 2026-07-08→11) found and fixed real
Pinokio-runtime issues — module format, `shell.run` cwd resolution, the reserved
`pinokio/` folder name — and #1513 fixed the `server/.env` load path, now confirmed
in `pinokio-scripts/start.js`.

**What genuinely remains:** **macOS has had zero on-box exercise on any axis**
(install, venv-from-conda, API spelling are all Windows-only confirmations); plus two
Windows items never explicitly re-confirmed — **native Stop actually reaping the
sidecar**, and **confirming the pinned Node is the one actually used**.

> **Escalated 2026-07-27 by [#1859](https://github.com/dudarenok-maker/Castwright/issues/1859);
> the pin landed in a follow-up chore.** The Node question used to be "which Node does
> Pinokio's bundled kernel ship, and is it ≥ 22.22" — that's now moot: `install.js`
> step 1 conda-installs `nodejs=24` (matching `.nvmrc`/CI), and `update.js` re-asserts
> the same pin so a pre-existing install picks it up on its next Update rather than
> staying on whatever Node it started with. `pinokio-scripts/lib/node-pin.test.js`
> pins both the pin itself and that it satisfies `package.json`'s `engines.node` floor
> in code, so a future floor raise without a matching pin bump fails that test — this
> register row is now about what a test can't reach: the real Pinokio runtime.
>
> **What to observe, concretely:** on a machine with Pinokio installed, run a fresh
> Install, then from a `shell.run` step (or the Pinokio terminal, once the conda env is
> active) run `node --version` and confirm it reports **24.x**, not whatever Pinokio's
> kernel bundles — conda envs prepend to PATH, so the pinned Node should shadow the
> bundled one, but that shadowing is unverified outside this repo's reasoning. Then
> confirm Install → Start still completes end to end (this pin adds a package to the
> conda env; a bad channel/solve would surface here, not in any local test).
>
> **The mid-life-upgrade path, and the lag you should EXPECT rather than report as a
> bug.** Pinokio loads `update.js` from the release the user currently has checked out
> and iterates the `run[]` it loaded; `resolve-release.js` `git checkout`s the new tag
> *inside* that run, replacing the file on disk without affecting the loaded array. So
> updating **from a pre-pin release runs the OLD `update.js`** — no pin step — and does
> that update's `npm ci`/build on Pinokio's bundled Node. **This is expected.** The pin
> takes effect from the *next* Update.
>
> Concretely: take an install from a pre-pin release, Update once, and check
> `node --version` — reporting the **bundled** version here is the correct result, not a
> failure. Update a second time and it should report **24.x**. A tester who sees the
> first result and files "the pin doesn't work" has found the documented behaviour, not
> a defect. What genuinely wants confirming is that the second Update converges, and
> that `node_modules` still works across that Node-major swap (native-module ABI is the
> nominal risk, though every native artifact in both trees is a prebuilt N-API binary,
> and `npm ci` deletes and rebuilds `node_modules` anyway — so this should self-heal;
> unproven on-box).
>
> Criteria live in `docs/features/218-pinokio-installer.md` open-verification item 2
> (updated in the same PR). **The release notes for 1.15.0 deliberately do not promise
> Pinokio users this is handled** — an earlier draft did, and it was unsupported; the
> current entry describes the pin without claiming on-box confirmation.

*Needs* a clean macOS machine with Pinokio, plus a short Windows follow-up. Budget
20–40 min for the macOS install alone.

### E2 · LAN HTTPS on by default (plan 250)

"## On-box acceptance (owed)" (`:43-48`). Fresh install boots HTTPS on :8443 with the
cert-provisioned log line · the Open-Web-UI tab loads with no cert warning · **a real
phone** installs the mkcert root CA and completes pairing over `castwright.local` ·
forcing `LAN_HTTPS=0` or deleting the certs degrades to loopback HTTP without a crash.
*Shipped* 2026-07-12 after four review rounds.

### E3 · Pair from `castwright.local` (plan 256)

"On-box acceptance owed — pair a real phone from `https://castwright.local/#/admin`"
(`:48-52`). Authorize a device from the friendly hostname with no 403 · name-first
pairing from the Listen tab shows the chosen name in the admin list · a bare-LAN-IP
request still gets the loopback-only 403 guidance.

**Same session as E2** — shares the phone + host setup, and E2 is what made
`castwright.local` the natural URL this depends on.

### E4 · fe-51 engine-recommendation CPU caveat (plan 259)

"On-box acceptance item (real hardware, not mock mode) — owed" (`:183-191`). The
wizard's CPU caveat claims a low/no-VRAM user can force Qwen onto CPU via the
voice-engine device setting and still render — slow, not crashing. Never confirmed on
real hardware. The plan names its own fallback if it turns out false: soften
`CAVEAT_VRAM` at `server/src/tts/engine-recommendation.ts:34`.

*Needs a real box but specifically the **CPU** path* — pairs naturally with Group B's
CPU-only sub-cases.

> **Correction, 2026-08-21.** The owner ruled E4 is runnable, not
> hardware-blocked like the ops-35 ffmpeg floor / ops-36 golden-assembly
> Blocked rows or B2-step-7 — `tts.qwen.device` is a real
> user-facing registry knob (`server/src/config/registry.ts:676-682`), not a
> machine-level hardware constraint. **Wave-4 step 5f attempt, STILL OWED:**
> port `:9000` was already held by another lane's live sidecar process for
> the whole session (confirmed via `Get-NetTCPConnection`), so this row could
> not be safely isolated this run without restarting a sidecar process this
> worktree does not own — recorded STILL OWED for that reason, not for any
> hardware limitation. Full evidence:
> `docs/testing/onbox-wave4-results/step-5f-e4-cpu-caveat.md`.

### E5 · fe-39 touch press-feedback — DevTools smoke-check ([#1795](https://github.com/dudarenok-maker/Castwright/pull/1795))

The behavioural touch-flash is confirmed by construction but not by an automated test
(jsdom cannot compile the variant); a one-time DevTools touch-emulation check is the
spec's accepted proof. Four controls: continue-listening play badge, "Add book" tile,
wizard "Review ›" chip, voice-library drag icon. Minutes, any machine.

> **Wave-4 step 5d, 2026-08-21 — 1 of 4 controls DISCHARGED, shrinks.** Driven
> via real synthesized touch (CDP `Input.dispatchTouchEvent` on a
> `hasTouch:true` Pixel-7-profile context, the same path `page.touchscreen`/
> `.tap()` use). The wizard **"Review ›" chip** is **DISCHARGED**: a
> measurably distinct mid-press color plus a real click-through confirmed.
> The other three controls (continue-listening play badge, "Add book" tile,
> voice-library drag icon) are **STILL OWED** — this worktree's workspace has
> 0 books (no `GEMINI_API_KEY` configured, by design, so no book could be
> analyzed to populate them), a genuine environment limitation, not a
> missing or broken control. Full evidence:
> `docs/testing/onbox-wave4-results/step-5d-e5-e7-observations.md`.

### E6 · fe-57 venv-bootstrap progress card — the fix nothing automated can prove ([#1883](https://github.com/dudarenok-maker/Castwright/issues/1883), plan [270](../features/270-openapi-setup-surface.md))

`src/components/venv-bootstrap.tsx` declared `status: 'installing'` — a value
`server/src/tts/venv-bootstrap.ts` **never emits** (its states are `detecting` /
`bootstrapping` / `installed` / `error`; `'installing'` is the sibling ollama/coqui/kokoro
vocabulary, copied here by mistake). So the in-progress branch was dead in production: through
a real multi-minute venv bootstrap the card never rendered and the user saw the idle
"Set up the voice engine runtime" button the whole time. **The suite stayed green because the
component's own tests mocked `'installing'` too** — a placebo over a wire value the server
cannot produce.

The fix is now typed against the generated contract, so that class of drift is a compile
error, and an `it.each(['detecting','bootstrapping'])` regression pins the card. **But every
one of those tests mocks `fetch`.** No automated test has ever driven this component from a
real bootstrap job, which is precisely how the bug survived in the first place.

Needs a box with **no** `server/tts-sidecar/.venv` (delete it, or a fresh clone). Any machine,
no GPU. ~2 GB download, several minutes — that duration is the point.

Observe:

1. Setup Wizard → voice-engine step with the venv absent → the "Set up the voice engine
   runtime" button.
2. Click it. **Within ~1.5 s the progress card must appear** — spinner, "Setting up the voice
   engine runtime…", and a live `job.step` line. Before this fix, nothing happened here.
3. Watch the step text **change** as the job advances (`Starting venv bootstrap…` → pip
   output). This proves the poll loop and the card are wired to the same job, not just that a
   card rendered once.
4. Let it finish → the green "Voice engine runtime ready" card, and `onBootstrapped` refetches
   so the parent's status flips without a reload.
5. **The `detecting` window is brief** — if you miss it, that is fine; step 2 covers the
   pre-terminal render. Do not report a missed `detecting` frame as a failure.
6. Failure path, if cheap to induce (e.g. no Python 3.12 on PATH): the red "Setup failed" card
   with the server's message, and a working "Try again".

> **Wave-3 step 7, 2026-08-20 — split, server half DISCHARGED, rendered half
> OPERATOR.** The job/poll wiring underneath the card (`POST
> /api/setup/venv/bootstrap`, `GET /api/setup/venv/bootstrap/:id`) was run
> for real against a genuinely absent venv (this worktree's own, never
> deleted from a live one) — a real 8m49s `bootstrap-venv.mjs` subprocess
> with distinct polled step values across the whole run and a genuine
> terminal `installed` state, independently confirmed via `detect` and the
> filesystem. This is the exact wiring the row's own text says "no
> automated test has ever driven... from a real bootstrap job," proven
> not-mocked. **Observations 1, 2, 4, 5, 6 remain owed** — they are rendered-
> page states (spinner, card timing, green ready card, refetch-without-
> reload, failure card) with no API-only substitute stated in the row.
> **Still owed to the operator** — observations 1, 2, 4, 5, 6 above have not
> been run; this row is not discharged, only its server/poll half is.
> **Correction, 2026-08-20:** this row previously stated the join to
> `onbox-sitting-device-browser.md` as if it had already happened; it had
> not — the pack's own row list and minute total were never updated to
> include E7 (confirmed empty diff against the pack file across all of wave
> 3). That gap is fixed in the same round: E7 is now folded into
> `onbox-sitting-device-browser.md` alongside E1, E2, E3, E5, E6, E9, E10,
> and `onbox-sitting-plan.md` §2.1/§2.2 are corrected to move E7's
> rendered-half debt from the wave-3 agent-runnable set to that operator
> pack — the same pattern already used for A32/A41.
> `docs/testing/onbox-wave3-results/step-7-e7-e8.md`.
>
> **Wave-4 step 5d, 2026-08-21 — split further, shrinks.** Observations 1, 2,
> the timing/no-flash behaviour, 4 (green ready card), and 5 (refetch
> without reload) are all **DISCHARGED** live, via a real ~8m55s
> `bootstrap-venv.mjs` subprocess against a genuinely absent venv, in a real
> browser tab held open the whole run. Two genuine findings, not failures,
> flagged alongside: (a) `sidecarVenvPresent()` can read "ready" before pip
> install actually finishes — a follow-up worth its own issue, not a fail of
> this row; (b) the auto-transition on completion lands on the setup
> **summary board**, not a lingering ready-card inside the step-voice
> drill-down — a UX note, not evidence against "no reload". **Observation 6
> (the failure path, e.g. no Python 3.12 on PATH) was NOT attempted** —
> inducing a real failure now would mean breaking a venv that just finished a
> real 9-minute install, or interrupting a live subprocess, both of which
> risk the shared box. Observation 6 is this row's one remaining debt. Full
> evidence: `docs/testing/onbox-wave4-results/step-5d-e5-e7-observations.md`.

---

### E7 · ORT marker — the Pinokio update path ([#2192](https://github.com/dudarenok-maker/Castwright/issues/2192), plan [282](../features/282-ort-pip-consistency-marker.md)) · **group with E1**

Design doc §On-box acceptance, criterion 4: `pinokio-scripts/update.js` — named
specifically, not `install.js` — as "the deployment shape that reported the bug."
`update.js` and `install.js` both invoke `bootstrap-venv.mjs` directly with **no
server process at all**, but they are not interchangeable: `update.js` loads from
the *currently checked-out* release and iterates its `run[]`, per the Pinokio
installer's own documented one-update-lag behaviour (see E1) — a fresh-install
pass does not stand in for an update pass. Every other on-box row for this feature
runs through the dev server, a different process entirely; this is the only row
that proves the out-of-process invocation applies the marker identically rather
than taking some code path only the server-mediated call exercises.

- On a machine with Pinokio and an **existing** (pre-fix) install (Windows, the
  original reporter's platform, is the priority; **group with E1**, which already
  owns the Pinokio box), run Update on the nvidia profile.
- **This PR changes no `requirements/*.txt`, so on this release Update takes the
  `noop` branch**: `bootstrap-venv.mjs`'s `classifyVenvState` sees an unchanged
  `reqHash`, `main()` returns before ever calling `runInstall`, and no marker is
  written by Update at all — that is expected, by design, not a failure. Confirm
  instead that `pip check` is unchanged from its pre-Update state, then that the
  marker arrives (and `pip check` goes clean) at the **next server boot** via
  `ensureOrtMarker`'s self-heal — the same mechanism criterion 3 already proved,
  reached through the Update entry point. A future release that *does* touch
  `requirements/*.txt` takes the `pip-in-place` branch instead, and on that
  branch `pip check` should be clean immediately after Update, with no server
  ever having started — written directly by `bootstrap-venv.mjs`'s own call to
  `applyOrtMarkerWrite`.
- From within the app once it does start, install Qwen3 (the original bug's own
  repro) and confirm no `WinError 5`.
- **In the same session, also run a fresh Install** (`install.js`) and confirm the
  same outcome — a second shape of this criterion, not a separate row. `install.js`
  has no prior stamp, so it always takes the `pip-in-place`-shaped path (marker
  written immediately, no boot needed) regardless of which branch Update took.

*Needs:* a machine with Pinokio installed, an existing pre-fix install, nvidia
profile. *Cost:* 20–40 minutes, sharing setup with E1. *Criteria:* design doc
§On-box acceptance item 4; run sheet §6 in
`docs/testing/ort-marker-onbox-acceptance.md`.

### E8 · revoke is loopback-only — the forwarder boundary and the copy that replaces the button ([#2269](https://github.com/dudarenok-maker/Castwright/issues/2269), PR [#2280](https://github.com/dudarenok-maker/Castwright/pull/2280), plan [225](../features/225-lan-browser-device-auth.md)) · **group with E2/E3**

`DELETE /api/devices/:id` is now gated to true loopback. Nothing automated reaches
the real boundary: the server test **fabricates** a request object with
`req.ip = '127.0.0.2'`, and the frontend test **stubs** `window.location`. Both are
correct unit tests and neither has ever seen the actual `:443` forwarder, which is
what makes the host's own browser non-loopback in the first place
(`lan-port-forwarder.ts` dials upstream with `localAddress: '127.0.0.2'`, and it is
host-blind, so a phone on `castwright.local` is indistinguishable from the desktop
there). The narrowing is also user-visible, and the replacement copy is the only
thing standing between an owner and "the button vanished with no explanation."

- From **`https://localhost:<port>`** (the direct port, NOT the `:443` shortcut):
  Revoke a device — it succeeds and the row drops out of the list. This is the one
  address the feature leaves working; if it fails, the gate is too tight.
- From **`https://localhost/`** (port 443, through the forwarder): the Revoke
  button still **renders** — `isLoopbackHost()` is a hostname-only client-side
  heuristic that cannot see the forwarder — and pressing it returns 403. Confirm
  the error shown is the actionable sentence naming the direct-port address, **not**
  a raw `revoke failed (403)`, **and that the port in it is the one you actually
  bound** (see the run-with-a-non-default-port note below).
- From **`https://castwright.local` on a phone**: no Revoke control on any row, and
  the explanation renders **once below the device list, not once per row**. Check
  this with **at least 3 paired devices** — per-row rendering was the shape caught
  in review, and with one device the bug is invisible. Confirm it is legible at
  phone width and does not crush the label/date columns.
- **The security half, and the reason the row exists:** from a paired phone (or any
  LAN device holding a valid credential), call `DELETE /api/devices/<the host's own
  record id>` directly — the id is in `GET /api/devices`, which that device can
  read. Expect **403**, and confirm afterwards via the host UI that the host's
  record is **still live, not revoked**. Before #2269 this succeeded and locked the
  owner out of their own install.

**Run this with a NON-DEFAULT `LAN_HTTPS_PORT`** — e.g. `LAN_HTTPS_PORT=9443`.
This is not a nicety, it is what makes two of the bullets above mean anything.
Every one of these hint strings hardcoded `https://localhost:8443` until
[#2278](https://github.com/dudarenok-maker/Castwright/issues/2278) (PR
[#2294](https://github.com/dudarenok-maker/Castwright/pull/2294)) made them read
the actually-bound port. **On a default-port box the old hardcoded string and the
new dynamic one render identically**, so the run would pass without proving the
fix — the same trap the automated tests avoid by pinning 9443 rather than 8443.
A non-default port also exercises the case the fix exists for: an operator who
moved the port had, until #2278, no way to discover the one address revoke works
from. (Note production auto-rebind can move the port again beyond whatever you
set; the bound value is the one in the server's own startup line.)

*Needs:* the LAN HTTPS server running with the `:443` forwarder actually bound
(`npm run start:lan`; no elevation required on Windows — see plan 283's ship
notes), a **non-default `LAN_HTTPS_PORT`** per the note above, plus a phone or
second machine paired over `castwright.local`. *Cost:* 15–20 minutes; shares its
whole setup with E2 and E3, so run the three together. *Criteria:* PR
[#2280](https://github.com/dudarenok-maker/Castwright/pull/2280) body and PR
[#2294](https://github.com/dudarenok-maker/Castwright/pull/2294) body; plan 225
§Invariants item 6.

### E9 · `measure-attribution.mjs` against the real workspace ([#1984](https://github.com/dudarenok-maker/Castwright/issues/1984) Wave 1, [plan](../superpowers/plans/2026-08-13-attribution-collapse-visibility-wave1.md)) · **real workspace, no GPU needed**

New read-only `scripts/measure-attribution.mjs` — every unit test mocks its
inputs; nothing automated runs it against the real `C:\AudiobookWorkspace`
library, and the spec's own acceptance criteria are stated as properties of
that run, not of a fixture. Partially run 2026-08-13 from a **feature
worktree**, which is the reason this row exists rather than closes:
`server/handoff/cache/` is per-checkout and git-ignored (CLAUDE.md's own
`CACHE_DIR` note), so a worktree's freshly-built `server/dist` reads an empty
cache for every book until its analyses are copied in from the checkout that
actually ran them — every book that has never been re-analysed in the
worktree itself reads `ok (not analysed)`, indistinguishable from a
genuinely-fresh import.

**What was observed** (21 of 23 real books' caches copied in, read-only, from
the primary checkout; copies deleted afterward — nothing written to
`C:\AudiobookWorkspace`, and the primary checkout's own `server/handoff/cache/`
was only ever read, never written): a row for every book, none blank; both
live CJK books (`煤落的委托`, `コールフォールの依頼`) at `spokenTotal > 0`;
`dashOnlySpoken` non-zero on both Russian books (`Юный дрессировщик` 17,
`Ночной дозор` 1719); `orphanSpoken` non-zero on several books, concentrated
in the *Coalfall Commission* family (0–62 across its seven language
editions); `unattributedSpeech` printed for every book. **Re-verified
2026-08-13** after a #2328 review-gate fix to `orphanSpoken` (it was
double-counting per unresolvable model id sharing one split span, instead
of once per span — finding 1): across this same corpus the fix moved
exactly one book's figure (`Ночной дозор (Tetralogy)`, 30→29), everything
else above is unchanged; see the acceptance doc's own §1/§5 for the
corrected per-book table and D13 percentages. **`modelNarrator` and
`demotedNarrator` read 0 on every book — this is the D18 trap doing its job,
not the R-9C1 finding recurring:** none of these 21 caches have been
re-analysed since `priorCharacterId` shipped, so every narrator-speech span
correctly lands in `unknownOriginNarrator` (verified non-zero, e.g. 193 of
193 on `Юный дрессировщик`) rather than being defaulted to `modelNarrator`.
The mutation-tested proof that site 1 (`reconcileSentenceCharacterIds`) *is*
instrumented lives in `server/src/routes/analysis.test.ts`, not in this run —
this row is what's left: confirming a **freshly re-analysed** real book
actually produces a non-zero `demotedNarrator`/`modelNarrator` split, which
requires GPU time this pass did not spend.

**Item (1) DISCHARGED 2026-08-14** — the full run from the primary checkout at
`df49a261`, read-only, no copied caches, so every book's `hasCacheFile`/`state`
reflects its real analysis history. All 23 books rowed; 21 measurable, and the
two `ok (not analysed)` rows are genuinely un-analysed C2/C3 throwaways rather
than the worktree artifact that forced the 2026-08-13 caveat. **Twenty of 23
books are identical in every column to the partial run**; the three that moved
(`Everblaze` +1 spoken, `Keeper of the Lost Cities` +1 spoken, and
`Ночной дозор (Tetralogy)` across eight columns, `spoken` 1928→2122 and
`orphan` 29→32) are the parser work merged in between — **measured not to be
#2286**, which moved nothing in this corpus on either side of its merge. The
same run completed the **D13 re-gate**, whose verdict is *drop the `drifted`
state* — the owner confirmed this 2026-08-14, closed as #2357: see the run
sheet §5 and spec §D13 re-gated → *Re-gate outcome*.

**Still owed:** (2) the dash-stripped re-run invariance check (Task 9's paired
assertion — run twice, second time over scratch-path copies of each cache with
every leading dash stripped, diff every field of every row); (3) re-analysing
one book post-D18 to confirm `demotedNarrator`/`modelNarrator` actually
populate outside a unit fixture. **Both need GPU/analysis time this pass did
not spend**, which is why the row stays rather than closing.

*Needs:* a checkout (or worktree with `server/handoff/cache/` populated from
one) whose cache holds the real 20-book library's analyses, `cd server && npm
run build`, then `WORKSPACE_DIR=C:\AudiobookWorkspace node
scripts/measure-attribution.mjs`. *Cost:* under 5 minutes once `server/dist`
exists. *Criteria:* spec §On-box acceptance
(`docs/superpowers/specs/2026-08-06-attribution-collapse-visibility-design.md`).

> **Wave-3 step 4, 2026-08-20 — item (2) run, criterion FAILS on real
> data.** Both passes run for real (straight, then dash-stripped over a
> scratch-path copy of every cache file, originals restored and verified
> byte-identical after). 22 of 23 books: zero diffs, every measured field
> identical. **`Ночной дозор` (the corpus's heaviest dash-convention book):
> 14 fields diverge** (`narratorIdSpoken` 229→223, `share` moved, `splitSpeech`
> 337→346, five chapters' per-chapter columns shifted). This is a real,
> reproducible property gap, not harness noise — 22/23 byte-identical rules
> out a broken diff, and the one failing book is the corpus's own worst case
> for the property being tested. Root cause (routed to a fix agent, not
> fixed here): `alignSentences`
> (`server/src/analyzer/dialogue-structure/aligner.ts:317,360`) locates its
> needle by substring-searching the **cached** sentence's normalized text in
> the chapter body — stripping the leading dash changes the needle without
> changing the body, shifting which offsets it locates at. Item (2) is
> therefore **STILL OWED** (the criterion fails, not merely unrun). **Item
> (3)** (post-D18 re-analysis) rides Group B/C's session per the plan and
> was not this step's job — not attempted. Run sheet's own `Result:` line
> updated: `docs/testing/attribution-collapse-visibility-onbox-acceptance.md`
> §4. `docs/testing/onbox-wave3-results/step-4-real-workspace-scripts.md`.
> Filed as [#2537](https://github.com/dudarenok-maker/Castwright/issues/2537)
> (see #2537).
>
> **2026-08-21 — Root-cause fix landed in PR #2577** (commits 40bee7ff..3053f5dd on
> branch fix/server-2537-dash-invariant-align). Item (2), the dash-stripped
> re-run invariance check, **remains owed** — the fix addresses the root cause
> (`alignSentences` needle-search not dash-invariant) and new unit tests pass,
> but on-box re-verification on the real workspace is still required to confirm
> the 14-field divergence observed on `Ночной дозор` is actually closed. Paired
> assertion in Task 9 — run twice, second time over scratch-path copies of each
> cache with every leading dash stripped, diff every field of every row.
>
> **2026-08-21 — On-box re-run against the landed fix (#2571), criterion
> STILL FAILS.** Both passes re-run for real against commit `d9eb03ad`
> (`fix/server-2537-dash-invariant-align`, rebased onto `origin/main`,
> containing PR #2577's full fix series) — straight, then dash-stripped over
> a scratch-path copy of every cache file, originals restored and verified
> byte-identical after. 22 of 23 books: zero diffs, unchanged from wave 3.
> **`Ночной дозор` still diverges: `narratorIdSpoken` 229→223, `share`
> 0.1302→0.1273, `unattributedSpeech` 9→7, `splitSpeech` 337→346,
> `tagNarratorSpan` 544→536, plus per-chapter shifts in chapters 1, 6, 7, 8**
> — the same field names, same direction, same magnitude as wave 3's pre-fix
> numbers. The fix is confirmed present and built into the `server/dist`
> actually exercised (`aligner.ts`/`aligner.js` both carry the dash-invariant
> needle-search code from #2537/#2540), and its own synthetic unit test and
> the #2541 parent-acceptance checklist both passed — but neither reaches
> whatever in this book's real 2,122-sentence, 1,940-dash-only-span structure
> still produces a divergent match. **Item (2) is therefore still owed, not
> discharged.**
>
> **2026-08-23 — pass-2 addendum on #2577:** an earlier draft of this entry
> called this "a residual real-data gap … not the original defect recurring
> unfixed" — that framing overstated what this run showed (removed above,
> not restated here since it no longer applies). It was measured against
> `d9eb03ad`, which predates the
> fix's final mechanism (attempt 4, commit `5a60b088`) — a later mechanism
> that itself needed two more blocking-regression fixes (P1/P2) found in
> subsequent review passes of the same PR. Whether this book's divergence is
> closed by the fix as it now stands is unconfirmed; item (2) stays owed
> pending a fresh on-box re-run against the current commit, not `d9eb03ad`.
> Evidence: `docs/testing/onbox-wave4-results/step-1-e11-item2-rerun.md`.

> **Wave-5 step 3, 2026-08-23 — reconfirmation only, disposition unchanged
> (STILL OWED).** Re-ran item (1) (the full real-workspace run) from a
> **second checkout** (`wt-2606-onbox-wave5`, not the primary), after
> confirming from source that the script's only filesystem write is its own
> JSON report — never the workspace. Observed figures matched the 2026-08-14
> discharge run's values everywhere directly comparable (23 book rows, none
> blank; both CJK books `spokenTotal>0`; `orphanSpoken`/`dashOnlySpoken`
> shapes unchanged; `Ночной дозор (Tetralogy)` at `spokenTotal=2122`,
> `orphanSpoken=32`, matching the post-parser-fix baseline). No regression
> found. Items (2) and (3) were not attempted this step (out of its scope);
> both remain owed exactly as recorded above. No register edit was made by
> that step itself — this note folds its verdict in per wave-5 step 6.
> Evidence: `docs/testing/onbox-wave5-results/step-3-e9.md`.

### E10 · `npm run stop` sweeps the RIGHT checkout's sidecar, Vite, AND server (#2632, PR #2635) · **two live checkouts, no GPU needed**

`scripts/stop-app.mjs`/`stop-app.ps1`'s belt-and-braces orphan sweep now
resolves every per-checkout port it sweeps — `LOCAL_TTS_PORT`, `PORT`, and
(PowerShell only) `VITE_PORT` — via `scripts/lib/sidecar-sweep-port.mjs`/
`.psm1`, instead of hardcoding the factory defaults `:9000`/`:8080`/`:5173`.
Pass 8 found the first cut of this fix resolved only the TTS port and left
the other three base ports (`:5173`, `:8080`, `:8443`) hardcoded — the
primary checkout's own values — so `npm run stop` run from a worktree
following the `npm run dev` workflow force-killed the **primary's** Vite and
server while leaving the worktree's own Vite/server untouched, the exact
inversion of this branch's headline claim. The first follow-up fix resolved
`PORT` from this checkout's own `server/.env` and `VITE_PORT` from its own
`.env.local` the same way `LOCAL_TTS_PORT` already was, sweeping neither
when unconfigured rather than guessing the primary's value.

A second follow-up removed `:8443` (LAN HTTPS) from the sweep entirely,
rather than resolving it the same way: unlike `PORT`/`VITE_PORT`, config
alone can't establish ownership of the currently-bound process even when
THIS checkout's own `server/.env` sets `LAN_HTTPS=1`. Two reasons: (a) in
production (`stop-app.mjs`'s launcher always sets `NODE_ENV=production`),
`listenWithAutoRebind` (`server/src/index.ts`) auto-rebinds `LAN_HTTPS_PORT`
on conflict, so the configured value is only a `startPort`, not necessarily
where the process actually listens; (b) even in dev (`stop-app.ps1`'s world,
where dev mode never rebinds — a losing checkout's server exits with an
actionable `EADDRINUSE` instead), "my config says `LAN_HTTPS=1`" only means
*this checkout would hold `:8443` if it won the race*, not that it currently
does. There is no owner-note file for the main server's bound port the way
`.run/tts.owner.<port>.json` exists for the sidecar, so neither script has an
authoritative source to settle it — the sweep now sweeps nothing for
`:8443` rather than guess. This is a **coverage tradeoff, not a defect**: an
orphaned LAN-HTTPS listener with no surviving PID file is no longer
auto-reaped by either script and needs a manual kill (`netstat -ano | findstr
:8443`) — accepted because a live-but-wrong guess can force-kill a different
checkout's server, and killing nothing is always safer than that.

The resolver and the swept-port-list assembly are both unit-tested against
real temp files (`scripts/tests/sidecar-sweep-port.test.mjs`/`.Tests.ps1`),
including mutation-style guards pinning that `:8443` never re-enters either
script's base-port list, but nothing in this PR executes `stop-app.ps1`/
`.mjs` end to end against real listeners — the actual claim this branch
exists to make (*"in a worktree, `npm run stop` stops my whole stack and
none of the primary's"*) has never been observed. Two checkouts each
running a live stack is "a real sidecar" in this register's own vocabulary
(see A1, D-group entries).

*Needs:* two checkouts of this repo (e.g. the primary + a `wt-new.mjs`
worktree, e.g. slot 1: `VITE_PORT=5183`, `PORT`/`VITE_API_PORT=8090`,
`LOCAL_TTS_PORT=9010`), each with **all three** of Vite, the server, and the
sidecar live (`npm start` / `npm run dev`) so each checkout owns a
`tts.owner.<port>.json` note. From the worktree, run `npm run stop` and observe
**four** things, not just the sidecar pair: (1) the worktree's own sidecar
(`:9010`) dies; (2) the primary's sidecar (`:9000`) survives; (3) the
worktree's own Vite (`:5183`) and server (`:8090`) die; (4) the **primary's**
Vite (`:5173`) and server (`:8080`) survive — this last pair is the one pass
8 found broken and is the one an operator must not skip. Then repeat after a
clean shutdown of the worktree's sidecar (so `tts.owner.<port>.json` is absent
and the sweep falls back to `server/.env`/`.env.local`) and confirm the same
four-way discrimination holds. **Optionally**, if exercising the LAN-HTTPS
path too: start the primary with `LAN_HTTPS=1` (so it's listening on
`:8443`), then from the worktree run `npm run stop` and confirm the
**primary's `:8443` also survives** — it should, because `:8443` is no
longer in either script's sweep list at all; this is a smoke check on the
removal, not a new required step for every run of this row. On Windows
PowerShell only (`stop-app.ps1` force-kills; `stop-app.mjs`, the prod
launcher, only warns and never runs Vite, so its own check is limited to
(1)/(2)/the server pair of (3)/(4)). **A fifth observation, in the PRIMARY
checkout itself** (#2632 N46): with no `.env.local` and no `PORT` line in
`server/.env` — the primary checkout's actual today-state, and the default
for anything derived from `server/.env.example` — `Get-PortsToSweep`'s
`-BasePorts` resolves to an empty array at the `stop-app.ps1` call site.
Run `scripts/stop-app.ps1` there (with nothing needing to actually be
running — this observation is about the script not throwing, not about
what it kills) and confirm: no red `ParameterBindingValidationException`/
`Cannot bind argument` block appears, and the script still reports its
outcome truthfully (`[OK] nothing to stop`, or the correct sweep line if a
listener is present) rather than silently swallowing the error and printing
a false "nothing to stop" while a raw exception scrolled past above it.
*Cost:* under 2 minutes, no live stack needed for this one. *Criteria:*
this PR's description (§On-box acceptance) and `docs/features/` plan 43's
stop-script contract, plus `scripts/lib/sidecar-sweep-port.mjs`'s own
module-level comment for the exact fallback order being exercised.

### E11 · Pinokio Install/Update: requirements CRLF normalization ([#2596](https://github.com/dudarenok-maker/Castwright/issues/2596), PR #2799) · **Windows box with pre-existing Pinokio install**

PR #2799 adds `renormalizeRequirementsCrlf()` to `pinokio-scripts/lib/resolve-release.js`, 
called during both `install.js` and `update.js` to normalize CRLF line endings in 
`requirements/*.txt` files after `git checkout` of a release tag. Before `.gitattributes` 
enforced `eol=lf` repo-wide, a user's pre-existing install may have stale CRLF 
requirements. The normalization prevents spurious 'file changed' detections that would 
trigger an unnecessary full `pip install --force-reinstall` on the next Update.

- On a Windows machine with a **pre-existing** Pinokio install that has CRLF-mangled 
  `requirements/*.txt` files (e.g. from a prior checkout before `.gitattributes` 
  enforcement), run Update.
- Confirm the requirements files are normalized to LF (check file endings via `file` 
  or hex dump, or confirm the files read as unchanged after running the normalizer 
  a second time).
- Confirm that the normalization does not trigger an unnecessary `pip install` 
  reinstall — `bootstrap-venv.mjs`'s `classifyVenvState` should see unchanged 
  `reqHash` and take the `noop` branch, exiting before `runInstall`.
- Confirm a subsequent Install (the `install.js` path) also normalizes any stale 
  CRLF it finds to LF and proceeds with the normal install flow.

*Needs:* a Windows machine with Pinokio installed, a pre-existing install with 
CRLF-mangled `requirements/*.txt` (or ability to create one by checking out an old 
release prior to `.gitattributes`). *Cost:* 10–15 minutes, grouping with E1's 
Pinokio box. *Criteria:* this PR's `resolve-release.test.js` acceptance test 
(automated verification of the CRLF→LF transform path), plus real-world confirmation 
that a stale-CRLF install updates without spurious reinstall and that a fresh install 
normalizes correctly. Issue #2596 and PR #2799 body.

**One-update lag:** Updates FROM pre-#2799 releases run the old `resolve-release.js`, 
so CRLF normalization only takes effect from the NEXT update onward (see E1 and 
`pinokio-scripts/update.js` lines 19–28).

### E12 · ASR warm footprint measurement via torch allocator peak ([#2682](https://github.com/dudarenok-maker/Castwright/issues/2682), PR #2799) · **GPU with CTranslate2/faster-whisper resident**

PR #2799 changes how `asr.warm` (the learned warmup footprint for Whisper ASR) is 
measured in the TTS sidecar (`server/tts-sidecar/main.py`). Previously, footprint was 
estimated via a snapshot of free GPU memory before and after warm load. Now it is 
measured via torch's allocator peak (the highest VRAM allocated during the entire 
warm-up). This is more reliable than free-memory deltas because:

- Free-memory measurements race against other concurrent processes and can miss 
  spikes that spike-then-release.
- Allocator peak is the actual peak VRAM the warm forward actually used, captured 
  from the torch/CUDA allocator itself.

However, the allocator-peak measurement is unproven on real hardware with a live 
CTranslate2-backed ASR session (the pytest only stubs `_observed_mb` to a fixed 
test value and doesn't exercise the real forward).

- Load the TTS sidecar with `faster-whisper` engine resident on a GPU.
- Trigger a real ASR warm-up via the app (e.g. during a repair/re-synthesis pass that 
  needs the ASR transcription gate, or an explicit `POST /transcribe` call with sample PCM 
  data).
- Confirm that `asr.warm`'s learned footprint **moves off its 128 MB seed value** after 
  the real warm forward completes — i.e., the allocator-peak measurement produces a 
  positive, observed value that is recorded, not dropped.
- Verify the recorded value matches the expected range for CTranslate2+faster-whisper 
  on this box's GPU (typically a few hundred MB, depending on model size and CUDA 
  compute capacity).

*Needs:* a GPU with CTranslate2 and faster-whisper weights installed, TTS sidecar 
with ASR enabled (`SEG_ASR_ENABLED=1`) and configured to use GPU (`ASR_DEVICE=cuda`). *Cost:* short — one real ASR warm-up sequence 
during a render or via manual endpoint. *Criteria:* the allocator-peak measurement in 
`server/tts-sidecar/main.py`'s `FootprintTable` class must observe a positive value 
recorded via its `record()` method when a real forward runs, not a stubbed test value. 
Issue #2682 and PR #2799 body.

### E101 · Port-keyed TTS owner notes prevent collision when servers share a run directory (#2641, PR #2754) · **no GPU needed**

Before #2641, the TTS sidecar owner-note file was fixed at `.run/tts.owner.json`
regardless of which port the sidecar was listening on. When two different server
instances on different ports both used the same `.run` directory — set via
`APP_RUN_DIR` environment variable pointing to a shared location — they would
both try to write to this single fixed filename. Whichever wrote last would
silently clobber the other's note, losing the ownership information (PID, port,
lineage). A server reading the note later would find stale or wrong data about
which sidecar it was supposed to manage.

#2641 fixes this by keying the owner-note filename by port: each sidecar now
writes to `.run/tts.owner.<port>.json`. When two instances share a `.run`
directory, each gets its own file. The sidecar-sweep logic that reads owner
notes to decide which listeners to kill also resolves the port, so it correctly
discriminates: a sweep from port 8090 reads `tts.owner.8090.json` only and leaves
`tts.owner.9000.json` untouched.

The claim is never tested by E10 — that row's setup uses **two separate
checkouts with two separate `.run/` directories**, so the fixed filename never
collided even before this fix. E10 verifies the sweep correctly uses different
ports; this row verifies the port-keying prevents collision when the run
directory **is** shared.

*Needs:* two checkouts of this repo, both with live TTS sidecars and servers on
**different ports**, both pointing to the **same `.run/` directory**. The most
straightforward setup: primary checkout at default ports (`PORT=8080`,
`LOCAL_TTS_PORT=9000`) + worktree at slot 1 (`PORT=8090`, `LOCAL_TTS_PORT=9010`),
then override both to share one `.run` by setting `APP_RUN_DIR=/abs/path/shared-run-dir` in
**both** checkouts' `server/.env` before starting, so each server will write its
owner note there instead of in its own checkout's `.run/`.

Run `npm start` or `npm run dev` in each checkout. From the primary, observe:
**(1)** `.run/tts.owner.9000.json` exists and contains the primary's sidecar PID;
**(2)** `.run/tts.owner.9010.json` also exists (written by the worktree's
sidecar) and contains a different PID. Both files coexist in the shared `.run`
directory without collision — this is the core fix of #2641. Verify by inspecting
file contents directly (e.g., `cat /abs/path/shared-run-dir/tts.owner.*.json`);
the port-keyed naming prevents the overwrite-collision that would have occurred
before this fix. 

**Note:** Verifying the port-based sweep's behavior in a shared-run-dir configuration
is not currently a safe on-box test, because the PID file (`.run/tts.pid`) is not
port-keyed — only the owner notes are. When two servers share a run directory, both
write to the same `tts.pid`, and whichever started last overwrites the first. Running
`npm run stop` from either checkout can then kill the wrong process (the one whose
PID happens to be in the file, not the one whose checkout the stop was issued from),
defeating the separation the port-keyed owner notes provide. The actual #2641 fix
(port-keyed owner-note filenames) is verified above; the sweep's correctness in
this shared-run-dir scenario will require #2641 to be extended to port-key the PID
files as well.

*Cost:* 5–10 minutes to set up and run. Needs two live sidecars on the same host.
*Criteria:* this PR's description (§On-box acceptance), the
`.run/tts.owner.<port>.json` keying in `server/src/tts/sidecar-owner.ts`
(the Node server that writes owner notes), and `scripts/lib/sidecar-sweep-port.mjs`
and `.psm1` (the sweep logic that reads notes and falls back to config).

## Group G — GitHub Actions itself

<!-- next-id: G101 -->

Not physical hardware — the prerequisite is a real dispatch of a specific workflow
on the real GitHub Actions runner, which local execution cannot substitute for
(a fresh `ubuntu-latest` image, real `GH_TOKEN`/`gh` wiring, real `apt-get`).

### G1 · Quarantine-lane health report — first live dispatch (ops-32, #1864, PR #1873) · **two distinct debts**

PR #1873's own body discloses both under "Known gaps — stated rather than
glossed" rather than leaving them to be rediscovered later.

**Partially discharged — the trigger-side dispatch question is answered; the
`gh issue view` half is not.** The Monday 03:00 UTC cron has now dispatched
the workflow for real, twice (`event: schedule`, 2026-08-03 and 2026-08-10;
latest run id `31355401008`), both `conclusion: success`. Its `Install
ffmpeg` step succeeded on the real runner, and the job summary rendered
exactly the clean no-op this row anticipated:

> \# Quarantine lane health report
>
> No quarantined tests are currently registered in
> `docs/testing/flaky-register.md` — nothing to run. Clean no-op.

`.github/workflows/quarantine-health.yml` parses as valid YAML and
`scripts/quarantine-health.mjs` is verified standalone (46 unit tests,
mutation-checked); the live dispatch now additionally confirms the job
doesn't crash on the real runner, which was the open half of this question.

**Still unverified (as of wave 3): `gh issue view` actually authenticating via
the injected `GH_TOKEN`.** Both real runs at that point took the
empty-register early-return path (`plan.outcome === 'empty'` →
`scripts/quarantine-health.mjs:979`, before the post-loop `gh issue view`
calls). `docs/testing/flaky-register.md` carries two data rows today (#1981
and #2235), but #1981 is marked "Not quarantined — still gates" and only
#2235 is quarantined, so only #2235 passes through the quarantine-lane
report. The run log does show `GITHUB_TOKEN Permissions:
Issues: read`, so the wiring is plausible — but that is not proof the call
actually works on a non-empty `gh issue view` invocation.
`continue-on-error: true` and exclusion from every required check still mean
a failure here cannot block anything.

**Genuine `intermittent` classification is exercised only by unit tests over
synthetic run sequences** — no real cross-run nondeterminism has been forced
through the classifier. This needs an *actual* flaky quarantined test
present in `docs/testing/flaky-register.md` at dispatch time, which the
empty register doesn't provide today — the first dispatch alone won't
discharge this half. **What to observe, next time a genuinely flaky test is
quarantined:** its row in the report's table lands in the `intermittent`
bucket (a real mix of passed/failed across the 5 runs), not `always-passes`
or `never-passes` — confirming the bucket that is this tool's entire reason
to exist actually fires on real data, not just the synthetic sequences in
`scripts/tests/quarantine-health.test.mjs`.

**Net: this row shrinks but does not come out.** The trigger-side dispatch
question above is answered — the workflow runs clean on the real runner —
but its residual (`gh issue view` under real auth) now shares a single
precondition with the second debt below: a real quarantined row in
`docs/testing/flaky-register.md`. Neither remaining half can move until one
exists.

*Why this sits here and not as a plain automated-test-gap issue* (per this
file's own closing rule below): this is NOT closable by writing more unit
tests — `classifyEntry` is already fully unit- and mutation-tested against
every synthetic sequence that matters. What's missing is a real occurrence
of cross-run nondeterminism, which by construction can't be manufactured or
asserted inside a unit test; the only way to discharge it is to observe live
data once it exists, the same shape as any other row in this register, just
triggered by an external event (a future genuine flake) rather than a
hardware prerequisite. One honest caveat: unlike G1's first debt, this half
does NOT strictly require the GitHub Actions runner — a local
`node scripts/quarantine-health.mjs` run against a real flaky register row
would equally discharge it. It stays grouped under G1 anyway because it
shares G1's dispatch-triggered, opportunistic-timing framing and "what to
observe" shape, not because Group G's runner criterion technically applies
to it.

*Needs:* a real quarantined flaky test (naturally occurring, not
manufactured) — the shared precondition left for both remaining halves.
*Cost:* opportunistic — piggy-back
on the next real quarantine event rather than manufacturing one.

> **Wave-3 step 8, 2026-08-20 — STILL OWED-blocked, both debts, on new live
> evidence.** This row's "flaky register carries one row today (#1981)" text
> above is now stale — corrected here rather than silently: `#2235` has been
> a real quarantined row since 2026-08-13, so the precondition both debts
> share has existed for a week. But `gh pr view 2488` shows PR #2488 (parses
> the register's real test-cell format) is still **OPEN** and `gh issue view
> 2465` (parseRegister drops every real register row) is still **OPEN**.
> Live-checked, not theoretical: the 2026-08-17 scheduled dispatch
> (`databaseId 31992063988`, off a commit descending from #2235's own
> quarantine commit) reported a clean "nothing to run" no-op — `#2465`
> silently dropping a real quarantined row **in production, today**. Because
> the run took the empty-register path, the post-loop `gh issue view` calls
> were never reached — debt 1 remains unreachable — and the `intermittent`
> classification (debt 2) is blocked for the identical reason. Both verdicts
> unchanged from STILL OWED-blocked; the live dispatch sharpens the evidence
> from "the fix will unblock this" to "the bug is actively dropping a real
> row today." `docs/testing/onbox-wave3-results/step-8-group-g.md`.
>
> **Correction, 2026-08-20 (rework of wave-3's own recording, `#2497`).** The
> step-8 note above captured PR #2488 and issue #2465 as **OPEN** roughly 15
> seconds before #2488 actually merged, and step 9's fold carried that stale
> "OPEN" forward without rechecking. Live-rechecked now: PR #2488 **MERGED**
> 2026-08-20T06:45:02Z (`gh pr view 2488`), and issue #2465 **CLOSED** the
> same second (`gh issue view 2465`) — see [#2488](https://github.com/dudarenok-maker/Castwright/pull/2488),
> [#2465](https://github.com/dudarenok-maker/Castwright/issues/2465). Blocking
> precondition (b) — the `parseRegister` fix landing — has therefore cleared.
> This does **not** discharge G1: neither debt has actually been re-observed
> under the fixed code yet — the two real dispatches captured above both
> predate the merge, and no scheduled or manual dispatch has run since. The
> row's disposition changes from **STILL OWED-blocked** to **STILL
> OWED — unblocked**: the next real dispatch (the following Monday 03:00 UTC
> cron, or an earlier manual `workflow_dispatch`) against the still-live
> `#2235` quarantined row is what would actually discharge debt 1 (`gh issue
> view` under real auth) and, opportunistically, debt 2 (`intermittent`
> classification on real data).
>
> **Wave-4 step 1, 2026-08-21 — debt 1 DISCHARGED, debt 2 STILL OWED.** A
> genuine post-fix manual dispatch (run id `32426439853`, `event:
> workflow_dispatch`, created 2026-08-20T22:55:36Z, after PR #2488's
> `ff4fec58` merged) confirmed a non-empty `parseRegister` return before
> dispatching, then reached the post-loop `gh issue view` calls for the first
> time in this workflow's life: the job summary table shows real `CLOSED`
> values for both `#2226` and `#2235`, a live value only a real, authenticated
> `gh issue view` call can produce. **Debt 1 is DISCHARGED.** **Debt 2 is
> STILL OWED**: the run's 5 repeats of `#2235` all landed `always-passes`
> (5/5) — a real verdict, not an `unknown`/runner failure, but per this row's
> own criteria a clean 5/5 does not discharge the `intermittent` bucket
> (needs an actual pass/fail mix). What would discharge it next: a dispatch
> that happens to run concurrently with other runner load, more likely to
> surface the contention-dependent race. **New finding, not yet reflected
> anywhere else:** the job summary itself flags both `#2226` and `#2235` as
> "orphaned debt with no owner" — both tracking issues are CLOSED while their
> quarantine-lane rows are still live. Full evidence:
> `docs/testing/onbox-wave4-results/step-1-g1-live-dispatch.md`.

### G2 · The published release body now comes from the committed file, not the tag annotation ([#2137](https://github.com/dudarenok-maker/Castwright/issues/2137), PR #2168)

`release.yml` validated `docs/release-notes-next.md` at the tag ref but published
the tag's *annotation* — a different string, with nothing verifying the two
agreed. This PR sources the body from the committed file, runs the same
BOM / conflict-marker / mojibake checks against the annotation, and **fails the
release closed** when file and annotation diverge.

**Every part of that is unexercised until a real tag push.** `scripts/release-body.mjs`
is covered standalone by `scripts/tests/release-body.test.mjs` (throwaway git repos,
real annotations), but the live path — the workflow step actually invoking it on
`ubuntu-latest`, the `actions/checkout` + "Restore annotated tag" dance leaving
`%(contents)` readable, `docs/release-notes-next.md` actually being present in that
checkout, and `gh release create --notes-file release/tag-notes.md` receiving the
file this step wrote — is not.

**This row carries more risk than most in this register: a false positive BLOCKS
the release outright.** The divergence check is fail-closed by design, so a
normalisation bug or a checkout that lacks the notes file does not degrade the
body — it stops the cut. That is the correct posture, and it is precisely why the
first live run needs watching rather than assuming.

Pre-merge evidence, gathered rather than asserted — the **shipped**
`resolveReleaseBody()` replayed against the last 12 real tags (not the test
suite's own fixtures; the production function fed each tag's real annotation and
real committed file):

- `v1.14.0`, `v1.13.0`, `v1.12.3`, `v1.12.2`, `v1.12.1`, `v1.12.0`, `v1.11.0`,
  `v1.10.0`, `v1.9.0` → **publish from FILE**. The normal path, 9 consecutive
  recent releases.
- `v1.8.0` → **BLOCKED**. Annotation is the bare placeholder `Castwright v1.8.0`
  (18 B); file is 3,060 B of the *previous* cycle's notes, headed
  `# Castwright v1.7.0`. Publishing the file would have shipped v1.7.0's notes.
- `v1.7.0` → **BLOCKED**. File 3,060 B vs annotation 6,757 B — the same stale
  file, against an annotation carrying the real notes.
- `v1.6.0` → file absent at that ref → **publish from ANNOTATION** (rule 2).

All four rules exercised against real history. Note that **two** historical
releases genuinely diverged: at v1.7.0 and v1.8.0 the published body was not the
file the gate had validated. This issue is not hypothetical, and the nine
consecutive agreements since suggest the modern cut path is sound — so a spurious
block on the next cut is unlikely, but not proven until observed.

**What to observe, at the next real release cut:**

1. The `publish` job's release-body step exits 0 and logs which source it chose —
   expected: **the file**, not the annotation.
2. The published GitHub release body is the full notes, not the one-line
   `Castwright vX.Y.Z` placeholder and not empty. Compare it against
   `git show <tag>:docs/release-notes-next.md`; they must match.
3. The annotation checks ran and passed — visible in the step's output, not
   silently skipped.
4. If the step instead **fails**, that is a real signal, not noise: read the
   message, which names both sources and their sizes, and decide whether the tag
   or the file is wrong before overriding anything.

*Needs:* nothing beyond a real `vX.Y.Z` tag push — i.e. the next release cut.
*Cost:* zero extra; it is observed as part of a cut that was happening anyway.
*Discharges when:* one real release publishes with a body sourced from the file
and the observations above are recorded here.

> **Wave-3 step 8, 2026-08-20 — STILL OWED, no opportunity yet.** PR #2168
> (the fix under test) merged 2026-08-06. Live-checked: `v1.14.0`, the
> latest and only candidate anywhere near the fix, was tagged 2026-07-23 —
> **two weeks before** the fix merged, so its published body was produced by
> the pre-fix path and cannot exercise this row. No tag has been pushed
> since. Unchanged from opportunistic framing; no manufacture attempted
> (box-safety: a false positive here blocks a real release).
> `docs/testing/onbox-wave3-results/step-8-group-g.md`.

---

## Group H — no hardware, needs a real CJK manuscript this corpus lacks

<!-- next-id: H101 -->

Not a hardware prerequisite at all — the blocker is a real-book fixture this
repo's corpus doesn't currently have. `detectManuscriptLanguageFromChapters`
needs no GPU, sidecar, or analyzer; it is a pure function over chapter text,
runnable on any machine (`npx tsx` against a real manuscript's chapters, or a
dry-run `npm run repair:book-language` pass over a real imported book).

### H1 · Kana-trigram richness gate holds at real-book scale for an all-kana (no kanji) Japanese manuscript (#2256 round 3, finding 3(b)/C5)

`server/src/tts/prose-units.ts`'s kana tokenizer (overlapping character
trigrams, replacing per-character tokenization) is verified only against an
own hand-authored synthetic all-kana fixture — 30 distinct hiragana base
words composed into 1,500 sentences, `detect-language.test.ts`'s
`finding 3(b)` fixture — not a genuine all-kana book. The fix closes the
SPECIFIC real
failure the original #2256 finding reported (a real book at N≈4,843
characters, old per-character scheme measured R=1.72, refused) using the
finding's own reported number as an anchor, but this repo cannot reproduce
that exact book to re-measure it directly, and the synthetic fixture's
margin is known to be vocabulary-dependent and thinner than Han-based CJK's
(round-3 finding C5 additionally found the richness gate is close to inert
for kana beyond what `dedupeProseUnits` already catches — see
`prose-units.ts`'s own finding-3(b) block for the honest numbers, all of
which round 4 re-measured against the fixture actually in the tree).

**What to observe, once a real all-kana Japanese manuscript is available**
(a children's book or early-reader text with no kanji at all is the
realistic shape — this repo's two real Coalfall Commission translations at
`C:\AudiobookWorkspace\books\Castwright\Standalones\{煤落的委托,
コールフォールの依頼}\manuscript.md` are real CJK text but MIXED kanji+kana,
not the all-kana case this row is about):

1. Run the manuscript's chapters through `detectManuscriptLanguageFromChapters`
   (or a full `POST /api/import`) and record the result — expected:
   `{ language: 'ja', supported: true, fallback: false }`.
2. Separately call `guiraudR` on the same (deduped, per
   `dedupeProseUnits`) winning sample and record the actual value against
   `LEXICAL_RICHNESS_FLOOR` (3) — a real number at real scale, not the
   30-word synthetic fixture's.
3. If the book has multiple chapters, note the total combined character
   count the richness gate actually saw (no cap applies post-#2256 round 3 —
   see `prose-units.ts`'s finding-3(a) retraction) — the margin at that
   real scale is the actual thing this row exists to confirm.

*Needs:* a real, legally usable all-kana (no kanji) Japanese manuscript —
no GPU, sidecar, or analyzer.
*Cost:* one `detectManuscriptLanguageFromChapters` call plus recording the
observed `R`/`digitTokenShare` numbers here.
*Discharges when:* a real all-kana manuscript has been run through
detection, the result and the observed `R` are recorded in this row (or a
dedicated run sheet this row is updated to point at), and either the
current trigram fix is confirmed sufficient at real scale or a follow-up
issue is filed with the real numbers that show it isn't.

### H2 · Lexical-richness floor still clears on a FULL-LENGTH real Han (Chinese) book (#2256 round 4, finding B3)

`voteLanguage` measures the two lexical gates over the whole joined winning
sample with **no length cap** — round 2 added one, round 3 removed it
because the cap made the verdict chapter-order-dependent. Removing it is
right for that reason, which is measured. What is NOT measured is the thing
the cap was originally added for: Guiraud's R is `V / sqrt(N)`, and `V`
saturates while `N` keeps growing, so R decays with book length.

Round 3 recorded a direct measurement of "the corpus's 815k-char worst case
→ R≈4.4" as the justification for removing the cap. **Round 4 could not
reproduce that number from anything in this repo, and it has been deleted
rather than restated.** What this repo can actually reach:

- the two real Coalfall Commission translations (read-only,
  `C:\AudiobookWorkspace\books\Castwright\Standalones\{煤落的委托,
  コールフォールの依頼}\manuscript.md`) — R = **12.078** (zh, 4,425 Han
  characters, 795 distinct) and **27.302** (ja mixed, 7,797 chars);
- no synthetic substitute: a 30-word-pool zh narrative at 21,711 characters
  measures R = **1.581** and is *refused*, because a hand-authored pool
  reaches ~250 distinct Han characters where real Chinese prose reaches
  thousands. A synthetic large-N fixture measures its own vocabulary, not
  the gate.

So the largest real Han sample this repo can measure is ~4.4k characters,
one to two orders of magnitude short of a book.

**What to observe, once a full-length real Chinese manuscript is available:**

1. Import it (or run `detectManuscriptLanguageFromChapters` over its
   chapters) and record the result — expected
   `{ language: 'zh', supported: true, fallback: false }`.
2. Record the **combined character count** of the joined winning sample the
   gates actually saw (every winning chapter's `prepareSample` output, each
   capped at 20,000 chars, joined) and the **observed `guiraudR`** on it,
   against `LEXICAL_RICHNESS_FLOOR` (3).
3. Record the **distinct-Han-character count** at that scale. That is the
   `V` in `V / sqrt(N)` and it is the whole question: at N = 400,000, R
   clears the floor only if V is above ~1,900.

*Needs:* one real, legally usable full-length Chinese (Han) manuscript —
no GPU, sidecar, or analyzer.
*Cost:* one detection call plus recording three numbers here.
*Discharges when:* a full-length real Han book has been run through
detection and its N, V and R are recorded in this row — either confirming
the uncapped gate clears the floor at book scale, or showing it does not,
in which case a follow-up issue owns re-introducing a length correction
that is NOT a chapter-order-dependent prefix.

---

## Blocked — hardware not available

### AMD GPU support Phase 2 ([#1335](https://github.com/dudarenok-maker/Castwright/issues/1335))

Waves A–G were built and merged **dormant** — the code path exists but has never run
against real ROCm hardware. A dormant capability, not an active bug. This box is
dual-NVIDIA; this will not move until AMD/ROCm hardware exists.

### ORT pip-consistency marker — AMD box ([#2192](https://github.com/dudarenok-maker/Castwright/issues/2192), plan [282](../features/282-ort-pip-consistency-marker.md))

Design doc §On-box acceptance, criterion 5: "no marker is written" on AMD.
`planOrtSwap('amd', …)` resolves to plain `onnxruntime` (`accelerator-profile.mjs`),
so the AMD profile takes the `marker.action === 'delete'` branch — the same branch
cpu and apple take, both of which this box CAN exercise. What is genuinely
AMD-specific and unverified is the ordering that branch exists to protect: the
AMD→ROCm-failure→CPU fallback inside `bootstrap-venv.mjs`'s `installForProfile`
(`cpu.txt` carries an **explicit** `onnxruntime` line the fallback needs to actually
install; a stale marker present at that moment would make pip silently skip it).
That fallback only fires on real AMD hardware attempting a ROCm bootstrap that then
fails over to CPU — nothing on a dual-NVIDIA box can reach it. Dormant, not broken:
the delete-at-entry ordering (invariant 3 in the plan doc) is unit-tested via the
injected `runPip`/marker seam, just never against a real ROCm→CPU fallback. This box
is dual-NVIDIA; this will not move until AMD/ROCm hardware exists. Run sheet §7 in
`docs/testing/ort-marker-onbox-acceptance.md` has the recipe ready for when it does.

### CPU-only `RAM_HEAVY_MODELS` clamp (plan 263, B2 step 7)

Formerly step 7 of B2 (per-model analyzer keep-alive). A `RAM_HEAVY_MODELS`
clamp is meant to override a configured positive keep-alive back to `0` when
the analyzer runs CPU-only. Dormant on this box: two resident NVIDIA GPUs
mean `accelerator` in `server/src/analyzer/ollama.ts` structurally resolves
to `'cuda'`, and forcing `'cpu'` would require disabling GPU visibility,
risking other lanes' concurrent work — not attempted. This box is
dual-NVIDIA; this will not move until a CPU-only box exists, or one where
GPU visibility can safely be disabled.

### ops-36 golden-assembly on a second ffmpeg build ([#1880](https://github.com/dudarenok-maker/Castwright/issues/1880), plan [272](../features/272-golden-assembly-comparison.md))

**1. What is dormant.** The cross-build half of the ops-36 design — whether
L1/L2/L3's hard assertions survive a genuinely different ffmpeg build, and
what L4-loose's RMS-error actually is when the encoder really differs. What
is *not* dormant: the LOOSE branch itself was forced during the ops-36
demonstration with a synthetic banner mismatch plus 2.0 LU of drift and
rejected at 24.79% RMS-error against a 16% tolerance. Only the
genuinely-different-encoder case is unproven.

**2. Why this box cannot reach it.** Verified by wave-3 step 7
(`docs/testing/onbox-wave3-results/step-7-e7-e8.md`): no Docker, no WSL, no
container runtime of any kind on this box, and the only other `ffmpeg.exe`
present (the WinGet package) is the same `8.1.1-full_build-www.gyan.dev`
binary already on `PATH` — not a different build. The tier also sits outside
`verify.yml`, so CI never exercises it either.

**3. What would change that.** A second machine with a different ffmpeg
build (e.g. a BtbN Windows build vs. this box's gyan.dev one, or a clearly
different version), or a CI leg on a runner whose ffmpeg differs from this
box's. This box is single-ffmpeg; this will not move until one of those two
options exists.

**4. Alternative considered and rejected, recorded so it is not
rediscovered.** A portable ffmpeg build unpacked to a scratch directory and
prepended to `PATH` for the duration of one command would change the banner
on *this* box, since every server ffmpeg call spawns the bare string
`'ffmpeg'` (`server/src/export/build-m4b.ts:336`,
`server/src/routes/clip.ts:104`, `server/src/audio/measure-loudness.ts:83`),
which resolves through `PATH`. **The owner ruled on 2026-08-21 that this does
not satisfy the row's intent** — the row means a different environment, not
a different binary on the same one. Recorded here as a neutral decision so a
future reader can reverse it deliberately rather than stumble into it.

### ops-35 ffmpeg floor — below-floor + Re-check walkthrough ([#1877](https://github.com/dudarenok-maker/Castwright/issues/1877), plan [269](../features/269-ffmpeg-version-floor.md))

**1. What is dormant.** The below-floor preflight exit (`npm run test:server`
must exit 1 against ffmpeg 4.4, printing the host OS's upgrade command); the
amber outdated Setup Wizard card (`data-testid="step-ffmpeg-outdated"`) plus
`GET /api/setup/readiness` reporting `ready: true` with
`blockers.ffmpeg.status === 'warn'`; the Admin diagnostics `warn` row and the
top-bar Admin health dot going and staying amber; and the Re-check-without-
restarting-the-server flip back to green — plan 269's invariant 6, described
in the row as "the most interesting part." Also owed and not coverable on
this box: the Pinokio `"ffmpeg>=6"` constraint on a real conda env, install
and update.

**2. Why this box cannot reach it.** Every unit test drives the floor through
a **mocked** `spawnSync`, so nothing has been exercised against a real old
ffmpeg binary — and per wave-3 step 7's verification (shared with the
ops-36 golden-assembly blocked row, above), this box has no ffmpeg swap
available and no container runtime of any kind,
so there is no way to put a genuinely-below-floor ffmpeg on `PATH` here.

**3. What would change that.** A box or container where ffmpeg can be
downgraded to a real pre-floor build — the row itself names a 22.04
container with archive ffmpeg 4.4 as the cheapest route.

---

## Unconfirmed — not debts until substantiated

Kept separate on purpose. Listing a suspicion as debt is how a register stops being
trusted.

- **fs-38 Wave 1** (designed-voice authoring, PR #1800) — no explicit owed callout
  beyond a generic "Live-GPU acceptance" line in plan 194 that is about cloning
  generally (Wave 3's concern), not marked outstanding the way 267/268/264/216/263
  are. Closed bugs #1802/#1833/#1836 show live "My voices" use, consistent with it
  being exercised informally. Not confirmed either way.
- **Ollama concurrency (K>1) real-VRAM validation** — PR #1707 fixed a case where K
  never took effect and ships `peak==K` telemetry so a future run self-verifies. The
  UI half is B1's K=4 step. If a separate `n_slots=1` physics check is owed, its
  written criteria were not found in this repo — do not double-count it.

---

## Deliberately not in this register

- [#1826](https://github.com/dudarenok-maker/Castwright/issues/1826) — its bar is an
  automated interleaving regression test, not a manual walkthrough.
- [#964](https://github.com/dudarenok-maker/Castwright/issues/964) (fs-48 Fish Audio)
  and [#1334](https://github.com/dudarenok-maker/Castwright/issues/1334) (fs-73 Cast
  Pass) — parked or unbuilt. Pre-implementation criteria, not debt on shipped code.
- [#819](https://github.com/dudarenok-maker/Castwright/issues/819) — `moscow:wont`.
- Archived plans whose prose still says "owed" but whose debt was discharged via a
  separate, un-cross-referenced issue — confirmed closed for plans 210 (#752), 214
  (#397), 219 (#823), 193 (#476), and 181 (#1670/#927/#515/#517).

This register is for **manual, hardware-dependent verification of shipped code**.
Automated-test gaps belong in the plan's test section or an issue.
