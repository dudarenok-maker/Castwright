# Step 4 — E2, E3, E8: LAN HTTPS / `castwright.local` (Castwright#2991)

Ran on-box in `wt-human-checkpoint-batch` (branch `docs/docs-human-checkpoint-batch`),
against a real built bundle (`npm run build`, commit `5c391c10`) launched via
`npm run start:lan` (`NODE_ENV=production`, `LAN_HTTPS=1`), driven through a real
Chromium instance (Playwright MCP — the `claude-in-chrome` tool named in the issue
wasn't connected in this runtime, so Playwright's browser stood in as the
non-loopback network client instead). **`LAN_HTTPS_PORT=9443`** (non-default) per
the register's own note that a default-port run can't distinguish the fix from the
old hardcoded string.

Two operational notes before the results, because they affect how to read them:

- Port `:8443` (the LAN_HTTPS default) was already held by another lane's server
  when this step started — `start-app-prod.mjs`'s own health probe correctly
  detected that and skipped rather than double-launching, which is why this run
  used `9443` instead of the default (also required by the register's own
  non-default-port note, independent of the collision).
- A stale `tsx watch` dev server (pid 25912, started ~2h before this claim) was
  already bound to this worktree's own `PORT=8270` from an earlier, already-closed
  step in this same chain and blocked `start:lan`'s own alt-port health check. It
  answered no `/api/health` from another lane's worktree — it was this worktree's
  own leftover — so it was stopped before relaunching. No other lane's process was
  touched.

## Reclassification premise — confirmed

