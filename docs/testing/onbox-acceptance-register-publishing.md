# Publishing the on-box acceptance register's live view

This is the full runbook for the [on-box acceptance register](onbox-acceptance-register.md): how its live view is stamped, checked and published, what each check failure means, and how row IDs are allocated. The register itself keeps only a summary. Where this text says "this file" or "this register", it means the register; "Retired carried rows" is a section of the register.

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

The token is now LIVE: `npm run check:onbox-register -- --stamped-since <ref>`
(#3116) checks in CI that the live view's content did not change without the
counter moving — catching cases where a branch reverts the live view to an
older revision, or where a conflict was resolved by taking one side wholesale
over the other. The check reads the base ref's copy and the working tree's,
which CI makes `merge(base, head)`, and **enforces it as a merge gate** (PR #3236
folds the check into `verify.yml`'s required `lint-and-checks` job).
In CI, `<ref>` is `HEAD^1` (the base branch's tip at merge time). **By hand,
never pass `HEAD^1`**: outside CI's merge commit it need not be the base your branch
will merge onto, so the check can fail to catch an unstamped edit — for example
when `HEAD^1` already contains the edit, or when a stamp main landed in between
is credited to your branch. Instead, merge the target in and pass it explicitly
(`git fetch origin && git merge origin/main`, then
`npm run check:onbox-register -- --stamped-since origin/main`); that reproduces
CI's comparison.
**Any PR that changes the live view's RENDERED content must re-stamp it** — this
includes any markdown-only edit that moves a count. After a markdown edit that
changes any generated figures, run `npm run register:build` locally (it regenerates
the summary strip and derived counts), then `npm run stamp:publish-token` to bump
the live view's publish counter. Skip the rebuild and CI's `register:build --check`
will fail (generated figures stale); skip the stamp and `--stamped-since` will fail
(content changed without re-stamping).

The live view carries derived figures — owed count, per-group counts, oldest
debt — that are **generated** on every build. Rows can be right while the
summary strip lies. `npm run register:build` generates the summary strip and all
its derived figures; `npm run check:onbox-register` verifies the row IDs are
unique across the document and that each group's `next-id` marker (and the
`BLK` / `UNC` marker of the Blocked and Unconfirmed sections, once they carry
one) sits at or above the shared allocation floor (never that a row ID itself
sits below the floor — the floor gates the NEXT id a group may mint, not the
ids already in use), and that each group's glance-table count matches the rows
in its body section. Both fail CI when rows are added, removed, or miscounted, so
**adding or removing a row here and missing the live view build fails CI**.
Know its edges, because three of them are wide:

- **A wording-only edit to ANY row does not fail.** Rewording a row (`A12`,
  `E9`, `BLK101`, `UNC101`, …), recording a run result, changing a hardware
  note or a criteria link — the most common edit this register gets — changes
  nothing either check compares, since every row, Blocked and Unconfirmed
  included, is matched by ID. The live view mirrors that prose in its own row
  bodies and will silently fall behind (the generator does not rewrite a
  row's title if you changed only the body; it preserves hand-authored
  titles). Mirror the edit into the live view yourself.
- **The markdown's own `## At a glance` table is hand-maintained input, not
  generated output — only the LIVE VIEW's mirrored glance table and strip are
  generated.** `register:build` reads the markdown's `## At a glance` table
  and body sections and writes the live view's HTML; it never writes back
  into the markdown. Adding, removing, or reordering a row still requires
  hand-editing the markdown's own glance-table row count for that row's
  group — `check:onbox-register` fails ("glance table says N, body has M
  rows … Update the table or the body") if you forget. Only the generated
  *HTML* summary strip and per-group `gcount`/glance-table-cell regions are
  off-limits to hand-editing; rebuild those with `register:build` instead.
- **The published page is invisible to CI checks.** Both `register:build` and
  `check:onbox-register` read only the two TRACKED files, so "was it published at all, and
  was it the right file?" is procedure, not that gate — see the merge step
  below, which gives the specific stale-snapshot race mechanical teeth via a
  second, explicit mode (`--against-published`), but still can't verify by itself that someone ran it.

**`npm run check:register-row-citations` (#2831) — a separate, narrower
check.** `check:onbox-register` above only validates the register's own
internal arithmetic; it says nothing about the `A\d+`/`E\d+` row IDs cited
*elsewhere* in the repo. `check:register-row-citations` closes that gap for
one specific, bounded surface: it scans every `.md` file under
`docs/testing/**` and `docs/features/**`, except the frozen dated-transcript
paths (`docs/testing/onbox-acceptance-staleness-audit.md` and the `onbox-wave{3,4,5}-results/`
directories), for a citation matching `row/Row <ID>` or a markdown link into
this file's own `#a41`/`#e3` anchor, and fails if the cited ID has no current row heading here. A bare `A41`-shaped
token with neither a "row" word nor a register link is never treated as a
citation. GitHub issue bodies are explicitly OUT of scope for v1 — that would
need `gh` API access from a CI script, disproportionate for this pass. A
citation whose own logical line (including hard-wrapped continuations) contains
a discharge/removal annotation is printed as a note, not failed — this register's
own body is full of exactly that shape ("register row A43, discharged 2026-08-26,
removed from the register"), and those are intentional history, not drift. A
"nearest citation to the left" rule ties each annotation to its nearest preceding
citation, preventing cross-contamination when multiple citations appear on the
same line. **Deliberately NOT this
checker's job:** confirming the citing prose's *description* of a row still
matches that row's current title — only that the ID it names still exists.
That stronger check ("title-text matching") is a genuinely separate,
harder-to-build capability, filed as its own follow-up rather than attempted
here — see #2838. This is a different script from the older, broader
`scripts/check-register-citations.mjs` (`npm run check:register-citations`,
#2629/#2630), which scans the whole repo tree with a much larger citation
surface and its own discharge/run-sheet/subject-conflict machinery — the two
are complementary, not a replacement of one by the other, and neither script
should be renamed to match the other's npm script name.

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
   `npm run check:onbox-register -- --against-published <saved-file>`. This
   comparison detects structural drift (rows live vs. in register), and — when
   the live-view baseline from `origin/main` is available — also detects
   content drift (per-row body text hash comparison). A published body equal
   to an OLDER version of that row on `origin/main`'s recent first-parent
   history is treated as behind main (#4105), unless main's current body of
   the row also appears at or before the newest commit carrying the published
   body (then main went back to it: a revert). Behind main passes, with a
   non-failing advisory naming the commit the live body matches and the
   commits that changed the row since (a hand-restored old body reads the
   same, so the advisory is its only trace). A revert, a body only an unmerged
   lane carried, and a row some version in the window cannot vouch for stay
   drift, and the drift line names that commit (a version unreadable only for
   OTHER rows does not count; a deleted file is "row absent", not unreadable).
   The mirror image fails, decided from the merge base: when this branch has
   not merged the current `origin/main`, any tracked row that differs from
   the live page and is not main's, and that main has since changed, added
   after the base, or removed (a discharge) relative to
   `git merge-base HEAD origin/main`, is refused unless the live page
   already carries your tracked body (`branch-behind-main`, with the reason;
   a row absent at the base and absent on main, your own new row, is never
   refused; a merge base that cannot be found or read, as in a shallow
   clone, fails closed). The no-flag run also rejects a tracked live view
   whose row markup the drift check cannot read. Your register having rows
   the live page doesn't have yet is the normal reason you're publishing, not a
   defect, so it is never reported here. A row (or group) the live page has that
   your register lacks is reported when `origin/main`'s own copy of this
   register still has it too — the signature of another lane having already
   published ahead of you. When `origin/main` also lacks it, it is not
   reported if `origin/main`'s register has **ever** carried that row ID on
   `main`'s own first-parent line, or if the row is listed under "Retired
   carried rows" below. "Ever carried" means a register `main` itself held:
   a commit on a merged PR's branch does not count, so a lane that minted an
   ID and renumbered it before merging (#3525's B103) never exempts the other
   lane's live copy. A row `main` held and then dropped was discharged there,
   whoever published the page. Two rare cases still read as a discharge.
   Two lanes mint the same ID, one reaches `main` and is discharged there,
   and the other's copy is still live; both lanes must have slipped past the
   live-collision and merged-lane collision checks for that to happen. And
   `main` merges a lane's row and then reverts that merge, and a lane
   re-landing the row publishes it: its live copy reads as discharged until
   the re-land merges.
   Otherwise **who published the live page decides** (#3529). The check finds the commit that stamped the page's
   `data-publish-id`: the **oldest** commit that introduced it, which is the
   commit step 3's `git log --all -S` names, never the merge commit that later
   brought it to `main`:
   - **reachable from `origin/main`** (a merged publish), or **in your own
     branch's history** (your earlier publish): a row that commit's live view
     carried is a deliberate discharge, or your own row you have since
     dropped, and is not reported. A row that commit did NOT carry rode in on
     a union publish for another lane, and FAILS as `unmerged-lane-row`.
   - **on another branch only** (an unmerged lane published): every such row
     is that lane's and FAILS as `unmerged-lane-row` — a brand-new group
     letter included, and so does a row in a group this register has dropped
     entirely, where `--discharging` silences only rows `origin/main` still
     has.
   - **in no history this checkout has**: FAILS as `unknown-provenance`.

   Blocked and Unconfirmed rows carry `BLK` / `UNC` IDs, so they are compared,
   carried and unioned exactly like lettered rows. A live page published
   before #3587 still has legacy `—` rows in those two sections; they have no
   ID, so the comparison cannot see them, and `--against-published` prints an
   advisory (non-blocking) warning naming the count. Read those sections on
   the live page by hand until a publish replaces it.

   A row ID you share with the live page under a different title FAILS as
   `row-id-collision` (unless the page is your own earlier publish and its
   stamp carried that row — then it is your retitle), and so does one you
   share with `origin/main` under a different title when the merge-base your
   branch forked from lacks it (the other lane merged first). To publish a
   **union** — your rows plus another lane's — build it with
   `--build-union <out>` (see step 3) and pass the file you are actually
   publishing with `--publishing <file>`: the check then requires that file to
   be exactly your tracked `.html` plus the carried rows' live blocks, with
   the derived figures regenerated.
   **The command fetches `origin/main` itself, fresh, every run — you do not
   need to `git fetch` by hand first.** It then reads `FETCH_HEAD`, deliberately
   NOT the local `origin/main` ref: `git fetch origin main` only guarantees it
   writes `FETCH_HEAD` — whether it also updates `refs/remotes/origin/main`
   depends on this checkout's `remote.origin.fetch` refspec actually mapping
   `refs/heads/main`, which a narrowed refspec can skip while the fetch still
   exits 0, leaving `origin/main` silently stale even though the fetch just
   "succeeded". If you ever need to reproduce this baseline by hand for
   debugging, run `git fetch origin main` followed by `git show FETCH_HEAD:<path>`
   — NOT `git show origin/main:<path>`, which can read stale (or, in a
   narrowly-configured clone, entirely unresolvable) content even immediately
   after a successful fetch. It follows that this step needs network access to
   `origin`, with no offline fallback: you're about to publish to a remote URL
   anyway, so an operator who can't reach the network here can't complete step 4
   either.
3. **If it fails**, do NOT publish. There are several distinct failure shapes,
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
   - **`unmerged-lane-row: <ID>`** (#3529) — the live page carries a row that
     belongs to a lane `origin/main` has not merged. The error names the row's
     **owner**: the oldest commit that introduced the live row itself, found
     by its ID and title (never a commit `origin/main` already contains, and
     never another lane's row under the same ID), with the branches that hold
     it and the `gh pr list --state all --search <commit>` that finds its PR.
     It never names whoever merely carried the row in a union. Publishing your
     tracked file would delete the row. It is not yours, so **never name it in
     `--discharging`**. Do one of three things. **The exception:** a row in a
     group your live view has no section for (that lane added a new group
     letter) cannot be carried. `--build-union` refuses it and `--publishing`
     refuses a hand-carried copy, so only the last two options apply, and no
     other lane can publish until one of them happens.
     - **Build the union and publish that.** Re-run step 2 with
       `--build-union <out>`, e.g. `npm run check:onbox-register --
       --against-published <saved-file> --build-union <scratch>/union.html`.
       It writes your tracked `.html` plus each such row's live block, copied
       verbatim and placed in ID order, with the derived figures (owed count,
       the group's glance-table count and `gcount`) raised by one per carried
       row. It then checks that file exactly as `--publishing` would. If that
       passes, publish **that file** in step 4. Never hand-build or hand-edit
       a union: `--publishing` refuses anything but this exact file. On
       2026-10-07 the union was assembled by hand in a throwaway worktree and
       its strip figures were edited by hand. That file happens to equal what
       `--build-union` writes, but nothing checked it at the time.
     - **Let that lane merge first.** Coordinate through its PR.
     - **Retire the row.** If its PR was closed without merging, add the row
       to "Retired carried rows" below, under that PR.
   - **`publishing-file: <ID>`** — the `--publishing` file is not exactly the
     union: it drops or alters one of your tracked rows, carries a row that
     is not on the live page, carries a live row with changes (another lane's
     row is that lane's to edit), or its derived figures differ from the
     regenerated ones. Rebuild it with `--build-union <out>`.
   - **`retired-carried-row: <ID>`** — a "Retired carried rows" entry the
     check will not honour: its PR is open or merged (an open lane's row must
     still be carried), `gh` could not read it or did not report its whole
     commit list, the PR does not own the row, or the table is malformed. The PR
     owns the row when the commit that introduced the live row, the one
     `unmerged-lane-row` names, is one of the PR's own commits. The list is
     read through paginated GraphQL (`gh api graphql --paginate`), because
     `gh pr view <N> --json commits` stops at the first 100 commits (#3505 has
     120); a list shorter than the PR's `totalCount` is refused as
     incomplete, not as "names the wrong PR". Branch names play no part. The
     PR's own commits are searched too, so a deleted branch or a fork's
     needs no local ref. When this checkout has neither that commit nor the
     PR's commits, the owner cannot be determined and the entry is refused:
     run `git fetch origin` and re-run. Fix or remove the entry. When `gh`
     is unavailable, the entry is accepted with a **`retired-row-warning`**
     instead. Confirm by hand that the PR is closed unmerged (`gh pr view <N>
     --json state,mergedAt`) and that one of its commits introduced the row
     (all of them, not `gh pr view`'s first 100) before you publish.
   - **`row-id-collision: <ID>`** (#3529) — another lane allocated the same ID
     for a different row: either it is live under another title, or it is on
     `origin/main` under another title and absent from the merge-base you
     forked from. Renumber YOUR row to the ID the error names (it clears your
     `next-id`, the live page's highest ID and `origin/main`'s `next-id`),
     bump your `next-id`, and re-run.
   - **`unknown-provenance`** (#3529) — the live page's publish id is in no git
     history this checkout has (an unfetched branch, or a hand-published page),
     or the page has no token, and a live row's verdict depended on it; or the
     merge-base could not be read while `origin/main` carries one of your row
     IDs under another title. The check refuses to guess. Fetch every branch —
     `git fetch origin '+refs/heads/*:refs/remotes/origin/*'` — and re-run.
     If a live row is still undecided, do not drop it: carry it with
     `--build-union <out>` (as for `unmerged-lane-row`) and publish that file.
     For the merge-base case, run from a clone with full history.
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
   - **A row's content has drifted** (#2599/A41) — the row exists, with the
     SAME ID, on both the tracked `.html` and the currently-published page,
     but its own body text hashes differently between the two. This is a
     DIFFERENT check from the BEHIND check above: it compares your local,
     working-tree copy of
     `docs/testing/onbox-acceptance-register-live-view.html` (including any
     uncommitted edits mid-publish) against the published snapshot, not the
     register — hashing the register's markdown against the published HTML
     would flag almost every row, since the two are deliberately different
     documents that only have to agree on structure, not wording. When tracked
     and published content differ, the check disambiguates via the baseline
     (`origin/main`'s copy) to tell a genuine defect apart from an ordinary
     in-progress publish:
     - **Your local copy matches the baseline, but the published page doesn't**
       — **two opposite situations produce this one signature, and the check
       cannot tell them apart.** Establish which one you are in before you
       touch anything; do not publish under either until you have.
       - **The live page is BEHIND** — an edit already merged to `origin/main`
         never reached it. This is the classic A41 signature: PR #2578 review
         rounds 13-18 caught it only by manually byte-diffing the two files,
         because nothing mechanical compared row content before this check
         existed. A genuine defect — investigate and reconcile before
         publishing.
       - **The live page is AHEAD** — another lane published from its own
         branch, which step 4 says to do *before* merging, so the live page
         legitimately carries rows `origin/main` has not seen yet. Nothing is
         wrong and there is nothing to reconcile: that lane is simply in front
         of you. **Republishing your older copy here is the destructive move**
         — it deletes that lane's rows from the artifact, which is the #1931
         incident one level up, and it is precisely what this signature will
         talk you into if you read it as the BEHIND case. Leave the page
         alone, let that PR merge, pull `main`, and only then start again from
         step 1.

       **The publish token separates them in one line, and it is the first
       thing to check** — not the row bodies. Compare `data-published-as` on
       the saved live page against the tracked file's:

       - **published HIGHER than tracked** → someone is AHEAD of you. Name them
         with `git log --all -S'<the live page's data-publish-id>' --
         docs/testing/onbox-acceptance-register-live-view.html`, which
         resolves to the exact commit that produced the live page, and
         `gh pr list --head <its branch>` to that lane's PR.
       - **published EQUAL or LOWER** → the BEHIND case above.

       Observed 2026-09-07: live at 11 against a tracked 9 located PR #3073 in
       one command, before any row-by-row comparison. The row-content report
       named A1/A16/A21 — true, but it reads identically in both directions,
       which is the whole reason to check the counter first. Note that nothing
       yet enforces the token *at publish time* (#2599 — `comparePublishTokens`
       still has no production consumer), so reading it by eye costs nothing and
       does not wait on that enforcement landing.
     - **The published page matches the baseline, but your local copy doesn't**
       — you have a local edit not yet merged to `origin/main`, and the
       published page is simply unchanged (still at baseline) because nothing
       has been published yet. This is the ordinary, expected pending-publish
       state — proceed.
     - **Neither matches the baseline** (all three — tracked, published, and
       `origin/main` — disagree) — a 3-way content disagreement. The check
       reports this as a visible warning to stderr (not blocking), since
       ordinary multi-step publishes (edit, publish again before merging)
       trigger this and hash-only comparison cannot distinguish from genuine
       conflicts. If the content seems wrong, investigate manually; otherwise,
       you can proceed to publish.

   **Known limitations** (#3529): provenance is the stamping commit's, so it
   is only as good as the history this checkout has. A page published by a
   branch you have not fetched reads as `unknown-provenance` until you fetch
   it, and an `unmerged-lane-row`'s owner reads as unknown the same way. A row
   carried on a merged publish that its stamping commit also committed reads
   as discharged even if a later revert on `main` removed it. "`origin/main`
   has ever carried it" reads `main`'s first-parent history of the register,
   including a `### <ID>` heading inside a fenced example. It is not
   allocate-once-proof: the colliding ID that reached `main` and was
   discharged while the other lane's copy is still live (step 2) reads as a
   discharge. Nor is it revert-proof: a row `main` merged and then reverted
   reads as discharged while a re-landing lane's copy is live, until the
   re-land merges (step 2). A row's owner is found by its summary line, so
   two lanes that wrote the same ID and the same title after normalisation
   (tags stripped, entities decoded, whitespace collapsed) cannot be told
   apart, and the older is named. Each lookup that a failing row needs costs a few seconds of
   `git log` on this repo: the ever-carried one, and the owner one, which a
   retired row the live page still carries also needs. A run with several
   such rows takes a minute or more.
   See `checkLiveView`'s own header comment in
   `scripts/check-onbox-register.mjs`.

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
4. Only once step 2 passes, publish the file step 2 passed on, with the
   canonical URL above as `url` **and `favicon` set to 📋**. That is the
   tracked `.html`, **unless step 2 needed a union**: then publish the union
   file that `--build-union` wrote (or the one you passed with
   `--publishing`), never the tracked file. Publishing the tracked file there
   drops the other lane's rows, which is the #3529 incident itself.

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

## Allocating row IDs

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

> **Blocked and Unconfirmed rows allocate the same way.** Each of those two
> sections has its own `next-id` marker directly under its heading
> (`<!-- next-id: BLK… -->`, `<!-- next-id: UNC… -->`), floor 101. A new
> Blocked row is a `### <ID> · <title>` heading and a new Unconfirmed row is
> a `- **<ID> · <title>** (…)` bullet, where `<ID>` is the ID named by that
> section's own next-id marker (e.g. `BLK107` / `UNC103` when this note was
> written; take the marker's current value); bump the marker in the same commit.
> IDs are allocate-once and never reused, exactly like lettered rows, and
> `register:build` rejects a Blocked or Unconfirmed row that has none. These
> rows never count toward `**N owed.**`, a lettered group's glance count or the
> strip's Owed tile. They DO have their own `— | **Blocked**` / `— |
> **Unconfirmed**` glance-table cell: bump it by hand when you add or remove a
> row — it drives the strip's Blocked/Unconfirmed tile, and
> `check:onbox-register` fails ("glance table says N, body has M") if it
> disagrees with the body.

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
> `check-register-citations.mjs` still does not close the gap reliably, even
> after #2721/#2833 widened Check C's fatal `wrongId` half to also cover a
> *last-row* discharge (a subject with NO live row left at all), and #2721/
> #2842 widened it again to cover a *partially*-discharged multi-row subject
> too (one row re-minted while a sibling row for the same subject stays
> live): `wrongId` only ever triggers when the stale citation sits on one of
> Check C's two surfaces (an anchored `### <ID> · …` heading or a
> `Criteria source:` line) with the subject on that *same* line, **and**
> the re-minted id's *own current* register row carries subject metadata of
> its own to contradict it with — an id that has never carried a subject
> number at all (a plan-only row, a real, permanent gap covering 15 of 66
> rows today) still can't be told apart from a fresh mint. A prose-idiom
> `row A22` citation fires nothing either way, since Check C doesn't read
> that surface at all. And a re-mint that is *self-annotated* as discharged
> — either near the citation itself, or (since #2721/#2842) in the re-minted
> row's *own* section of this register, naming the subject it moved on from
> — (this repo's own "annotate, don't renumber" convention) is deliberately
> treated as historical record, not a live defect, and prints non-fatal
> instead of failing the gate — an annotation is not an escape hatch from
> the rule above, it only changes whether a genuine re-mint is reported as
> `wrongId` or as a printed, non-fatal note; a re-mint with NEITHER kind of
> annotation is still fatal even when a sibling row for the same subject
> survives. **You cannot rely on a check to stop you.** If `wrongId` does
> fire after a re-mint, the fix is to undo the re-mint — never to edit the
> cited heading to match the new ID, which is exactly the corruption this
> design exists to prevent. The rule above is the only guard.
