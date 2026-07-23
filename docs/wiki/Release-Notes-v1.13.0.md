Released 2026-07-12. [View on GitHub](https://github.com/dudarenok-maker/Castwright/releases/tag/v1.13.0).

---

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

**Reach without setup — and a safety net for every language.** This release brings the English pipeline's polish to every other language Castwright performs, and takes the friction out of listening on your other devices. Non-English books — Russian, Spanish, French, German — now get a graceful fallback voice when a character's bespoke voice isn't ready yet, the same net English books have always had, with Coqui XTTS joining Qwen as an eligible casting engine. And listening from a phone or tablet now works the moment you install: LAN-over-HTTPS is the production default, provisions its own certificates, and keeps paired devices paired across upgrades — while the Pinokio one-click app finally surfaces an **Open Web UI** button the instant the server is ready. Around those two headliners, a run of accuracy and touch fixes: a stray name from a book's introduction no longer sneaks into your cast, the non-English quality gate understands numbers and contractions, designing a whole cast rides out GPU contention instead of grinding through it, you can audition a voice before assigning it, and tablet controls are finally finger-sized.

---

## ✨ Headline features

### 🌐 A fallback voice for every language — and Coqui as an eligible engine (new) — fs-60
Non-English books are no longer hard-locked to Qwen with no recovery path: an undesigned or briefly-unavailable character now falls back to a generic voice instead of stopping the chapter, exactly as English books already do — and Coqui XTTS becomes a first-class casting choice alongside it.

- **fs-60: Coqui XTTS becomes an eligible casting choice and automatic fallback for Russian/Spanish/French/German books**, no longer hard-locked to Qwen with no recovery path. A new `ENGINE_LANGUAGE_SUPPORT`/`resolveEligibleEngines` model (server) computes a per-book `eligibleTtsEngines` field; an undesigned or unavailable Qwen character now falls back to a generic Coqui voice instead of failing the chapter, mirrored in the cast-view banner, the voice-readiness gate ("Proceed anyway" now names the real fallback engine), the engine picker, and a new "Fallback (Coqui)" status pill. A mixed Qwen+Coqui chapter is serialized (never co-resident) to protect an 8 GB card. `PRELOAD_KOKORO`'s default also flips `true`→`false` (Coqui/Qwen already default off; Kokoro now matches). Live-GPU acceptance still owed. (#1005)

### 📱 Phone & tablet listening works out of the box — LAN HTTPS default
Reaching Castwright from another device on your network used to mean a special command and hand-generated certificates. Now every production install starts up ready — secure, device-locked, and pairing-capable — and degrades safely to loopback when certs can't be set up.

- **LAN HTTPS is now the production default, so phone/tablet listening + companion pairing work out of the box — flipped safely.** `isLanHttpsEnabled()` defaults ON when `NODE_ENV=production` (native installers, Pinokio, `start:prod`) and OFF in dev/test; explicit `LAN_HTTPS=0/1` still wins. Three coupled pieces make the flip safe: (1) **boot never crashes on missing certs** — the server computes effective LAN = requested AND certs-present and degrades to loopback HTTP with a one-command-fix warning instead of the old `process.exit(1)`; (2) **the LAN API is never left unauthenticated** — `ensureLanAuthToken()` auto-mints + persists a `LAN_AUTH_TOKEN` to a **shared, cross-release run-dir file** (so a versioned upgrade keeps paired devices paired) whenever LAN is on and none is set (device tokens still accepted, loopback still bypasses, the pairing QR carries it), and `GET /lan` + pairing advertise the **actually-bound** protocol/port so a cert-less degrade never hands out dead `https://…:8443` links; (3) **certs auto-provision on every install path** — `setup-lan-certs.mjs` is now non-fatal and honours `APP_RUN_DIR`, `start-app-prod.mjs` provisions on first launch (native/manual/versioned), and Pinokio `install.js` installs mkcert via conda + provisions. Each phone still installs the mkcert root CA once (pinned via the pairing QR's CA fingerprint). On-box pairing acceptance owed. (See docs/features/250-lan-https-default.md; the Pinokio Open-Web-UI tab under LAN also relies on the URL-capture fix below.) (#1541)

---

## 🗣️ Quality & Accuracy

- **ASR content-QA gate: non-English integer-spelling and contraction normalization for es/fr/de/ru (#1084).** Real per-language `maxWer` calibration against rendered audio remains a tracked follow-up.
- **A real third-party person named/quoted only in a non-story front-matter chapter is no longer rostered as a cast member (#1447).** Follow-up to #1446's synthesis safety net: a critical essay or foreword that quotes a *different* real author (e.g. "Вступительная статья" about Radiy Pogodin) used to have stage-2 cast that person as a one-line speaker, which `fold-minor-cast`'s `proseTagged` carve-out then preserved as an orphaned cast reference. A new pre-fold guard (`stripThirdPartyFrontMatter`) strips a character only when all of: attributed in exactly one chapter with `< minLines` lines, name+aliases absent from every other chapter body, and that chapter is front-matter-suspicious (a dedicated essay-title predicate `isNonStoryEssayTitle`, or positional front-region) AND confirmed non-story by Signal 1 (title) or a conservative optional analyzer classification (`runNonStoryClassification`, Signal 2). Stripped lines re-route to the narrator, so the essay stays narrated and genuine framed/walk-on characters are untouched.
- **Dialogue-structure attribution escalation: two low-priority srv-59 follow-ups.** Each escalated conversation window in a chapter now keeps its own forensics artifact on disk instead of the last window overwriting every earlier one; and the "characters present" candidate list shown to the escalation model no longer surfaces `narrator` as a suggested guess (it's still a valid answer, just noise as a candidate). (#1483)

## 🎙️ Voice design & casting

- **"Design full cast" no longer silently grinds through GPU contention.** If another job was using the GPU while a bulk cast design was running, every remaining character used to fail identically, one after another, with the progress pill misleadingly climbing toward 100% the whole time (even reading "0/16 · 94%" — zero characters designed, but nearly "complete"). The sidecar now recognizes this specific contention and triggers its existing self-recovery restart (matching how it already handles other transient failures); the job rides out a brief pause before halting with a clear message naming the cause and how far it got, instead of grinding through every remaining character. The progress pill's percent no longer counts failures as progress, and now shows the failure count inline while the job is still running. (#1533)
- **fe-7: per-row voice sample-preview button in the model-voice override picker (#416).** Each base-voice row in the Profile Drawer's override picker now carries a hover/focus-revealed ▶ (faintly visible on touch via `coarse-pointer:opacity-60`) that auditions that voice through the shared `playBaseVoiceSampleWithAutoLoad` single-flight helper using the drawer's `previewText`, without committing the override; picking the row still commits. `stopPropagation` separates audition from selection, and the button carries `coarse-pointer` 44px touch sizing. New wrapper tests in `voice-override-picker.test.tsx`.

## 🚀 One-click install (Pinokio)

- **The Pinokio launcher now surfaces a proper way into the app during the 1–2 min startup, works under LAN sharing, and confirms Reset.** Three launcher-UX fixes, matching the conventions of every shipping Pinokio app (comfy/flux-webui/dia/Kokoro-TTS): (1) while the server is warming up (`local.url` not yet captured) the menu now defaults to a live **Terminal** tab and auto-flips to **Open Web UI** the instant the server is ready — previously it rendered `Open Web UI` with a `null` href, so Pinokio fell back to a bare terminal and first-time users saw no way to open the app; (2) `start.js` now **captures** the URL the server actually prints (`/(https?:\/\/localhost:[0-9]+)/` → `input.event[1]`) instead of hardcoding `http://localhost:8080`, so **LAN sharing** (`LAN_HTTPS=1`, server binds `https://localhost:8443`) surfaces a working Open-Web-UI tab too; (3) the **Reset** menu item now carries a `confirm:` before it wipes `node_modules`/venv/`dist` and reinstalls. `menu.test.js` (both running states + the Reset-confirm guard) and `structure.test.js` (adds the `running/url:null` startup window) pin all three. (Refs #822)

## 📱 Touch & tablet

- **Library Cards/Table toggle fixed on touch + app-wide 44px touch targets for tablets (bug).** Two defects surfaced via an Android tablet emulator + a Playwright coarse-pointer probe. (1) The library view toggle rendered unconditionally in `LibraryChrome` but `book-library.tsx` force-collapses to cards below 640px — so tapping *Table* flipped `aria-pressed` yet never changed the view (a live-looking dead control at 600px: `aria-pressed=true`, table sections = 0). It's now hidden whenever the viewport forces card mode (new `showViewToggle` prop, regression test in `book-library.test.tsx`). (2) The touch-target convention flipped from `min-h-[44px] sm:min-h-0` (phone-only — `sm:` stripped the 44px target at exactly the ≥640px tablet range) to `min-h-[44px] fine-pointer:min-h-0`, so phones AND tablets get WCAG-2.5.5 targets while mouse (fine-pointer) devices stay compact; library + top-bar controls that lacked any base size (toggle, filter/tag/language pills, table kebab, theme toggle, account avatar, version + admin pills) got `coarse-pointer` sizing. 44 files. Verified: toggle 44px at tablet width, hidden below 640px, all frontend tests + tsc green. (#1543)

---

**Full changelog:** v1.12.3...v1.13.0
