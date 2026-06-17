<!--
Draft release notes for the NEXT version (technical register — this IS the
GitHub release body). bump-version.mjs feeds this file verbatim as the
annotated-tag message → release.yml, and now uses it by DEFAULT (no
--notes-file needed). Everything in this HTML comment is invisible in the
rendered release, so it never leaks into the body.

Keep it current for each release:
  1. Update the version marker below.
  2. Rewrite the body (theme paragraph → ## ✨ Headline features with
     ### … (new) subsections → emoji-themed sections → bold-lead bullets with
     (#PR) refs → **Full changelog:** vPREV...vNEW footer). v1.7.0 is the
     canonical example; see CONTRIBUTING.md "Release notes".

The marker is what bump-version checks: if it doesn't match the version being
cut, the bump refuses (so a stale file can't ship as the body). The
user-facing, brand-voice notes live separately in RELEASE_NOTES.md (#/release-notes).

release-notes-next-version: 1.8.0
-->

**The open-beta release.** Castwright reaches more machines this cycle — an early **AMD GPU** preview and a **one-click Pinokio** install — on top of a deep round of analysis honesty, multilingual depth, and GPU-contention resilience that keeps long runs upright on an 8 GB card.

---

## ✨ Headline features

### 🟧 AMD GPU support — early preview (new)
Castwright can reach for an AMD GPU when it finds one, with a safe net under it.

- **Auto-detect with CPU fallback** — ROCm / DirectML is detected on its own; if the GPU path isn't ready it quietly falls back to the processor so the app still runs (#818).
- **Accelerator control** — an `ACCELERATOR` knob + in-app picker, with the resolved per-engine profile surfaced on `/health`. Kokoro stays on CPU under DirectML (a documented DirectML limitation, not a fault). NVIDIA and Apple Silicon remain the smoothest paths.

### 📦 One-click install with Pinokio (new)
A self-contained conda install (ops-16) built from the latest published release — no terminal, nothing to install by hand — landing in the same guided first-run as the desktop installers (#821).

### 🧠 Pick the model that reads your book (new)
The local analyzer is now yours to choose (plan 221).

- **Installed-only model picker** — pick any Ollama model you've pulled per run; not-yet-pulled curated models install from the Model Manager (#851, #859, #860).
- **Honest residency + label** — warm/residency and the analysing chip key to the model actually doing the reading, not the configured default; an `ANALYZER_KEEP_ALIVE` knob; per-phase model support.

### 🩺 Honest engine health + one-tap Repair
The Model Manager stops showing a hopeful green light (plan 220).

- **True per-engine health** — package / weights / integrity, with a **"Needs repair"** badge and a one-click **Repair** + sidecar restart (#837).
- **Re-tiered engines** — Qwen → standard (GPU), Coqui → opt-in, Whisper = base; fail-open readiness + diagnostics.

---

## 🌍 Multilingual & attribution (plan 221)

- **Cyrillic, end to end** — character names, ids and cross-book keys handle non-Latin scripts (#852).
- **Steadier non-English attribution** — a deterministic narrator-default heuristic, a Russian dash-dialogue preamble guard, and script-aware attribution + ASR normalizers (#852, #824).
- **Localized cast review** — language-aware minor-cast fold buckets, so a Russian book's grouped roles read in Russian (e.g. _Незнакомый Парень_ / _Незнакомая Девушка_) instead of English (#856).

## 📊 Analysing view — honesty & live progress

- **Truthful progress** — a per-chapter section sub-bar and counts, live ETA refinement, and a model-label chip that mirrors the server-resolved analyzer model (#841, #864, #826).
- **Reload-proof** — a reconnecting bridge so refreshing the page no longer blanks the elapsed timer (#869).
- **Big-chapter handling** — Stage-1 chunking for oversized chapters and cast-detection name-fidelity guards (#825, #827).

## 🎮 GPU residency & resilience (plan 222)

- **Waits its turn instead of crashing** — `withGpuLoad` does an atomic evict+verify+load and refuses on a busy card (409) rather than OOM-crashing; a top-bar "GPU busy · N waiting" pill says why (#840, #841).
- **Smarter residency** — a VRAM-threshold policy keeps the analyzer resident across the analysis loop on a GPU; voice-design and generation preload run through the same gated path.
- **VRAM telemetry substrate** — passive, env-gated per-engine VRAM sampling (fs-45, record-only; MB-accounting deferred) with a clean-process gate (#861, #863).

## 🎙️ Voice design & casting

- **A/B compare modal fixed** — portaled out of the clip-path drawer so it no longer renders clipped; Play-current resolves the Qwen voice and shows the descriptor on Side A; play errors surface (#832, #834).
- **Age made audible** — Qwen voice-design personas describe age acoustically, not just as a label (#831).

## 🎧 Listening & companion

- **Offline waveform** — downloaded chapters persist their peaks, so the phone scrubber stays drawn with no signal.

## 🏗️ Under the hood

- **Kokoro uses the NVIDIA GPU** — forces `onnxruntime-gpu` via an ORT swap (not `kokoro-onnx[gpu]`); a failed swap is fatal, so it can't silently run on the CPU (#828).
- **Analyzer tolerates stray model keys** instead of failing the run (#839).
- **Test resilience** — `test:server` auto-retries once on a vitest fork-pool worker-crash (#850); the `analysis-pipelining` rolling-roster CPU-contention timeout flake is quarantined in CI (#875).
- **Release hygiene** — `.gitignore` now covers the renamed `castwright-workspace/` (#867); a CodeQL workflow and a pre-push commit-subject guard land (#858).
- **Docs & Help** — CODE_OF_CONDUCT, a repo-opening-public checklist, repo legal pointers, plan-221/222 reconciliations, and new offline Help topics for analysis model-reload / "GPU busy" and an engine that reads "Needs repair".

---

**Full changelog:** `v1.7.0...v1.8.0`
