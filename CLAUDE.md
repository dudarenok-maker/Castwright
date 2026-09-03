# Project context for Claude Code

Frontend for an audiobook-generation tool. Vite + React 18 + TypeScript +
Redux Toolkit. Mocked API surface today; designed to swap to a real backend
without changing component code.

**Brand:** the product is **Castwright** (`castwright.ai`) — _any book, performed by a full
cast — effortlessly. Even in your own voice._ Brand assets + guidelines live in `brand/`; the
design spec is `docs/superpowers/specs/2026-06-07-castwright-brand-design.md`; the brand story
is `brand/project-narrative.md`. **`brand/` and `mockups/` are local-only (git-ignored)** —
the brand identity is "all rights reserved" and these are working/scratch artifacts. The app
ships the _generated_ assets in `public/` (PNGs rendered from `brand/identity/logo/*.svg`
via `scripts/render-brand-pngs.mjs`), which ARE committed, so the build never depends on the
sources. **`mockups/` is the home for all brand / style / UI exploration work** — put any
future visual concepts or HTML mockups there, not in a new tracked directory.
npm packages: `castwright` (frontend) / `castwright-server`
(backend). GitHub repo: `Castwright`. Release artifact: `castwright-vX.Y.Z.zip`.
**Note: v1.6.0 cannot self-upgrade across the rename — alpha installs reinstall fresh.**
App fonts: **General Sans** (sans) + **Lora** (serif) — self-hosted in
`public/fonts/` (woff2, via `scripts/fetch-self-hosted-fonts.mjs`); no external
font CDN at runtime (#698). Next big
release = voice cloning (`fs-38`, plan `docs/features/194-voice-cloning.md`).

## Working principles

General working style layered on top of the project-specific rules below.
These bias toward caution over speed; for trivial tasks, use judgment.

### Think before coding

Don't assume, don't hide confusion, surface tradeoffs.

- State your assumptions explicitly. If uncertain, ask before implementing.
- If multiple interpretations exist, present them — don't pick silently.
- If a simpler approach exists, say so. Push back when warranted.
- If something is unclear, stop, name what's confusing, and ask.

### Simplicity first

Minimum code that solves the problem — nothing speculative. (Reinforces
"Out of scope until told otherwise": the v1 surface area is final.)

- No features beyond what was asked; no abstractions for single-use code.
- No "flexibility" or "configurability" that wasn't requested.
- No error handling for impossible scenarios.
- If you write 200 lines and it could be 50, rewrite it. Ask: "would a
  senior engineer call this overcomplicated?" If yes, simplify.

### Surgical changes

**Fix what's broken; don't restyle what works.** (Reinforces the
one-branch-one-cohesive-change rule under "Branching workflow".)

The seam is defect vs. taste, not near vs. far:

- **Taste is off-limits.** Don't "improve" adjacent code, comments, or
  formatting; don't refactor, rename, or reorganise what isn't broken. Match
  existing style even if you'd do it differently (see "Conventions worth
  preserving"). "I'd have written it another way" is never a reason to touch
  a line. This is narrower than it looks: a comment your change made *false*
  is a chore, not taste, and gets fixed under the next bullet — the test is
  whether the repo's own rules already say it's owed, or only your preference
  does.
- **Defects _and chores_ get fixed in the same round** — not noted, not
  deferred, not left for a cleanup pass. This covers code you're already
  touching *and* code next door that the work surfaced; adjacency is not the
  test. A chore the work made owed — a staled derived artifact, a missing index
  or register row, a knob without its wiring — is a finding on the same footing
  as a bug, not a lesser one. The only finding that is filed instead of fixed is
  one needing a **design pass** — a decision with more than one defensible
  outcome — and then the ticket names that decision. Full protocol: [Execution
  model → Incidental findings](#incidental-findings-report-fix-record).
- **Remove what YOUR changes orphaned** (imports, variables, functions).
  Pre-existing dead code is a finding, not a licence: route it through the
  same report-fix-record path rather than deleting it on sight.
- The test: every changed line traces to the user's request **or to a defect
  that request exposed** — and the PR body says which.

### Goal-driven execution

Define success criteria, then loop until verified.

- Turn vague tasks into verifiable goals: "fix the bug" → "write a test
  that reproduces it, then make it pass." (Already mandated under
  "Testing discipline.")
- For multi-step tasks, state a brief plan with a verify check per step.
- Strong success criteria let you loop independently; weak ones ("make it
  work") force constant clarification.

## Execution model (default for all non-trivial work)

**All work is sub-agent-executed by default.** The main thread coordinates,
curates context, and **judges**; it does not produce. Writing code a subagent
could write is a violation of this section, not a shortcut through it — the
only work that stays inline is work that clears [the trivial
bar](#the-trivial-bar) below, plus validation, which is inherently the main
thread's job because it holds the session's accumulated context and the
subagents don't.

**Dispatch fresh agents, not forks.** Execution subagents start cold and are
briefed from the ticket: the issue's implementation-brief comment plus the plan
doc it links. A fork inherits this session's context, which defeats the point —
it re-pollutes the thread the split exists to keep clean, and it ignores [Model
routing](#model-routing) (forks always inherit the dispatching model). Forks
remain correct for **read-only** work where inheriting context IS the point —
mid-task "search this and report back" fan-out — never for producing a diff.

**The brief is the contract.** A fresh agent knows only what it is told, so the
issue comment + plan doc must be self-sufficient. That is what phase 1 exists to
produce. Practically it means the fork in the road is **trivial, or ticketed** —
if there is no ticket to brief from and the work isn't trivial, the missing
ticket is the first task, not an excuse to type the code yourself.

Substantial work additionally splits **design and implementation into SEPARATE
threads.** Three phases, each with a clean handoff:

**1. Design & brainstorming — its own thread.** Use `superpowers:brainstorming`
→ `superpowers:writing-plans` to produce the spec/plan. Non-trivial specs/plans
still get the mandatory Premium-tier `assumption-checker` pass (see Model
routing). **The design thread produces two artifacts and no code:** (a) the
full plan committed under `docs/features/` — the durable design of record; and
(b) a comment on the item's GitHub issue that is the _handover brief for the
implementation agent_ — it links the plan doc, then gives the implementation
thread what it needs to START: the task breakdown, entry point, global
constraints, key files, and acceptance criteria. The comment is the kickoff
instructions the implementation agent reads first; the plan doc holds the rest.
The design thread does **not** implement. Suggest `/compact` at the
spec-approved and plan-approved checkpoints.

**2. Implementation — a separate thread.** Picks up the ticket + its
implementation-brief comment as the sole source of requirements. Runs
`superpowers:subagent-driven-development` as the **primary** mode: cut the
worktree + branch (per Branching workflow), then dispatch a fresh implementer
subagent per task, a task-review subagent (spec + quality) after each, and a
broad whole-branch review at the end — the mandatory gate is phase 3's, not
this one — models chosen per the Model-routing table. The controlling thread
coordinates and curates context; it does **not** hand-write task code a
subagent could do. Keep the progress ledger
(`.superpowers/sdd/progress.md`) so the run survives compaction —
including every incidental finding and its disposition, per below.

**3. Ship.** PR with `Closes #NN`, the mandatory `pr-review-gate` pass,
merge — per the Before-shipping checklist and Branching workflow.

**Why the split:** design and implementation have different context needs; one
thread pollutes both. The issue-comment handoff lets an implementation thread
(or a teammate) execute cold from the ticket alone.

### The trivial bar

**One definition, three uses.** Clearing this bar is what lets a change skip the
worktree, skip the subagent, and skip the design thread. Nothing else does.

Clearing it skips the worktree, the subagent, and the design thread — it does
**not** skip the branch or the PR, which `main`'s required status checks make
unavoidable for every change (see Branching workflow → The two carve-outs).

A change is trivial when **nothing can break and nothing needs review**:

- no runtime code, no config, no test, no CI, no dependency;
- the correct fix is unarguable — one right answer, nothing to weigh;
- no regression test is owed, because there is no behaviour to regress.

In practice that is a typo, a dead comment, a single-line doc tweak, and very
little else. **If you would want a review pass on it, it is not
trivial.** If a reviewer could reasonably ask "why this way?", it is not
trivial. **When in doubt, it is not trivial** — an unnecessary branch costs
thirty seconds; an unreviewed change on `main` costs whatever it costs.

Invoking the bar is **announced, not silent**: say so in the end-of-turn summary
so the shortcut can be redirected. It should be rare. A run in which several
changes were "trivial" is a run that mis-scoped the work.

### Incidental findings: report, fix, record

Long-running agent work turns things up in passing — in code being touched, in
code next door. **They are fixed in the same round, by a dispatched fix agent.**
Not accumulated into a cleanup pass, not converted into a queue of tickets for
someone else's day. The queue is the failure mode: it turns a day of agent work
into a day of human janitorial work, and every deferral re-pays the whole cost
of rediscovering the finding from cold.

**A finding is a defect OR a chore — the rule does not distinguish them.** The
`bug`-vs-`type:chore` label is a routing detail for the board, not a licence to
defer one and fix the other. Both were surfaced by this work; both cost the same
to fix now and strictly more to fix later. Chores that count, with real examples
from this repo:

- **a derived artifact your change staled** — `src/lib/api-types.ts` after an
  `openapi.yaml` edit, `docs/BACKLOG.md` after a board change, brand PNGs after
  an SVG edit;
- **a bookkeeping row your change made owed** — an `INDEX.md` entry, an
  on-box-acceptance register row, a flaky-register line;
- **a knob that landed without its wiring** — a registry key with no
  `config:sync`, no Settings row, no `.env.example` line;
- **dead or duplicated code the work exposed** — an orphaned export, a helper
  that is now the second copy of one that already exists;
- **a seam you touched that has no test**, or a `.skip` with no replacement;
- **a stale comment or doc sentence your change made false.**

**The seam is defect / chore / taste — the first two are fixed, the third is
never touched.** Taste is "I'd have written it another way": renaming,
reordering, restyling, or refactoring code that is correct and consistent with
its neighbours. That stays off-limits under "Surgical changes" and does not
become fixable by being relabelled a chore. The test: a chore is something the
repo's own rules already say is owed; taste is something only your preference
says is owed.

The subagent's behaviour is unchanged — **it reports, it does not
opportunistically fix.** The main thread dispatches:

1. **The subagent reports the finding** in its return value (implementer or
   task-review agent alike). It does not widen its own diff to fix it.
2. **The main thread dispatches a dedicated fix agent immediately**, at the task
   boundary where the finding surfaced — not at the end of the branch. Fresh,
   narrowly scoped: one finding, one fix, one paired test, briefed from the
   report. Not "and while you're there."
3. **Record it too.** File the GitHub issue in the same round, labelled and
   boarded per "The backlog" — plus a `docs/BACKLOG.md` row *only* if it is
   `type:feature`, since chores and bugs never render there. **The issue is
   bookkeeping that accompanies the fix, not a substitute for it.** Filing one
   and moving on is the leak this protocol exists to close.

**The one thing that defers a finding: it needs a design pass.** That means the
fix has more than one defensible outcome and something has to *choose* between
them — an interface, a contract, or a behaviour the user has a stake in. Only
then is the issue the whole deliverable for this round, and it goes through
phase 1. Say in the issue which decision is owed; "needs design" without the
decision named is a deferral in disguise.

> This replaces the four-conjunct **"fix-now bar"** that earlier plans and code
> comments cite. That bar gated *fixing*; this one gates *deferring*, and only
> its third clause (no interface/contract/behaviour decision) survives. A
> historical doc saying something "fails the fix-now bar" recorded a decision
> under the old rule — it is not precedent under this one.

**These are NOT reasons to defer.** Each has been used; each is void:

- **"it would expand the scope of this PR"** — a finding the work surfaced is in
  scope by definition. The PR body declares the fix and that settles it.
- **"it needs a judgement call"** — every fix needs judgement. The bar is
  needing a *decision*, not needing thought. Weighing two implementations of
  one agreed behaviour is not a design pass; picking which behaviour is right
  is.
- **"it's pre-existing"** / "the branch doesn't touch that file" / "it's next
  door" — adjacency stopped being the test.
- **"it needs its own test / its own regression plan"** — write the test in this
  PR. That is the standing requirement anyway.
- **"it's cheaper to batch these later"** — it is not. Ten open tickets cost
  strictly more than ten dispatched agents, and they cost it in the user's time.
- **"the user can decide later whether it's worth fixing"** — the user asked for
  working code, not a triage inbox.
- **"it's only a chore"** — the label is the board's routing, not a priority
  ruling, and a chore is the *cheapest* thing on this list to dispatch. "It's
  not user-visible" and "nothing is broken yet" are the same excuse: a stale
  derived artifact or an unwired knob is a defect that has not been noticed
  yet.

**Cost is not an objection.** A finding that needs no design pass is by
definition Cheap tier on the Model-routing table — a defect is its "single
well-specified bug fix with a clear repro and no design decisions", a chore its
"boilerplate/scaffolding" or "running commands and summarizing output". The
dispatch is yours and stays cheap; the typing is Haiku's. More dispatches is the
intended outcome, not a side effect: a round that turns up ten findings ends
with ten fix agents, not ten tickets.

**Nothing is dropped silently.** Every finding lands in the progress ledger as
fixed-here (with the fix agent's SHA), or — for the design-pass case only — as
an issue number *plus the decision that is owed*. A finding that is neither is
the exact leak this protocol closes. Incidental fixes are also **declared in the
PR body** ("Also fixed, found in passing: …") — an unannounced fix reads as
scope creep to a reviewer.

This is the operative half of "Surgical changes": *fix what's broken, don't
restyle what works.*

## Model routing

Route non-fork subagent/Workflow dispatch (and, as guidance, the main
session's own model) by task shape — not by habit. Forks always inherit the
dispatching session's model; the table below does not apply to them.

| Tier | Model | Selected for |
|---|---|---|
| Cheap | Haiku 4.5 | Mechanical search-and-report subagents, boilerplate/scaffolding, running commands and summarizing output, single well-specified bug fixes with a clear repro and no design decisions, high-volume parallel fan-out via non-fork subagents |
| Default | Sonnet 5 | Everything else — standard feature work, most debugging, most non-fork subagent dispatch, code review, the main session itself |
| Premium | Opus 4.8 | Ambiguous specs needing judgment, architecture/design tradeoffs with multiple viable options, adversarial review passes (spec/plan and PR review — see below), cases where Sonnet visibly got stuck (2 failed attempts), irreversible/high-blast-radius decisions |
| Reserved | Fable 5 | Never auto-selected. Explicit user approval only, per task |

**Reasoning effort is the second axis, and `medium` is this repo's declared
norm** — for dispatched roles, for the main session, and for CLI worker
dispatch (`claude --effort`, `copilot --effort`, `cline --thinking`; pass it
explicitly, since omitting it inherits an undeclared default — though passing
it is a declaration, not a guarantee: at least one CLI is reported to ignore
it in some configurations). `high` and
above are deliberate, work-shaped raises rather than a resting state. Dispatch
by named role — `Agent({subagent_type: 'pr-reviewer'})` — rather than by raw
`model:`; the six roles and their pinned `model:`/`effort:` values live in the
role table in
[`.claude/skills/model-routing/SKILL.md`](.claude/skills/model-routing/SKILL.md),
which is also the registry every `.claude/agents/**` file — nested subdirectories included — must appear in.

A subagent that fails twice on its assigned tier is silently re-dispatched
one rung up (Haiku → Sonnet, Sonnet → Opus) and the escalation is reported
after the fact — no need to ask first, since subagent dispatch is cheap and
disposable. A session-level tier mismatch (the current work matches a
different table row than the model the session is actually running) is
flagged instead of silently absorbed — I cannot switch my own running model,
so a drift gets an explicit sentence naming it and asking whether to switch.

**Mandatory review gates**, both using this table's Premium tier:
- Every non-trivial spec (`brainstorming`) or plan (`writing-plans`) gets a
  real `assumption-checker` pass before the user is asked to approve it.
- Every PR gets a `pr-review-gate` pass (findings only, never auto-applied)
  once fully staged, before merge — except a docs-only PR (same file-set
  test as CONTRIBUTING.md's doc-only CI fast-path), which is exempt
  entirely. Otherwise **review depth** scales with the PR's commit type/scope
  (review depth, not the model's `effort` setting;
  CONTRIBUTING.md's commit-convention vocabulary): `low` for a single-scope
  `chore`/`test`/`build`/`ci`, `medium` for a single-scope `feat`/`fix`,
  `high` for `refactor`/`perf` or any multi-scope PR — see the
  `pr-review-gate` skill for the full split.

Full escalation logic, the "fails"/"drifted" definitions, the review-gate
mechanics (in-session vs. subagent dispatch, re-review loop caps, the
judgment-call carve-out), and the PR issue-linkage gate live in
[`.claude/skills/model-routing/SKILL.md`](.claude/skills/model-routing/SKILL.md)
— this section is the quick-reference table, that file is the full spec.
Design rationale:
[docs/superpowers/specs/2026-07-01-model-routing-and-review-gates-design.md](docs/superpowers/specs/2026-07-01-model-routing-and-review-gates-design.md).

## Commands

- `npm start` — frontend + server + TTS sidecar in one shot (plan 43). Server owns the sidecar child-process lifecycle (per-user `autoStartSidecar` preference, default on); Ctrl+C tears the sidecar down via `taskkill /T /F` on Windows.
- `npm run dev` — frontend (Vite, HMR, `:5173`) **and** server (`:8080`) together via `concurrently`; the server auto-starts the TTS sidecar same as `npm start` (per-user `autoStartSidecar`, default on) — it is not frontend-only.
- `npm run typecheck` — `tsc --noEmit` (frontend + server).
- `npm test` — Vitest single-run for the frontend.
- `npm run test:server` — Vitest single-run for the server (parallel, excludes the 10 hot files routed to `test:server-slow`).
- `npm run test:changed` / `npm run test:server:changed` — `vitest run --changed HEAD` for the frontend/server suites respectively, selecting only tests vitest's own dependency graph says the diff (staged + unstaged, vs `HEAD`) affects. Not run standalone in practice — these back pre-commit's `--scope-staged` narrowing (see "Commit gate") — but usable directly for a quick local check.
- `npm run test:server-slow` — Vitest single-run for 10 timeout-prone server test files (analyzer/gemini, a parsers PDF test, and routes tests), pinned to one fork via `server/vitest.config.slow.ts`. Runs in the cloud `verify.yml` battery and the full local `npm run verify`, not in pre-push `verify:fast:branch` or `verify:fast` pre-commit. See `docs/features/archive/45-vitest-pool-tuning.md` for the rationale.
- `npm run test:server:routes` / `:tts` / `:analyzer` / `:workspace` and `npm run test:components` / `:store` / `:lib` / `:views` — opt-in, manual, subsystem-scoped test runs (`vitest run <subdir>` under the hood) for a fast local loop when you know you're only touching one area. Not part of the automated verify pipeline — not in `STEPS[]`, not cached, not gated by any hook, and carry no coverage guarantee (a `routes/` change that breaks something in `workspace/` isn't caught by `test:server:routes` alone). The four server-side scripts cover 76.9% of `test:server`'s **tests** (file counts differ: `test:server:routes` selects 138 files, not the 146 a raw file search under `server/src/routes/` would find — 8 are in `vitest.config.slow.ts`'s `SLOW_FILES` and excluded from `test:server` itself, so this matches, not a gap); the four frontend scripts cover 86.3% of `test`'s tests (as of 2026-09-02; these figures will drift as test files are added or removed). See `docs/superpowers/specs/2026-09-01-verify-scope-branch-timing-design.md` Decision E.
- `npm run test:scripts` — Pester 5 single-run for `scripts/lib/` PowerShell helpers
  (log rotation/pruning). Requires Pester >= 5.0; install once with
  `Install-Module -Name Pester -Scope CurrentUser -Force -SkipPublisherCheck`.
- `npm run test:sidecar` — pytest single-run for `server/tts-sidecar/tests/`.
  Uses the sidecar venv at `server/tts-sidecar/.venv\Scripts\python.exe`; emits
  a SKIP banner and exits 0 when the venv isn't bootstrapped yet (fresh clone).
  Runs `-m "not golden"` so the opt-in golden-audio tier never loads a model here.
- `npm run test:golden-audio` — **opt-in** golden-audio regression gate (ops-11,
  plan 185; content-drift check added by ops-45 / #1911). NOT in `test:all` /
  `verify` — run on demand. Two layers: **Suite B** (`:assembly`, GPU-free) feeds
  a committed recorded-PCM fixture through the real `synthesiseChapter` + ffmpeg
  loudnorm; **Suite A** (`:sidecar`, real Kokoro) asserts each fixture line's
  length vs `kokoro-baseline.json` within tolerance, AND (since #1911) that a
  fresh Whisper transcript of the line matches the baseline's recorded
  `transcript` at tolerance 0. Real Qwen carries a duration-only golden
  baseline (#1994) — each fixture line's length vs `qwen-duration-baseline.json`
  within tolerance, no Whisper check. Triple-gated (venv / pytest / Kokoro OR
  Qwen OR Coqui weights), SKIP+exit-0 when absent. Partials:
  `npm run test:golden-audio:assembly` (Node-side audio changes, runs
  anywhere) and `npm run test:golden-audio:sidecar` (engine changes, box with
  weights). Flags via the full runner: `--assembly-only`, `--sidecar-only`,
  `--engine=<kokoro|coqui|qwen>`, and `--bless` (re-records the baselines of
  the **selected** suites — bare `--bless` does both, `--assembly-only
  --bless` records Suite B's `golden-chapter.baseline.json` + `.decoded.pcm`,
  `--sidecar-only --bless` records `kokoro-baseline.json` and
  `instruct-baseline.json`; Qwen duration requires explicit `--engine=qwen`,
  since a bare `--sidecar-only --bless` passes `-k 'not qwen_duration'` to
  exclude it. `npm run test:golden-audio:sidecar` run directly (bypassing
  this runner, e.g. with `GOLDEN_BLESS=1` set by hand) carries the same
  `-k 'not qwen_duration'` default baked into `run-golden-tests.ps1` itself
  when no `-k` is already supplied, so it can't silently re-bless Qwen
  duration either — an explicit `-k qwen_duration` overrides it. Note
  `npm run test:golden-audio:assembly` bypasses the runner and so can never
  bless). Cross-engine sanity needs `GOLDEN_COQUI=1` /
  `GOLDEN_QWEN_VOICE=<id>`. The content-drift check adds `ASR_MODEL=base`'s ~145 MB
  Whisper weights as a **network prerequisite** on first run (fetched from
  HuggingFace, not by the bootstrap) and ~+9–10s of wall-clock to a Suite A run
  (~+50%) — `GOLDEN_ASR=0` disables the check for a run where that's a problem.
  A `--bless` that would silently overwrite a DIFFERING recorded transcript is
  refused unless `GOLDEN_REBLESS_CONTENT=1` is also set (see
  `tests/golden/compare.py`'s `bless_guard`, G1/G2) — this also fails CLOSED
  (refuses, same flag) when an existing entry is missing its `transcript` key
  outright (or the key is present but `null`/non-string — the same corruption
  shape) rather than silently reopening the no-op first-bless path; a missing
  (or `null`/non-int) `text_edits` key is a separate mechanism — it neither
  refuses nor needs the flag, it just applies the strictest possible recorded
  cap (`0 + 1`), so it only refuses if the fresh transcript's edit count
  exceeds that cap (#2003). Separately, `instruct-baseline.json` mixes a
  THRESHOLD (`tolerances.rtf_max` etc.) with raw stochastic measurements
  (`identity` cosines, `loudness_dbfs`) that later assertions are diffed
  against — a `--bless` that would move ANY of the three is guarded by
  `bless_guard_thresholds` (#1995, widened by #2035/#2045, split and
  hardened by #2060/#2061/#2062/#2069), but not identically: `tolerances`
  is quantised, so an EXACT change refuses outright; `identity`/
  `loudness_dbfs` are noisy (~0.0014 run-to-run identity spread per the
  committed baseline's own `metadata.notes`), so a move under a
  field-specific `epsilon` (`compare.LOUDNESS_DBFS_EPSILON` is 10% of the
  ±`loudness_dbfs_abs` window the field is diffed against;
  `compare.IDENTITY_COSINE_EPSILON` has no equivalent window — `identity`
  feeds an absolute ceiling, not a diff — so it's calibrated instead off the
  committed baseline's own ~0.0014 run-to-run noise) is ACCEPTED WITHOUT
  REWRITING the reference (#2060) — the existing block is kept as-is; only
  a first bless or an explicitly-flagged forced move ever overwrites it, so
  N consecutive noise-sized moves can no longer walk the reference across
  its own window — and echoed to stdout. An exact-equality guard on those
  two was found to refuse on every honest re-bless, which is *why*
  `identity`/`loudness_dbfs` now sit behind their OWN flag rather than the
  single shared one used before: reaching for that one flag on a routine
  re-bless used to silently re-open the `tolerances` hole one level down
  (#2060's root cause). `tolerances` refusing beyond its bar needs
  `GOLDEN_REBLESS_THRESHOLDS=1`; `identity`/`loudness_dbfs` refusing beyond
  THEIRS needs the separate `GOLDEN_REBLESS_MEASUREMENTS=1` — including
  when a previously-blessed baseline lost one of its keys outright (same
  merge-conflict shape as above; disambiguated from a genuine first bless
  via `any(baseline.get(k) is not None for k in ("rtf", "identity",
  "loudness_dbfs", "tolerances"))`, not any single key and not bare `k in
  baseline` — a single-key probe was tried twice and both times left a
  narrower version of the same blind spot, and a bare presence check
  refuses the documented first-bless scaffold shape (all four keys present
  but `null`) — so an unrelated bless (e.g. one only meant to re-record
  Kokoro transcripts) can't silently loosen a throughput/identity/loudness
  ceiling, or re-centre identity/loudness beyond noise, to whatever the
  blessing box happened to measure. That key-was-missing forced write is
  the highest-stakes case the guard handles, and used to be the one echo
  shape that printed nothing at all; it now reads `<field>: FORCED, key
  was ABSENT -- no prior reference; wrote {...}` (#2069), unmistakably
  distinct from both a noise line and a normal forced-move line.
- `npm run test:e2e` — Playwright (chromium) against Vite in mock mode on port 5174.
  Requires one-time `npx playwright install chromium`. Excludes the visual baselines (run via `test:e2e:visual` separately). See `docs/features/archive/37-e2e-playwright.md`.
- `npm run test:e2e:visual` — Playwright visual-snapshot specs at `e2e/responsive/visual.spec.ts`, chromium-only, `--workers=1` so per-snapshot Windows font-hinting drift can't race against the parallel `test:e2e` battery. Baselines are per-platform (`e2e/{linux,win32}/**`). Runs in the cloud `verify.yml` PR battery (Ubuntu → `e2e/linux` baselines) and the full local `npm run verify`, not in pre-push `verify:fast:branch`, so visual regressions still surface at PR time rather than only at release.
- `npm run test:fast` — frontend + server only (matches the pre-commit hook).
- `npm run test:all` — frontend + server + server-slow + PowerShell-scripts + sidecar tests (no e2e).
- `npm run verify` — full battery: typecheck + all tests + e2e + build. No longer the pre-push default (see "Commit gate") — run manually when you want the full local battery (e.g. before a release cut).
- `npm run verify:quick` — all tests (no e2e, no typecheck, no build) — alias for `test:all`.
- `npm run verify:fast` — fast tests only (alias for `test:fast`); a manual full-fast run. NOTE: pre-commit actually gates on `verify:fast:scoped` (the scope-filtered variant), not this — see "Commit gate".
- `npm run verify:fast:branch` — lint + typecheck + config:check + test:hooks + test + test:server + build + test:sidecar + audit + audit:server, each scope-gated to whether the current branch's diff (vs local `main`) touches its inputs. This is the new pre-push default (see "Commit gate") — the fast, branch-scoped smoke check; cloud `verify.yml` is now the actual enforcement gate for everything else.
- `npm run audit` — npm audit against the root lockfile, gating on any unwaived high/critical severity advisories (threshold `--audit-level=high`). Waivers live in `audit-waivers.json` at repo root with expiry enforcement. Exit codes: 0 = pass, 1 = unwaived high/critical, 2 = expired waiver(s) or bad CLI args, 3 = audit cannot be trusted (npm audit failed, or its output could not be parsed). See `scripts/check-audit.mjs` for scope and mechanics (#2434).
- `npm run audit:server` — npm audit against the server lockfile, omitting devDependencies (`--omit=dev` for production/runtime scope only), same gate and severity threshold as root. Exits with the same codes as `audit`. Runs in both `verify.yml` and `verify:fast:branch` (root runs full tree, server scope-gated to `server/package-lock.json` changes). **Note:** both audit steps require network access to npm's advisory database — they cannot run offline.
- `npm run build` — production build into `dist/`.
- `npm run apk:companion` — build the Android companion APK and drop it at
  `companion/castwright-companion.apk` (the path `GET /api/companion/apk` serves;
  set `COMPANION_APK_PATH` to drop elsewhere). Stamps an **auto-incrementing
  timestamp `versionCode`** (minutes since epoch) via `flutter build --build-number`,
  so every build's code strictly increases and it **update-installs** over the prior
  one — never the "same versionCode → won't update / had to uninstall" trap. It also
  **verifies the built APK's signer cert** == the upload key (`ba7b147d…`) and refuses
  to drop a debug-/wrong-key build (which would fail `INSTALL_FAILED_UPDATE_INCOMPATIBLE`).
  Run from a checkout that has `apps/android/android/key.properties` + `upload-keystore.jks`
  (git-ignored). Pure helpers unit-tested in `scripts/tests/build-companion-apk.test.mjs`.
- `npm run openapi:types` — regenerate `src/lib/api-types.ts` from `openapi.yaml`.
- `npm run skills:sync` — mirror `.claude/skills/pr-review-gate/` **and**
  `.claude/skills/model-routing/` into
  `~/.agents/skills/`, the skill store Cline (and the five other agents sharing
  it) is known to resolve — it does **not** read a workspace `.claude/skills/`
  (probed 2026-08-13, `docs/testing/agent-skill-resolution-probe.md`). "The
  ONLY store it resolves" overstated that probe, which tested two paths, not
  the loader's whole search list: it composes skill roots from its rule
  directories (`skillsPath: join(<ruleDir>, "skills")`), so workspace roots may
  work too and would make this per-machine step avoidable. Untested, and code
  presence is not proof — `~/.cline/skills` is in that same list and was proven
  dead — so it stays unverified pending #2368. A
  **per-machine** step: the target is under `$HOME`, so CI cannot run it and a
  fresh clone has no mirror. Re-run after any change under either directory;
  the drift guard in `scripts/tests/review-gate-mechanism.test.mjs` checks
  against the store root (`~/.agents/skills/`), so it only **skips**, loudly,
  on a machine with no store at all — once the store exists (e.g. any box
  where Cline has installed its global skills), the guard **fails** rather
  than skips if this repo's mirror is missing or stale there, even if
  `skills:sync` has never been run on that machine.
- `cd server && npm run dev` — local analysis backend on `:8080`. Reads `server/.env`
  (Node 20.6+ native `process.loadEnvFile`, no dotenv dep). **The analyzer engine
  is chosen in the UI (Account → analyzer settings) / `user-settings.json`, not
  by env — `ANALYZER` no longer selects the engine (retired 2026-07-15); a stray
  `ANALYZER=gemini` in an old `.env` is inert.** The default is **local**.
  - **Local (default)** — calls a local Ollama model (with Gemini as an opt-out
    fallback when `GEMINI_API_KEY` is set, `allowCloudFallback` is on, and the
    daemon is unreachable).
  - **Gemini** (`GEMINI_API_KEY=…`) — calls the free-tier Gemini API
    directly. Optional `GEMINI_MODEL` (ships defaulting to
    `gemini-3.5-flash-lite`; resolves through the config registry like every
    other knob, so an unset env falls through to that same shipped default —
    the prior hardcoded `gemma-4-31b-it` code-level last-resort was retired
    in #2179. Switch to a `gemma-*` model manually — its own free-tier
    bucket, 30 RPM / 14,400 RPD, and RECITATION-filter-immune — via env).
    Every outbound call (primary AND retry) is gated through a per-model
    RPM/TPM/RPD limiter
    (`server/src/analyzer/rate-limit.ts`) so retries can't compound into
    429/500 storms. See `server/.env.example` for `GEMINI_RPM_*` /
    `GEMINI_TPM_*` / `GEMINI_RPD_*` overrides and
    [docs/features/archive/06-analyzer-gemini.md](docs/features/archive/06-analyzer-gemini.md)
    for the limits table.

## Layout

- `src/main.tsx` — entry; mounts `<App/>` inside `<Provider>`.
- `src/App.tsx` — root component; selects off the discriminated-union `ui.stage`
  and renders the matching view + any active modals.
- `src/lib/` — utilities and the API layer (~70 files), e.g. `icons.tsx`,
  `time.ts`, `colors.ts`, `router.ts`, `api.ts`, `types.ts`, generated
  `api-types.ts`.
- `src/data/` — design fixtures (characters, chapters, voices, books, etc.).
- `src/store/` — ~25 RTK slices + middleware, e.g. `ui`, `cast`, `chapters`, `revisions`, `manuscript`, `book-meta`, `notifications`, `voices`, `generation-stream`, … plus `broadcast-middleware.ts` (cross-tab `BroadcastChannel` sync since plan 63)
  - `index.ts` (configureStore, typed `useAppDispatch`/`useAppSelector`, router
    install).
- `src/components/`, `src/modals/`, `src/views/` — UI. Since plan 60, `src/views/listen.tsx` is a thin orchestrator (~440 lines) over three region sub-components under `src/components/listen/` — `listen-header.tsx` (cover + title + book-meta + Notes card), `listen-player-region.tsx` (markers + chapter list + Share-clip button), `listen-download-section.tsx` (download tiles + export queue). New listen-view features should land in the relevant sub-component, not the orchestrator.
- `src/mocks/canned-data.ts` + `src/mocks/manuscripts/` — mock API payloads.
- `openapi.yaml` (root) — **API contract**, source of truth for backend shapes.

## Conventions worth preserving

- **Discriminated-union `ui.stage`** (`src/store/ui-slice.ts`) — `{ kind: 'books'
| 'upload' | 'analysing' | 'confirm' | 'ready' }`, with `view`/`currentChapterId`/
  `openProfileId` living _inside_ the `ready` variant. Don't flatten.
- **Hash router grammar** (`src/lib/router.ts`) — pure `parseHash`/`stageToHash`,
  installed against the store via the `RouterStore` adapter so the router stays
  decoupled. Same URL grammar as the original prototype.
- **OpenAPI is the type source of truth** — `Character`/`Chapter`/`Sentence` etc.
  come from `src/lib/api-types.ts` (generated). Don't hand-write them.
- **Design tokens are CSS custom properties** — `src/styles.css` declares
  `--peach`, `--ink`, `--magenta`, etc.; `tailwind.config.ts` references those
  vars. No hex literals in component code.
- **Mocks behind `VITE_USE_MOCKS`** — `src/lib/api.ts` exports
  `api = USE_MOCKS ? mock : real`. Components import from `api.*` with a
  bounded, deliberate exception set: the install/detect/provisioning
  surfaces (`/api/{ollama,qwen,kokoro,coqui,whisper}/{detect,install}`,
  `/api/ollama/{pull,refresh}`, `/api/setup/venv/bootstrap`) talk to the
  local machine and have no mock counterpart; `mini-player`'s `keepalive`
  unload flush bypasses the mock api by design (must survive page unload);
  `store/queue-thunks.ts` honours the toggle through its own branch rather
  than through `api.*`. `.env.development` sets `VITE_USE_MOCKS=false` (real
  backend, since commit `6b4b2e51`) — `npm run dev` drives the real server;
  `npm run dev:mock` (`.env.mock`) is mock mode, and `.env.e2e`/
  `.env.marketing` set it true for their Playwright harnesses.
- **RTK immer** — slice reducers mutate via Immer drafts. Don't rewrite to spreads.
- **`server/src/gpu/` reaches a route module through a leaf gate, never an
  import** — a static import, a dynamic `import()`, and even `import type`
  all close an import cycle through `tts/index.ts`. Anything under
  `server/src/gpu/` that needs a value from a route module goes through a
  stateless leaf gate the owning module registers an accessor into instead.
  Three exist: `gpu/active-generation-gate.ts`, `gpu/qwen-tier-reconcile-gate.ts`,
  `gpu/sidecar-health-gate.ts` — each fails closed. The import graph's
  circular-dependency baseline is mechanically enforced (#2053) by
  `npm run check:cycles` (`scripts/check-import-cycles.mjs`) against the
  committed cycle LIST in `server/madge-cycles-allowlist.json` — not a
  hand-typed count, which is blind to a swapped cycle. Runs as a `verify.yml`
  leg scope-gated to `server/**`, and in the full local `npm run verify` — not
  in pre-commit or pre-push, so it never slows a commit. It shells out to a
  version-pinned `npx --yes madge@8.0.0` rather than a `server/` devDependency
  (madge 8 declares `peerOptional typescript@^5.4.4` and this repo is on
  TypeScript 6, which makes the lockfile unresolvable for `npm ci`). Add a new
  cycle to the allowlist if it's new and intentional, otherwise break it
  instead of allowlisting it.
- **`cast.json` writes go through `withCastLock`/`withCastLocks`, never a
  bare `writeJsonAtomic`/`rm`** (`server/src/workspace/cast-lock.ts`). Four
  rules: (1) lock the innermost read-through-write, never the caller — one
  level only, a locked function must not call another locked function on the
  same book; (2) the read goes inside the lock, and so does every decision
  derived from it — wrapping only the write buys nothing at all; (3) two or
  more books → `withCastLocks`, never nested `withCastLock`s; (4) global lock
  order is **`design` → `library-voice` → `cast`** — never acquire an earlier
  class while holding a later one, or two requests deadlock. Since #2260 that
  no longer hangs forever: `withKeyLock` bounds each acquisition at 10s and
  throws a `LockAcquisitionTimeoutError`
  (`server/src/workspace/file-lock.ts`) naming the key and both rules. It is a
  diagnostic, **not** a licence to violate the order — the budget is per
  acquisition, so a nested path's worst case is depth × 10s, and ORDINARY
  contention behind a long holder reaches the same error, so a firing timeout
  means "look at the holder first, then the rules". **WHICH WRITE the timeout
  came out of decides the outcome — never which handler caught it** (#2295:
  discriminating by handler is what produced that bug, since one handler can
  cover an authoritative write and a best-effort one at once). EIGHT sites fail
  loud *by rethrowing into their job's or request's terminal outcome*: the six
  best-effort `catch` blocks around identity writes, plus the two
  AUTHORITATIVE `castBase.writeChecked` calls in the analysis persist blocks,
  each wrapped at its own call rather than at the enclosing
  `catch (persistErr)` — that handler also covers the fold/dedup/suggestions
  journals, which are lineage and must stay best-effort. Swallowing at an
  identity site would report success with `cast.json` written and the
  retirement lost; swallowing at an authoritative write reported success with
  `cast.json` and `state.json` never written at all. FOUR handlers swallow it
  deliberately: `reconcileRejectEdgesOnDisk`
  (`server/src/routes/analysis.ts`), which runs after every retirement has
  landed and writes only cosmetic `notLinkedTo` edges the next persist
  re-heals; and the three interim cast.json snapshots (per-chapter, stage-1,
  subset), which a final write in the same run clobbers, so a timeout there
  diverges nothing (#2292). A NINTH site fails loud in a different shape and is
  counted separately for that reason: `cast-reject-orphan`'s
  `forgetSupersededId` handler answers its OWN 500 rather than rethrowing,
  because its leftover is not something a user can rely on anything else
  clearing — the two `supersededBy` prune passes key on conditions an orphaned
  id does not ordinarily meet (they fire only if a later analysis re-mints that
  id as a live cast row, or if the target leaves the roster), so the body names
  a retry rather than a later analysis. Only the five batch routes
  (`script-review`, `cast-design`,
  `voice-style`, `cast-series-patch`, `voice-override-linked`) are neither
  swallowed nor escalated: they keep their per-item failure shape inside an
  otherwise-successful 200/207 and report contention through `itemFailureReason`
  (`workspace/file-lock.ts`). **No client-facing failure ever carries a lock
  timeout's own message** — not an escalating body, not a per-item reason, and
  not an SSE `error` event: a `LockAcquisitionTimeoutError` names the lock key,
  which embeds the absolute workspace path, and this app is served over LAN
  HTTPS. Three curation seams, all in `workspace/file-lock.ts`, and a route
  needs exactly one of them: **per-item** failures inside a 200/207 use
  `itemFailureReason` (the five batch routes); a handler that fails the
  **whole request** uses `requestFailureMessage`, which curates this one class
  and leaves every other body verbatim — `git grep requestFailureMessage`
  enumerates all twelve sites (`book-state` ×4, `voice-library` ×3, `voices`,
  `qwen-voice`, `voice-style`, `single-design`, `cast-design`'s defensive
  outer), alongside the two merge routes' own explicit
  `LOCK_CONTENTION_REQUEST_ERROR` branch; and
  both **analysis jobs** go through `classifyAnalysisFailure`, which maps the
  class to `code: 'lock-contention'` with the same curated sentence and no
  `detail` blob (that blob renders in the UI's collapsible). The raw error goes
  to the log at every one of them. A new handler downstream of any lock is
  wrong if it returns `(e as Error).message` (#2292 round 5, widened in the
  final round). See each site's own comment.
  **Letting it through is not the
  same as throwing where it was caught** — at a handler that sits mid-way
  through a multi-file write (the two analysis persist blocks, `cast-merge.ts`),
  throwing on the spot skips the writes that follow and lands in an enclosing
  best-effort handler that reports success anyway, which is worse than
  swallowing: loud nowhere, and now with a half-written book. Those sites park
  the error in a local and rethrow it after the remaining writes have
  completed, so the terminal outcome is an error AND disk is whole. **A
  deferred rethrow binds the CALLER too**: by the time it escapes, the work is
  applied, so a caller with follow-up writes of its own must finish them before
  letting it surface (`cast-merge-suggestions.ts`'s accept route and its
  `dismissSuggestion`) — otherwise the skipped write just moves up one frame.
  `server/src/workspace/cast-lock.guard.test.ts`
  fails the build on a new unlocked site. Two allowlisted exceptions, each
  keyed on file **and** count so a further unlocked write in either still
  fails: `analysis.ts`'s five merge-base writes (deferred to #2015), and
  `voice-override-linked.ts`'s one write, which **is** locked but through a
  helper the deliberately-syntactic scan cannot follow. The guard is
  call-graph-blind by design — a new *unlocked* caller of an already-locked
  helper adds no occurrence text and passes; its header lists that and the
  other blind spots.
- **`cast.json` is the identity of record; an analyzer/cache `characterId` is
  only an alias into it** (#2040) — any path that changes a persisted character
  id calls `retireCharacterId` (`server/src/store/cast-id-history.ts`), which
  records the old id before the new one takes over; any path that joins on a
  `characterId` from manuscript attribution or a frozen render resolves it
  through `buildCastResolver` (`server/src/store/cast-resolve.ts`) rather than
  a raw `.get()`. Don't add a second id matcher or a second id-history field.

## Testing discipline (REQUIRED for every change)

Every PR MUST improve automated coverage on top of updating its regression
plan. Regression plans under `docs/features/*.md` document invariants and
manual acceptance walkthroughs — they complement automated tests, they do
not replace them.

- New behaviour → ship paired automated test(s).
- Bug fix → ship a regression test that fails before the fix and passes after.
- Refactor → existing tests stay green; add coverage for any previously-uncovered seam you touched.
- Never delete or `.skip` a test without an explicit replacement or follow-up plan item.
- If a change lands in untested territory (e.g. the Python sidecar still has no pytest), the test scaffold itself is part of the work — do not ship code without it.
- **UI-visible behaviour SHOULD land an e2e test** when the change crosses
  router/redux/layout seams (Vitest+jsdom can lie about layout, focus, and
  hashchange timing). One Playwright spec per feature surface is the bar.
- **Flaky tests** route through `quarantinedIt` (`server/src/test-utils/quarantine.ts`) into the non-gating lane (`npm run test:quarantine`); each is logged in `docs/testing/flaky-register.md`. Never add a raw `it.skipIf(process.env.CI)`.
- **Behaviour only real hardware can prove** — a live GPU, a real sidecar, a real analyzer, a real book — is logged in [`docs/testing/onbox-acceptance-register.md`](docs/testing/onbox-acceptance-register.md) when it cannot be verified inside its own PR. Complex work routinely cannot be accepted at PR time, so **owed acceptance never blocks a merge — it converts into a row there.** *Recording* that debt does block: the register, the per-feature run sheet, and the register's live view ([`docs/testing/onbox-acceptance-register-live-view.html`](docs/testing/onbox-acceptance-register-live-view.html), the file published to the artifact URL) all move in the shipping PR. The add/remove rule is Before-shipping checklist step 3.

Harnesses (five tiers):

- Frontend: `npm run test` (Vitest + jsdom + React Testing Library). Tests live next to the unit (`*.test.ts(x)`).
- Server: `cd server && npm run test` (Vitest + node env, real-ffmpeg integration where relevant). Same colocation.
- Sidecar (`server/tts-sidecar/`): pytest harness at `server/tts-sidecar/tests/`,
  invoked via `server/tts-sidecar/run-tests.ps1` or `npm run test:sidecar`.
  Any new sidecar code MUST add cases here.
- PowerShell helpers (`scripts/lib/`): Pester 5 tests in `scripts/tests/`, invoked via `scripts/tests/run.ps1` or `npm run test:scripts`.
- **E2E (`e2e/`)**: Playwright + chromium against Vite in mock mode on port 5174,
  invoked via `npm run test:e2e`. Browser-level golden paths + on-ramp for
  visual regression (`toHaveScreenshot()`). See `docs/features/archive/37-e2e-playwright.md`.
- Top-level `npm run test:all` runs the frontend, server (incl. server-slow),
  PowerShell-scripts, and sidecar harnesses, plus `test:hooks` and the
  `test:pinokio` stub.
  `npm run verify` adds typecheck + e2e + build on top (no longer the
  pre-push default — see "Commit gate" — but still the full local battery
  when you want to run it).

Canonical end-to-end manuscript for full-pipeline regression:
`server/src/__fixtures__/the-coalfall-commission.md` — _The Coalfall Commission_,
a Castwright-owned original (committed; safe to use freely). A Russian variant of
Chapter One lives alongside it at `the-coalfall-commission.ru.md` for the
language-detection fixtures. Cite these from any regression plan that needs an
e2e run rather than inventing fresh fixtures. See
`docs/features/archive/28-chapter-audio-format.md` for the canonical recipe.

## The backlog

`docs/BACKLOG.md` is the thin, MoSCoW-bucketed **prioritized planning view**,
**generated from the GitHub Projects (v2) "Castwright Kanban" board**
(`npm run backlog:sync` — see CONTRIBUTING.md "The board") — don't hand-edit
it. Each item maps to exactly one GitHub issue (title `<prefix>-<n> — <what>`),
which is the **canonical detail home** — What / Acceptance / Key files /
Depends on / Benefit live in the issue, not in BACKLOG.md. The `<prefix>-<n>`
ID stays the durable cross-reference for code/commits/plans; the issue `#NN`
is the GitHub-native auto-close hook. A numeric `Priority` field on the board
drives intra-tier ordering. **`docs/BACKLOG.md` renders `type:feature` issues
only.** `npm run backlog:sync` filters to `type:feature` with board Status not
`Done`; **`type:chore` issues and `bug` issues never appear there** — they live
on the board's "Bugs & Chores" view, which is their complete home. So a chore
needs no BACKLOG row, and its absence is not drift. (Bugs remain out-of-band
besides: the user files them as they hit them.) The label taxonomy, issue forms, and the full
convention live in [CONTRIBUTING.md "Issues"](CONTRIBUTING.md#issues); plan
[241](docs/features/archive/241-github-projects-kanban-board.md) is the rationale
(supersedes [166](docs/features/archive/166-github-issues-backlog-integration.md)).

When you ship a backlog item:

1. Close its issue — or let the delivering PR auto-close it via `Closes #NN`
   in the PR body (`Refs #NN` for a partial / multi-wave delivery).
2. Remove (or, for a Won't item, collapse) its row in `docs/BACKLOG.md`.
3. Update the source plan's `status:` and/or fill its **Ship notes**; if the
   plan is now `stable`, move it to `docs/features/archive/`.

When you discover a new outstanding item (e.g. a "Suggested follow-up"
added to a plan), file a Backlog-item issue in the same round — it gets
`area:`/`moscow:`/`type:` labels and is auto-added to the board by
`.github/workflows/add-to-project.yml`. **If it is `type:feature`, also
re-run `npm run backlog:sync`** so its row lands in `docs/BACKLOG.md`; a
`type:chore` or `bug` issue is complete at the board and needs no row (see
above). The backlog is only useful while it stays current.

**Filing is for net-new work, not for findings.** A "suggested follow-up" that
is a genuinely new capability belongs here. A **defect or a chore** found in
passing does not: it gets **fixed in the same round** by a dispatched fix agent,
and its issue merely records that — see [Incidental
findings](#incidental-findings-report-fix-record). This is where the `type:chore`
label misleads: it exists so the item routes to the board's "Bugs & Chores" view
instead of `docs/BACKLOG.md`, **not** to mark it as deferrable. A chore the work
made owed is fixed now and the issue closes in the same PR. A plan that ends
with a list of unfixed defects or chores under "Suggested follow-ups" has
mis-filed them.

## Planning-mode behaviour

When in planning mode, or when asked "what's outstanding?" / "what's left?" / "summarise what we'd do":

- **List ALL items, in priority order.** No top-N truncation, no "and a few more" hand-waves. If there are 12 things, write 12. The user reads the whole list and re-prioritises if needed — collapsing it to "top 3" forces them to ask follow-ups.
- **Each item carries a one-line benefit.** Tag it `*Benefit (user / technical / architectural):*` so the _why_ is visible at a glance. An item without a benefit line is a TODO masquerading as a plan — write the benefit or drop the item.
- **Priority is explicit.** Number the list (1, 2, 3 …) — do not present a flat unordered set. If two items are genuinely tied, group them under one number and say so.
- **Distinguish "must do" from "nice to have."** When the plan has a natural break (e.g. v1 vs. follow-up), call it out with a heading rather than burying it in adjectives.
- **Do not narrate work already done in the summary section.** Past tense belongs in a separate "Done in this session" line, NOT mixed into the outstanding list.

This applies to BOTH formal plans (ExitPlanMode) AND informal end-of-turn summaries when the user is mid-planning.

## Before-shipping checklist

Run this before declaring any non-trivial task "done." Skipping a step is fine when the step genuinely does not apply (e.g. a doc-only change has no test plan) — but say so explicitly rather than silently omitting.

1. **Update or create the regression plan** under `docs/features/` — _for substantial/cross-cutting work._ New feature → new file from `TEMPLATE.md` (and tag the issue `needs-plan`). Changed behaviour cited in an existing plan → update that plan in the same diff. Use frontmatter `status:` (`draft` / `active` / `stable` / `scaffolded` / `deferred`). Small/localized items skip the plan doc — the issue body + paired test is the spec.
2. **Land paired automated test(s).** New behaviour → new test. Bug fix → regression test (fails before, passes after). UI-visible behaviour crossing router/redux/layout seams → Playwright e2e spec under `e2e/`.
3. **Account for on-box acceptance — a merge gate.** If this PR ships behaviour that only real hardware can prove — a live GPU, a real sidecar, a real analyzer, a real book — or if it discharges acceptance already owed, then **this PR must leave the acceptance state recorded across all three surfaces**, in the same diff:
   - [`docs/testing/onbox-acceptance-register.md`](docs/testing/onbox-acceptance-register.md) — the row, grouped by hardware prerequisite;
   - the per-feature run sheet (`docs/testing/<feature>-onbox-acceptance.md`) where one exists — the criteria, and the filled-in `Result:` lines once run;
   - **the live view, [`docs/testing/onbox-acceptance-register-live-view.html`](docs/testing/onbox-acceptance-register-live-view.html)** — a hand-authored styled page, **not** a rendering of the markdown. Edit that file here, then publish *it* with the `url` recorded in the register's header, never from scratch. Two ways this breaks silently: publishing *without* the URL mints a *second* register, and publishing the `.md` itself *to* that URL keeps the URL while replacing the styled page with default markdown rendering (this happened four times on 2026-07-31/08-01). Its derived figures (owed count, group counts, oldest debt) are recomputed, not carried over. `npm run check:onbox-register` cross-checks the owed total, the per-group counts and the row IDs — **not** the rest of the summary strip (oldest debt, the group/blocked/unconfirmed tallies), which stay a manual recompute. **Immediately before publishing**, run `npm run check:onbox-register -- --against-published <file>` against a locally saved copy of the page currently live at that URL — the same comparator as the tracked-pair check, reused against the live artifact. It detects structural drift (rows live vs. registered) and content drift (per-row body text hash changes from baseline). It fails when the live page has rows your register lacks AND `origin/main` still has them (another lane ahead of you); when your register has rows the live page doesn't yet, that's the normal reason you're publishing, not a defect — qualified further by #2199 (a live-page row `origin/main`'s own copy also lacks is a discharge, not a defect, and isn't reported either) and by `--discharging <ID>[,<ID>...]` (#2272, for the one shape #2199 can't see: a discharge THIS change made that hasn't merged to `origin/main` yet — publishing runs before merge, so the baseline can't tell it apart from a genuinely-owed row until you name it; naming an ID that isn't actually live-only is refused, not silently accepted) — and stop if it disagrees: two lanes can each merge a correct, agreeing edit and still lose a row at publish time if the second one publishes from a build made before the first one's merge landed (#1931's original incident, one level up from the git-side race the tracked-pair check already closes). See the register's own "Live view" section for the full four-step procedure — this is a manual step CI cannot run for you (no network access from a required check).

   **Recording blocks the merge; running does not.** Complex work often cannot be accepted at PR time and a PR must not sit open waiting for a contended box — owed acceptance still converts into a row rather than holding the PR. What is no longer optional is the *bookkeeping*: a PR that ships unproven behaviour without a row, or discharges acceptance without recording the outcome, is not finishable.

   When adding a row, say what to observe (concretely, not "verify it works"), the hardware prerequisites, and where the criteria live. A row **comes out** only when (a) the acceptance was run on the box and the result recorded, or (b) the repo owner explicitly confirms it was exercised on a live book or books; either way record what was observed, by whom, and when — an outcome, not a deletion. "Tests pass, so it's presumably fine" never removes a row.

   `npm run check:onbox-register` (`.github/workflows/onbox-register-check.yml`, ops-43) mechanically backstops the register's own internal arithmetic — glance-table counts vs. body row headings, and the stated total vs. the glance table — on every PR touching the file. It cannot tell you a row is missing, only that the ones already there don't add up.
4. **Update `docs/features/INDEX.md`** if the plan is new or moved (new entry under its area, or move to `## Shipped (archive)` per `archive/README.md` when shipping a plan).
5. **Update the two release-notes documents, in this PR.** Append an entry to `docs/release-notes-next.md` (technical register, PR-refed) AND a matching user-facing, brand-voice line to the in-progress version section at the top of `RELEASE_NOTES.md`. Land both PR-by-PR, not reconstructed from git history at cut time — that's the whole point of this step. The first-PR-after-a-cut bootstrap case (resetting both files) is documented once, in [CONTRIBUTING.md "Release notes"](CONTRIBUTING.md#release-notes) — check there, don't re-derive it. Skip only when the change has no shippable delta (pure docs/process, CI-only, internal chore with no user- or operator-visible effect) — say so explicitly rather than silently omitting.
6. **Close or advance the linked issue.** Put `Closes #NN` in the PR body for a full delivery (`Refs #NN` for a partial), and confirm the issue's `area:`/`moscow:` labels still reflect reality. Bugs link their `bug` issue with `Closes #NN` too. This link is verified, not assumed — if none exists at PR-creation time, one is auto-filed and linked without pausing to ask, including for bug-shaped work (a deliberate, scoped override of "The backlog" section's general "the user files [bugs] as they hit them" convention, for this gate only — see [PR review → issue verification](.claude/skills/pr-review-gate/SKILL.md#issue-verification-at-pr-creation)); `.github/workflows/pr-issue-link.yml` mechanically backstops the check on every PR, and (since 2026-07-06) a missing link blocks merge outright via `main`'s required-status-check ruleset — see `docs/features/235-model-routing-review-gates.md`.
7. **Run `npm run verify:fast:branch`** locally (same battery as pre-push) — or the full `npm run verify` if you want more than the branch-scoped subset. Cloud `verify.yml` is the required, authoritative gate either way (see "Commit gate").
8. **If shipping a plan** (status → `stable`): fill its **Ship notes** section with the shipped date and the commit SHA, then `git mv` it under `docs/features/archive/` and re-link any active plan that pointed at it.
9. **Surface what changed** in the end-of-turn summary in 1–2 sentences. Do not narrate the diff — point at the user-visible delta and the test that locks it.
10. **Independent PR review.** Once every item above is done (or explicitly marked not-applicable) and the branch is pushed, run the mandatory gate via the `pr-review-gate` skill — see [the PR review runbook](.claude/skills/pr-review-gate/SKILL.md). Triage and fold findings before merge.

## Out of scope until told otherwise

- New features. Surface area is final for v1.
- Visual redesign. Reproduce the existing look pixel-for-pixel.
- Backend work. This repo is the frontend that will call the OpenAPI spec.

## Mobile testing protocol (plan 81)

The app drives on phone + tablet over LAN HTTPS (plan 81 archive: `docs/features/archive/81-mobile-tablet-support.md`). When working on any view, verify it stays responsive at three viewports:

| Viewport | Tailwind prefix | Target devices | Layout rule |
|---|---|---|---|
| `<640px` | (default) | portrait phones | single-column, drawers + bottom sheets, modals full-screen, hamburger menus |
| `640–1024px` | `sm:` and `md:` | tablets, landscape phones | two-column where appropriate, modals as dialog, secondary panes as right drawer |
| `≥1024px` | `lg:` and `xl:` | desktop, tablet landscape | three-pane layouts, full top bar |

> **Top-bar nav exception (2026-06-19):** the top-bar navigation collapses into a
> hamburger drawer below `xl` (1280px), so a 1024–1279px desktop window shows the
> hamburger rather than the inline strip. The rest of the bar follows the generic
> `lg:`=desktop rule above. See `docs/superpowers/specs/2026-06-19-responsive-topbar-nav-design.md`.

**Touch-equivalence rule:** every desktop drag/hover affordance ships its tap replacement. Examples already in the codebase:
- Cast voice library: drag-and-drop voice card → cast row OR tap "Assign" pill → tap row (`src/views/cast.tsx`).
- Manuscript paragraph boundary: PointerEvent handler covers mouse + touch + pen in one path (`src/views/manuscript.tsx`).
- Hover-reveal labels: `coarse-pointer:opacity-60` keeps them faintly visible on touch devices (`src/views/manuscript.tsx` boundary handle).

**Touch targets:** every interactive control ≥44×44 px on **any touch device** per WCAG 2.5.5. Use `min-h-[44px] fine-pointer:min-h-0` (and `min-w-[44px] fine-pointer:min-w-0` for icon-only buttons) so phones **and tablets** get the target while mouse (fine-pointer) devices stay compact. The `coarse-pointer`/`fine-pointer` variants are defined in `src/styles.css` (`@media (pointer: coarse|fine)`); for a control with no base size, add `coarse-pointer:min-h-[44px]` instead. This superseded the old `min-h-[44px] sm:min-h-0` phone-only pattern (2026-07-12 touch-bug sweep) — `sm:` removed the target at ≥640px, i.e. exactly the tablet range, so tablet toggles/pills read as unresponsive to touch.

**LAN access for real-device testing:**

1. One-time per dev box: install `mkcert` (`scoop install mkcert` / `brew install mkcert` / `apt install mkcert`), then `mkcert -install`.
2. `npm run install:cert-mobile` — prints LAN URL + QR code + per-OS root-cert install steps.
3. Install the root CA on each mobile device once (iOS: Settings → Profile downloaded → Install → trust; Android: Settings → Security → Install certificate).
4. Run the server in LAN HTTPS mode: `npm run dev:lan` (HMR-capable Vite + Node both at `https://0.0.0.0:5173`/`:8443`) OR `npm run build && npm run start:lan` (production bundle at `https://0.0.0.0:8443`).
5. Open the printed LAN URL on the device — lock icon, no warning.

**Automated regression net:**

- `npm run test:e2e` (cloud `verify.yml` gate, ~90s): `playwright test --project=chromium`. Runs every spec + the chromium project of the responsive specs (`e2e/responsive/*.spec.ts`).
- `npm run test:e2e:mobile` (opt-in, ~10-15min): `playwright test --project=mobile-chrome --project=tablet-chrome`. Runs only `e2e/responsive/*.spec.ts` at phone (Pixel 7) + tablet (iPad Pro 11) viewports.
- `npm run test:e2e:all` (opt-in, ~17min): everything across all 3 projects.

Adding a new view? Append a case to `e2e/responsive/coverage.spec.ts` — it auto-runs at every project.

## Suggested follow-ups (not requirements)

- **Model lifecycle is split between eager and button-driven** —
  _Don't confuse "default generation engine" with "eagerly-resident model":_
  **Qwen is the default/main generation engine** (the hot path a book render
  uses); **Kokoro is the always-available fallback**, cheap enough (~1 GB) to
  optionally keep resident, gated by the `PRELOAD_KOKORO` setting
  (`server/src/config/registry.ts:635`, registry key `tts.preload.kokoro` —
  defaults **off** since fs-60, because non-English books can use Coqui too,
  so an always-hot English-only engine stopped being a universally good
  default; "Turn off if Qwen is your main engine" still applies for anyone
  who does turn it on). Resident ≠ default-for-generation.
  - **Kokoro v1 (fallback engine, new in 2026-05)**: warms on demand at the
    first synth that needs it (~1 s cold load, ~1 GB VRAM) unless
    `PRELOAD_KOKORO=1`, in which case it's eagerly loaded at sidecar startup
    and stays permanently resident alongside the analyzer Ollama on an 8 GB
    GPU. A Stop pill exists (the same `ModelControlPill` Coqui uses) and is
    reachable via the Status popover (residency-gated, but behind a click) as
    well as, since #1839, the global TTS notice banner
    (`src/components/tts-notice-banner.tsx`) for direct access whenever it
    happens to be resident. It's available once
    `server/tts-sidecar/scripts/install-kokoro.ps1` (or its
    cross-platform `install-kokoro.mjs`/`.sh` wrappers) has dropped the
    weights into `server/tts-sidecar/voices/kokoro/`. Voice catalog
    filtered to English-only (28 voices: `af_*`, `am_*`, `bf_*`, `bm_*`).
  - **Coqui XTTS v2 (alternate)**: button-driven via `ModelControlPill`
    (`src/components/`). The TTS sidecar defaults `PRELOAD_COQUI=0`
    (`server/tts-sidecar/main.py`) so XTTS only loads on demand. Loading
    XTTS auto-evicts the analyzer Ollama and vice versa (with an inline
    "TTS / Analyzer unloaded to free VRAM" banner). Endpoints:
    `POST /api/sidecar/{load,unload}` (60 s / 2 s budgets),
    `POST /api/ollama/{load,unload}` (uses Ollama's `keep_alive` idiom,
    see `server/src/analyzer/ollama.ts:179` (`keepAliveFor`) for the equivalent in-band
    evict on real chat calls).
  - **Qwen has TWO models with split lifecycles** (`QwenEngine`,
    `server/tts-sidecar/main.py`): the **Base 0.6B** synth model is the
    resident one (button-driven `/load`, like Coqui; not eager unless
    `PRELOAD_QWEN=1`). The **VoiceDesign 1.7B** model is loaded transiently
    during `design_voice` and kept WARM across a cast-review session so
    back-to-back designs don't reload it — then freed (reclaiming ~4–5 GB)
    by a startup idle watchdog once it idles past `QWEN_DESIGN_IDLE_TTL`
    (default 120 s), or immediately at the first real `/synthesize` (leaving
    design mode for generation). On an 8 GB GPU Base + VoiceDesign are
    co-resident only DURING a design; don't add a third heavy model
    (e.g. an accidental Coqui `/load`) on top — that was the plan-108
    OOM (108 post-ship `fix/sidecar-qwen-design-vram`).
  - **Per-character voice profiles are per-engine**: each cast member
    carries an `overrideTtsVoices: { coqui?: {name}, kokoro?: {name},
gemini?: {name} }` map. Engine switches preserve cast assignments;
    no re-cast needed when toggling Coqui ↔ Kokoro. Legacy single-field
    `overrideTtsVoice` is migrated lazily at cast.json read time.
  - **Whisper ASR is a 4th sidecar engine (srv-31 / plan 186)** — audio→text,
    NOT in the synth `ENGINES` map (`WhisperEngine` + `POST /transcribe`). Used
    by the per-sentence content-QA gate to catch "fluent but wrong words"
    generations. **CPU-first by default** (`ASR_DEVICE=cpu` → zero VRAM, never
    competes with synth); `ASR_DEVICE=cuda` opts into the GPU with a tiny/base
    int8 model (~150–400 MB) gated by the weighted VRAM semaphore (`asr:1`) plus
    an idle-evict watchdog (`ASR_IDLE_TTL`, mirrors the Qwen VoiceDesign one).
    ASR and Qwen VoiceDesign never co-reside (design = cast-review, ASR =
    generation/repair). OFF unless `SEG_ASR_ENABLED`; `faster-whisper` ships
    in `requirements/base.txt` (installed with the standard sidecar bootstrap)
    — only the model weights are fetched on first ASR load.

## Commit gate

Three-tier automated gate, enforced by husky hooks in `.husky/`:

- **commit-msg** (`.husky/commit-msg`): runs `scripts/validate-commit-msg.mjs`
  on the subject line. Rejects commits that don't match the
  `<type>(<scope>): <subject>` convention (with `chore: <subject>` as the
  no-scope catch-all). Merge / Revert / fixup! / squash! commits are exempt.
  Full spec lives in [CONTRIBUTING.md](CONTRIBUTING.md); regression plan is
  [docs/features/archive/38-branching-and-commit-convention.md](docs/features/archive/38-branching-and-commit-convention.md).
- **pre-commit** (`.husky/pre-commit`): runs `npm run verify:fast:scoped` —
  validator unit tests + frontend + server tests, but **scope-filtered against
  the staged diff** (plan 156): a leg whose scope the staged change never
  touched is skipped (`[skip] … (out of scope)`), so a sidecar-only or
  docs-only commit runs none of them. Sub-5s on a warm cache. Refuses the
  commit if any in-scope spec is red. Sidecar (pytest), Pester scripts,
  Playwright e2e, and typecheck are NOT in pre-commit — they live in
  pre-push so commits stay snappy. Under `--scope-staged` the `test`/
  `test:server` steps additionally run vitest's own `--changed HEAD`
  selection (`test:changed`/`test:server:changed`) instead of the whole
  suite — a one-file server commit runs only the tests that file's diff
  touches, not all ~6700. Applies only to an UNSHARED `--scope-staged` diff
  that is CONFINED to the step's own primary source root with a safe
  extension (`diffSafeForChangedOnly` — `src/**` for `test`,
  `server/src/**` for `test:server`, `.ts`/`.tsx`/`.js`/`.jsx`/`.mjs`/`.cjs`/
  `.mts`/`.cts` only) — a positive allowlist, not an exclusion list, after
  three review rounds each found a narrower live gap in "matches this step's
  declared scope" (a shared root-manifest/lockfile change; a step's own
  `extraFiles`/server lockfile; a root-level config file matched only via
  `globs`; a non-JS asset like `src/styles.css` read by its guard tests via
  `readFileSync`, not import). Any diff outside that allowlist still runs
  every step's full script, since `--changed` against a file no test's
  dependency graph actually reaches would otherwise exit 0 having run
  zero tests. A `--changed`-only pass is also never written to the verify-cache
  (only a full run is), so it cannot leave behind a cache entry a later
  `--scope-branch`/CI run would read as `[cached]` and skip. `--scope-branch`
  (pre-push) always runs the full suite — the narrowing above never applies
  there — so a change `--changed` misses through an untracked dependency is
  still caught before merge. (Cloud CI narrows its own PR runs via
  `vitest run --changed <PR base>` independently — see `verify.yml`'s
  Frontend/Server test legs — a pre-existing, deliberate design predating
  this pre-commit optimisation and unrelated to it; pre-push's full local
  run is the actual full-suite gate before merge, not CI.) If a co-running
  GPU generation is
  detected (nvidia-smi) **or a sibling worktree is already running a
  vitest/verify-cache battery**, the runner warns and throttles test
  concurrency (`LOW_CONCURRENCY=1`); `SKIP_CONTENTION_CHECK=1` disables both
  probes.
  `npm run verify:fast` (no scope filter) remains for a manual full fast run.
- **pre-push** (`.husky/pre-push`): first runs `scripts/guard-protected-push.mjs`,
  which refuses a force-push or deletion of a protected branch (`main`) before
  the battery even starts (a local guard; since 2026-06-14 `main` ALSO has
  server-side branch protection — a GitHub ruleset blocking force-push +
  deletion, enabled after the Pro upgrade per `com-4` — so this hook is now
  belt-and-suspenders; see
  [docs/features/163-protected-push-guard.md](docs/features/163-protected-push-guard.md);
  bypass the local hook intentionally with `git push --no-verify`). Then, unless
  the push is docs-only (below), runs `npm run verify:fast:branch` — a fast,
  branch-diff-scoped subset (lint, typecheck, config:check, test:hooks, check:budget-poll, test,
  test:server, build, test:sidecar, audit, audit:server). Requires npm registry
  access (unlike other `verify:fast:branch` legs, the audit steps cannot run offline).
  Refuses the push if any in-scope step fails. This
  replaced running the full `npm run verify` battery on every push (see
  [docs/superpowers/specs/2026-07-06-verify-ci-rebalance-design.md](docs/superpowers/specs/2026-07-06-verify-ci-rebalance-design.md))
  — the heavy legs (e2e, server-slow, scripts, test:pinokio) now run in the
  cloud instead, which is now the required, enforcing gate (see below).

**Docs-only pushes skip `npm run verify:fast:branch` entirely** — `scripts/is-docs-only-push.mjs`
checks the pushed commits' changed-file set against the same doc-glob test as
CONTRIBUTING.md's "Doc-only PR fast-path" (`docs/**`, root `*.md`, `.github/*.md`);
a doc-only diff has no runtime surface for tests/build to exercise, so paying
even the fast local check is wasted time/CPU. Conservative by design: any
uncertainty (git error, unresolvable merge-base) runs the full selected-steps
battery rather than guessing.

`npm run verify` is cache-aware (see
[docs/features/archive/50-verify-cache.md](docs/features/archive/50-verify-cache.md)):
each step skips with `[cached]` when its input hash matches the last
green run. Pass `npm run verify -- --no-cache` to force a full re-run.

`npm run verify` also prepends `lint` (ESLint + Prettier via
`eslint-config-prettier`) and includes `test:a11y` (axe-core on the six
core views) — see [docs/features/archive/46-lint-format-a11y.md](docs/features/archive/46-lint-format-a11y.md)
for the rulesets, the autofix-baseline shape, and the rationale for each
relaxed rule.

**GitHub CI is OPT-OUT (2026-07-06, superseding plan 215's opt-in design)**:
the `verify.yml` battery runs automatically on every PR by default and is a
**required status check** on `main` — it actually blocks merge on red. This
replaces the prior opt-in/label-gated design, which existed to control
Actions-minute cost while the repo was private; the repo is now public, so
standard-runner Actions minutes are free and uncapped, and that rationale no
longer applies. Local pre-push now only runs a fast, branch-scoped subset
(`verify:fast:branch`) — this cloud run is the real enforcement gate for
everything else, not redundant insurance. Every leg is still
**scope-filtered** to what the PR's diff actually touched (plan 103 — `git
diff` against the PR base; a frontend-only PR skips server tests, a
server-only PR skips Playwright e2e + the frontend unit suite, a root
`package.json`/`package-lock.json` change runs every leg) — that scoping is
now about not running tests that can't fail, not about saving money. A
manual dispatch (Actions tab → Verify → Run workflow, or `gh workflow run
verify.yml --ref <branch>`) still runs the full unscoped battery, useful for
a clean-room check off a non-PR ref.

What still runs automatically: `pr-title-lint.yml` and `pr-issue-link.yml` on
every PR, `app.yml` on `apps/android/**` changes (the only automated coverage
for the Flutter companion — no local hook runs `flutter analyze`/`test`),
`release.yml` on a `vX.Y.Z` tag, and `cross-os.yml` on its **twice-weekly**
(Wednesday + Sunday) cron. **Every release tag now runs COMPLETE
cross-platform verification before it publishes** (plan 215): `release.yml`
gates publish on full `npm run verify` (Ubuntu) + `test:e2e:mobile` (Ubuntu)
+ `verify:quick`+build on macOS **and** Windows — a red leg on any deployer
OS blocks the public-beta release, so you no longer fire cross-OS by hand
before a release. `cross-os.yml` (`workflow_dispatch` + twice-weekly cron on
`main`) stays as the between-releases pulse + ad-hoc cross-OS/mobile run.
Docs-only PRs still complete `verify.yml` in seconds rather than deadlocking
the required check — every leg's own scope condition is false for a
docs-only diff, so the job just does env setup and reports green (see
[docs/superpowers/specs/2026-07-06-verify-ci-rebalance-design.md](docs/superpowers/specs/2026-07-06-verify-ci-rebalance-design.md)
for why `paths-ignore` was deliberately removed rather than kept).
See [docs/features/215-ci-label-gated-verify.md](docs/features/215-ci-label-gated-verify.md)
and [103](docs/features/archive/103-ci-cost-reduction.md) for the superseded opt-in
design's history/rationale, and
[docs/superpowers/specs/2026-07-06-verify-ci-rebalance-design.md](docs/superpowers/specs/2026-07-06-verify-ci-rebalance-design.md)
for the current design.

Branching model and the full commit convention (allowed types, allowed scopes,
multi-scope syntax, worktrees for parallel agent work) are documented in
[CONTRIBUTING.md](CONTRIBUTING.md). Read this before opening a branch.

## Branching workflow (REQUIRED for every non-trivial change)

**Every piece of work gets its own worktree AND its own branch. Never ride
`main`.** This holds for solo, sequential work as much as for parallel agents —
worktrees are not a parallelism device here, they are the isolation boundary
that keeps the primary checkout clean and keeps concurrent sessions from
stealing each other's HEAD.

Before starting any non-trivial work — new feature, bug fix, refactor, plan
implementation:

1. **Create the worktree and branch first, off the latest `main`.** The branch
   is `<type>/<scope>-<slug>`, with `<type>` and `<scope>` from the
   [commit-convention vocabulary](CONTRIBUTING.md#commit-convention). Examples:
   `feat/server-batch-retry`, `fix/frontend-voice-swatch-click`,
   `docs/docs-plan-39`. A worktree created with an auto-generated name gets
   its branch renamed to that shape immediately, not at merge time.
2. **Make the worktree real before trusting it** — see the setup checklist
   below. A fresh worktree's hooks silently no-op, so an unprepared one gives
   you the *appearance* of a gate with none of the enforcement.
3. **Land all commits for that piece of work on that branch.** Do not mix
   unrelated work on one branch — one branch = one cohesive change.
4. **Surface the worktree path and branch name in your end-of-turn summary**,
   along with the commit SHAs, so the user can review the diff and decide when
   to merge.
5. **Tear the worktree down deliberately** once merged — junctions first, then
   the worktree. See the teardown recipe below.

### Worktree setup (do this before the first commit)

**Preferred: `node scripts/wt-new.mjs <type>/<scope>-<slug>`.** One command for
branch + worktree + non-clashing port assignment + both `npm install`s — and the
root install activates husky via `prepare`, so the tree is gated from its first
commit. See [CONTRIBUTING.md "Running multiple Claude Code
conversations"](CONTRIBUTING.md#running-multiple-claude-code-conversations).

**A tool-created worktree is NOT set up for you.** `EnterWorktree` and the Agent
tool's `isolation: "worktree"` create the tree and nothing else — no
dependencies and, critically, **no active git hooks**. `core.hooksPath` is
inherited but resolves per-worktree, and `.husky/_` is git-ignored, so a fresh
checkout never carries it. Git finds no hook and runs none, **silently**:
invalid commit messages sail through, pre-push verify never fires. In that case:

1. **`npx husky`** in the worktree — regenerates `.husky/_`. This is the fix.
   Junctioning `node_modules` does **not** activate hooks. `npm install` does
   (via `prepare`) but is heavy, and *replaces* an existing junction with a real
   directory, which changes teardown.
2. **Junction `node_modules` AND `server/node_modules`** from the primary
   checkout — the cheap alternative to installing. Frontend tooling resolves via
   root alone, so `server/` is easy to forget and fails the server test legs
   with "vitest not found".
   **For real sidecar/TTS work, also junction `server/tts-sidecar/voices/`**
   (found 2026-08-31, register row A1) — it holds the actual model weights
   (Qwen HF cache, Kokoro ONNX, Coqui/XTTS, cloned-voice artifacts) and is
   git-ignored like `.venv`, but junctioning only `.venv` leaves it absent. A
   missing `voices/` doesn't 404 cleanly — Kokoro throws `Kokoro model not
   found` repeatedly at sidecar boot, which can trigger enough restarts to trip
   the `recycle-storm` circuit breaker mid-chapter, misreporting as a side-11
   host-memory-leak regression (#399) when the real cause is the missing
   junction. See [#2811](https://github.com/dudarenok-maker/Castwright/issues/2811).
3. **Verify both.** `ls -d .husky/_ && git config core.hooksPath`, and for each
   junction `(Get-Item $p -Force).Target` — a relative `..` target resolves
   against the shell's CWD at creation time, not the link's own directory, so an
   off-by-one silently points at nothing while `ls` still looks plausible.
   **Do not use `.LinkTarget`:** it is PowerShell 6.2+, and on this box's Windows
   PowerShell 5.1 it reads as empty for a real junction — a check written against
   it passes vacuously and proves nothing. `.Target` works on both; so does
   `fsutil reparsepoint query <link>`.
4. **Never treat hook output as proof of verification in a worktree.** Hook
   output has been observed looking entirely genuine — real timings, real test
   counts — while gating nothing. If it matters, run
   `npm run verify:fast:branch` by hand.
5. **Create `server/.env`** with its own `PORT`, `WORKSPACE_DIR`, **and `LOCAL_TTS_PORT`**,
   **and** a root **`.env.local`** with matching `VITE_PORT` / `VITE_API_PORT` / `PORT`.
   Both halves are required: `vite.config.ts` resolves its API-proxy target
   from `VITE_API_PORT ?? PORT`, falling back to `8080` (no `strictPort`)
   when neither is set — so a worktree with only `server/.env` filled in gets
   a frontend that silently proxies `/api` to whatever's already listening on
   `:8080` (typically the primary checkout's server and workspace) while its
   own correctly-isolated server sits idle. `LOCAL_TTS_PORT` in `server/.env`
   isolates the TTS sidecar to a per-worktree port (#2632), so multiple
   worktrees can run sidecars concurrently without port conflict. A tool-made
   worktree (`EnterWorktree`, Agent `isolation: "worktree"`) never has this
   file — only `scripts/wt-new.mjs` writes it, and it's git-ignored — so this
   step doesn't error when skipped, it just silently breaks isolation. Pick an
   unused slot N (mirroring `scripts/wt-new.mjs`'s own `BASE_PORTS`/
   `PORT_STEP`) and step each port by `10 × N` off its own base —
   `VITE_PORT` off `5173`, `PORT`/`VITE_API_PORT` off `8080`, `LOCAL_TTS_PORT`
   off `9000` — e.g. slot 1 is `VITE_PORT=5183`, `PORT`/`VITE_API_PORT=8090`,
   `LOCAL_TTS_PORT=9010`. Set `VITE_PORT`, `VITE_API_PORT`, and `PORT` — all
   three — in `.env.local`; separately, set `PORT` **and `LOCAL_TTS_PORT`** in
   `server/.env`. Point `WORKSPACE_DIR` at a directory this worktree
   alone owns (e.g. `../castwright-workspace-<slug>`, relative to `server/`)
   so two servers never share one `cast.json`/`state.json`. Do not copy the
   primary checkout's `server/.env` wholesale — that would leak secrets like
   `GEMINI_API_KEY` into the worktree (#2345); `.env.local` carries no
   secrets, so writing it from scratch is fine.

### Worktree teardown

Drop the reparse points **first**, then remove the worktree — `git worktree
remove` / `Remove-Item -Recurse` can follow a junction and delete the *real*
`node_modules` in the primary checkout. Use
`[System.IO.Directory]::Delete($p, $false)` or `(Get-Item $j -Force).Delete()`;
both remove the link only. Gate that on
`$i.Attributes -band [IO.FileAttributes]::ReparsePoint` — **not** on
`.LinkTarget`, which is empty on Windows PowerShell 5.1 even for a real junction,
so the guard skips the delete and the junction survives the teardown. A path
converted to a real directory by an `npm install` needs
`Remove-Item -Recurse -Force` instead. `cmd /c rmdir` from the Bash tool
**silently no-ops and returns 0**, so verify removal with `Test-Path` on both the
junction and its target rather than trusting an exit code.

### The two carve-outs

**Trivial changes may skip the worktree** — same [trivial
bar](#the-trivial-bar) as the Execution model's, no separate definition. Nothing
can break, nothing needs review, and you would not want a review pass on
it. Commit on a branch in the primary checkout, PR it, merge. **Announce the
shortcut in the end-of-turn summary** so the user can redirect if they disagree.
This should be rare; when in doubt, take the worktree.

**Note what this carve-out does NOT buy: landing on `main` directly.** That path
does not exist here — `main`'s rulesets apply `required_status_checks`, so a
pushed commit with no passing checks is rejected outright. Every change reaches
`main` through a PR regardless of how trivial it is. What the bar actually
skips is the worktree, the subagent, and the design thread.

**Git-ignored artifacts are produced in the primary checkout, not a worktree.**
`brand/`, `mockups/`, marketing captures, and anything else outside version
control do not travel with the branch and are **destroyed by worktree
teardown**. Capture pipelines also write relative to their own checkout, so
running them from a worktree scatters output somewhere nobody will look. Do that
work in the primary checkout and say so; the committed result (e.g. rendered
PNGs under `public/`) still lands via a normal worktree + branch.

### Opening the PR

Every non-trivial change merges via a GitHub PR. The PR title MUST match the
[commit-convention subject format](CONTRIBUTING.md#commit-convention) — a
GitHub Actions workflow rejects malformed titles. GitHub pre-fills the body
from [.github/pull_request_template.md](.github/pull_request_template.md);
keep the `## Summary` and `## Test plan` sections, fill them in, and link
the regression plan under `docs/features/` when one applies. Merges use the
"Create a merge commit" button (squash / rebase merge are disabled at the
repo level) and the head branch is auto-deleted on merge. Full spec:
[CONTRIBUTING.md "Pull requests"](CONTRIBUTING.md#pull-requests). Regression
plan: [docs/features/archive/44-pr-hygiene.md](docs/features/archive/44-pr-hygiene.md).

**Every PR body must link a GitHub issue** (`Closes #NN` / `Refs #NN`) —
verified at creation time, not assumed. If none exists yet, one is
auto-filed and linked without pausing to ask — **including bug-shaped work**,
a deliberate, scoped override of "The backlog" section's general "the user
files [bugs] as they hit them" convention, for this gate only — labeled per
`CONTRIBUTING.md`'s two-shape convention (bug-shaped work → standalone `bug`
label; backlog-shaped work → `type:feature`/`type:chore` + `area:<prefix>`,
`moscow:` left for you to set). `.github/workflows/pr-issue-link.yml` surfaces a failing
check on every PR that skips this, mirroring `pr-title-lint.yml`, and (since
2026-07-06) a missing link blocks merge outright — wired into `main`'s
required status checks alongside `verify.yml` in the same ruleset action;
see [docs/features/235-model-routing-review-gates.md](docs/features/235-model-routing-review-gates.md).
Full mechanics: [`.claude/skills/pr-review-gate/SKILL.md`](.claude/skills/pr-review-gate/SKILL.md#issue-verification-at-pr-creation).

**Requesting a clean-room CI run on a PR.** CI now runs automatically on
every PR push (see "Commit gate" above) and is the real, required gate —
you don't need to request it. Dispatch `verify.yml` manually (Actions tab →
Verify → Run workflow, or `gh workflow run verify.yml --ref <branch>`) only
when you want an unscoped, full-battery run off a non-PR ref. Rationale +
history of the prior opt-in design:
[docs/features/118-ci-cost-round-2.md](docs/features/118-ci-cost-round-2.md)
and [215](docs/features/215-ci-label-gated-verify.md); current design:
[docs/superpowers/specs/2026-07-06-verify-ci-rebalance-design.md](docs/superpowers/specs/2026-07-06-verify-ci-rebalance-design.md).

### Parallel agents

Worktrees are mandatory for all work, not just parallel work (see above). What
parallelism adds is that each agent needs its **own** one, and that scopes must
not overlap. When spawning implementation agents via the Agent tool for work
that can run in parallel:

- Use `isolation: "worktree"` so each agent gets its own working tree off the
  shared `.git`. Two agents on the same checkout will trip over each other.
  Each of those trees needs the same setup as any other — `npx husky` and both
  `node_modules` junctions — or the agent commits ungated.
- Give each agent a non-overlapping scope per the [scope discipline table](CONTRIBUTING.md#scope-discipline--merge-magic).
  Two agents in `frontend/src/components/` will collide; one in `frontend` +
  one in `sidecar` will not.
- The Agent tool auto-names the temporary branch (`claude/wt-…`). When the
  agent finishes, rename the branch to the proper `<type>/<scope>-<slug>`
  shape before merge — or pre-create the branch with `git switch -c
feat/server-foo` and tell the agent in its prompt to check it out as its
  first step.
- **Default disposition for a round of parallel agent work: one integration PR,
  verified once — not N separate PRs.** Reconcile the branches via the
  [`integration/<date>` pattern](CONTRIBUTING.md#reconciliation-pattern): fresh
  branch off `main`, merge each agent branch one at a time, run `npm run verify`
  between merges. Open that integration branch as a **draft** PR while
  reconciling — draft is a work-in-progress signal, not a cost lever now that
  cloud `verify.yml` runs automatically (and posts a required status) on every
  push regardless of draft state — and `gh pr ready` once the whole
  reconciliation is locally green, so reviewers see one settled PR per round
  instead of N in-flight ones. See
  [docs/superpowers/specs/2026-07-06-verify-ci-rebalance-design.md](docs/superpowers/specs/2026-07-06-verify-ci-rebalance-design.md)
  for why the opt-in/draft-batching cost framing in
  [docs/features/118-ci-cost-round-2.md](docs/features/118-ci-cost-round-2.md)
  is now historical.

### Planning agents

Plan agents (`subagent_type: "Plan"`) design strategies but don't write code,
so they don't need their own worktree or branch. But the implementation work
that follows a plan does — when you act on a plan, step 1 is cutting the
worktree + branch named after the plan number (e.g.
`feat/frontend-plan-38`). This is the phase-1→phase-2
boundary of the [Execution model](#execution-model-default-for-all-non-trivial-work):
the design thread ends at the ticket + handover-brief comment, and cutting the
branch is the implementation thread's first act.

Hooks activate automatically after `npm install` via the `prepare` script
(husky v9.1 — sets `core.hooksPath` to `.husky/_`, the dir holding the
shebang'd wrapper scripts that source `.husky/<hook>`). Do NOT set it to
`.husky/` — those user hooks are shebang-less, so git can't spawn them
directly (`cannot spawn .husky/pre-commit: Exec format error`). If hooks ever
stop firing, run `npm install` (or `npx husky`) to reset the path. On a fresh
clone, run `npm install` once and you're done.

Additional one-time setup:

- **Pester >= 5.0** for the PowerShell-scripts harness (Windows-bundled Pester 3.4 isn't API-compatible). Install once per user:

      Install-Module -Name Pester -Scope CurrentUser -Force -SkipPublisherCheck

  `scripts/tests/run.ps1` prints this same hint if it can't find Pester 5+.

- **Playwright chromium** for the e2e harness:

      npx playwright install chromium

  One ~100 MB download, cached in `%LOCALAPPDATA%\ms-playwright`. `npm run test:e2e` errors with a clear hint if chromium is missing.

Working practice:

- Default loop for non-trivial work: finalize the change → run
  `npm run verify:fast:branch` (same branch-scoped check pre-push now runs)
  → open the PR → cloud `verify.yml` (required, opt-out) and the mandatory
  `pr-review-gate` pass run independently → merge once both are green. Run the
  full `npm run verify` manually only when you specifically want the full
  local battery (e.g. before a release cut, or debugging something scope-
  filtering might be hiding).
- `npm run verify:fast` matches pre-commit; `npm run verify:quick` is `test:all` without typecheck/build/e2e.
- **Do not use `--no-verify` to bypass.** If a hook fails:
  1. **Triage first.** Categorise the failure as **related to my change** vs. **pre-existing** (i.e. the same test would fail on `main`). A `git stash && git checkout main && <run the failing test>` round-trip settles it in 30 seconds.
  2. **Related → fix it.** Update the code, the regression doc, and the paired test in the same commit. Then retry.
  3. **Pre-existing → surface to the user before doing anything else.** Do NOT silently fix unrelated test breakage in the same commit (couples scope; muddies blame). Do NOT bypass with `--no-verify`. Ask whether to land a separate fix PR first, or to scope a follow-up.
  4. **Flake suspicion → run the failing test in isolation once.** If it passes alone, name the flake explicitly to the user and propose either a retry-loop or a quarantine — never bypass on a hunch.
- Sidecar pytest coverage lives at `server/tts-sidecar/tests/` —
  `test_smoke.py`, `test_synthesize.py`, `test_runtime_wiring.py`,
  `test_kokoro.py`, `test_logging_format.py`,
  `test_concurrent_synthesis.py`. `test_runtime_wiring.py` pins the
  CUDA+DeepSpeed+fp16 primary path: DeepSpeed init reaches the model
  and runs before `tts.to(device)`, init failure is swallowed, fp16
  autocast wraps the synth call, `_float_audio_to_int16_le` handles
  clipping / stereo downmix / list input, and speaker-manifest
  enumeration tolerates API drift. `test_concurrent_synthesis.py` pins
  the thread-pool saturation contract: N parallel `/synthesize` calls
  run in parallel (asyncio.to_thread offload intact), each response
  carries its own PCM (no cross-request bleed), and the sample-rate
  header is per-response — Coqui and Kokoro covered separately. Wired
  into `npm run test:all` via `npm run test:sidecar` (skips with a
  banner on an unbootstrapped venv).

## Task tracking & checkpoint flagging

**Task tracking is mandatory, not discretionary, once spec-writing ends.**
Plan-writing itself is tracked (drafting each of `writing-plans`' own
tasks/steps is itself a task via `TaskCreate`/`TaskUpdate`/`TaskList`), and
tracking continues through implementation at one-task-per-implementation-step
granularity. Reconcile the task list against the plan document at task/step
boundaries — not on every edit — preserving the status of steps that didn't
change, but catching structural changes (a step added, removed, or reworded)
before the next one begins.

**Three checkpoints get a `/compact` suggestion**, left to the user to
accept: spec approved (end of `brainstorming`), plan approved (end of
`writing-plans`), and PR merged/shipped. These map onto the three phases of the
[Execution model](#execution-model-default-for-all-non-trivial-work) — the
spec- and plan-approved checkpoints both sit inside its design thread, before
the handover to implementation. There is no tool to trigger compaction
directly — this is a suggestion at a good moment, not a state-preservation
mechanism.
