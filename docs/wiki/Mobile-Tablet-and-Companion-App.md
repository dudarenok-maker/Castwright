# Mobile, Tablet & Companion App

Castwright is usable from a phone or tablet in three ways: over your LAN in a
mobile browser (with a one-time root-certificate trust step), through the
native **Castwright Companion** Android app, or — if you just want to check
progress — by resizing any browser to a phone width, since every view is
built responsive-first.

## LAN access

The desktop app doesn't listen on plain HTTP for other devices — it needs
**LAN HTTPS mode** (`npm run dev:lan` or `npm run start:lan`) plus a locally
trusted certificate, so a phone's browser doesn't show a security warning.
**Admin → LAN access** is where you authorize a browser device once that
mode is running — see the LAN access card on the [Admin](Admin) page.

**The friendly `castwright.local` / `castwright.dev.local` hostnames still
need pairing.** These addresses (and any raw LAN IP) always go through the
same LAN entry point as a phone would — even when you type them into a
browser on the desktop machine itself — so the app loads but the library
fails with `401: Missing or invalid LAN access token` until that browser is
paired via the steps below. `https://localhost:8443` is the one address
exempt from this: it's recognised as loopback and skips pairing entirely, so
it's the quickest way to check the app locally without pairing anything.

![Admin page — LAN access card with Authorize a device and the resulting pairing QR](images/mobile-tablet-and-companion-app/lan-access-qr.png)

Click **Authorize a device** (a device name is optional — it defaults to "Device") and a pairing QR appears right below the card, ready for a phone's camera.

The one-time root-certificate step is
`npm run install:cert-mobile` — it generates a per-LAN-IP certificate, prints
the LAN URLs for both the Vite dev server and the production bundle, and
prints an ASCII QR **in the terminal** (not the browser) linking to
`https://<lan-ip>:8443/cert/root.crt`, followed by per-OS trust steps for
iOS, Android, macOS, Windows, and Linux. See the full walkthrough in
[Installing Castwright](Installing-Castwright).

## Phone layout

Every view targets three breakpoints — `<640px` (phone: single-column,
bottom sheets, full-screen modals), `640–1024px` (tablet: two-column,
dialog-style modals), and `≥1024px` (desktop: three-pane, full top bar) —
with every desktop drag/hover affordance shipping a tap equivalent. Below is
the Books view at a phone viewport: the top bar collapses to a hamburger
menu, the four stat tiles wrap to two columns, and the card grid drops to
one column.

![Phone viewport — Books view](images/mobile-tablet-and-companion-app/02-phone-viewport.png)

> **Known issue found in an earlier capture at this viewport:** `document.documentElement.scrollWidth` measured wider than `clientWidth` — a genuine horizontal-overflow bug, not a capture artifact. The cause was the workspace-path row under the page header (`WorkspacePathRow` in `src/components/library/library-chrome.tsx`): its path `<span>` carries a fixed `max-w-[520px]` with no responsive breakpoint, so on a narrow phone the row alone can exceed the viewport width and drag the whole page into horizontal scroll — a violation of this project's own "no horizontal overflow at 375×667" mobile testing invariant. Worth re-checking against a current build; flagged as a real bug rather than fixed in this docs pass.

## Android companion app

The **Castwright Companion** app is a real, code-complete Flutter app
(`apps/android/`) — offline downloads, a finished-shelf, and cross-device
sync, paired to your desktop over the same LAN HTTPS session via a QR-based
deep link. Its store listings aren't live yet, so today's distribution is a
direct APK download plus in-browser pairing, both surfaced from the Listen
view's Companion banner — see [Exporting](Exporting) for that banner.

Once paired, the companion app mirrors your library for offline listening,
tracks finished books in its own shelf, and keeps that shelf and your
listening position in sync across every paired device.

![Pair a device modal — QR code, expiry countdown, and the manual-code fallback](images/mobile-tablet-and-companion-app/pair-a-device-modal.png)

The Listen view's Companion banner opens the same pairing flow: **Pair a device → Scan QR** in the app, pointed at this code — it expires after a few minutes, with **Regenerate code** and a manual-entry fallback if scanning isn't an option.

Next: [Admin](Admin).
