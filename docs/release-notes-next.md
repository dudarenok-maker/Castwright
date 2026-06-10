# Castwright v1.7.0

Draft release notes for the next version (technical register — this is the
**GitHub release body**, fed to `bump-version.mjs` as
`--notes-file docs/release-notes-next.md` → the annotated tag → `release.yml`).
The user-facing, brand-voice notes live separately in the committed
`RELEASE_NOTES.md` (shown in-app at `#/release-notes`). Remove this header after
the tag is created.

---

## Features

- **macOS / Apple Silicon support.** Device auto-detect resolves `cuda → mps → cpu`; the sidecar spawns cross-platform via `start.sh` with a group-kill teardown. A macOS build ships in the release zip (uncodesigned; documented Gatekeeper click-through). README/INSTALL hardware guidance widened to "any Apple Silicon Mac".
- **Bulk emotion-variant voice design (fe-32 / srv-37, plan 201).** Per-book "Design full cast" gains a scope picker (bases / variants / both); a per-character `VariantGlyphStrip` replaces the count badge; variants propagate across linked books in a series; a VRAM arbiter keeps VoiceDesign ↔ Kokoro mutually exclusive.
- **Long-render stall protection (three waves).** Config-safety guards, safe boundary recycles, and better recovery so a full-book render rides out sidecar recycles and contention instead of stalling.
- **Companion pairing redesign + APK distribution.** A compact `CWP1*host:port*code*fpTag` pairing payload scans reliably on real phones; the installable APK is built + attached each release and bundled into the server zip.
- **Multi-source cover search.** OpenLibrary + Apple + Google adapters with free-text fallback, interleaved results with per-source badges.
- **Advanced Settings (fs-42).** A new `#/advanced` view (from Admin and Account) exposes model, generation, and QA knobs via a collapsible accordion — per-knob current value, "live"/"restart" apply-mode badges, Revert-to-default, `.env`-locked read-only values, forkable analyzer prompts, and a one-click "Restart sidecar". Persisted in `config.json`.
- **Brand moved into the product.** Export stamps, a branded on-ramp/listener, a real `/about` page, single-sourced brand strings, refreshed favicons/og image, and an in-app multi-version release-notes history at `#/release-notes`.
- **Source-available licensing.** FSL-1.1-Apache-2.0 LICENSE + NOTICE, CLA/DCO, and a repo-opening checklist.

## Fixes

- Per-chapter re-analysis no longer drops designed voices or cross-book reuse links; missing-speaker roster-coverage guard; stage-2 loop/truncation guards.
- Listen-section finalize + export-progress sync moved to a store-level poller (bars no longer freeze on close/nav/retry).
- Voice-library "Series" tab scoped to the current series; narrator no longer matches across unrelated series on the confirm screen.
- False "Generated with Kokoro" drift stamp corrected to the per-character effective engine.

## Engineering

- Per-sentence pre-assembly QA gate + auto re-record; ASR (Whisper) content-QA; golden-audio regression harness (opt-in).
- Cross-platform launch hardening; sidecar recycle-storm diagnostics.
