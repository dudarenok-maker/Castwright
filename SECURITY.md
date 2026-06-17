# Security Policy

Castwright is a **local-first, single-user** application: by default the
analyzer and the voice engine run on your own machine and nothing leaves it.
The remote attack surface is therefore small and almost entirely **opt-in** —
it appears only when you deliberately expose the app to your home network
(`npm run start:lan`) or pair the Android companion. The
[2026-05-31 security review](docs/security/2026-05-31-security-review.md)
documents that surface and the hardening backlog.

## Supported versions

Security fixes land on `main` and ship in the next tagged release. Only the
**latest published release** is supported — please reproduce on the newest
version before reporting.

| Version                 | Supported                                                      |
| ----------------------- | -------------------------------------------------------------- |
| Latest release (`main`) | ✅                                                             |
| Older releases          | ❌ — upgrade first (in-app: **Account → Application updates**) |

## Reporting a vulnerability

**Please report privately — do not open a public issue for a security bug.**

1. **Preferred:** use GitHub's private vulnerability reporting — the
   **"Report a vulnerability"** button under this repository's **Security** tab
   (Security → Advisories). This keeps the report confidential and threads the
   fix through a private advisory.
2. **Alternative:** email **hello@castwright.ai** with `SECURITY` in the
   subject. PGP available on request.

Please include: affected version, environment (OS, GPU, local vs. LAN/companion
exposure), reproduction steps, and impact. A proof of concept helps but isn't
required.

### What to expect

- **Acknowledgement** within 5 business days.
- An initial assessment (severity + whether it's in scope) within 10 business
  days.
- We'll keep you updated through the fix and credit you in the advisory unless
  you'd prefer to remain anonymous.

This is a solo-maintained project — timelines are best-effort, not contractual.
There is **no paid bug-bounty program**.

## Scope

In scope — issues that let an attacker who is **not** the local user do
something they shouldn't:

- Authentication / cert-pinning bypass on the LAN exposure surface
  (`start:lan`) or the companion pairing flow.
- Remote code execution, path traversal, or arbitrary file read/write reachable
  over the network.
- Code-execution from loading an **untrusted** shared voice artifact
  (see `side-13` in [docs/BACKLOG.md](docs/BACKLOG.md)).
- Secret leakage (API keys, tokens) from the running server.

Out of scope (by design, not vulnerabilities):

- The **opt-in** cloud analyzer (Gemini) sending your manuscript text to Google
  — that is the documented trade-off of choosing a cloud analyzer; the local
  Ollama analyzer keeps everything on-device.
- Anything requiring local access to a single-user machine the attacker already
  controls (the app trusts the local user by design).
- Model output quality / mispronunciation (use the in-app issue forms).
- Denial of service against your own local instance.

Thank you for helping keep Castwright users safe.
