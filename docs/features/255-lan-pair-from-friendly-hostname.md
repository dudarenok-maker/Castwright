---
status: active
owner: null
---

# Pair from `castwright.local` + name the device on Listen-tab pairing

> Status: active — code landed on `feat/server-frontend-pair-from-friendly-hostname`; on-box acceptance owed (pair a real phone from `https://castwright.local/#/admin`).
> Key files: `server/src/lan-auth.ts` (`FRIENDLY_HOSTNAME`, `isFriendlyHostnameRequest`, `mayStartPairingSession`), `server/src/routes/devices.ts` + `server/src/routes/pairing.ts` (gate swap + label plumbing), `src/modals/pair-device.tsx` (name-first + 403 guidance), `src/components/lan-access-card.tsx` (403 guidance), `src/lib/api.ts` (`createPairSession(label?)`).
> Issue: #1621. Related: [250 — LAN HTTPS on by default](250-lan-https-default.md) (made `castwright.local` the natural URL), [225 — LAN browser device auth](225-lan-browser-device-auth.md) (the loopback gate this relaxes).

## Benefit / Rationale

- **User (Benefit — user):** the whole app — including *starting* a pairing session — now works from the shipped friendly hostname `https://castwright.local`, so people never have to fall back to `https://localhost:8443` to add a phone. And a device paired from the Listen tab shows the name the user chose in the admin LAN-access list, instead of "Device".
- **Technical:** one small gate helper (`mayStartPairingSession`) shared by both pairing-session routes; label flows through the existing session object with no schema change.
- **Security:** deliberately narrow relaxation — see below.

## Problem

`POST /api/devices/pair-session` and `POST /api/pair/session` were **loopback-only**. `castwright.local` resolves to the machine's LAN IP and reaches the server through the `:443` port-forwarder as source `127.0.0.2` (never loopback), so both endpoints 403 — the user sees "pair-session failed (403)" / "Couldn't load pairing details" even though the device *list* (not loopback-gated) loads fine. Separately, the Listen-tab companion flow minted its session with no label, so `/redeem` named the device from the phone (or "Device"), leaving the admin list unrecognisable.

## What changed

1. **`mayStartPairingSession(req)` gate** (`lan-auth.ts`): `isLoopbackRequest(req) || (isLanTokenEnforced() && isFriendlyHostnameRequest(req))`, where `isFriendlyHostnameRequest` matches the `Host` header host-part against `FRIENDLY_HOSTNAME = 'castwright.local'` (port-tolerant, case-insensitive). Both pairing-session routes now gate on this instead of `isLoopbackRequest`. Admin token-mint (`POST /api/devices`) stays loopback-only, untouched.
2. **Device naming on the Listen-tab flow**: `PairDeviceModal` opens on a **name-first** step — the user names the device, then generates the code. `api.createPairSession(label?)` sends `{ label }`; `POST /api/pair/session` stores it on the session; `POST /api/pair/redeem` uses `result.label ?? body.label ?? 'Device'`, so the desktop-chosen name wins and shows in the admin list. Backward-compatible: no desktop label → the phone's own label → "Device".
3. **Actionable 403 guidance**: `LanAccessCard` and `PairDeviceModal` turn a genuine 403 (reached via a bare LAN IP, or the friendly name isn't served) into "Start pairing from `https://localhost:8443` or `https://castwright.local` on the computer running Castwright" instead of a raw code.

## Security posture

Both pairing-session routes sit **behind `requireLanToken`** (`app.ts`), so the only non-loopback caller that can reach them is an **already-paired device** (its `req.ip` is the forwarder's `127.0.0.2`, never loopback, so it could not have bypassed the token check). The relaxation therefore grants exactly: *an already-authorized device reaching the server via `castwright.local` may start a pairing session.* Unpaired LAN devices are still rejected by the token guard; bare-LAN-IP access stays loopback-only; direct durable-token mint stays loopback-only.

- **Cost accepted:** previously only the physical host (loopback) could *initiate* pairing; now any already-authorized device via the pretty name can — i.e. a stolen device cookie could mint further device tokens until revoked. Acceptable for a single-user home-LAN tool; documented rather than silent.
- **Host header is spoofable**, but moot: a spoofer must already hold a valid token to pass `requireLanToken`, at which point they are already an authorized device and the `Host` check gains them nothing.

## Tests

- `server/src/lan-auth.pairing.test.ts` — `isFriendlyHostnameRequest` (bare / ported / cased / IP / missing) and `mayStartPairingSession` (loopback-any-host; friendly+enforced; bare-IP rejected; friendly-but-not-enforced rejected).
- `server/src/routes/pairing.test.ts` — mock gains `mayStartPairingSession`; 403 retargeted; new label-precedence cases (session label wins; phone label fallback).
- `server/src/routes/devices.test.ts` — unchanged (its real `mayStartPairingSession` takes the loopback branch under supertest).
- `src/modals/pair-device.test.tsx` — name-first open, label passed to `createPairSession`, 403→restricted, plus the existing QR/unavailable/error/countdown flows driven through the new generate step.
- `src/components/lan-access-card.test.tsx` — 403 shows guidance, no QR.
- `src/components/listen/companion-app-banner.test.tsx` — opens modal → generates → QR.

## Ship notes

_(Fill on merge: shipped date + SHA.)_

## Manual acceptance (owed, on-box)

1. Open `https://castwright.local/#/admin` on the host. Click **Authorize a device** → QR renders (no 403).
2. Listen tab → **Pair a device** → type a name → **Generate pairing code** → scan from the companion app → the admin list shows the chosen name.
3. Open `https://<bare-LAN-IP>:8443` on the host → pairing shows the "start from localhost/castwright.local" guidance (still loopback-only).
