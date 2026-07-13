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

release-notes-next-version: 1.14.0

DRAFT IN PROGRESS — first PR of the v1.14.0 cycle (v1.13.0 shipped
2026-07-12). Bootstrapped per CONTRIBUTING.md "Release notes": marker bumped
forward, stale v1.13.0 body cleared, this PR's own entry opens the fresh
draft. Diffed against v1.13.0 (the previous public release). Later PRs in
this cycle append to this draft rather than opening a new one.
-->

**In progress.** _(Theme statement written at cut time.)_

---

## 🎙️ Voice design & casting

- **A cast-confirmed book that hasn't started generating now reopens on the Cast view (voice design), not the Generate tab — new `voices_pending` stage + "Cast ready" library badge.** Confirming a cast used to flip a book straight to `generating` status, so reopening it from the library jumped to the Generate tab even before any voice was designed. A new server-derived `voices_pending` `LibraryBookStatus` (`castConfirmed && !generationStarted && not-complete`, where "started" is derived from disk — any rendered audio or any failed chapter, so no `state.json` field and no migration) sits between `cast_pending` and `generating`; such a book now routes to the Cast view, shows a "Cast ready" badge, and counts under "In progress". `isConfirmed` includes the new status (series-memory counting unaffected), and the library status-pill lookup gains a defensive fallback so an unknown server status can never blank-crash the grid. (#1560)
- **The intermittent Qwen meta-tensor load fault now retries in-process instead of recycling the whole sidecar (#1557).** `_load_qwen_model` hitting `NotImplementedError: Cannot copy out of meta tensor` (an uncovered composite submodule landing on the meta device despite `low_cpu_mem_usage=False`) used to schedule an immediate sidecar self-recycle on the FIRST fault. But the fault is intermittent — a fresh `from_pretrained` in the *same* process loads cleanly ~8s later (logs 2026-07-12 18:35, same pid; ~90 fault lines vs only 2 recycles over a week) — so a bulk voice-design run read as the sidecar "crashing continuously." The load now retries in-process (a fixed 2 attempts — one retry — VRAM-reclaimed between) on that fault class only. The self-recycle is scheduled ONLY when the meta fault is persistent (every attempt hits it) — behaving exactly as the pre-retry code did, one recycle and the meta error raised. Any other outcome surfaces truthfully: a clean retry returns the model; a retry that hits a different error (e.g. a CUDA OOM, or a deterministic fault) re-raises that true error with NO recycle, so the caller's own handling (the design route's GPU-poison latch, the mint route's fallback) fires as before and a real error is never masked as "meta" into an endless recycle. A loader that arrives after another thread already scheduled the recycle skips its own retry, without rejecting healthy unrelated loads. A new `_log_meta_device_params` names the uncovered submodule on the next fault. Regression tests in `test_qwen_load_reclaim.py`.

---

## 🐛 Fixes

- **A rendered chapter no longer reads permanently, un-clearably stale when a sentence carries an inline audio tag (`[emphatic]`, `[shouting]`, … — `AUDIO_TAGS`).** The #1105 text-staleness diff assumed the server stamps the RAW `group.text` and the client hashes the RAW `sent.text`, so they can't desync. False for a tagged sentence: the synth path strips the tag before synthesis (`stripAudioTags` / `emotion-from-tags`), so the render stamps `textHash` over the SPOKEN text (`[emphatic] Ende.` → `Ende.`) while the manuscript keeps the tag for display — the hashes never match, so the chapter shows `⚠ Sentences reassigned · regenerate to refresh` forever (regenerating re-strips + re-stamps the stripped hash, so it can't clear). Fixed by stripping audio tags on BOTH sides before hashing: `synthesise-chapter.ts` now stamps `textHashForStale(stripAudioTags(group.text))` (idempotent; pins the contract for an un-migrated book too), and `isChapterTextEditedSinceRender` hashes `stripAudioTags(liveText)` via a new `src/lib/audio-tags.ts` mirror of the server `AUDIO_TAGS` + `stripAudioTags`. The two strip implementations are pinned by a shared vector (`'She said [emphatic] hello.'` → `'She said hello.'`) in both test files, mirroring the existing `textHashForStale` vector. A tag-only difference now reads not-stale; a real edit to a tagged sentence's spoken words still reads stale. Fixes existing renders with no re-render needed. (#1564)

---

## ⚙️ Engine & performance

- **Kokoro no longer eager-loads at sidecar startup by default — the ~1 GB it held resident is now free unless you opt in.** fs-60 flipped the registry default `tts.preload.kokoro` to `false`, but the sidecar's own Python fallback in `_preload_default_engines` (`main.py`) was still hardcoded `True`, and `buildSidecarEnv` deliberately omits a knob that's at its registry default — so `PRELOAD_KOKORO` never reached the sidecar and it eager-loaded anyway, silently defeating the flip for every user who hadn't manually toggled the setting off. The Python fallback is now `False`, matching the registry default (and matching Coqui/Qwen, which already agreed on both sides). Kokoro warms on demand on the first synth that needs it (or via `POST /load`); opt back into the always-hot ~1 GB engine with `PRELOAD_KOKORO=1` (Advanced Settings → "Preload Kokoro at startup"). Regression test flipped in `test_kokoro.py` (`test_preload_skips_kokoro_when_unset`).

**Full changelog:** v1.13.0...v1.14.0