Playwright's own Chromium, navigating to `https://castwright.local` (mDNS-resolved
to this box's LAN IP `192.168.86.20`, mkcert-trusted, zero cert warnings across every
request below), is a genuine non-loopback client from the server's point of view:
`GET /api/devices/pair-session` from that origin without a token returned **401**
(not silently loopback-authorized), and the peer-IP-based checks below (the :443
forwarder's `127.0.0.2`) behaved exactly as the row predicted. The reclassification
holds for E3 and E8's `castwright.local` bullets. It does **not** apply to E2's
phone-pairing bullet (device cert-trust UX), which stays a genuine device gap — see
below.

## E2 · LAN HTTPS on by default (plan 250)

1. **Cert-provisioned boot line** — first `start:lan` invocation (before the port
   was fixed to 9443) printed:
   ```
   [setup-lan-certs] generating cert for hosts: localhost, 127.0.0.1, castwright.local, castwright.dev.local, 192.168.86.20
   Created a new certificate valid for the following names:
    - "localhost" - "127.0.0.1" - "castwright.local" - "castwright.dev.local" - "192.168.86.20"
   [cert] LAN certs provisioned via mkcert — serving HTTPS for phone/tablet access.
   ```
   The subsequent clean boot on `:9443` (same cert, cert generation is idempotent):
   ```
   [START] server pid=45012 -> logs/server.log (NODE_ENV=production, LAN_HTTPS=1)
   [OK] server on :9443 (LAN HTTPS)
   [READY] https://localhost:9443/  (stop with "npm run stop:prod")
   ```
   `logs/server.log`: `2026-09-06 20:58:08.821 [server] listening on https://localhost:9443`.

2. **No cert warning over LAN HTTPS** — `https://castwright.local:9443/` loaded the
   full app shell (title "Castwright", nav, library view) with no interstitial;
   only the expected 401s from an unpaired browser (`Missing or invalid LAN access
   token…`) appeared in console, not a certificate error.

3. **Degrade to loopback HTTP, no crash** — stopped the LAN server
   (`npm run stop:prod`), relaunched with `LAN_HTTPS=0` (`npm run start`, dev-mode
   launcher). Server log: `2026-09-06 21:13:31.474 [server] listening on
   http://localhost:8270` (plain HTTP, this worktree's own port, no TLS). Confirmed
   alive and serving: `GET http://localhost:8270/api/info` → `200`. No crash, no
   error in the launcher or server log. Stopped cleanly afterward
   (`npm run stop`).

4. **Phone pairing — staged, not attempted with the desktop browser.** From the
   host's Admin → LAN access panel (`https://localhost:9443/#/admin`, true
   loopback), "Authorize a device" with a name generated a pairing QR and a link:
   `https://castwright.local/#/pair?c=RRZ8XP91FQ2AYHH3`, with a 5-minute countdown
   and a "Regenerate code" control. This is exactly what a phone would scan/open.
   **Installing the mkcert root CA and completing pairing from a real phone's own
   OS trust store is the one criterion this run cannot supply** — it's a device
   cert-trust flow, not a routing question, so the desktop-browser stand-in doesn't
   reduce it (per the issue's own carve-out).

## E3 · Pair from `castwright.local` (plan 256)

1. **Authorize from `castwright.local` → no 403.** Opened the pairing link from
   (1) above in a second tab navigated to `https://castwright.local/#/pair?...`
   (port 443, via the server-owned forwarder, not loopback). Clicked Authorize:
   `POST https://castwright.local/api/pair/redeem-browser` → **201 Created**.

2. **Name-first pairing shows in the admin device list.** After redeeming, `GET
   /api/devices` (from the host, loopback) listed:
   ```json
   {"id":"a5d6c35f387dc6c0","label":"oe-2991-test-device-1","revoked":false,...}
   ```
   and the Admin UI's LAN access device list rendered the row with that exact
   label once a fresh page load re-mounted the panel. (One tool-side hiccup: a
   `browser_navigate` to the *same* admin URL in an existing tab sometimes left the
   device list showing a stale subset — confirmed via raw `fetch('/api/devices')`
   that the server's data was always correct and current; a brand-new tab against
   the same session always rendered the full, current list. Logged as a Playwright/
   client-router quirk in this evidence, not a product defect — the API and a fresh
   mount both agreed throughout.)

3. **Bare LAN IP still rejected.** `https://192.168.86.20:9443/#/admin` (bare IP,
   no cookie for that origin) — `POST /api/devices/pair-session` → **401**
   `"Missing or invalid LAN access token. Start pairing from https://localhost:9443
   or https://castwright.local on the computer running Castwright."` (the general
   token gate; a bare-IP caller never reaches the loopback/friendly-hostname-only
   403 branch because it fails the earlier, broader check first — same practical
   effect the row asks for: a bare LAN IP cannot pair or manage devices).

## E8 · Revoke is loopback-only (issue #2269, PR #2280/#2294, plan 225)

Paired 3 devices total for the ≥3-device check
(`oe-2991-test-device-{1,2,3}`, later also `oe-2991-forwarder-test` and
`oe-2991-castwright-local-view` for the port/hostname bullets below).

1. **`https://localhost:9443` (direct port) — revoke succeeds.** Clicked Revoke on
   `oe-2991-test-device-3`'s row: request succeeded, row dropped from the list on
   refresh. Confirmed via `GET /api/devices` — no longer present (later confirmed
   `revoked:true` in the full list).

2. **`https://localhost/` (port 443, forwarder) — button renders, 403 on press,
   correct port named.** Paired a fresh device from `https://localhost:9443` itself
   (`oe-2991-forwarder-test`) so this browser held a real `localhost`-scoped
   cookie (cookies aren't port-scoped), then loaded `https://localhost/#/admin`
   (through the :443 forwarder, peer IP `127.0.0.2`, not true loopback). The
   Revoke button rendered for every row (client-side `isLoopbackHost('localhost')`
   is a hostname-string check, blind to the forwarder). Pressing it:
   `DELETE https://localhost/api/devices/e17260abd2f17fa8` → **403 Forbidden**, UI
   message: *"Revoking only works from **https://localhost:9443** on the computer
   running Castwright — castwright.local and the :443 shortcut can't be used for
   this."* — the port named is `9443`, the port this run actually bound (not a
   stale hardcoded `8443`). Re-checked the device afterward: still present,
   `revoked:false` — the failed revoke did not silently succeed.

3. **`https://castwright.local`, ≥3 devices — no Revoke control anywhere, one
   explanation below the list.** With 4 live devices, loaded
   `https://castwright.local/#/admin` from a browser holding a valid
   castwright.local-scoped device cookie. `browser_find` for "Revoke" → no matches
   across the whole page. The hint text *"Revoking only works from
   https://localhost:9443 on the computer running Castwright — castwright.local
   and the :443 shortcut can't be used for this."* appeared **exactly once**,
   below the full 4-row list — not once per row (the exact regression the row
   calls out from review round 2).

4. **Security half — a paired device cannot delete the host's own record.**
   Created the host's own self-bound device record via "Authorize this browser"
   (`label: "This computer"`, id `804b1aad4e17276f`). From a *different*, already-
   paired device's own session (`oe-2991-castwright-local-view`, on
   `castwright.local`, a real LAN credential, able to read the id via its own `GET
   /api/devices`), called `DELETE /api/devices/804b1aad4e17276f` directly →
   **403 Forbidden**, `{"error":"Devices can only be revoked from the host UI."}`.
   Re-checked via the host UI/API afterward: `"This computer"` still present,
   `revoked:false` — the pre-#2269 lockout this row exists to prevent did not
   reproduce.

## Reclassification outcome

Holds for all `castwright.local` bullets tested above (E3 all three, E8 bullet 3):
none of them silently routed as loopback. The only bullet that did **not**
reduce — by design, not by test failure — is E2's real-phone mkcert-install +
pairing step, which is a device-side OS trust flow and is staged (QR + link
rendering correctly) rather than completed here.

## Cleanup

Test devices left in server state are throwaway (`oe-2991-*`, `This computer`)
and scoped to this worktree's own `castwright-workspace`; no server process was
left running (`npm run stop` / `npm run stop:prod` both confirmed clean, ports
8270/9443/443/9190 all free afterward). No `server/**` source was touched, no
register edit was made (out of scope — step 8 does that), no PR opened.
