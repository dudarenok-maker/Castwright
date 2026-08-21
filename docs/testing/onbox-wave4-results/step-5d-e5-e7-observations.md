# Step 5d — E5 / E7 rendered-page observations

Worktree: `C:\Claude\Projects\wt-2551-onbox-wave4-retire` @ branch `docs/docs-2551-onbox-wave4-retire`.
Ports: VITE 5263, API 8170, TTS sidecar 9090 (per this worktree's `.env.local` / `server/.env`).
Date: 2026-08-21.

This file records real, verbatim evidence for the operator-owed rendered-page
halves of E7 (`fe-57` venv-bootstrap progress card) and E5 (`fe-39` touch
press-feedback), per `docs/testing/onbox-acceptance-register.md`. Nothing here
edits the register itself.

---

## Setup

Dev server started from this worktree with `npm run dev` (detached, log at
`.scratch/dev-server.log`, not committed). Startup excerpt confirming the
correct ports:

```
[frontend]   VITE v8.0.16  ready in 10722 ms
[frontend]   ➜  Local:   http://127.0.0.1:5263/
...
[server] 2026-08-21 12:52:30.063 [server] listening on http://localhost:8170
[server] 2026-08-21 12:52:30.063 [server] workspace root: C:\Claude\Projects\wt-2551-onbox-wave4-retire\castwright-workspace
[server] 2026-08-21 12:52:30.135 [sidecar] already listening on :9000 (protocol v1), skipping spawn (current sidecar honoured)
```

Both bound the worktree-specific ports (5263, 8170), not 5173/8080 — correct checkout confirmed.

Venv precondition, confirmed absent before anything else touched it:

```
$ ls server/tts-sidecar/.venv
ls: cannot access '.../server/tts-sidecar/.venv': No such file or directory
```

---

## E7 · fe-57 venv-bootstrap progress card — rendered-page observations

All six observations use the register's own numbering. Driven via a throwaway
Playwright script (`.scratch/e7-driver.mjs`, `.scratch/e7-observe.mjs`,
`.scratch/e7-final-ready.mjs` — none committed, none added as repo specs),
navigating `http://localhost:5263/setup` → clicking
`[data-testid="setup-summary-row-voice"]` → clicking the real "Set up the
voice engine runtime" button. This triggered one real
`POST /api/setup/venv/bootstrap` (job id `1`) and the server ran a genuine
`bootstrap-venv.mjs` subprocess (real pip installs, real ~2 GB download) end
to end while the browser session stayed open and polled it.

**Observation 1 — idle "Set up the voice engine runtime" button (absent venv):**
Confirmed. Screenshot:
`step-5d-e5-e7-screens/03-idle-absent-venv-card-2026-08-21T02-53-42-815Z.png`.
**DISCHARGED.**

**Observation 2 — progress card appears within ~1.5s of the click (spinner +
"Setting up the voice engine runtime…" + a live `job.step` line):**
Log:
```
[02:53:42.862Z] clicking "Set up the voice engine runtime" button
[02:53:43.104Z] OBSERVATION 2: progress card appeared after 242ms (spec: within ~1.5s)
```
242ms, well inside budget. Screenshot:
`04-progress-card-appeared-2026-08-21T02-53-43-104Z.png`.
**DISCHARGED.**

**"The card's timing behaviour" (no flash/jump; progress over the real
~8-9 min duration):** Real step-text progression captured over the live
session, same browser tab, no reload between entries:
```
02:53:53Z  creating venv at .../server/tts-sidecar/.venv
02:54:03Z  pre-installing torch from the nvidia index (https://download.pytorch.org/whl/cu128)
02:57:03Z  installing requirements (nvidia overlay; this can take several minutes)
03:02:16Z  swapping ONNX runtime → the nvidia GPU build
03:02:37Z  Done. Venv ready. (status: installed)
```
Total wall clock: 02:53:42 → 03:02:37 = **8m55s**, matching the row's own
"several minutes, ~2 GB download" framing and the wave-3 run's 8m49s almost
exactly. The card held one visible step at a time and advanced smoothly (no
flashing/placeholder flicker observed across the five distinct step values).
Screenshots: `05-poll-01…04*.png`. **DISCHARGED.**

**Observation 4 — green "Voice engine runtime ready" card on real completion:**
Two pieces of evidence, with an honest caveat:
- A **real, load-bearing finding**: `server/src/diagnostics/venv.ts`'s
  `sidecarVenvPresent()` checks only for `Scripts\python.exe` /
  `bin/python` existing — which is created by `python -m venv` almost
  immediately, well before `pip install -r requirements.txt` (the actual
  multi-minute, ~2 GB part) finishes. Confirmed on this box: at 02:55:19,
  with the real job still reporting `"status":"bootstrapping"` (torch/pip
  still installing — verified: `torch` package files already present under
  `.venv/Lib/site-packages` but the job object said "bootstrapping"), a
  **fresh page load** of the same step already rendered the green
  `venv-bootstrap-ready` card (`11-card-state-venv-bootstrap-ready-...png`).
  This means `models.runtime.installedOnDisk` (which independently feeds the
  ready-card branch, ahead of the job-in-progress branch in
  `VenvBootstrap`'s render order for a *remounted* component) can show
  "ready" before the bootstrap has actually finished installing packages.
  This is real evidence to flag, not a pass/fail call on this task's part.
- The **genuine post-completion** ready card, captured after the real job
  object reported `"status":"installed","step":"Done. Venv ready."` (job-poll
  log below): `12-final-ready-post-real-completion-2026-08-21T03-08-23-591Z.png`,
  card text: "Voice engine runtime ready / The Python runtime is set up —
  all voice engines can be loaded."
**DISCHARGED** (the green card does render on real completion), **with the
above premature-disk-detection caveat flagged as a separate finding** — not
this row's failure, but worth a follow-up issue.

**Observation 5 — `onBootstrapped` refetches without a reload:**
The same long-lived browser tab (started at the 02:53:42 click) was polled by
a `framenavigated` listener for the full ~8m55s run. Every single navigation
event logged was to the identical URL
`http://localhost:5263/setup#/setup` (a hash-router same-document
transition) — never a different pathname, never a `document`-level reload.
Independently, at 03:02:34 — with no user interaction from the driver script
at that instant — the setup **summary board** re-rendered in place with
freshly updated content (`Voice engines` row's message flipped from the
job-in-progress state to `"kokoro is installed but its voice weights have
not been downloaded."`, screenshot `05-poll-04-null-2026-08-21T03-02-34-033Z.png`),
proving the update arrived via the poll/refetch path, not a page reload.
**DISCHARGED**, with one honest gap: the automatic transition landed on the
**summary board**, not a lingering ready-card inside the step-voice sub-view
— i.e. `onBootstrapped`'s refetch appears to also cause the wizard to leave
the per-step drill-down back to the checklist view. That's a UX detail worth
a follow-up look, not evidence against "no reload."

**Observation 6 — failure path (e.g. no Python 3.12 on PATH):**
**NOT ATTEMPTED.** Inducing a genuine failure now would require either (a)
deleting the venv that just finished a real 9-minute install and re-breaking
Python discoverability on this shared box, which risks the box's other
worktrees/lanes that may depend on the same adopted sidecar on `:9000`, or
(b) interrupting the subprocess mid-install, which the task's own
instructions caution against if it "risks leaving things broken." Skipped
for both reasons. **STILL OWED.**

### E7 verdict summary

| # | Observation | Verdict |
|---|---|---|
| 1 | Idle button, absent venv | DISCHARGED |
| 2 | Progress card within ~1.5s | DISCHARGED (242ms) |
| — | Timing/no-flash over real ~9min | DISCHARGED |
| 4 | Green ready card on completion | DISCHARGED (+ premature-disk-detection finding) |
| 5 | Refetch without reload | DISCHARGED (+ summary-board-return UX note) |
| 6 | Failure card | STILL OWED — not attempted, honestly, for the reasons above |

---

## E5 · fe-39 touch press-feedback

Driven via a throwaway Playwright script (`.scratch/e5-driver.mjs`,
`.scratch/e5-drag.mjs`, `.scratch/e5-nav-test.mjs` — not committed, not added
as repo specs), using `chromium.launch()` +
`browser.newContext({ ...devices['Pixel 7'], hasTouch: true })` (same device
profile as this repo's own `mobile-chrome` Playwright project in
`playwright.config.ts`), then genuine touch input via CDP
`Input.dispatchTouchEvent` (`touchStart` → hold → screenshot → `touchEnd` →
screenshot). This is a real synthesized touch (not a converted mouse event):
Chromium's CDP touch input path is the same one `page.touchscreen` /
`.tap()` use, and requires `hasTouch: true` on the context to be honoured
as touch rather than rejected/ignored.

**Environment note (affects 3 of 4 controls):** readiness in this run never
reaches `ready: true` — after the venv finished, `blockers.tts` still fails
because `kokoro is installed but its voice weights have not been
downloaded` (a real, separate, large download; out of scope for a
touch-feedback check). `layout.tsx:519-537`'s boot-time gate therefore
force-navigates every **full page load** to `/setup`. That gate runs once
per `Layout` mount (`useEffect` with `[]` deps), so a client-side hash
change (`window.location.hash = '#/voices'` + a synthetic `hashchange`
event) after the initial mount does reach the real app views without
re-triggering the redirect — used here to reach `/` and `/voices` for real.
This is a documented workaround for a real environment gap, not a change to
anything under test.

Even after reaching the real views, this worktree's workspace is **freshly
empty** (`GET /api/library` → `authors: 0`) and there is no `GEMINI_API_KEY`
configured for this worktree's `server/.env` (by design — worktrees don't
inherit secrets), so no book can be analyzed/created to populate the
library, voice catalogue, or continue-listening rail. This is a genuine,
unresolvable-in-scope environment limitation, not a control that's missing
or broken.

### 1. Continue-listening play badge — **STILL OWED**
Not found: `GET /api/library` reports 0 authors/books, so the
continue-listening rail (which only renders for books with playback
progress) never mounts. No book exists in this workspace and creating one
requires the real analysis pipeline (needs a configured LLM key, not present
in this worktree). Screenshot of the actual empty-workspace home page:
`step-5d-e5-e7-screens/20-home-loaded-2026-08-21T03-06-30-730Z.png`.

### 2. "Add book" tile — **STILL OWED**
Not found: with 0 books the home view renders the big empty-state "Start a
new book" CTA, not the per-item grid tile (`[data-tour-id="new-book-btn"]`,
covered by `src/components/library/library-grid.test.tsx`'s fe-39 test) —
that tile only exists once the grid has at least one author/book row. Same
screenshot as above shows the actual rendered state (empty-state CTA, not
the tile).

### 3. Wizard "Review ›" chip — **DISCHARGED**
Real touch verified: `Input.dispatchTouchEvent` `touchStart` on the summary
row's "Review ›" chip on a `hasTouch:true` Pixel-7-profile context produced a
measurably different computed color (`oklab(0.164546 0.00102162 0.00246866 /
0.4)`, the `group-active:text-magenta` mirror) mid-press —
screenshot `26-review-chip-mid-press-2026-08-21T03-06-35-409Z.png`. On
`touchEnd`, the chip's own real `onClick` fired and navigated the wizard into
that step (confirmed by the chip becoming unlocatable afterward, i.e. the
DOM actually changed) — proof this was a genuine, functioning touch
interaction, not a no-op. Release screenshot:
`27-review-chip-after-release-2026-08-21T03-06-35-704Z.png`.

### 4. Voice-library drag icon — **STILL OWED**
Checked both the "My voices"/"In use" and "Catalogue" tabs on `/voices`
(`.scratch/e5-drag.mjs`): 0 matches for
`span.group-hover\:text-ink\/60` in both. Confirmed via
`docs/testing/.../28-voices-page-...png` and
`28b-voices-catalogue-....png`: "No voices yet — Finish setting up a book —
once you confirm its cast, every character will appear here as a reusable
voice." Same root cause as #1/#2: 0 books in this workspace means 0
characters/voices, so no `VoiceCard` (and therefore no drag icon) ever
mounts, regardless of tab. Not achievable without creating a real book.

### E5 verdict summary

| Control | Verdict | Why |
|---|---|---|
| Continue-listening play badge | STILL OWED | 0 books in workspace; rail never mounts |
| "Add book" tile | STILL OWED | 0 books ⇒ empty-state CTA renders instead of the per-item tile |
| Wizard "Review ›" chip | **DISCHARGED** | Real CDP touch, hasTouch:true, Pixel 7; computed-style flash + real click-through confirmed |
| Voice-library drag icon | STILL OWED | 0 voices/characters in workspace; VoiceCard never mounts |

### Existing e2e coverage check

Searched `e2e/` (the `testDir` in `playwright.config.ts`) for any existing
spec already covering this touch-flash interaction:
```
grep -r "group-active|hasTouch|\.tap\(" e2e/   →  no matches
```
**No existing Playwright spec covers this.** The only existing coverage is
the four **Vitest/jsdom** unit assertions on the CSS class strings
themselves (not real touch events):
- `src/components/library/continue-listening-rail.test.tsx:71`
- `src/components/library/library-grid.test.tsx:77`
- `src/components/setup/setup-wizard.test.tsx:486`
- `src/components/voice-library-panel.test.tsx:371`

No new spec was written, per the task's scope limit.

---

## Screenshots

All under `docs/testing/onbox-wave4-results/step-5d-e5-e7-screens/`:
- `01-setup-summary-*.png`, `02-step-voice-*.png` — initial navigation
- `03-idle-absent-venv-card-*.png` — E7 obs 1
- `04-progress-card-appeared-*.png` — E7 obs 2
- `05-poll-01..04-*.png` — E7 step-text progression + the auto-return-to-summary moment (obs 5 evidence)
- `06-terminal-*.png` — end of the live-session poll loop
- `10-remount-step-voice-*.png`, `11-card-state-venv-bootstrap-ready-*.png` — the premature-disk-detection finding (obs 4 caveat)
- `12-final-ready-post-real-completion-*.png` — genuine post-completion ready card
- `20-home-loaded-*.png` — E5 controls 1 & 2, real empty-workspace state
- `25-setup-summary-mobile-*.png`, `26-review-chip-mid-press-*.png`, `27-review-chip-after-release-*.png` — E5 control 3
- `28-voices-page-*.png`, `28b-voices-catalogue-*.png`, `28c-voices-my-*.png` — E5 control 4, real empty-catalogue state
- `e5-results.json`, `poll-log.json` — raw structured output from the driver scripts

---

## Box-safety confirmation

- The primary checkout's venv (`C:\Claude\Projects\Audiobook-Generator\server\tts-sidecar\.venv`) was **never navigated to or modified** — the only command touching that path in this entire pass was a final read-only `ls` to confirm it still exists, run once, at the very end, after all worktree work was done.
- This worktree's own `server/tts-sidecar/.venv` was genuinely absent at the start (confirmed via `ls` failure) and is left in its real, successfully-bootstrapped end state (per the task's instruction — not deleted).
- The dev server (`npm run dev`, vite :5263 + tsx-watch server :8170) started for this pass was fully stopped at the end (process tree killed via `taskkill /T /F` on both root branches; verified `netstat` shows neither port listening afterward).
- No other worktree's or lane's process was touched — the adopted TTS sidecar on `:9000` (owned by a different worktree, "already listening... skipping spawn") was left completely alone.
- No `docs/testing/onbox-acceptance-register.md` or `onbox-sitting-*.md` file was edited.
- No git operations (add/commit/push) were performed.
