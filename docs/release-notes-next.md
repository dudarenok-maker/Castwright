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

**A polish-and-reach release.** Listen from any browser on your home network, know the moment a new build lands, and ride a steadier companion player — all on a foundation hardened by a full security pass (torch CVE, a maximal CodeQL remediation, and a fourth round of dependency hygiene).

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

## 🖥️ Responsive UI

- **Collapsing top-bar nav** — the inline nav strip folds into a hamburger drawer below `xl` (1280px) and stays inline at desktop, with reachability + visual baselines covered (#911).
- **Recoverable library scan** — a failed shelf scan shows a Retry button instead of an eternal skeleton.

## 🔒 Security & dependencies

- **torch CVE bump** — torch / torchaudio 2.8 → 2.11 plus pytest ≥ 9, with a guardrail test that the sidecar never calls `torchaudio.load` (#884); the NVIDIA torch wheel is pre-installed from the cu128 index and the Kokoro ONNX-runtime swap is made skew-proof (#885).
- **Maximal CodeQL remediation** — path-containment sanitizers threaded into every traversal sink, linear-time ReDoS strips, tainted log values passed as `%s` args, crypto-minted session ids, a cover `<img>` scheme allowlist, and generic sidecar errors; the CodeQL workflow now excludes test files to cut future noise (#887, #889, #890, #891, #892).
- **Global API rate limiter** — an unconditional limiter mounted in front of the API (#887).
- **Dependency hygiene round 4** — in-range server + frontend refresh, sharp 0.34 → 0.35, express-rate-limit 7 → 8, a js-yaml override, undici patched to 7.28.0 / 8.5.0, and esbuild / form-data bumps (#894, #912, #882).

## 🏗️ Under the hood

- **Dependency-drift guardrail** — a monthly `app-deps-watch` workflow plus app-CI assertions that keep the Kotlin-Gradle-Plugin escape-hatch flags and the Flutter pin in lockstep (ops-17, #917).
- **Test resilience** — a non-gating quarantine lane with a `quarantinedIt` helper and a flaky register; the load-sensitive `analysis-pipelining` cases were rewritten event-driven and graduated off quarantine; the release body can no longer silently become a placeholder (#879, #880).
- **Docs** — the LAN public-cert broker design + implementation plan (design only, not yet built); regression plan 225 for LAN browser device-auth; a `srv-41` device-token hardening backlog item.

---

**Full changelog:** `v1.8.0...v1.9.0`
