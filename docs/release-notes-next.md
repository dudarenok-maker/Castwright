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

release-notes-next-version: 1.13.0

DRAFT IN PROGRESS — first PR of the v1.13.0 cycle (v1.12.3 shipped as the
consolidated Pinokio-installer patch, superseding v1.12.1/v1.12.2).
Bootstrapped per CONTRIBUTING.md "Release notes": marker bumped forward,
stale v1.12.3 body cleared, this PR's own entry opens the fresh draft.
Diffed against v1.12.3 (the previous public release). Multiple PRs have
now landed in this cycle; later PRs append to this draft rather than
opening a new one.
-->

**Ongoing hardening.** *(placeholder theme — refine at cut time once the full v1.13.0 scope is known.)*

---

## 🗣️ Quality & Accuracy

- **ASR content-QA gate: non-English integer-spelling and contraction normalization for es/fr/de/ru (#1084).** Real per-language `maxWer` calibration against rendered audio remains a tracked follow-up.
- **A real third-party person named/quoted only in a non-story front-matter chapter is no longer rostered as a cast member (#1447).** Follow-up to #1446's synthesis safety net: a critical essay or foreword that quotes a *different* real author (e.g. "Вступительная статья" about Radiy Pogodin) used to have stage-2 cast that person as a one-line speaker, which `fold-minor-cast`'s `proseTagged` carve-out then preserved as an orphaned cast reference. A new pre-fold guard (`stripThirdPartyFrontMatter`) strips a character only when all of: attributed in exactly one chapter with `< minLines` lines, name+aliases absent from every other chapter body, and that chapter is front-matter-suspicious (a dedicated essay-title predicate `isNonStoryEssayTitle`, or positional front-region) AND confirmed non-story by Signal 1 (title) or a conservative optional analyzer classification (`runNonStoryClassification`, Signal 2). Stripped lines re-route to the narrator, so the essay stays narrated and genuine framed/walk-on characters are untouched.
- **Dialogue-structure attribution escalation: two low-priority srv-59 follow-ups.** Each escalated conversation window in a chapter now keeps its own forensics artifact on disk instead of the last window overwriting every earlier one; and the "characters present" candidate list shown to the escalation model no longer surfaces `narrator` as a suggested guess (it's still a valid answer, just noise as a candidate). (#1483)

## 🎙️ Voice design & casting

- **"Design full cast" no longer silently grinds through GPU contention.** If another job was using the GPU while a bulk cast design was running, every remaining character used to fail identically, one after another, with the progress pill misleadingly climbing toward 100% the whole time (even reading "0/16 · 94%" — zero characters designed, but nearly "complete"). The sidecar now recognizes this specific contention and triggers its existing self-recovery restart (matching how it already handles other transient failures); the job rides out a brief pause before halting with a clear message naming the cause and how far it got, instead of grinding through every remaining character. The progress pill's percent no longer counts failures as progress, and now shows the failure count inline while the job is still running. (#1533)

## 🌐 Languages

- **fs-60: Coqui XTTS becomes an eligible casting choice and automatic fallback for Russian/Spanish/French/German books**, no longer hard-locked to Qwen with no recovery path. A new `ENGINE_LANGUAGE_SUPPORT`/`resolveEligibleEngines` model (server) computes a per-book `eligibleTtsEngines` field; an undesigned or unavailable Qwen character now falls back to a generic Coqui voice instead of failing the chapter, mirrored in the cast-view banner, the voice-readiness gate ("Proceed anyway" now names the real fallback engine), the engine picker, and a new "Fallback (Coqui)" status pill. A mixed Qwen+Coqui chapter is serialized (never co-resident) to protect an 8 GB card. `PRELOAD_KOKORO`'s default also flips `true`→`false` (Coqui/Qwen already default off; Kokoro now matches). Live-GPU acceptance still owed. (#1005)

## 📱 LAN, mobile & install

- **LAN HTTPS is now the production default, so phone/tablet listening + companion pairing work out of the box — flipped safely.** `isLanHttpsEnabled()` defaults ON when `NODE_ENV=production` (native installers, Pinokio, `start:prod`) and OFF in dev/test; explicit `LAN_HTTPS=0/1` still wins. Three coupled pieces make the flip safe: (1) **boot never crashes on missing certs** — the server computes effective LAN = requested AND certs-present and degrades to loopback HTTP with a one-command-fix warning instead of the old `process.exit(1)`; (2) **the LAN API is never left unauthenticated** — `ensureLanAuthToken()` auto-mints + persists a `LAN_AUTH_TOKEN` to `server/.env` whenever LAN is on and none is set (device tokens still accepted, loopback still bypasses, the pairing QR carries it); (3) **certs auto-provision on every install path** — `setup-lan-certs.mjs` is now non-fatal and honours `APP_RUN_DIR`, `start-app-prod.mjs` provisions on first launch (native/manual/versioned), and Pinokio `install.js` installs mkcert via conda + provisions. Each phone still installs the mkcert root CA once (pinned via the pairing QR's CA fingerprint). On-box pairing acceptance owed. (See docs/features/250-lan-https-default.md; Pinokio Open-Web-UI tab under LAN also needs the #1540 URL-capture fix.)

---

**Full changelog:** v1.12.3...v1.13.0
