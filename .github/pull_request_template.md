<!--
PR title MUST match the commit convention: <type>(<scope>): <subject>
  - feat(frontend): add foo
  - fix(server): patch retry budget
  - chore: tidy gitignore        (chore is the only no-scope catch-all)
See CONTRIBUTING.md "Pull requests" for the full spec.
-->

## Summary

<!--
1-3 sentences: what changes, why. If a regression plan under docs/features/ applies,
link it here (e.g. "Implements docs/features/archive/44-pr-hygiene.md."). If this PR fills
in a plan's Ship notes, say so.
If it delivers a backlog item or fixes a bug, end with "Closes #NN" (or "Refs #NN"
for a partial) — the keyword auto-closes the issue on merge.
-->

## Test plan

<!--
Checklist of what was run / what reviewers should look at. Examples:

- [ ] cloud `verify.yml` (required status check) — green
- [ ] Manual walkthrough in mock mode: <steps>
- [ ] Reviewer: spot-check <file>:<line> against the regression plan

If this PR touches server/tts-sidecar/**, the sidecar acceptance gate needs
one of these two lines somewhere in this body (see CONTRIBUTING.md "Sidecar
acceptance fast-path" for the full format):

  Sidecar acceptance: `npm run test:sidecar` -- <YYYY-MM-DD> -- passed
  Sidecar acceptance: see docs/testing/onbox-acceptance-register.md row <ID>
-->

- [ ] `npm run verify` — green
