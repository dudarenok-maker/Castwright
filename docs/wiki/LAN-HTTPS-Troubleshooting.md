<!-- docs/wiki/LAN-HTTPS-Troubleshooting.md -->
# LAN HTTPS Troubleshooting

Castwright serves your library over HTTPS on your local network so phones and
tablets can pair and listen. That needs a local certificate, created once at
install. If a phone shows "Not secure", or pairing is unavailable, the
certificate is missing, expired, or doesn't cover your current network.

## Fix it from the app

Open **Set up Castwright → LAN access** (or **Admin → LAN access**) and click
**Regenerate certificate**. If the app booted without HTTPS, restart it once
afterwards to bind HTTPS. The first-run wizard's **LAN access** step now
detects a missing or expired certificate on its own and surfaces the same
one-click regenerate, so you usually won't have to go looking for it.

## Fix it from a terminal

Run `npm run install:cert-mobile` on the computer running Castwright. It prints
a QR code and per-OS steps to install the local root certificate on your phone.

## Install the root certificate on a device (one-time)

Download it from `https://<computer-ip>:8443/cert/root.crt`, then:

- **Android:** Settings → Security → Install a certificate → CA certificate.
- **iOS:** install the profile, then General → About → Certificate Trust
  Settings → enable it.

The companion app trusts the certificate automatically (pinning) — only phone
browsers need this step.

## Still stuck?

Make sure `mkcert` is installed (bundled with the Pinokio install; otherwise
`brew install mkcert` / `choco install mkcert` / `apt install mkcert`), then
regenerate again.
