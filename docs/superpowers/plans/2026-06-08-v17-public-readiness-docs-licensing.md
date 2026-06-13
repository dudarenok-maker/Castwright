# v1.7.0 Public-Readiness: Docs + Licensing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the developer-oriented README into an app/user-facing document, tidy INSTALL for a first-time public reader, and create every licensing artifact for the first public GitHub release of Castwright — without flipping the repo public yet.

**Architecture:** Pure docs/licensing change in the `docs` scope. Four new files (`LICENSE`, `brand/LICENSE`, `NOTICE`, `docs/licensing.md`) carry exact, verified content; three existing files (`README.md`, `INSTALL.md`, `CONTRIBUTING.md`) are edited surgically. No code, no tests, no version bump.

**Tech Stack:** Markdown + plain-text licence files. Verification via `grep`/manual link check. Worktree at `C:\Claude\Projects\wt-docs-v17`, branch `docs/docs-v17-public-readiness`, worktree-scoped husky hooks already configured.

**Spec:** `docs/superpowers/specs/2026-06-08-v17-public-readiness-docs-licensing-design.md`

**Working rules for the executor:**
- All paths below are relative to the worktree root `C:\Claude\Projects\wt-docs-v17`.
- Commit subjects MUST be `docs(docs): <subject>` (the worktree-scoped commit-msg hook enforces it). `docs` scope skips the test legs in pre-commit.
- Stage files **explicitly by path** in each commit — never `git add -A` (the untracked `.husky-wt/` dir must not be committed).
- Licence files are reproduced **verbatim** where this plan marks them verbatim. Do not reword legal text.
- Release-framing rule: v1.7.0 is the **first public release**. No comparative/changelog framing, no per-version upgrade history, no inline `(vX.Y.Z)` feature tags. Use `vX.Y.Z` placeholders for artifact names.

---

## File Structure

| File | Responsibility |
|---|---|
| `LICENSE` *(new)* | The code licence — FSL-1.1-ALv2 verbatim, filled placeholders |
| `brand/LICENSE` *(new)* | Brand-asset carve-out — all rights reserved + fair use |
| `NOTICE` *(new)* | Third-party / bundled-model attributions + engine-audit summary |
| `docs/licensing.md` *(new)* | Maintainer-facing licence model, engine audit, repo-opening checklist |
| `README.md` *(rewrite)* | App/user-facing project front page incl. License section |
| `INSTALL.md` *(edit)* | Add Configuration; remove migration history; forward-looking Updating |
| `CONTRIBUTING.md` *(edit)* | Add "Contributing & licensing" section |

---

## Task 1: `LICENSE` (FSL-1.1-ALv2, verbatim)

**Files:**
- Create: `LICENSE`

- [ ] **Step 1: Create the file with this exact content**

(Verbatim FSL-1.1-ALv2 template with `${year}`→`2026`, `${licensor name}`→`Mikhail Dudarenok`. Do not alter wording.)

