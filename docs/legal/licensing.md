# Licensing & repo-opening compliance

Maintainer-facing record of Castwright's licensing model, the bundled-model
audit, and the checklist that must clear before the GitHub repository is made
public. Companion to the local-only planning brief
`brand/monetisation-free-vs-gated-2026-06-08.md` (kept out of the public repo),
§5 and §7.

## The model

- **Code** — Functional Source License v1.1 with an Apache-2.0 future grant
  (**FSL-1.1-ALv2**, a.k.a. FSL-1.1-Apache-2.0). Source-available, *not* OSI
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

| Engine | Model(s) | Upstream licence | Bundled? | Verified |
|---|---|---|---|---|
| Kokoro v1 | hexgrad/Kokoro-82M (ONNX via thewh1teagle/kokoro-onnx) | Apache-2.0 | **Yes** — weights ship / install with the app | 8 Jun 2026 |
| Qwen3-TTS Base | Qwen/Qwen3-TTS-12Hz-0.6B-Base | Apache-2.0 | No — download-on-demand | 8 Jun 2026 |
| Qwen3-TTS VoiceDesign | Qwen/Qwen3-TTS-12Hz-1.7B-VoiceDesign | Apache-2.0 | No — download-on-demand | 8 Jun 2026 |
| Coqui XTTS v2 | coqui/XTTS-v2 | **CPML — non-commercial** | No — download-on-demand, licence shown at install | 8 Jun 2026 |
| Whisper (QA, optional) | faster-whisper models | MIT | No — download-on-demand | known; re-confirm |

Rule of thumb: the installer may fetch weights from their official home; the
release archive bundles nothing whose licence is unverified.

## Repo-opening checklist

**Done in the docs/licensing pass:**

- [x] `LICENSE` (FSL-1.1-ALv2)
- [x] `docs/legal/brand-and-trademarks.md` (brand + trademark carve-out; assets kept out of the repo)
- [x] `NOTICE` (bundled-model attributions + audit summary)
- [x] README license statement (source-available, brand carve-out, model notice)
- [x] CONTRIBUTING contribution-licensing terms (DCO / CLA / PRs-by-invitation)

**Pending before flipping the repo public:**

- [ ] **Companion website (`castwright.ai`) live** — the stated gate for going
      public; the public-flip and any "Cast Pass" messaging wait for it.
- [ ] **Git history scrub — DESTRUCTIVE, force-push.** Audit history for
      committed secrets and copyrighted fixtures, then rewrite if found:
  - Audit: `git log --all --full-history -- '**/.env' 'server/.env'` and a
    secret scan (e.g. `gitleaks detect`, `trufflehog`). Also check the canonical
    copyrighted manuscript fixture never entered history:
    `git log --all --full-history --oneline -- '**/*Marlow*'`.
  - If anything is found: back up the repo, rewrite with
    `git filter-repo --invert-paths --path <file>` (or BFG), force-push, and
    have every clone re-clone. Do **not** run casually.
- [ ] **cla-assistant bot** wired (GitHub App) so external PRs collect the CLA.
- [ ] **Branch protection on `main`** (available once the repo is public / Pro):
      require the PR-title check and a review. Also update the now-stale
      `CONTRIBUTING.md` heading "Server-side enforcement (private repo on Free
      plan)".
- [ ] **`gh repo edit --visibility public`** and confirm the repo name is
      `Castwright`.
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
