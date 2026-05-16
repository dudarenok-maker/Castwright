---
status: draft
shipped: null
owner: null
---

# {{Feature name}}

> Status: {{stable | KNOWN: scaffolded | KNOWN: backend-pending | KNOWN: operational dependency | deferred}}
> Key files: `path/one.ts`, `path/two.tsx`
> URL surface: {{e.g. `#/books/<id>/listen`, or "indirect — see 01-hash-router.md"}}
> OpenAPI ops: {{e.g. `POST /api/books/{id}/analyse`, or "none"}}

## Benefit / Rationale

State the **user-level**, **technical**, and/or **architectural** payoff in 2–6 bullets. Future-you reads this section to decide whether the plan is still load-bearing.

- **User:** what changes for the person clicking buttons?
- **Technical:** what is now possible / impossible / cheaper / faster?
- **Architectural:** what invariant does this lock in, what seam does it open?

If a bullet is "n/a", say so — empty == missing thought, not "no benefit on this axis".

## Architectural impact

What this plan touches, what it preserves, what it breaks. Be explicit about:

- **New seams / extension points** added (interfaces, hooks, slices, env flags).
- **Invariants preserved** — call out the rule from the cross-cutting plans (00, 23, 24, 25, 26, 27) that this plan must not violate.
- **Migration story** if data shape or storage changes (state.json, cast.json, openapi.yaml, etc.). Include the lazy-migration code path if relevant.
- **Reversibility** — what undoes this if it ships and breaks something?

## Invariants to preserve

Numbered list of structural rules a refactor must not break. Each item cites the
file + line that enforces the rule, so the reader can sanity-check the citation
hasn't drifted. Example:

- `Stage` union variants in `src/lib/types.ts:253-260` are exactly: …
- `READY_DEFAULTS` in `ui-slice.ts:13` is `{ currentChapterId: 3, openProfileId: null }`.

## Test plan

### Automated coverage
List the tests that lock this behavior in. Cite the file + the assertion. New plans MUST land paired tests in the same PR. Forms:

- Vitest unit (`src/foo/bar.test.ts`) — asserts X.
- Vitest server (`server/src/foo.test.ts`) — asserts Y.
- Pytest sidecar (`server/tts-sidecar/tests/test_z.py`) — asserts Z.
- Pester (`scripts/tests/foo.Tests.ps1`) — asserts W.
- Playwright e2e (`e2e/foo.spec.ts`) — asserts the golden path through this feature in a real browser.

If a surface area is untested, state that explicitly with a follow-up plan item — do not silently omit.

### Manual acceptance walkthrough
Numbered click-through with expected URL hash, redux state, and visible UI after each step. Run in mock mode (`VITE_USE_MOCKS=true`) unless the plan needs the real backend or sidecar.

1. **Cold boot at `#/`** → expected stage = `{ kind: 'books' }`, expected UI = library cards.
2. …

## Out of scope

What this plan deliberately does NOT cover, with pointers to the plan that does.

## Ship notes

(Filled in when status flips to `stable`. Append: shipped date, commit SHA, any
behaviour delta vs. the original spec. Once filled, the plan becomes eligible
for archive — move to `docs/features/archive/` in the same PR as the ship.)