```
# Functional Source License, Version 1.1, ALv2 Future License

## Abbreviation

FSL-1.1-ALv2

## Notice

Copyright 2026 Mikhail Dudarenok

## Terms and Conditions

### Licensor ("We")

The party offering the Software under these Terms and Conditions.

### The Software

The "Software" is each version of the software that we make available under
these Terms and Conditions, as indicated by our inclusion of these Terms and
Conditions with the Software.

### License Grant

Subject to your compliance with this License Grant and the Patents,
Redistribution and Trademark clauses below, we hereby grant you the right to
use, copy, modify, create derivative works, publicly perform, publicly display
and redistribute the Software for any Permitted Purpose identified below.

### Permitted Purpose

A Permitted Purpose is any purpose other than a Competing Use. A Competing Use
means making the Software available to others in a commercial product or
service that:

1. substitutes for the Software;

2. substitutes for any other product or service we offer using the Software
   that exists as of the date we make the Software available; or

3. offers the same or substantially similar functionality as the Software.

Permitted Purposes specifically include using the Software:

1. for your internal use and access;

2. for non-commercial education;

3. for non-commercial research; and

4. in connection with professional services that you provide to a licensee
   using the Software in accordance with these Terms and Conditions.

### Patents

To the extent your use for a Permitted Purpose would necessarily infringe our
patents, the license grant above includes a license under our patents. If you
make a claim against any party that the Software infringes or contributes to
the infringement of any patent, then your patent license to the Software ends
immediately.

### Redistribution

The Terms and Conditions apply to all copies, modifications and derivatives of
the Software.

If you redistribute any copies, modifications or derivatives of the Software,
you must include a copy of or a link to these Terms and Conditions and not
remove any copyright notices provided in or with the Software.

### Disclaimer

THE SOFTWARE IS PROVIDED "AS IS" AND WITHOUT WARRANTIES OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING WITHOUT LIMITATION WARRANTIES OF FITNESS FOR A PARTICULAR
PURPOSE, MERCHANTABILITY, TITLE OR NON-INFRINGEMENT.

IN NO EVENT WILL WE HAVE ANY LIABILITY TO YOU ARISING OUT OF OR RELATED TO THE
SOFTWARE, INCLUDING INDIRECT, SPECIAL, INCIDENTAL OR CONSEQUENTIAL DAMAGES,
EVEN IF WE HAVE BEEN INFORMED OF THEIR POSSIBILITY IN ADVANCE.

### Trademarks

Except for displaying the License Details and identifying us as the origin of
the Software, you have no right under these Terms and Conditions to use our
trademarks, trade names, service marks or product names.

## Grant of Future License

We hereby irrevocably grant you an additional license to use the Software under
the Apache License, Version 2.0 that is effective on the second anniversary of
the date we make the Software available. On or after that date, you may use the
Software under the Apache License, Version 2.0, in which case the following
will apply:

Licensed under the Apache License, Version 2.0 (the "License"); you may not use
this file except in compliance with the License.

You may obtain a copy of the License at

http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software distributed
under the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR
CONDITIONS OF ANY KIND, either express or implied. See the License for the
specific language governing permissions and limitations under the License.
```

- [ ] **Step 2: Verify the placeholders are filled and no template tokens remain**

Run: `grep -nE '\$\{|licensor name|\{year\}' LICENSE`
Expected: no output (exit 1).

- [ ] **Step 3: Commit**

```bash
git add LICENSE
git commit -m "docs(docs): add FSL-1.1-ALv2 LICENSE"
```

---

## Task 2: `brand/LICENSE` (all rights reserved)

**Files:**
- Create: `brand/LICENSE`

- [ ] **Step 1: Create the file with this exact content**

```
Castwright brand assets — Copyright © 2026 Mikhail Dudarenok. All rights reserved.

This directory ("brand/") contains the Castwright name, wordmarks, logos, the
"Castwave" mark, icons, colour system, and related identity assets.

These brand assets are NOT covered by the Functional Source License that governs
the Castwright source code (see the LICENSE file at the repository root). A
licence to the code is not a licence to the identity.

You MAY, without prior permission, reproduce the unmodified marks at reasonable
size for the purpose of identifying or referring to Castwright in news articles,
reviews, academic work, and similar editorial or informational contexts (nominative
fair use).

You MAY NOT, without prior written permission from the copyright holder:

- use the marks (or anything confusingly similar) to name, brand, or promote
  another product, service, fork, or distribution;
- imply sponsorship, affiliation, or endorsement by Castwright;
- modify, recolour, or redraw the marks; or
- incorporate the marks into your own logos or trademarks.

"Castwright" is an unregistered trade mark of the copyright holder; trade-mark
registration is in progress. All rights not expressly granted above are reserved.

Questions / permission requests: open an issue on the repository.
```

- [ ] **Step 2: Commit**

```bash
git add brand/LICENSE
git commit -m "docs(docs): add brand asset licence (all rights reserved)"
```

---

## Task 3: `NOTICE` (third-party + bundled-model attributions)

**Files:**
- Create: `NOTICE`

Engine licences below were verified 8 June 2026 from the Hugging Face model cards.

- [ ] **Step 1: Create the file with this exact content**

