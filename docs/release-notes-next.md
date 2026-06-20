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

release-notes-next-version: 1.9.0
-->

**A polish-and-reach release.** Listen from any browser on your home network, know the moment a new build lands, ride a steadier companion player, and meet a cast that reads truer — Russian books included — all on a foundation hardened by a full security pass (torch CVE, a maximal CodeQL remediation, and a fourth round of dependency hygiene).

---

## ✨ Headline features

### 🔐 Listen from any browser on your LAN (new)
Authorize a browser on your home network and your whole library opens there too — with the security to match (app-17).

- **Browser device authorization** — authorize a browser with a scan; the session is held in an HttpOnly `__Host-cw_lan` cookie, guarded by an Origin allow-list CSRF check, and device tokens carry a TTL so trust expires on its own (#901).
- **Admin LAN access card** — authorize, list, and revoke trusted devices; a revoked device drops out of the list immediately (#901, #904).
- **Redeem hardening** — the pair-redeem routes are rate-limited, body-capped at 1 KB, restricted to the local network, and answer a stale browser redeem with a 410 (#902).

### 🔔 In-app update notifier (new) — fe-27
- A non-blocking update banner plus a version-pill update dot, keyed to cached update fields on `/api/info`; dismissible, and it reappears when a newer version lands (#908).

### 📱 Companion player & pairing (app-17)
- **Deep-link pairing launch** — a compact `CWP1` pairing URL that a real phone camera reads first-try, a private-host guard, and a re-entrancy guard against stacked pairing screens from deep links (#899).
- **Listening cues** — the transport shows the current chapter name and a progress bar, finished chapters are marked, and the list auto-scrolls to where you are (#896).
- **Playback fidelity** — the transport is synced to the real play state and now handles audio focus, pausing for calls and other apps (#906).
- **APK build pipeline** — `npm run apk:companion` drops a signed APK with an auto-incrementing `versionCode` and a signer-cert verification so an update-install can't fail on a key/version mismatch (#897).

---

## 🎭 Cast & analysis quality

- **Byline author no longer enters the cast** — front-matter / boilerplate is stripped before analysis (Layer A), the resolved byline author is guarded out of stage-1 roster builds incl. cached `chapterCast` (Layer B), and the detection prompt clarifies the byline-author + first-person rule (Layer C), so a name on the title page can't surface as a phantom character (#938).
- **Russian cast localization** — non-English manuscripts now always emit `tone` and write role / description / attributes (incl. narrator) in the manuscript's language, divergent same-id name forms fold into `aliases` instead of being dropped (#936), and descriptor fold-phrases are handled (#939).
- **Voice identity decoupled from display name** — characters and voices carry an inert `voiceUuid` minted at design time and threaded through synth-key resolution, reparse, override-save, snapshots, series reuse, and the audition / sample path, so a freshly designed voice auditions as itself and a shared qwen display name can't mis-route storage (srv-43, #940).
- **Honest analysing screen** — the two pipelined phases (cast detection + attribution) each render their own live ticker instead of clobbering one another, the section counter shows the in-progress section (1-based, clamped) rather than a stuck `0/N`, and section / sentence counts gain thousands separators (#931).
- **A lone scene break can't stall a chapter** — a word-free `***` chunk is skipped before attribution and a zero-word source is treated as un-evaluable by the coverage guard, so a chapter built around a section break no longer flags "truncated" forever (#926).

## 🖥️ Responsive UI

- **Collapsing top-bar nav** — the inline nav strip folds into a hamburger drawer below `xl` (1280px) and stays inline at desktop, with reachability + visual baselines covered (#911).
- **Phone top-bar reachability** — Help, the theme toggle, and the account avatar stay on-screen at a 412px phone width (the wordmark text is hidden below `sm` and the Admin pill moves into the hamburger drawer on nav stages) instead of being clipped off-viewport (#916).
- **Recoverable library scan** — a failed shelf scan shows a Retry button instead of an eternal skeleton.

## 🔒 Security & dependencies

- **torch CVE bump** — torch / torchaudio 2.8 → 2.11 plus pytest ≥ 9, with a guardrail test that the sidecar never calls `torchaudio.load` (#884); the NVIDIA torch wheel is pre-installed from the cu128 index and the Kokoro ONNX-runtime swap is made skew-proof (#885).
- **Maximal CodeQL remediation** — path-containment sanitizers threaded into every traversal sink, linear-time ReDoS strips, tainted log values passed as `%s` args, crypto-minted session ids, a cover `<img>` scheme allowlist, and generic sidecar errors; the CodeQL workflow now excludes test files to cut future noise (#887, #889, #890, #891, #892).
- **Global API rate limiter** — an unconditional limiter mounted in front of the API (#887).
- **Dependency hygiene round 4** — in-range server + frontend refresh, sharp 0.34 → 0.35, express-rate-limit 7 → 8, a js-yaml override, undici patched to 7.28.0 / 8.5.0, and esbuild / form-data bumps (#894, #912, #882).

## 🏗️ Under the hood

- **Dependency-drift guardrail** — a monthly `app-deps-watch` workflow plus app-CI assertions that keep the Kotlin-Gradle-Plugin escape-hatch flags and the Flutter pin in lockstep (ops-17, #917).
- **Test resilience** — a non-gating quarantine lane with a `quarantinedIt` helper and a flaky register; the load-sensitive `analysis-pipelining` cases were rewritten event-driven and graduated off quarantine; the release body can no longer silently become a placeholder (#879, #880). Rename-retry backoff is now jittered to de-flake concurrent `state.json` writes with the retry count aligned (#921, #928), and the e2e visual baselines were force-refreshed / regenerated and now run on label-gated PR CI (#923, #924, #933).
- **Demo bundle** — the fs-22 demo bundle is re-keyed to uuid-keyed qwen voices and re-captured from the canonical book, with a `--copy` script mode for shared workspaces (srv-44, #942, #943).
- **Companion deps** — `connectivity_plus` bumped 6.1.0 → 7.1.1 with the iOS compile moved to macos-26 for the iOS 26 SDK (app-18, #929).
- **Repo hygiene** — personal / internal-only docs removed from the now-public repo (#932) and an unused Flutter import dropped to keep `flutter analyze` green (#919).
- **Docs** — the LAN public-cert broker design + implementation plan (design only, not yet built); regression plan 225 for LAN browser device-auth; a `srv-41` device-token hardening backlog item.

---

**Full changelog:** `v1.8.0...v1.9.0`
