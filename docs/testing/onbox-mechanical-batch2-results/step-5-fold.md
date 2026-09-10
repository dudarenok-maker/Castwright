# Step 5 — fold Batch 2's 10 rows into the on-box acceptance register

Issue: Castwright#2972 (chain #2960 → #2435). Worktree
`C:\Claude\Projects\wt-mechanical-batch-2`, branch `docs/docs-mechanical-batch-2`.
Sole register writer for this chain — folded steps 1-4's evidence
(`docs/testing/onbox-mechanical-batch2-results/step-{1,2,3,4}-*.md`) into
`docs/testing/onbox-acceptance-register.md` for all 10 rows this parent owns.

## Before / after

- **Owed:** 65 → **63**.
- **Group A:** 39 → **37**.

## Disposition per row

| Row | Disposition |
|---|---|
| **A20** | Narrowed. Forced-refusal bullets (null transcript; `identity.cosine.angry` +0.05) and the `.onnx`-corruption FAIL-not-SKIP bullet all confirmed exactly as specified. #2066's own open question answered from this run's real per-leaf identity deltas (`angry` +0.0052 > epsilon 0.005 — "0.005 is too tight" for that leaf). **Still owed:** the accept-path echo line (`[golden-bless] identity moved ...`) was never actually observed printing on a genuine passing bless this run — `-rs` suppresses stdout on pass, and a `-s` retry hit the tolerances refusal before reaching the echo point. |
| **A24** | Narrowed. Five of six bullets confirmed on real hardware across the 14th-18th runs (render-waits, design-completes, extended-budget-wait, cross-device no-extension, abort-budget conversion, Pause-stays-plain-AbortError). **Still owed:** the original wedged-design bullet (force a hung `_design_in_flight`, confirm 503 `design_in_flight` via `DesignContentionTimeoutError`'s own ~150s bound) — never attempted in the whole 18-run session; a different mechanism from the Base17 contention path A105 already closed. |
| **A26** | Narrowed. Collapse-reproduction bullet not reproduced this session (accepted per the row's own text). False-positive control bullet surfaced a real defect — WER-drift fires on invented-name lines Whisper can't transcribe — filed as **[Castwright#3118](https://github.com/dudarenok-maker/Castwright/issues/3118)**, row narrowed to point at it rather than re-describing inline. |
| **A27** | Narrowed. Fresh-install and no-routine-thrash bullets confirmed (the latter from genuine 23-restart production history, not a fresh push). VRAM soft-ceiling observation satisfied via a real historical near-miss (22MB under ceiling); VRAM hard-ceiling leg explicitly not attempted, for a contention-safety reason the row's own text permits recording as an acceptable partial. **Still fully owed:** the RAM hard-restart bullet (drive committed RAM toward 70%, confirm self-exit code 43) — not attempted at all this session. |
| **A32** | Narrowed. Lead (chapter-title) criterion confirmed at both text and audio level (Coqui/XTTS, French). Secondary (dash-opened body dialogue) confirmed at text level only. **Still owed:** an audio-level listen for the dash-pause timing and accented-word pronunciation on synthesized body text. |
| **A33** | Narrowed further (already partial). Bullet 3 (idle positive control) now confirmed, with a permanent wording correction (Kokoro's ORT engine can never report a "real GPU index" — always the `-1` bucket, by design). Bullet 2 (contended CPU admission) still not achieved this run; traced the Qwen-pin anomaly to very likely being the same tooling artifact (env var and sidecar launch split across separate shell invocations) that batch 2 step 2's 18th run later root-caused and fixed procedurally — not a sidecar defect. **Still owed:** re-attempt bullet 2 with the corrected single-invocation launch. |
| **A35** | **Fully discharged, dropped.** Batch 2 step 2's on-box run drove the row's own decisive post-unload diff (Qwen Base 0.6B + Qwen 1.7B-Base explicitly unloaded, Whisper TTL-lapsed) to `allocated≈163MB`/`reserved≈271MB` — close to the established single-model baseline, no multi-hundred-MB residual. #2656 closes as working-as-intended. |
| **A102** | **Fully discharged, dropped.** All three bullets confirmed for real (`cuda_verified` populated on real load; documented warning + `/health`/`/api/info` fields on a forced CUDA→CPU fallback; silence when CUDA genuinely succeeds). |
| **A104** | Narrowed. Prerequisite resolved definitively: `used_memory` returns `[N/A]` on this box's WDDM driver, confirmed live for a real Ollama process. Both warning sites gate on `!dataUnavailable`, so the split/no-split/mismatch bullets are **structurally unreachable on this hardware**, not merely unattempted — confirmed via live call to the real `detectOllamaGpuSplit()` and by reading the UI's `dataUnavailable` branch. **Still owed, and not attemptable from this box:** the split/no-split/mismatch bullets need a driver/OS where `nvidia-smi` reports numeric `used_memory` for Ollama. |
| **A105** | Narrowed. Four of five bullets confirmed (widened eviction guard, Stop-button-mid-load, bulk-design Kokoro-pause in both required directions, failed-eviction/lock-leak both halves). The co-residency bullet **FAILED** — a live repro showed a raw Kokoro `/synthesize` call completing while two designs were still genuinely resident, contradicting the arbiter's documented exclusion contract. Filed as **[Castwright#3086](https://github.com/dudarenok-maker/Castwright/issues/3086)** (already filed by the step-2 run that found it); row narrowed to point at it. |

No row's disposition was written from anything beyond what steps 1-4's evidence files actually show; several rows keep an explicit "still owed" remainder rather than being marked confirmed on partial evidence.

## Live view

`npm run register:build` regenerated `docs/testing/onbox-acceptance-register-live-view.html` from the edited markdown; `npm run check:onbox-register` (no flag) now reports the two tracked files agree.

**The actual publish to the canonical artifact URL is deliberately deferred, not silently skipped.** This chain's own "first half" batch is documented elsewhere as editing this same register concurrently, and the register's own "Live view" section requires fetching the currently-published page and running `--against-published` (with `--discharging A35,A102` for this change's two genuine drops) immediately before every publish, specifically to avoid one lane's publish silently erasing a concurrent lane's already-merged row. Right now, with a sibling batch potentially mid-edit on the same tracked file, publishing before both sides have merged risks exactly that race. Deferring here is the outcome the register's own text explicitly sanctions for this situation ("it is fine to defer the republish and say so explicitly and plainly ... do not force a race with another lane's publish"). Whoever merges this chain's changes next should run the full merge-step procedure (stamp the publish token, fetch the live page, `check:onbox-register -- --against-published <fetched> --discharging A35,A102`, then publish) once both halves are on `main`.

## Standing rules honoured

No book data touched. No other lane's process stopped, killed, or restarted. `server/.env` untouched. Nothing under `server/tts-sidecar/.venv`/`voices/` touched. This step touches only `docs/**` (register, live view, this evidence file, and two new/referenced GitHub issues) — no `server/**` source.