```
Castwright
Copyright © 2026 Mikhail Dudarenok

This product is licensed under the Functional Source License, Version 1.1,
ALv2 Future License (FSL-1.1-ALv2). See the LICENSE file at the repository root.

Castwright incorporates and/or works with third-party components, each governed
by its own licence. Model weights are bundled in the release only when their
upstream licence permits commercial redistribution; non-commercial weights are
downloaded on demand from their official source and are never bundled.

Rule of thumb: the installer may fetch weights from their official home; the
release archive bundles nothing whose licence is unverified.

============================================================
Bundled model weights
============================================================

Kokoro v1 (text-to-speech)
  Upstream: hexgrad/Kokoro-82M; ONNX build via thewh1teagle/kokoro-onnx
  Licence:  Apache License 2.0
  Source:   https://huggingface.co/hexgrad/Kokoro-82M
            https://github.com/thewh1teagle/kokoro-onnx
  Verified: 8 June 2026

============================================================
Optional model weights (downloaded on demand, NOT bundled)
============================================================

Qwen3-TTS (text-to-speech; per-character designed voices)
  Models:   Qwen/Qwen3-TTS-12Hz-0.6B-Base
            Qwen/Qwen3-TTS-12Hz-1.7B-VoiceDesign
  Licence:  Apache License 2.0
  Source:   https://huggingface.co/Qwen/Qwen3-TTS-12Hz-0.6B-Base
            https://huggingface.co/Qwen/Qwen3-TTS-12Hz-1.7B-VoiceDesign
  Verified: 8 June 2026

Coqui XTTS v2 (text-to-speech; zero-shot voice cloning)
  Model:    coqui/XTTS-v2
  Licence:  Coqui Public Model License 1.0.0 (CPML) — NON-COMMERCIAL
  Status:   NOT bundled. Fetched on demand from the original source; its licence
            is shown at install time and it is offered as a user-supplied,
            optional engine.
  Source:   https://huggingface.co/coqui/XTTS-v2
  Verified: 8 June 2026

Whisper / faster-whisper (optional speech-to-text quality check)
  Licence:  MIT (OpenAI Whisper models) — downloaded on demand under their
            upstream licence.
  Source:   https://github.com/SYSTRAN/faster-whisper

============================================================
Application dependencies
============================================================

The frontend, server, and TTS sidecar depend on third-party npm and PyPI
packages, each retaining its own open-source licence. See each package's
distribution (node_modules, the Python environment) for the full texts.
```

- [ ] **Step 2: Verify no unresolved verification placeholders**

Run: `grep -niE 'TODO|TBD|verify before|unverified-claim' NOTICE`
Expected: no output (the "unverified" appears only in the rule-of-thumb sentence; if `grep` matches only that line, that is fine — confirm visually).

- [ ] **Step 3: Commit**

```bash
git add NOTICE
git commit -m "docs(docs): add NOTICE with bundled-model licence attributions"
```

---

## Task 4: `docs/licensing.md` (maintainer compliance home)

**Files:**
- Create: `docs/licensing.md`

- [ ] **Step 1: Create the file with this exact content**

````markdown
# Licensing & repo-opening compliance

Maintainer-facing record of Castwright's licensing model, the bundled-model
audit, and the checklist that must clear before the GitHub repository is made
public. Companion to
[`brand/monetisation-free-vs-gated-2026-06-08.md`](../brand/monetisation-free-vs-gated-2026-06-08.md)
§5 and §7.

## The model

- **Code** — Functional Source License v1.1 with an Apache-2.0 future grant
  (**FSL-1.1-ALv2**, a.k.a. FSL-1.1-Apache-2.0). Source-available, *not* OSI
  open source: any use is permitted except a Competing Use, and each release's
  code converts to plain Apache-2.0 two years after it is made available. File:
  [`/LICENSE`](../LICENSE).
- **Brand** — the `brand/` assets are all rights reserved
  ([`brand/LICENSE`](../brand/LICENSE)). A code licence is not a licence to the
  identity.
- **Engine weights** — bundled only if the upstream licence permits commercial
  redistribution; non-commercial weights are download-on-demand from their
  official home and never bundled ([`/NOTICE`](../NOTICE)).
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
- [x] `brand/LICENSE` (all rights reserved + nominative fair use)
- [x] `NOTICE` (bundled-model attributions + audit summary)
- [x] README license statement (source-available, brand carve-out, model notice)
- [x] CONTRIBUTING contribution-licensing terms (DCO / CLA / PRs-by-invitation)

**Pending before flipping the repo public:**

- [ ] **Companion website (`castwright.ai`) live** — the stated gate for going
      public; the public-flip and any "Cast Pass" messaging wait for it.
