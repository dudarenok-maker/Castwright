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
- **Every new book's narrator now gets a localized name and one consistent folkloric voice, instead of an English "Narrator" on a Kokoro preset.** Newly analysed books seed the narrator (`id: 'narrator'`) with a per-language display name (`Erzähler` / `Рассказчик` / `Narrador` / `Narrateur`; `Narrator` kept as an alias) and a fixed folkloric voice persona, so the narrator gets a designed Qwen voice rather than the plan-108 preset fallback. Applied in both the full and subset analyzer jobs; a user rename or re-designed narrator voice survives reparse (merge carry-forward). No migration — existing books and shipped samples are untouched. (#NNNN)

---

## 📚 Sample library

- **The bundled demo pack now ships a runnable Coalfall sample in every supported language, and a guard keeps it that way (fs-61, #1027).** `samples/` previously carried only the English _Coalfall Commission_; a non-English user couldn't get a runnable demo, because a Qwen voice is calibrated in its design language. New captures `samples/the-coalfall-commission-{es,fr,de,ru}/` each ship the localized manuscript + language-matched Qwen voices designed from the same English personas (distinct `voiceUuid`-keyed `.pt` files, so all five samples co-load without clobber), and the English sample is refreshed with its redesigned cast. Sample discovery is a dir-scan and the release zip already globs `samples/**`, so the new books auto-list and auto-ship with no route or manifest change. A new server guard (`language-sample-coverage.test.ts`) asserts every `supported:true` language in `language-registry.ts` has a sample whose `state.json` language matches — adding a language now forces adding its sample.
- **New `scripts/slim-epub-cover.mjs` trims each sample's epub from ~5.6 MB to ~0.3 MB.** The captured epubs embed a 2048² PNG cover that _is_ the file weight. The tool resizes/converts it to a ~1000px JPG in place, rewriting `content.opf` + the titlepage cover reference (png→jpg) while preserving every text/content entry byte-for-byte, so a slimmed sample's attribution is untouched. Pure core in `scripts/lib/` (fflate, hermetically unit-tested); ffmpeg at the CLI boundary. Five samples cost ~4 MB instead of ~28 MB.
- **Coalfall manuscript locations consolidated (srv-49, #1043).** The `brand/test-book/` (masters) ↔ `samples/` (shippable) split is now the settled layout, and `samples/the-coalfall-commission/` gains a `manuscript.en.md` so all five editions are uniform Markdown in one place. The `.ru.md` test fixture was assessed for de-duplication and deliberately kept — it's a live e2e/marketing fixture, not a stray duplicate.

---

## 🐛 Fixes

- **Installing/repairing Coqui XTTS v2 (and Qwen) from the Model Manager no longer aborts with `ERROR: Constraints cannot have extras`.** `install-coqui.mjs` pins its opt-in install against `requirements/base.txt` via `pip install coqui-tts -c base.txt`, but `base.txt` is a *requirements* file that legitimately carries extras (`uvicorn[standard]`) — which pip forbids in a `-c` **constraints** file, aborting the whole install before it starts (three more latent `-c base.txt` sites lived in `install-qwen3.mjs`: `qwenPipInstallArgs` + both flash-attn installs). Extras are meaningless as a constraint (a constraint only pins a version), so a new shared `server/tts-sidecar/scripts/pip-constraints.mjs` strips `[extras]` from each line into a temp constraints file and all four call sites route through it; `base.txt` stays the single source of truth. Verified end-to-end against the real sidecar venv (`-c base.txt` reproduces the error, `-c <sanitized>` parses cleanly); unit-tested in `server/src/tts/pip-constraints.test.ts`. (#1567)
- **A failed model install/repair is legible again in dark mode.** The five in-app install affordances (`coqui`/`qwen`/`kokoro`/`whisper`/`venv-bootstrap`) render their error body as `text-rose-900/80`, but the `[data-theme='dark']` override in `styles.css` remapped only `.text-rose-900`, `/85`, and `/70` — the `/80` alpha was missed, so the failure detail painted dark-maroon-on-dark-maroon (the header, bare `text-rose-900`, stayed readable). Added the missing selector; guarded in `dark-mode-css.test.ts` alongside the existing rose/red alpha cases. (#1567)
- **A rendered chapter no longer reads permanently, un-clearably stale when a sentence carries an inline audio tag (`[emphatic]`, `[shouting]`, … — `AUDIO_TAGS`).** The #1105 text-staleness diff assumed the server stamps the RAW `group.text` and the client hashes the RAW `sent.text`, so they can't desync. False for a tagged sentence: the synth path strips the tag before synthesis (`stripAudioTags` / `emotion-from-tags`), so the render stamps `textHash` over the SPOKEN text (`[emphatic] Ende.` → `Ende.`) while the manuscript keeps the tag for display — the hashes never match, so the chapter shows `⚠ Sentences reassigned · regenerate to refresh` forever (regenerating re-strips + re-stamps the stripped hash, so it can't clear). Fixed by stripping audio tags on BOTH sides before hashing: `synthesise-chapter.ts` now stamps `textHashForStale(stripAudioTags(group.text))` (idempotent; pins the contract for an un-migrated book too), and `isChapterTextEditedSinceRender` hashes `stripAudioTags(liveText)` via a new `src/lib/audio-tags.ts` mirror of the server `AUDIO_TAGS` + `stripAudioTags`. The two strip implementations are pinned by a shared vector (`'She said [emphatic] hello.'` → `'She said hello.'`) in both test files, mirroring the existing `textHashForStale` vector. A tag-only difference now reads not-stale; a real edit to a tagged sentence's spoken words still reads stale. Fixes existing renders with no re-render needed. (#1564)

---

## ⚙️ Engine & performance

- **Kokoro no longer eager-loads at sidecar startup by default — the ~1 GB it held resident is now free unless you opt in.** fs-60 flipped the registry default `tts.preload.kokoro` to `false`, but the sidecar's own Python fallback in `_preload_default_engines` (`main.py`) was still hardcoded `True`, and `buildSidecarEnv` deliberately omits a knob that's at its registry default — so `PRELOAD_KOKORO` never reached the sidecar and it eager-loaded anyway, silently defeating the flip for every user who hadn't manually toggled the setting off. The Python fallback is now `False`, matching the registry default (and matching Coqui/Qwen, which already agreed on both sides). Kokoro warms on demand on the first synth that needs it (or via `POST /load`); opt back into the always-hot ~1 GB engine with `PRELOAD_KOKORO=1` (Advanced Settings → "Preload Kokoro at startup"). Regression test flipped in `test_kokoro.py` (`test_preload_skips_kokoro_when_unset`).

**Full changelog:** v1.13.0...v1.14.0
