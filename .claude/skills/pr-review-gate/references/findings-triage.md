# Findings triage

What happens after a review pass's comment lands. This file is read by the
shipping session, not the reviewer — the reviewer's contract for producing
findings lives in [`reviewer-brief.md`](reviewer-brief.md).

## Fix in this round (the report-fix-record rule)

CLAUDE.md retired the old four-conjunct "fix-now bar" name: that bar
*licensed deferral*, whereas [the current rule](../../../../CLAUDE.md#incidental-findings-report-fix-record)
gates deferring instead — a historical doc that cites "the fix-now bar" is
not precedent under this rule.

Triage the report by hand, then **fix in this round**. Every finding gets a
dispatched fix agent — one finding, one fix, one paired test — committed and
pushed before merge. Clear-cut findings (unambiguous bug, obvious dead code,
a straightforward CLAUDE.md violation) are the ordinary case, not the only
case. **Cleanup-only findings are in scope too** — a reuse/simplification/
efficiency nit, a staled derived artifact, a missing index or register row,
an unwired knob. They are cheaper to dispatch than a bug, not a lesser class
of work, and "it's only a chore" / "it's not user-visible" is not a
deferral. A ten-finding report ends as ten fix commits, not a follow-up
epic. None of this licenses `--fix`: the fixes are dispatched and reviewed
per finding, never applied wholesale.

## The defect / chore / taste seam

A finding is a **defect** (correctness bug) or a **chore** (a derived
artifact your change staled, a bookkeeping row your change made owed, a knob
that landed without its wiring, dead or duplicated code the work exposed, a
seam with no test, a stale comment your change made false) — both are fixed
in this round, on the same footing. The bug/chore label is a routing detail,
not a priority ruling.

## Void deferral reasons

Reproduced verbatim from [CLAUDE.md → Incidental findings: report, fix,
record](../../../../CLAUDE.md#incidental-findings-report-fix-record). Each
has been used to justify deferring a finding; each is void:

- **"it would expand the scope of this PR"** — a finding the work surfaced
  is in scope by definition. The PR body declares the fix and that settles
  it.
- **"it needs a judgement call"** — every fix needs judgement. The bar is
  needing a *decision*, not needing thought. Weighing two implementations of
  one agreed behaviour is not a design pass; picking which behaviour is
  right is.
- **"it's pre-existing"** / "the branch doesn't touch that file" / "it's
  next door" — adjacency stopped being the test.
- **"it needs its own test / its own regression plan"** — write the test in
  this PR. That is the standing requirement anyway.
- **"it's cheaper to batch these later"** — it is not. Ten open tickets cost
  strictly more than ten dispatched agents, and they cost it in the user's
  time.
- **"the user can decide later whether it's worth fixing"** — the user asked
  for working code, not a triage inbox.
- **"it's only a chore"** — the label is the board's routing, not a priority
  ruling, and a chore is the *cheapest* thing on this list to dispatch.
  "It's not user-visible" and "nothing is broken yet" are the same excuse: a
  stale derived artifact or an unwired knob is a defect that has not been
  noticed yet.

## The design-pass carve-out — the only way to leave a finding unfixed

**The single finding allowed to leave the round unfixed is one needing a
design pass** — more than one defensible outcome, a decision the user has a
stake in. This is the judgment-call carve-out shared with the spec/plan
review loop
([`model-routing`](../../model-routing/SKILL.md#judgment-call-carve-out-shared-by-both-review-loops)): a
finding that requires a decision only the user can make suspends the
fix-and-re-review loop and routes through the normal ask-first behavior in
CLAUDE.md's "Think before coding" rather than being silently resolved just
to keep the loop moving.

**Its issue must name the decision owed**, not just restate the finding.
"Needs design" without the decision named is a deferral in disguise — see
CLAUDE.md's same rule. File it in the same round via the normal backlog
path, labelled per CONTRIBUTING.md's two-shape convention; that issue is the
whole deliverable for this finding.

Everything else — "it expands the PR's scope", "it's pre-existing", "it
needs its own test", "we can batch these" — is not a design pass and is
fixed now.

## One fix agent per finding

Each finding gets its own dispatched fix agent: one finding, one fix, one
paired test. Not a single agent working the whole list, and not a fix
folded into an unrelated commit — each fix is traceable back to the finding
that produced it, committed and pushed before merge.

## How the split drives the re-review trigger and the loop cap

Every finding is labeled 🔴 Blocking / 🟠 Significant (a correctness bug —
wrong behavior, crash, security issue) or 🟡 Minor (a reuse/simplification/
efficiency-only cleanup nit). This label is what the re-review trigger
reads:

- **Re-review trigger**: only when the pass surfaced at least one finding
  that is an actual 🔴/🟠 correctness bug. Fixing and pushing those
  re-triggers a pass. If the pass came back empty, or surfaced only 🟡
  cleanup-only findings, fix-and-push (or push nothing) does **not**
  re-trigger a re-review — re-running it in that case just burns tokens for
  no new signal. (This is a *fixing* rule, not a re-review rule: 🟡-only
  findings are still fixed this round per "Fix in this round (the
  report-fix-record rule)" above — they just don't reopen the loop.)
  Re-review re-derives the effort level from the
  PR's current commit set rather than reusing the initial pass's tier — a
  fix commit can raise the tier the same way any other commit would.
- **Loop cap**: initial pass + up to 2 re-review rounds (3 total). Still
  tripping the trigger after that stops the loop and hands it to the user —
  do not keep looping automatically past the cap.

A report without the 🔴/🟠 vs 🟡 split cannot drive this loop — the
dispatching session would have to re-derive it by re-reading every finding,
which defeats the point of a structured report.