- [ ] **Git history scrub — DESTRUCTIVE, force-push.** Audit history for
      committed secrets and copyrighted fixtures, then rewrite if found:
  - Audit: `git log --all --full-history -- '**/.env' 'server/.env'` and a
    secret scan (e.g. `gitleaks detect`, `trufflehog`). Also check no copyrighted
    manuscript fixture ever entered history (search by the legacy external
    bonus-story filename, plus the fixtures path):
    `git log --all --full-history --oneline -- 'server/src/__fixtures__/**'`.
  - If anything is found: back up the repo, rewrite with
    `git filter-repo --invert-paths --path <file>` (or BFG), force-push, and
    have every clone re-clone. Do **not** run casually.
- [ ] **cla-assistant bot** wired (GitHub App) so external PRs collect the CLA.
- [ ] **Branch protection on `main`** (available once the repo is public / Pro):
      require the PR-title check and a review.
- [ ] **`gh repo edit --visibility public`** and confirm the repo name is
      `Castwright`.
- [ ] **Licence-key seam (Cast Pass)** — needs an `fs-` plan (server settings +
      companion pairing + series matcher). Not a blocker for a free-tier-only
      public release.

## Trade mark

Register "Castwright" as a trade mark (AU via IP Australia first, ~AU$250/class
self-filed; US later) — tracked as **ops-12**. Strengthens the `brand/`
all-rights-reserved carve-out against a confusing fork. Not executed here.

## Sources

- FSL template: <https://github.com/getsentry/fsl.software> (`FSL-1.1-ALv2.template.md`).
- Engine licences: the Hugging Face model cards linked in the audit table,
  verified 8 June 2026.
- Decisions & rationale:
  [`brand/monetisation-free-vs-gated-2026-06-08.md`](../brand/monetisation-free-vs-gated-2026-06-08.md)
  §5 (action items) and §7 (distribution & licensing).
````

- [ ] **Step 2: Commit**

```bash
git add docs/licensing.md
git commit -m "docs(docs): add licensing compliance + repo-opening checklist"
```

---

## Task 5: `README.md` — rewrite to app/user-facing

**Files:**
- Modify (full replace): `README.md`

- [ ] **Step 1: Replace the ENTIRE file content with the following**

````markdown
# Castwright

> _Any book, performed by a full cast — effortlessly. Even in your own voice._

Turn a manuscript into a finished, **full-cast** audiobook on your own machine —
every character in their own voice, consistent across a whole series. Castwright
runs locally end-to-end; nothing leaves your computer unless you opt into a cloud
analyzer.

Upload `.md` / `.txt` / `.epub` / `.pdf` / `.mobi` / `.azw3` → an analyzer
extracts characters, chapters, and per-sentence speaker tags → assign a voice to
each character → generate per-chapter audio → listen, revise, and export to M4B
or MP3.

## What you get

- **Full-cast narration** — every character speaks in their own voice, not one
  flat narrator.
- **Series memory** — a character keeps the same voice across every book in a
  series.
- **Your own voice** — clone a voice from a short sample (optional, on-device).
- **Private by default** — analysis and speech run on your machine; cloud is
  opt-in.
- **You own the files** — export standard M4B / MP3 / AAC / Opus and keep them.
  No lock-in.

## Features

- **Ingest** — paste or upload `.md`, `.txt`, `.epub`, `.pdf`, `.mobi`, or
  `.azw3`. Chapters and character names are extracted automatically; low-confidence
  speaker tags are surfaced for a quick review pass. DRM-protected files are
  rejected up front. Re-uploading a book shows a sentence-level diff before
  anything changes.
- **Analyzer choice** — run a fully local model via Ollama (no API key, nothing
  leaves your machine) or use the Gemini free tier. For long books, an optional
  two-model pipeline runs cast detection and sentence attribution in parallel to
  roughly double throughput.
- **Voice & cast** — per-engine voice catalogues with family grouping, drag- or
  tap-to-assign, per-character overrides, and sample playback. Audition candidate
  voices in the profile drawer before committing, and compare two characters side
  by side — even across books.
