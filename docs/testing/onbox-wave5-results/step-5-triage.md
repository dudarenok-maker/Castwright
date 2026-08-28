# Wave 5 step 5 — triage: re-bin the device-browser pack, reclassify G1/G2

**Issue:** #2611. **Parent:** #2606 / #2435.

**VERDICT: DISCHARGED** — a triage step; no acceptance row was run, none was in scope.

## What this step is

A pure re-derivation and documentation task. No server, no sidecar, no
browser session, no analyzer — only reading `docs/testing/onbox-sitting-plan.md`,
`docs/testing/onbox-sitting-device-browser.md`, and `docs/testing/onbox-acceptance-register.md`
(read-only) and editing `docs/testing/onbox-sitting-plan.md`.

## Job 1 — re-bin the device-browser pack (7 rows)

Applied the line from the brief: **listening, physical hardware, or a live
GPU is operator-only; "needs a click-through" is not, by itself.** Checked
each row against its own `Needs:`/criteria text in
`docs/testing/onbox-acceptance-register.md`, not against the pack's
"browser-shaped" framing.

| Row | Verdict | Reason (tied to the row's own text) |
|---|---|---|
| E1 | **Operator-only** | Register: *"a clean macOS machine with Pinokio, plus a short Windows follow-up."* A specific separate physical macOS machine (zero prior on-box exercise on any axis) plus native-Stop process reaping on the Windows box — neither reachable from a browser. |
| E2 | **Operator-only** | Register: *"a real phone installs the mkcert root CA and completes pairing over `castwright.local`."* Physical hardware (a real phone on the LAN). |
| E3 | **Operator-only** | Register: *"Same session as E2 — shares the phone + host setup."* Inherits E2's real-phone requirement directly. |
| E5 | **Agent-runnable** | Register: *"a one-time DevTools touch-emulation check... minutes, any machine."* No real phone, no physical-hardware axis, no GPU, no listening — pure Chrome DevTools device-toolbar touch emulation, the same `Input.dispatchTouchEvent`/`.tap()` path wave-4 step 5d already drove to discharge the "Review ›" chip. This campaign's browser automation can drive it directly. |
| E6 | **Operator-only (unchanged)** | Existing 2026-08-20 correction in the plan, not undone: rendered-half observations need *"a real browser watching a real card render"* over a genuine multi-minute bootstrap — live process-timing observation, not a DOM click-through — "same boundary as A33/A43." Observation 6 (the failure path) remains this row's one owed debt. |
| E7 | **Operator-only** | Register: *"a machine with Pinokio installed, an existing pre-fix install, nvidia profile."* A specific physical machine in a specific pre-fix state, card set to the nvidia profile to install Qwen3 — physical hardware and a live GPU. |
| E8 | **Operator-only** | Register: *"the LAN HTTPS server... a phone or second machine paired over `castwright.local`."* Shares E2/E3's phone session — physical hardware. |

**Net: 6 of 7 stay operator-only; E5 moves to wave-3 agent-runnable.**
Applied honestly in both directions per the brief: five rows I might have
expected to free on "it's just a browser" reasoning stayed operator-only
because their *own* criteria name a real phone, a real second machine, or a
live multi-minute render — the pack's browser-shaped framing does not
override the row's own text. Only E5's own criteria contain no such axis.

## Job 2 — reclassify G1/G2 as opportunistic

Register's own text for both, quoted directly:

- **G1** — *"Needs: a real quarantined flaky test (naturally occurring, not
  manufactured) — the shared precondition left for both remaining halves.
  Cost: opportunistic — piggy-back on the next real quarantine event rather
  than manufacturing one."* Wave 3 recorded this STILL OWED-blocked on both
  debts.
- **G2** — *"Needs: nothing beyond a real `vX.Y.Z` tag push — i.e. the next
  release cut."* An agent must not manufacture a release tag, and wave 3
  explicitly declined to.

Neither can be discharged by an agent on demand. Moved both out of §2.2's
plain "agent-runnable" list into a labelled **opportunistic** subsection of
the same wave-3 set (not a new top-level set — neither is operator-GPU-bound
or acquisition-blocked, so neither belongs in the other two sets; §1's "three
sets" framing is unchanged). **Both rows stay OWED** — this is a re-binning,
not a discharge, and their register entries were not touched.

## Arithmetic re-derived by counting (not by subtracting from the old total)

- **§2.1 operator sittings:** counted the device-browser pack's row list
  after removing E5 — E1, E2, E3, E6, E7, E8 = 6 rows (was 7). Recounted the
  full §2.1 table: 4 + 9 + 7 + 8 + 9 + 4 + 6 + 1 = **48** (was 49).
- **§2.2 wave-3 agent-runnable:** counted the "runnable now" list with E5
  added — A29, A39, A40, A41, A42, A45 (6) + B1, B4 (2) + C1, C2, C3, C4 (4)
  + E11 (1) + E5 (1) = 14 rows. Counted the opportunistic subsection — G1, G2
  = 2 rows. 14 + 2 = **16** (was 15).
- **§2.3 blocked-on-acquisition:** unchanged — H1, H2, D3 = **3** rows. Not
  touched by either job.
- **Grand total:** 48 + 16 + 3 = **67** — unchanged from before this step,
  as required. Every register row still appears exactly once across the
  three sets.
- **Also updated for consistency** (not explicitly named in the acceptance
  list, but left stale would contradict "internally consistent"): the
  device-browser pack's estimated-minutes column (140 → 135, E5's 5 minutes
  moved out) and §7's running-totals section (operator minutes 1,055 →
  1,050; wave-3 row count 15 → 16; grand reconciliation 48 + 16 + 3 = 67).
  Also fixed a pre-existing stale header at §2.1 ("51 rows" did not match
  its own row-count arithmetic of 49 even before this step's edit) to the
  now-correct 48.

## Not in scope / does not supersede

- No acceptance row was run. No register or live-view edit was made —
  `docs/testing/onbox-acceptance-register.md` and
  `docs/testing/onbox-acceptance-register-live-view.html` are untouched.
- `docs/testing/onbox-sitting-device-browser.md` (the pack file itself) was
  **not** edited — this step's brief scopes the correction to
  `onbox-sitting-plan.md`; the pack file is a separate child's deliverable.
- Group C is a separate parent and was not touched.

## Cleanup

No server, sidecar, or browser session was started by this step — nothing to
tear down.
