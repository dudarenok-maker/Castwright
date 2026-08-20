# Device & browser sitting — on-box acceptance run sheet

> **This is a working document.** Fill in the `Result:` lines AS you run this
> on the box. Do not pre-fill them.
>
> Plan of record: [`docs/testing/onbox-sitting-plan.md`](onbox-sitting-plan.md)
> §5 (pack format), §4.7 (this sitting's place in the order).
> Register rows: [`onbox-acceptance-register.md`](onbox-acceptance-register.md)
> E1, E2, E3, E5, E6, E7, E9, E10.
> Feature plans: [`218-pinokio-installer.md`](../features/218-pinokio-installer.md) (E1),
> [`250-lan-https-default.md`](../features/250-lan-https-default.md) (E2),
> [`256-lan-pair-from-friendly-hostname.md`](../features/256-lan-pair-from-friendly-hostname.md) (E3),
> [#1795](https://github.com/dudarenok-maker/Castwright/pull/1795) (E5),
> [`269-ffmpeg-version-floor.md`](../features/269-ffmpeg-version-floor.md) (E6),
> [`270-openapi-setup-surface.md`](../features/270-openapi-setup-surface.md) (E7),
> [`282-ort-pip-consistency-marker.md`](../features/282-ort-pip-consistency-marker.md) (E9),
> [`225-lan-browser-device-auth.md`](../features/225-lan-browser-device-auth.md) (E10).
>
> **E7 added 2026-08-20**, correcting a wave-3 gap: the register's E7 row
> (wave-3 step 7) claimed it had already "joined
> `onbox-sitting-device-browser.md`," but this file's own row list and
> minute total were never actually updated — confirmed by an empty
> `git diff` against this file across the whole wave-3 range. E7's
> server/poll half is already DISCHARGED (see the register row); only its
> **rendered-half** observations (spinner, card timing, green ready card,
> refetch-without-reload, failure card) are still owed to the operator, and
> that is what E7's step below covers. Same "still owed to the operator"
> pattern as A33/A43 in `onbox-sitting-cloning-identity.md`.
>
> **Running time total (recomputed 2026-08-20):** E1 30 + E2 20 + E3 15 +
> E5 5 + E6 30 + E7 20 + E9 30 + E10 20 = **170 minutes** (was 150 before
> E7's addition).

---

## 1. Purpose & scope

None of these eight rows need the operator's GPU. They need Pinokio, a real
phone/browser on the LAN, a swappable ffmpeg build, and (for E7) a box whose
sidecar venv can be deleted — hardware the two-card/VRAM sittings don't
touch. This sitting has three independent parts that can run in either order
or on separate days:

- **Pinokio half — E1, E9, E6.** Pinokio install/update on Windows (and, for
  E1 only, a separate macOS machine), grouped because E9 and E6 each name
  themselves "grouped with E1" and share its Pinokio setup.
- **LAN/browser half — E2, E3, E10, E5.** One phone-pairing session on the
  LAN-HTTPS server, because the audit records E3 as running in the same
  session as E2, and E10 as sharing that whole setup. E5 is a DevTools
  smoke-check with no server dependency and can be slotted into either half's
  spare minutes, but is grouped here since it is browser-shaped like the rest
  of this half.
- **E7 — rendered-half venv-bootstrap card.** Independent of both halves
  above: needs a box with no `server/tts-sidecar/.venv`, any machine, no
  GPU. Can run before, after, or between the two halves.

**Re-resolution note:** every row below was independently re-checked against
live `gh issue`/`gh pr` state and the current source tree while writing this
pack (2026-08-20). The original seven remain accurately STILL OWED as the
staleness audit describes; no citation had drifted, and nothing here is
discharged or self-contradictory. **One UI label has drifted** since the
register row was written — see E5's step, which names the corrected control
name. E7 was folded in later the same day (see above) — its server/poll half
is DISCHARGED, its rendered half is not.

## 2. Preconditions

**Pinokio half:**

- [ ] A Windows machine with Pinokio installed, and a **separate** clean
      macOS machine with Pinokio installed (E1's macOS axis has had zero
      on-box exercise — it cannot be satisfied by the Windows machine).
- [ ] On the Windows machine, an **existing pre-fix Pinokio install** (i.e.
      not a fresh Install) so an Update actually exercises the `reqHash`
      branch E9 needs — see
      [`ort-marker-onbox-acceptance.md`](ort-marker-onbox-acceptance.md) §6
      preconditions for the exact prior-state requirement.
- [ ] The Windows machine's card set to the **nvidia profile** for the E9
      Update/Install pass.
- [ ] ffmpeg swappable between a real **< 4.4** build and a real **≥ 6.0**
      build on one machine (a 22.04 container with archive ffmpeg 4.4 is the
      cheapest route per the register; any machine, no GPU needed for E6
      itself — it only needs to be reachable from the same Pinokio conda env
      for the `"ffmpeg>=6"` constraint half).

**LAN/browser half:**

- [ ] Server running with `LAN_HTTPS=1` (the default) so it boots HTTPS on
      `:8443`.
- [ ] A real phone on the same Wi-Fi as the server, with the Castwright
      Companion app installed, free to: install a root CA, scan a pairing QR,
      and be revoked.
- [ ] A desktop browser open to the app for the DevTools smoke-check (E5) —
      any machine, no server dependency.
- [ ] A second shell/terminal free to issue a direct `DELETE
      /api/devices/<id>` call for E10's forwarder-boundary check.

## 3. Procedure — Pinokio half (E1, E9, E6)

Ordered to seat the Windows Pinokio state once and reuse it across E1's
Windows checks, E9's Update pass, and E6's Pinokio constraint check, then do
E1's macOS axis as an independent block.

1. **(E1, Windows — pinned Node)** From a fresh Install on the Windows
   machine, open a `shell.run` step (or the Pinokio terminal, once the conda
   env is active) and run `node --version`.
   **Observe:** reports **24.x**, not whatever Pinokio's bundled kernel ships.
   Then confirm Install → Start completes end to end with no solve/channel
   error from the added conda package.
   `Result:` _(fill in — node --version output, Install→Start outcome)_

2. **(E1, Windows — mid-life upgrade path)** Take a **separate** install from
   a pre-pin release. Run Update once and check `node --version`.
   **Observe:** reporting the **bundled** version here is the documented,
   correct result (the old `update.js` ran, no pin step) — not a failure. Run
   Update a **second** time and check `node --version` again.
   **Observe:** now reports **24.x** (the pin took effect from this Update).
   Confirm `node_modules` still works after the Node-major swap (app starts,
   no native-module load error).
   `Result:` _(fill in — first Update version, second Update version,
   node_modules outcome)_

3. **(E1, Windows — native Stop)** From a running install, use Pinokio's
   native Stop control.
   **Observe:** the TTS sidecar process is actually reaped (not left
   orphaned) — check the process list before and after Stop.
   `Result:` _(fill in — sidecar PID before/after Stop)_

4. **(E9 — ORT marker, Pinokio update path)** On the Windows machine's
   existing pre-fix install (step 1's precondition), run
   [`ort-marker-onbox-acceptance.md`](ort-marker-onbox-acceptance.md) §6.2–6.3
   in full: run Update on the nvidia profile, confirm the `noop`/
   `pip-in-place` branch behaves as documented (including the self-heal at
   next server boot if `noop`), confirm Qwen3 installs with no `WinError 5`,
   then in the same session run a fresh `install.js` pass and confirm the
   same outcome. Fill in that run sheet's own §6.3 `Result:` fields — do not
   duplicate them here.
   `Result:` _(fill in here only: confirmed run against §6.3 of the cited
   sheet, yes/no, and today's date)_

5. **(E6 — ffmpeg floor, six-step walkthrough)** On the ffmpeg-swappable
   machine, with ffmpeg **4.4** on PATH:
   a. `npm run test:server` — **observe** preflight exits **1**, printing
      "ffmpeg 4.4 is older than Castwright supports" with the host OS's
      upgrade command.
   b. Start the server, open the Setup Wizard's ffmpeg step — **observe** the
      **amber outdated** card (`data-testid="step-ffmpeg-outdated"`), not the
      "isn't installed yet" card; the wizard still **advances**; `GET
      /api/setup/readiness` reports `ready: true` with
      `blockers.ffmpeg.status === 'warn'`.
   c. Admin → diagnostics — **observe** the ffmpeg row at status `warn` with
      the version in its detail, **and** the top-bar Admin health dot goes
      amber and stays amber on every screen (no dismiss).
   d. Upgrade ffmpeg to **≥ 6.0**, click **Re-check without restarting the
      server** — **observe** the card flips to green ready state.
   e. Confirm the upgrade advice text itself is what actually cleared the
      card (not a stale cache) — re-run diagnostics and confirm the health
      dot returns to its normal state.
   `Result:` _(fill in — each of a–e, pass/fail and any deviation)_

6. **(E6 — Pinokio constraint, grouped with E1)** In the same Pinokio conda
   env used above, confirm the `"ffmpeg>=6"` constraint is actually enforced
   on a real conda solve (not just declared) — attempt a solve that would
   pull ffmpeg <6 and confirm it's rejected or upgraded.
   `Result:` _(fill in)_

7. **(E1, macOS — independent block)** On the clean macOS machine, from a
   fresh Pinokio Install:
   a. **Observe** the install completes (first-ever macOS exercise of this
      axis).
   b. **Observe** the venv-from-conda step succeeds.
   c. **Observe** the app's API spelling/calls work identically to Windows
      (spot-check one render).
   `Result:` _(fill in — install outcome, venv outcome, API spot-check
   outcome)_

## 4. Procedure — LAN/browser half (E2, E3, E10, E5)

Ordered so the phone-pairing session happens once and every row that reads
its state rides the same pairing.

1. **(E2 — fresh boot)** Fresh install (Pinokio or native/manual
   `start:prod`) with `LAN_HTTPS=1`.
   **Observe:** server comes up HTTPS on `:8443`, `[cert] LAN certs
   provisioned` is logged, `server/.env` gains a `LAN_AUTH_TOKEN`. Open the
   desktop Open-Web-UI tab at `https://localhost:8443` — **observe** it loads
   with no certificate warning.
   `Result:` _(fill in)_

2. **(E2 — real phone pairing)** On the phone, install the mkcert root CA
   once (via the pairing QR / fingerprint pin), then browse
   `https://castwright.local:8443` and complete pairing.
   **Observe:** pairing completes with no cert warning on the phone.
   `Result:` _(fill in)_

3. **(E3 — friendly-hostname authorize + name-first pairing, same session)**
   From the Listen tab's **"Pair a device"** banner (`companion-app-banner.tsx`),
   open the pairing modal — its first step names the device (**"Name this
   device… then generate a code"**, `aria-label="Device name"`) before
   minting a session. Enter a name, generate the code, and complete pairing
   from `https://castwright.local/#/admin`.
   **Observe:** no 403 during authorization; in Admin → LAN access, the
   device appears under the **chosen name**, not a generic "Device" label.
   `Result:` _(fill in)_

4. **(E3 — bare-LAN-IP guard)** From the phone (or another LAN client),
   request the server by its bare LAN IP instead of `castwright.local`.
   **Observe:** the loopback-only 403 guidance, not a raw failure.
   `Result:` _(fill in)_

5. **(E2 — degrade path)** Force `LAN_HTTPS=0` (or delete the certs) and
   restart.
   **Observe:** the server degrades to loopback HTTP on `:8080` with no
   crash — a missing-cert warning is acceptable, a crash is not.
   `Result:` _(fill in)_ Restore `LAN_HTTPS=1` and the certs before
   continuing to E10.

6. **(E10 — direct-port revoke, non-default port)** Set `LAN_HTTPS_PORT` to a
   **non-default** value and bind the `:443` forwarder. From
   `https://localhost:<port>` (direct, not through the forwarder), revoke one
   of the paired test devices from Admin → LAN access (`lan-access-card.tsx`'s
   **Revoke** button, only rendered when `isLoopbackHost()`).
   **Observe:** revoke succeeds.
   `Result:` _(fill in)_

7. **(E10 — forwarder boundary)** From `https://localhost/` (through the
   `:443` forwarder), attempt the same revoke.
   **Observe:** the Revoke button renders, but the action returns **403**
   with the actionable direct-port sentence (`revokeLoopbackOnlyHint` in
   `lan-access-card.tsx`) — not a raw "revoke failed (403)".
   `Result:` _(fill in — exact 403 message shown)_

8. **(E10 — paired-phone view)** From the paired phone on `castwright.local`
   (with **at least 3** devices paired in the list, per the row's own
   caveat), open the LAN access list.
   **Observe:** no Revoke control renders on **any** row, and the explanation
   sentence appears **once**, below the whole list — not repeated per row.
   `Result:` _(fill in)_

9. **(E10 — direct DELETE from a paired LAN device)** From a second shell on
   the paired phone's network (or curl from the phone itself if tooling
   allows), issue `DELETE /api/devices/<host id>` directly, bypassing the UI.
   **Observe:** 403, and the host's own device record is still present
   afterward (survived, not silently revoked).
   `Result:` _(fill in — response body, record presence after)_

10. **(E5 — DevTools touch press-feedback smoke-check)** On the desktop
    browser, open DevTools → toggle device emulation with touch enabled
    (Chrome: **Ctrl+Shift+M** device-toolbar toggle, any touch-capable device
    preset — this turns on `:active`/pointer-coarse styling instead of
    `:hover`-only). Tap-and-hold, then release, each of the four controls
    below and **observe** the press state visibly persists briefly on
    tap/release, matching the existing `:hover` treatment (a flash that
    disappears instantly, or no visible change at all, is a fail):
    - Continue-listening rail **play badge**
      (`src/components/library/continue-listening-rail.tsx:111`,
      `group-active:bg-white/35`).
    - The library's **"Add another book"** tile
      (`src/components/library/library-grid.tsx:551-569`,
      `data-tour-id="new-book-btn"`, `group-active:bg-peach` on its icon
      circle). **Note:** the register row names this the "Add book" tile;
      the control's current visible copy is **"Add another book"** — verified
      against source while writing this pack, since Wave 1's whole finding
      was that written-down control names drift.
    - Setup Wizard **"Review ›"** chip on an amber/red diagnostics row
      (`src/components/setup/setup-wizard.tsx:465-477`,
      `group-active:text-magenta`).
    - Voice-library card **drag icon**
      (`src/components/voice-library-panel.tsx:563-564`, `IconDrag`,
      `group-active:text-ink/60`).
    `Result:` _(fill in — pass/fail per control)_

## 5. Procedure — E7 rendered-half (venv-bootstrap progress card)

Independent of the two halves above; needs no Pinokio and no phone/LAN
setup. Wave-3 step 7 already discharged the server/poll wiring underneath
this card (`POST/GET /api/setup/venv/bootstrap`) against a real 8m49s
`bootstrap-venv.mjs` run — see the register's E7 row. What's left is the
**rendered-page** half, register observations 1, 2, 4, 5, 6:

1. On a box with **no** `server/tts-sidecar/.venv` (delete it, or a fresh
   clone), open Setup Wizard → voice-engine step.
   **Observe:** the "Set up the voice engine runtime" button.
   `Result:` _(fill in)_
2. Click it. **Observe:** within ~1.5 s the progress card appears —
   spinner, "Setting up the voice engine runtime…", and a live `job.step`
   line.
   `Result:` _(fill in)_
3. Let it finish. **Observe:** the green "Voice engine runtime ready" card,
   and `onBootstrapped` refetches so the parent's status flips without a
   reload.
   `Result:` _(fill in)_
4. A missed `detecting` frame is not a failure — do not report it as one.
5. Failure path, if cheap to induce (e.g. no Python 3.12 on PATH):
   **Observe:** the red "Setup failed" card with the server's message, and a
   working "Try again".
   `Result:` _(fill in — pass/fail, and any deviation)_

## 6. Teardown

- Stop the server; unset `LAN_HTTPS_PORT` and restore the default
  `LAN_HTTPS=1`.
- Un-pair every test device added during this sitting from Admin → LAN
  access.
- Turn off DevTools device/touch emulation.
- Restore ffmpeg on PATH to the machine's normal (≥ 6.0) build.
- Revert the Windows machine's Pinokio card selection away from the
  nvidia-profile-only state if it differs from normal use.
- Leave the macOS Pinokio install in place or remove it, operator's choice —
  not required for any other sitting in this plan.

_(Once run, mark register rows E1, E2, E3, E5, E6, E9, E10 discharged with a
summary of these results and remove them from the "owed" count. E7's
server/poll half is already DISCHARGED — running §5 above discharges its
rendered half too, at which point the whole row comes out.)_