- **TTS engines** — Kokoro (fast, English, runs on a modest GPU), Coqui XTTS v2
  (zero-shot voice cloning, optional download), Qwen3-TTS (designs a unique voice
  per character from a persona and reuses it across the series), and Gemini cloud.
  A character keeps its voice when you switch engines.
- **Generation** — per-chapter, resumable, and sticky across navigation; chapters
  synthesise in a bounded parallel pool. Each chapter opens with its title spoken
  in the narrator's voice. Open the same book in two tabs and progress stays in
  sync.
- **Revisions & drift** — pending-revision review, A/B audition with rollback, a
  per-chapter revision timeline, and automatic detection (with one-click
  regeneration) when a chapter's voices drift from the current cast.
- **Listening** — a built-in player with speed control, markers, a sleep timer,
  true waveform peaks, resume bookmarks, per-book notes, and one-tap sharing of a
  30-second clip or the whole book.
- **Library** — auto-fetched cover art with a manual cover picker (search /
  upload / frame), title & author search, tag filters, series grouping, and a
  portable book bundle for backup or transfer.
- **Export** — M4B (with cover and chapter markers), AAC/M4A, Opus, MP3 (zip or
  per-chapter folder), plus LAN download with a QR code. EBU R128 loudness
  normalisation is on by default.
- **Mobile, tablet & companion app** — every view is responsive across phone /
  tablet / desktop and reachable over your home network via HTTPS, with a native
  Android companion that syncs only what changed and plays offline (background,
  lock-screen, Bluetooth, Android Auto).

## Quickstart

