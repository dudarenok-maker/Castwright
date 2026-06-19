---
title: LAN cert-trust bootstrap (two-pass browser authorize)
date: 2026-06-19
status: REJECTED — adversarial security review found a CRITICAL device-wide MITM. NOT implemented.
area: server + frontend
follows: srv-42 / docs/features/225-lan-browser-device-auth.md
---

# LAN cert-trust bootstrap — two-pass browser authorize

> **REJECTED (2026-06-19).** The adversarial security pass verdict: serving a
> private root CA over plaintext HTTP and guiding the user to install it into the
> **device-wide OS trust store** is a CRITICAL, one-tap path to total HTTPS MITM
> of all the user's traffic (an active LAN attacker substitutes their CA). The
> companion analogy is false — the companion *pins* a CA in its own app sandbox
> (one app's blast radius) and never touches the OS store; this asks for
> system-wide signing authority fetched over an unauthenticated channel.
> Fingerprint comparison is security theater for a browser (the page is served
> over the same MITM-able channel; a browser can't pin-and-verify; users won't
> hand-compare). The architecture pass independently flagged: the pairing code
> would leak onto HTTP, the trust-link would trust the attacker-controllable
> `Host` header, and a busy `:8080` would fatally kill the working HTTPS server.
> **There is no secure + smooth way to bootstrap a private CA into a phone
> browser's OS trust store.** Pursue instead: (1) keep the one-time manual
> install (discoverable via the shipped Admin cert-help note) + the companion app
> for untrusted networks; or (2) a publicly-trusted cert via a real hostname
> (zero device install — the only true "no warning" fix). The design below is
> retained as the record of what was rejected and why.

## Problem

A phone **browser** hitting `https://<lan-ip>:8443` shows
`NET::ERR_CERT_AUTHORITY_INVALID` — it doesn't trust the dev box's mkcert root
CA. The user must install that CA once. Today that's an undocumented separate
chore (`npm run install:cert-mobile`), disconnected from the Admin "Authorize a
device" flow. The user wants the cert step **linked to authorize** (a two-pass
flow is acceptable): authorizing a device should also get the device to trust
the cert, so the browser stops showing "not secure".

The **companion app** doesn't have this problem — it fetches `/cert/root.crt`
over the untrusted channel and **pins it against a fingerprint embedded in the
QR** (out-of-band integrity). A browser has no such mechanism.

## Proposed flow

Today the LAN server is **HTTPS-only on :8443** (no HTTP listener). The cert
itself can only be downloaded over that untrusted HTTPS channel, which re-shows
the warning. So we add a **warning-free HTTP channel** for the cert bootstrap.

**Pass 1 — Trust (HTTP, warning-free):** Admin "Authorize a device" shows a QR →
`http://<host>:<TRUST_PORT>/trust`. The phone scans it (HTTP, no cert warning) →
a static bootstrap page with a **"Download & install certificate"** link
(`/cert/root.crt`, served over the same HTTP listener) + per-OS install steps +
a **"Continue to pair →"** button.

**Pass 2 — Pair (HTTPS, now trusted):** "Continue to pair" → the existing
`https://<host>:8443/#/pair?c=<code>` → now loads with a clean lock → tap
**Authorize** → cookie set.

### Server

- **New HTTP listener** (`server/src/lan-trust-server.ts`), started in `index.ts`
  ONLY when `LAN_HTTPS=1`, bound to the same host, on `LAN_HTTP_TRUST_PORT`
  (default 8080 — free in LAN mode since the app listens on :8443). Serves
  **exactly two** exact-match routes and 404s everything else:
  - `GET /cert/root.crt` — the public root CA from `resolveRootCaPath()` (fixed
    path, never user-derived), `Content-Type: application/x-x509-ca-cert`,
    `Content-Disposition: attachment`.
  - `GET /trust` — a static HTML bootstrap page (cert link + install steps +
    "Continue to pair" linking to the HTTPS pair URL).
  - No API, no body parsing, no file-path-from-request, no auth surface.
- `POST /api/devices/pair-session` adds `trustUrl =
  http://<host>:<TRUST_PORT>/trust` to its response (alongside the existing
  `url`).

### Frontend

- The Admin "LAN access" card's "Authorize a device" QR uses `trustUrl`. The
  card explains the two passes (install cert → continue to pair).

## Security considerations (the reason for the adversarial pass)

These are pre-identified; the review should pressure-test and extend them.

1. **CA delivered over an unauthenticated channel = MITM of the trust anchor.**
   An active LAN attacker can intercept `http://…/cert/root.crt` and serve
   **their own** root CA. If the user installs it, the attacker can MITM all the
   user's HTTPS traffic — far worse than the original warning. The companion app
   avoids this by pinning the fetched CA against a **QR-embedded fingerprint**
   (out-of-band). A browser flow has no built-in equivalent; the trust page is
   itself served over the same MITM-able HTTP, so a displayed fingerprint could
   also be forged. **Candidate dispositions:** (a) accept for the home-LAN threat
   model + document loudly (the user trusts their home network; an active MITM on
   your own LAN is already a severe compromise) and keep the companion app as the
   secure path for untrusted networks; (b) show the CA fingerprint on the desktop
   Admin (loopback = trusted) AND on the phone, asking the user to compare — but
   users rarely verify fingerprints; (c) don't ship the HTTP CA channel at all.
2. **Pairing code on the wire.** If the pairing `code` travels in the HTTP trust
   URL/page, a **passive** LAN sniffer reads it (the QR kept it visual-only). A
   sniffer could then race the single-use redeem and obtain a device cookie.
   **Disposition:** keep the `code` OUT of the HTTP channel — the trust QR/page
   carries **no code**; the code is delivered only in the HTTPS pair step
   (Pass 2). This may mean two QRs (trust QR without code; pair QR with code over
   trusted HTTPS) rather than one — confirm the UX.
3. **New bound listener = added attack surface.** It must serve only the two
   static routes (no path traversal, no API, no body parsing), bound only in LAN
   mode, and be covered by the same `assertNoTrustProxy` / loopback-spoofing
   reasoning where relevant.
4. **`Content-Type: application/x-x509-ca-cert` auto-install is dead on modern
   Android** (removed since Android 7) — the user still installs via Settings.
   Don't design around an auto-install that won't fire.
5. **Interaction with the shipped CSRF/guard model** — the trust server is a
   SEPARATE http.Server, not the guarded Express app, so it must not expose any
   `/api` surface or share the cookie. Confirm isolation.

## Open questions for the review

- Is the HTTP CA channel an acceptable convenience given finding #1, or does the
  MITM downgrade make it not worth shipping vs. keeping the (documented) manual
  install + the companion app for untrusted networks?
- One QR (trust, then continue) vs. two QRs (trust without code, then pair with
  code over HTTPS) — which best balances UX and finding #2?
- Should the trust page's "Continue to pair" even carry the host, or derive it,
  to avoid leaking anything extra over HTTP?

## Out of scope

- A publicly-trusted certificate via a real hostname (zero device setup) — the
  only true "no warning, no install" path, but needs domain + cert infra and is
  a separate, larger design.
- Auto-installing the CA (impossible from a web page — OS security boundary).
