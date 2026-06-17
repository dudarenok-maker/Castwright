# Licensing & repo-opening compliance

Maintainer-facing record of Castwright's licensing model, the bundled-model
audit, and the checklist that must clear before the GitHub repository is made
public. Companion to the local-only planning brief
`brand/monetisation-free-vs-gated-2026-06-08.md` (kept out of the public repo),
§5 and §7.

## The model

- **Code** — Functional Source License v1.1 with an Apache-2.0 future grant
  (**FSL-1.1-ALv2**, a.k.a. FSL-1.1-Apache-2.0). Source-available, _not_ OSI
  open source: any use is permitted except a Competing Use, and each release's
  code converts to plain Apache-2.0 two years after it is made available. File:
  [`/LICENSE`](../../LICENSE).
- **Brand** — the Castwright name and brand assets are all rights reserved and
  kept out of this repository (see
  [`brand-and-trademarks.md`](brand-and-trademarks.md)). A code licence is not a
  licence to the identity.
- **Engine weights** — bundled only if the upstream licence permits commercial
  redistribution; non-commercial weights are download-on-demand from their
  official home and never bundled ([`/NOTICE`](../../NOTICE)).
- **Paid gate (future)** — an Ed25519-signed offline licence key for the "Cast
  Pass", no phone-home (monetisation §7.2). Not built; needs an `fs-` plan.

## Engine-licence audit

Verified 8 June 2026 from the Hugging Face model cards. **Re-verify at the
pinned release version before every public release** — a model card licence can
change between snapshots.

| Engine                 | Model(s)                                               | Upstream licence          | Bundled?                                          | Verified          |
| ---------------------- | ------------------------------------------------------ | ------------------------- | ------------------------------------------------- | ----------------- |
| Kokoro v1              | hexgrad/Kokoro-82M (ONNX via thewh1teagle/kokoro-onnx) | Apache-2.0                | **Yes** — weights ship / install with the app     | 8 Jun 2026        |
| Qwen3-TTS Base         | Qwen/Qwen3-TTS-12Hz-0.6B-Base                          | Apache-2.0                | No — download-on-demand                           | 8 Jun 2026        |
| Qwen3-TTS VoiceDesign  | Qwen/Qwen3-TTS-12Hz-1.7B-VoiceDesign                   | Apache-2.0                | No — download-on-demand                           | 8 Jun 2026        |
| Coqui XTTS v2          | coqui/XTTS-v2                                          | **CPML — non-commercial** | No — download-on-demand, licence shown at install | 8 Jun 2026        |
| Whisper (QA, optional) | faster-whisper models                                  | MIT                       | No — download-on-demand                           | known; re-confirm |

Rule of thumb: the installer may fetch weights from their official home; the
release archive bundles nothing whose licence is unverified.

## Repo-opening checklist

**Done in the docs/licensing pass:**

- [x] `LICENSE` (FSL-1.1-ALv2)
- [x] `docs/legal/brand-and-trademarks.md` (brand + trademark carve-out; assets kept out of the repo)
- [x] `NOTICE` (bundled-model attributions + audit summary)
- [x] README license statement (source-available, brand carve-out, model notice)
- [x] CONTRIBUTING contribution-licensing terms (DCO / CLA / PRs-by-invitation)

**Cleared for the public flip (2026-06-17):**

- [x] **Companion website (`castwright.ai`) live** — went live on Cloudflare
      Pages 2026-06-17 (www served, apex 301-forward, canonical → www). The
      stated gate for going public is met.
- [x] **Git history scrub — audited clean, no rewrite needed.** Verified
      2026-06-17 before the flip:
  - Secret scan clean — `git log --all --full-history -- '**/.env' 'server/.env'`
    returns nothing (no `.env` ever committed); a pattern sweep for
    `AIza…` / `ghp_…` / `sk-…` / `BEGIN … PRIVATE KEY` across all of history
    found nothing; the only `token:` literal in the tree is the mock
    `mock-lan-token-…` in `src/lib/api.ts`. The runtime `user-settings.json`
    (where a real Gemini key would live) is git-ignored, not tracked.
  - Copyrighted-fixture check clean — `… --oneline -- '**/*Marlow*'` returns
    nothing; the canonical fixture is the Castwright-owned original
    _The Coalfall Commission_. No `git filter-repo`/BFG rewrite was required.
- [x] **Branch protection on `main`** — a server-side ruleset
      (`id 17654264`, `enforcement: active`) blocks force-push + deletion, and a
      second ruleset protects release tags. We **deliberately do not** add
      required-status-check or required-review/required-PR rules: CI is opt-in
      (plan 215) so a required `verify` would deadlock PRs that never run it, and
      direct-to-`main` trivial fixes + tag-based releases must keep working —
      and on a solo project a required review with no second reviewer blocks all
      merges. `pr-title-lint.yml` (runs on every PR) plus the local
      `guard-protected-push.mjs` hook are the soft layer. See
      `CONTRIBUTING.md` → "Server-side enforcement (branch protection)".
- [x] **`gh repo edit --visibility public`** — flipped 2026-06-17; repo name
      confirmed `dudarenok-maker/Castwright`.

**Follow-ups (do not block the flip):**

- [~] **CLA collection** wired in-repo via the **`contributor-assistant/github-action`**
  workflow (`.github/workflows/cla.yml`), with the agreement text at
  [`CLA.md`](CLA.md) and signatures stored in `signatures/version1/cla.json`
  on a `cla-signatures` branch. **One step left:** add a repo secret
  **`CLA_SIGNATURES_TOKEN`** (a PAT with `repo` scope) so the action can
  commit signatures — until then the check posts the sign prompt but can't
  persist the signature. Lower urgency while PRs are by-invitation (README).
- [ ] **Licence-key seam (Cast Pass)** — needs an `fs-` plan (server settings +
      companion pairing + series matcher). Not a blocker for a free-tier-only
      public release.

## Trade mark

Register "Castwright" as a trade mark (AU via IP Australia first, ~AU$250/class
self-filed; US later) — tracked as **ops-12**. Strengthens the brand & trademark
carve-out against a confusing fork. Not executed here.

## Sources

- FSL template: <https://github.com/getsentry/fsl.software> (`FSL-1.1-ALv2.template.md`).
- Engine licences: the Hugging Face model cards linked in the audit table,
  verified 8 June 2026.
- Decisions & rationale: the local-only planning brief
  `brand/monetisation-free-vs-gated-2026-06-08.md` (kept out of the public repo),
  §5 (action items) and §7 (distribution & licensing).