Download the latest `castwright-vX.Y.Z.zip` from
[Releases](https://github.com/dudarenok-maker/Castwright/releases), extract it,
and follow **[INSTALL.md](INSTALL.md)**. You'll end up with a single
`npm run start:prod` command that brings up the server, the TTS sidecar, and the
web UI at <http://localhost:8080>.

**Prerequisites** (full detail and per-OS steps in [INSTALL.md](INSTALL.md)):

- Node.js 20.19+
- Python 3.11 (for the TTS sidecar)
- ffmpeg on `PATH`
- ~3 GB free disk for the TTS weights
- An NVIDIA GPU is strongly recommended (TTS on CPU is far slower)

## Companion app (Android)

A native Flutter companion pairs to your running server over the home network
(HTTPS, cert-pinned), delta-syncs only the chapters that changed, and plays them
offline with background, lock-screen, Bluetooth, and Android Auto controls.
Pairing is cryptographically self-verified, so **no certificate install is needed
on the phone**.

Each [GitHub Release](https://github.com/dudarenok-maker/Castwright/releases)
attaches a ready-to-sideload `castwright-vX.Y.Z.apk`. Server-side pairing setup
(LAN HTTPS + an access token) is in [INSTALL.md](INSTALL.md); the app's own build
and usage notes are in [`apps/android/README.md`](apps/android/README.md).

## Releases

Tagged releases are published to
[GitHub Releases](https://github.com/dudarenok-maker/Castwright/releases). Each
attaches (all with `.sha256` checksums):

- `castwright-vX.Y.Z.zip` — the platform-independent **server** bundle
  (Windows / macOS / Linux); install via [INSTALL.md](INSTALL.md).
- `castwright-vX.Y.Z.apk` — the sideloadable **Android companion** app.
- `castwright-vX.Y.Z-ios-unsigned.*` — an **unsigned iOS** build (needs Apple
  signing to become an installable `.ipa`).

After the first public release, upgrading is one click inside the app
(**Account → Application updates**); see [INSTALL.md](INSTALL.md#updating).

## How it's built

Castwright is a Vite + React frontend, a Node/Express server, and a Python
(FastAPI) TTS sidecar, with a native Flutter companion app. Building from source,
the branching model, and the commit convention are documented in
**[CONTRIBUTING.md](CONTRIBUTING.md)**.

## Documentation

- **[INSTALL.md](INSTALL.md)** — install, configure, and update the app.
- **[`apps/android/README.md`](apps/android/README.md)** — the Android companion.
- **[CONTRIBUTING.md](CONTRIBUTING.md)** — building from source, branching, and
  the commit convention.

## License

Castwright is **source-available — not OSI open source**. The code is licensed
under the **Functional Source License v1.1 with an Apache-2.0 future grant**
(FSL-1.1-ALv2, a.k.a. FSL-1.1-Apache-2.0) — see **[LICENSE](LICENSE)**. In short:
use, modify, and share it for any purpose **except** building a competing product
or service; two years after each release, that release's code becomes Apache-2.0.
Leading with this plainly is deliberate — it bars a competing fork from day one
while keeping the source fully readable.

- **Brand assets** in [`brand/`](brand/) are **not** covered by the code licence —
  all rights reserved ([`brand/LICENSE`](brand/LICENSE)).
- **Model weights** carry their own upstream licences ([NOTICE](NOTICE)). Coqui
  XTTS v2 is non-commercial (CPML) and is therefore download-on-demand, never
  bundled.

**Contributing:** issues welcome; PRs by invitation for now (a DCO sign-off and a
lightweight CLA apply — see [CONTRIBUTING.md](CONTRIBUTING.md)).
````

- [ ] **Step 2: Verify the dev sections and changelog framing are gone**

Run: `grep -nE 'worktree|Parallel sessions|verify:fast|Testing harness|\(v1\.[0-9]|cannot self-upgrade|Private — not' README.md`
Expected: no output (exit 1). (A single match on `npm run start:prod` context is acceptable only if it is the Quickstart line — there should be none of the listed patterns.)

- [ ] **Step 3: Verify every relative link target exists**

Run: `grep -oE '\]\(([A-Za-z][^)]*)\)' README.md`
Then eyeball that each path (`INSTALL.md`, `LICENSE`, `NOTICE`, `brand/`, `brand/LICENSE`, `CONTRIBUTING.md`, `apps/android/README.md`) exists in the tree.

- [ ] **Step 4: Commit**

```bash
git add README.md
git commit -m "docs(docs): rewrite README as app-focused for first public release"
```

---

## Task 6: `INSTALL.md` — add Configuration, drop migration history, forward-looking Updating

**Files:**
- Modify: `INSTALL.md`

- [ ] **Step 1: Add a Configuration section.** Insert the following block immediately BEFORE the line `## Setting up the analyzer` (i.e. after the Troubleshooting section, before analyzer setup):

````markdown
## Configuration

The server reads `server/.env` (copied from `server/.env.example` in the install
steps above). All knobs have safe defaults — set only what you need.

**Analyzer**

- `ANALYZER` — `local` (default, Ollama) or `gemini`.
- `GEMINI_API_KEY` — required when `ANALYZER=gemini` (or as the automatic
  fallback when Ollama is unreachable).
- `GEMINI_MODEL` — the Gemini model id; plus per-model `GEMINI_RPM_*` /
  `GEMINI_TPM_*` / `GEMINI_RPD_*` rate caps (see `server/.env.example`).
- `ANALYZER_PHASE0_MODEL` / `ANALYZER_PHASE1_MODEL` /
  `ANALYZER_PHASE1_MIN_LAG_CHAPTERS` — optional two-model analyzer (cast
  detection + sentence attribution in parallel). Set both phase vars to enable.

**Generation & TTS**

- `WORKSPACE_DIR` — where your per-book library lives (set this to a writable
  folder).
- `GEN_WORKERS` — how many chapters synthesise at once (default `2`).
- `GPU_VRAM_BUDGET` — VRAM-weighted GPU budget in GiB (default `8`). Drop to `6`
  on a 6 GB card.
- `PRELOAD_COQUI` — `0` (default; Coqui loads on demand) or `1`.
- `QWEN_BATCH_SIZE` (default `8`) and `QWEN_ATTN_IMPL` (default `sdpa`) — Qwen
  tuning knobs.
- `AUDIO_LOUDNORM_ENABLED` — `true` (default; two-pass EBU R128 at
  -16 LUFS / 11 LU / -1.5 dBTP) or `false` to opt out.

**LAN / companion access**

- `LAN_HTTPS` — `1` serves over mkcert-backed HTTPS on `:8443`, bound on all
  interfaces (phone/tablet web + the Android companion). Off by default;
  `npm run start:lan` sets it. Requires the LAN cert
  (`npm run install:cert-mobile`); with `LAN_HTTPS=1` the server refuses to start
  if the cert is missing.
- `LAN_AUTH_TOKEN` — the shared pairing secret for the companion (and the LAN
  access guard on `/api` + `/workspace`). Required for the companion app.
````

- [ ] **Step 2: Delete the migration-history sections.** Remove these three subsections in their entirety from the `## Updating` area:
  - `### One-time conversion when you adopt v1.6.0 (from v1.5.x)` (and its numbered steps + the trailing paragraph ending "...the first self-upgrade you'll experience is 1.6.0 → 1.7.0. (1.6.0 ships the mechanism; it can't upgrade *into* itself.)")
  - `### v1.4.0 → v1.5.0 notes` (entire bullet list)
  - `### v1.3.x → v1.4.0 notes` (entire bullet list)

Keep `### Manual fallback (any version)`.

- [ ] **Step 3: Rewrite the `## Updating` opening.** Replace everything from the `## Updating` heading down to (but not including) `### Manual fallback (any version)` with:

````markdown
## Updating

Upgrading is one click in the app: open **Account → Application updates**, pick
the new `castwright-vX.Y.Z.zip`, confirm the version delta, and the app stages,
validates, swaps, reinstalls dependencies, migrates your book data (with an
automatic backup first), and restarts itself. No terminal commands.

This works because Castwright uses a **versioned-directory layout**: each release
lives in its own `releases/vX.Y.Z/` folder, a stable `launch.mjs` at the install
root always runs the current one, and your data lives in shared siblings outside
the release folders. An upgrade extracts the new release into a *fresh* folder and
only flips a pointer once it's ready — the running version is never touched, so a
failed upgrade just keeps running the previous one. A fresh install already ships
this machinery, so there is nothing to convert.

```
<install>/
  launch.mjs            <- start the app from here (shortcut / start-app.bat points at it)
  .current-version      <- e.g. "1.7.0"
  releases/v1.7.0/      <- the code (one extracted zip)
  workspace/            <- your library (books, voices)
  venv/  models/kokoro/ <- shared Python venv + Kokoro weights
  logs/  .run/
```

Your account settings live in `~/.castwright/user-settings.json` (outside any
install folder) and carry over automatically; copy your old `server/.env` into
`releases/vX.Y.Z/server/.env` if you set custom keys.
````

- [ ] **Step 4: Sweep remaining inline version tags in INSTALL.** Open the file and remove parenthetical `(v1.4.0)` / `(v1.5.0)` / `(v1.3.0)` style tags from section headings and prose where they read as changelog noise (e.g. `## Picking a chapter audio format (v1.4.0)` → `## Picking a chapter audio format`; `## Mobile + tablet access over LAN HTTPS (v1.4.0)` → drop the tag). Leave the `## Switching TTS to Qwen3-TTS` section's substance intact but drop its `(v1.5.0, ...)` tag from the heading. Do NOT change install commands or technical content.

- [ ] **Step 5: Verify the migration history is gone and no stale version tags remain in headings**

Run: `grep -nE 'One-time conversion|v1\.4\.0 → v1\.5\.0|v1\.3\.x → v1\.4\.0|adopt v1\.6\.0' INSTALL.md`
Expected: no output (exit 1).

Run: `grep -nE '^#+ .*\(v1\.[0-9]' INSTALL.md`
Expected: no output (exit 1) — no heading carries an inline version tag.

- [ ] **Step 6: Commit**

```bash
git add INSTALL.md
git commit -m "docs(docs): add Configuration, drop pre-public upgrade history from INSTALL"
```

---

## Task 7: `CONTRIBUTING.md` — add "Contributing & licensing"

**Files:**
- Modify: `CONTRIBUTING.md`

- [ ] **Step 1: Insert a new section** immediately after the `## TL;DR` list (before `## Branching model`):

````markdown
## Contributing & licensing

Castwright is **source-available under the Functional Source License**
(FSL-1.1-ALv2, a.k.a. FSL-1.1-Apache-2.0) — not OSI open source. See
[`LICENSE`](LICENSE); the [README license section](README.md#license) explains
the model in one paragraph. The `brand/` assets are **not** covered by the code
licence — all rights reserved ([`brand/LICENSE`](brand/LICENSE)).

**Posture today: issues welcome, PRs by invitation.** Until the CLA tooling is in
place, please open an issue to discuss a change before sending a PR.

**When external PRs open up,** two things will be required on every contribution:

- **DCO sign-off** — add `Signed-off-by: Your Name <you@example.com>` to each
  commit (`git commit -s`), certifying you wrote the change and may submit it
  under the project licence.
- **A lightweight CLA** — so the maintainer retains the right to relicense (the
  FSL future-grant and any relicensing depend on owning the copyright). This will
  be collected by a CLA bot; see [`docs/licensing.md`](docs/licensing.md).
````

- [ ] **Step 2: Verify the section landed and links are intact**

Run: `grep -nE 'Contributing & licensing|Signed-off-by|FSL-1.1-ALv2' CONTRIBUTING.md`
Expected: the new section's lines appear.

- [ ] **Step 3: Commit**

```bash
git add CONTRIBUTING.md
git commit -m "docs(docs): add contributing & licensing terms (DCO / CLA / FSL)"
```

---

## Task 8: Final verification sweep

**Files:** none (read-only checks)

- [ ] **Step 1: No "Private — not licensed" residue anywhere in user docs**

Run: `grep -rnE 'Private — not currently licensed|not currently licensed for redistribution' README.md INSTALL.md CONTRIBUTING.md`
Expected: no output (exit 1).

- [ ] **Step 2: All new licensing files exist and are non-empty**

Run: `for f in LICENSE NOTICE brand/LICENSE docs/licensing.md; do test -s "$f" && echo "OK $f" || echo "MISSING $f"; done`
Expected: four `OK` lines.

- [ ] **Step 3: No template placeholders survived in licence files**

Run: `grep -rnE '\$\{|\{year\}|licensor name|TODO|TBD' LICENSE NOTICE brand/LICENSE docs/licensing.md`
Expected: no output (exit 1).

- [ ] **Step 4: Confirm `.husky-wt/` was never staged**

Run: `git log --name-only --pretty=format: docs/docs-v17-public-readiness | grep -c '.husky-wt'`
Expected: `0`.

- [ ] **Step 5: Review the full diff against `main`**

Run: `git diff main --stat`
Expected: only `README.md`, `INSTALL.md`, `CONTRIBUTING.md`, `LICENSE`, `NOTICE`, `brand/LICENSE`, `docs/licensing.md`, and the two `docs/superpowers/{specs,plans}/...` files.

- [ ] **Step 6: Open the PR (draft) per CONTRIBUTING**

```bash
git push -u origin docs/docs-v17-public-readiness
gh pr create --draft --title "docs(docs): v1.7.0 public-readiness docs + licensing" --body "<summary + test plan>"
```

PR body must include `## Summary` (the docs/licensing wrap-up; note the repo is NOT
yet flipped public — that waits on the companion website) and `## Test plan`
(`- [ ] npm run verify — green`; manual link check; grep sweeps from Task 8).

---

## Self-Review

**Spec coverage:**
- Spec §1 README app-focus → Task 5. ✓
- Spec §2 INSTALL cleanup (Configuration, drop history, forward Updating) → Task 6. ✓
- Spec §3 licensing files (LICENSE, brand/LICENSE, NOTICE, README license) → Tasks 1, 2, 3, 5. ✓
- Spec §4 CONTRIBUTING CLA/DCO → Task 7. ✓
- Spec §5 docs/licensing.md + flagged follow-ups (history scrub, CLA bot, visibility flip) → Task 4. ✓
- Release-framing constraint (first public release, no version tags) → enforced in Tasks 5 & 6 with grep gates. ✓
- Engine audit web-verification → done during planning; results baked into Tasks 3 & 4. ✓

**Placeholder scan:** Licence/NOTICE/licensing.md bodies are complete verbatim text. The only `<...>` placeholder is the PR body in Task 8 Step 6, which is intentional (author writes it at PR time). No "TBD/TODO/implement later" in deliverable content.

**Type/naming consistency:** Licence named consistently as "FSL-1.1-ALv2 (a.k.a. FSL-1.1-Apache-2.0)" across LICENSE, NOTICE, README, CONTRIBUTING, docs/licensing.md. Licensor "Mikhail Dudarenok" consistent. Model ids match the installers (`Qwen/Qwen3-TTS-12Hz-0.6B-Base`, `Qwen/Qwen3-TTS-12Hz-1.7B-VoiceDesign`, `hexgrad/Kokoro-82M`, `coqui/XTTS-v2`).
