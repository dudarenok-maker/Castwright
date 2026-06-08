# Castwright — free vs gated: community comparison & one-off pricing model

**Date:** 8 June 2026 · **Estimated read time:** 12 minutes
**Companion to:** `competitive-brief-2026-06-08.md` (competitor detail and sources) and `brand-guidelines.md` (Pillar 4 — ownership)

---

## Executive summary

**The free community products define the floor: anything they do free, Castwright must do free.** Gating a capability that Alexandria or ebook2audiobook gives away simply routes users to GitHub. What they *cannot* do — series memory, the quality gate's auto-repair loop, family voices with a consent trail, the companion app, the multi-book studio — is where a gate is both fair and defensible, because the value accumulates with sustained use.

**Recommended model: free core, one-off "Cast Pass" at US$7.**

- **Free, forever, no caps or watermarks:** the complete single-book magic — ingest, full-cast analysis, designed voices, emotion, basic cloning, QA *detection*, manuscript editing, M4B export. The free tier must be the best local audiobook tool available, full stop.
- **Cast Pass (one-off US$7, covers all v1.x):** the library that remembers — series continuity, cross-book voice library, family voices (fs-38), companion-app pairing, multi-book queue, A/B diff player, QA auto-repair.
- **Never gated, on principle:** export (no lock-in is a brand non-negotiable), consent controls, QA detection (trust is not a paid feature).

**Decisions sought:** confirm the free/gated split (Section 3), the US$7 price point, and the sell-on-web-not-in-app distribution (avoids Apple's 30% and IAP rules).

**Sustainability check:** fixed costs ≈ US$300–650/yr (Apple developer program, code signing, domain, store fees — itemised with verified 2026 pricing in Section 4; GitHub CI drops to $0 once the repo is public). **~50–105 passes a year covers it** at ~$6.15 net per sale after Paddle's cut. A 5% conversion on 2,000 free users clears the bar comfortably.

---

## 1. The free community floor (what must stay free)

| Capability | Best free community offering | Maturity | Implication for Castwright |
|---|---|---|---|
| EPUB/PDF/MOBI ingest → chaptered M4B | ebook2audiobook (~19k★), Audiblez (~6k★) | Mature, mainstream | **Free** — commodity |
| Single-voice conversion (Kokoro-class) | Audiblez, abogen (~4.7k★) — CPU-friendly | Mature | **Free** — commodity |
| **LLM character detection + auto full-cast** | Alexandria (580★, surging), audiobook-creator (465★), E2A-SML | Working, rough edges | **Free** — this is the demo of the magic; gate it and users pick Alexandria |
| Designed voices from a persona | Alexandria (same Qwen3-TTS stack, incl. voice design + LoRA) | Working | **Free** — parity exists |
| Emotion/tone direction | Alexandria (instruct-based), audiobook-creator (Orpheus tags) | Partial | **Free** — capability parity exists; Castwright wins on automation quality, not existence |
| Basic voice cloning from a sample | ebook2audiobook, Pandrator, Alexandria | Mature (table stakes) | **Free** (single personal voice) |
| Runs on an 8 GB consumer GPU | Alexandria (8 GB min), abogen/Audiblez (CPU-class) | Yes | **Free** — it's the shared pillar |

**What none of them have** (verified in the 8 June competitive research): series-level cast memory, automated per-sentence QA with re-record, voice-drift detection, a consent-tracked family-voice library, a paired companion app, a finished non-technical UX, multi-book parallel workflow.

---

## 2. Where Castwright is alone (the gateable surface)

| Capability | Community state | Value pattern | Gate? |
|---|---|---|---|
| **Series continuity** — cast memory across books, alias-aware matching, merge, provenance, rebaseline | Nobody (Alexandria is within-book only) | Accumulates with every book; heavy series readers | **Gate** — flagship of the Pass |
| **Cross-book voice library** — reuse, duplicate review, compare | Nobody | Accumulates | **Gate** |
| **Family voices (fs-38)** — cloning with consent trail, provenance, reuse rules, on-device guarantee | Raw cloning is free everywhere; the consent/family *experience* is nowhere | Most personal value in the product | **Gate** (the *experience*; raw single-voice cloning stays free) |
| **Companion app pairing** — sync, offline, resume, CarPlay/Android Auto | None paired to generation (Audiobookshelf is player-only) | Daily-use comfort; real app-store costs | **Gate** — M4B export to any player stays free, so no lock-in |
| **Multi-book studio** — workspace queue, parallel books, drag reorder | None | Power-user comfort | **Gate** |
| **A/B revision diff player** | None | Power-user comfort | **Gate** |
| **QA auto-repair loop** — failed lines re-recorded automatically; one-click drift regeneration | Nobody detects, nobody repairs | Comfort on top of trust | **Gate the automation** — detection and flags stay free |
| QA *detection* + drift *flags* | Nobody | Trust | **Free** — a broken line a free user can't see hurts the brand more than US$7 |
| Export (M4B/MP3, anywhere) | Free everywhere | Principle | **Never gated** — "no lock-in" is a non-negotiable |

**The pattern:** free buys you a perfect *book*; the Pass buys you a *library*. One render is the magic trick; the accumulated cast across a series is the relationship — and the only part no one can copy from GitHub this year.

---

## 3. The recommended split, as the user sees it

| | **Free** | **Cast Pass — one-off US$7** |
|---|---|---|
| Books | Any book, full cast, no caps, no watermark | Everything in Free |
| Voices | Catalogue + designed + one personal cloned voice | **Family voices** with consent trail & reuse rules |
| Series | Each book casts fresh | **Castwright remembers your cast across the series** |
| Library | Per-book | **Cross-book voice library, merge, provenance, rebaseline** |
| Quality | Every line checked & flagged; manual re-record | **Auto-repair + one-click drift regeneration** |
| Listening | Export M4B/MP3 to any player | **Companion app pairing** (sync, offline, resume) |
| Workflow | One book at a time | **Multi-book queue, A/B diff player** |
| Updates | All v1.x | All v1.x; future major versions may carry an upgrade pass |

**Brand framing (in the house register):** *"Castwright is free — every book, the full cast, yours to keep. The Cast Pass is seven dollars, once. It keeps the lights on, and it gives your library a memory."* Honest about why the gate exists (sustainability, not rent-seeking) — consistent with Pillar 4: it is the anti-subscription.

---

## 4. Pricing & mechanics

| Question | Recommendation | Rationale |
|---|---|---|
| Price | **US$7** (within your 5–10 band) | Below impulse threshold; ~half an Audible month; trivially fair against $132/yr clouds. $5 leaves margin on the table; $9.99 reads like a SaaS trick |
| Model | One-off, all v1.x updates | Anti-subscription IS the positioning; a recurring fee would contradict Pillar 4 |
| Sales channel | **Web (Stripe/Paddle), key emailed; never in-app on iOS** | Selling the unlock inside the companion app triggers Apple's 30% + IAP rules; the desktop product unlock sold on castwright.ai avoids it entirely (Paddle handles AU GST/EU VAT as merchant of record) |
| Enforcement | Light, honour-system licence key; no phone-home DRM | A privacy-first local product cannot phone home to validate licences without breaking its own story. Price below piracy effort; goodwill converts |
| Series trial | First *returning* cast match in book two works free, then prompts | The user must *hear* the moat before paying for it |

### Sustainability arithmetic (verified 8 June 2026)

| Cost line | US$/yr | Notes |
|---|---|---|
| Apple Developer | **99** | Required for the iOS app AND macOS notarisation (Gatekeeper blocks unnotarised apps even off-store). Deferred until a Mac/iOS ship |
| Windows code signing | **115–139** | **Decided (§4.2): Certum Cloud Code Signing Individual via SSLmentor** — $139/yr, or $115/yr on a 3-yr purchase. Open-source cert ruled out (revocation on commercial use), Azure excludes AU, no Australian CA exists, EV is pointless post-2024. Microsoft Store (Phase 3) sidesteps SmartScreen entirely |
| Domain (castwright.ai) | **~78** | Actual: A$240 / 2 yr = A$120/yr — normal for `.ai` |
| Hosting | **~0** | Cloudflare Pages (site) + Workers free tier (licence issuance; 100k req/day) + Paddle-hosted checkout. Workers Paid US$5/mo only if the issuance log outgrows free KV |
| Google Play | **25 once** | Personal accounts need a ~12-tester closed test before production — the alpha channel already satisfies it |
| GitHub CI | **~0 once public** | Standard runners on public repos are free and unlimited, incl. macOS — opening the repo zeroes the current private-repo minutes burn (Windows ×2, macOS ×10 multipliers). Interim: self-hosted runner on the dev box for heavy legs (free; per-minute billing for self-hosted postponed indefinitely) or Pro US$4/mo |
| **Fixed total** | **≈ 300–650/yr** | Signing path decides the band |

**Per-sale cut (variable):** Paddle 5% + US$0.50 → on a US$7 Pass: **$0.85 (~12%), netting ~$6.15**. The $0.50 floor stings at low price points but buys merchant-of-record status (GST/VAT is Paddle's problem). Chargebacks $20 each — noise at this price.

**Break-even ≈ 50–105 passes/yr** at $6.15 net. Anything beyond funds the GPU fund and the languages roadmap. Strategic note: the open-repo decision is also the cost decision — public CI minutes are free, so distribution strategy and cost floor are the same lever.

### 4.1 Why the signing costs exist at all (plain language)

Both Microsoft and Apple treat downloaded software from an unidentified publisher as malware-until-proven-otherwise; the "proof" is a cryptographic signature traceable to a verified real-world identity. That identity verification — not the cryptography — is what the money buys.

- **Windows (SmartScreen).** An unsigned `castwright-setup.exe` triggers the full-screen blue *"Windows protected your PC"* wall, with the proceed button hidden behind "More info." Technical users click through; the non-technical reader Castwright targets — the one who chose it over Alexandria precisely because they can't drive a Python install — reads "protected," assumes virus, deletes. Plausibly a 50%+ funnel kill at the worst possible moment. A signed installer shows a verified publisher name instead, and **reputation accrues to the certificate** with download volume until the prompt disappears entirely. The annual fee exists because the certificate is an expiring identity document, and since 2023 the key must live in tamper-proof hardware or a cloud HSM (hence the price gap between bare and token/cloud options). Note: **EV certificates no longer buy instant SmartScreen reputation** (Microsoft dropped EV special treatment in Aug 2024) — OV is sufficient; EV matters only for kernel drivers.
- **macOS (Gatekeeper).** Since Catalina, any internet-downloaded app must be **notarised** — uploaded to Apple, scanned, stamped — or macOS refuses to open it (a hard block, not a click-through: *"damaged or can't be checked for malware"*). Notarisation itself is free **but only works from a paid Apple Developer account** — that's gate one of the $99/yr. Gate two: the iOS companion app has no distribution path at all except the App Store, which requires the same membership. One fee, both gates.
- **Why $0 today:** alpha testers are inside the personal trust radius and have been told to click through. The moment a stranger downloads from a public repo, the OS warning *is* the first impression — and a product whose pillar is "trust me with your books on your machine" cannot open with a malware warning. Windows signing is therefore due at public launch; Apple's fee only when a Mac/iOS build ships.

### 4.2 Windows signing: cheapest viable paths (investigated 8 June 2026)

Constraint: Australian individual (no company), FSL-licensed (source-available, not OSI open source).

| Path | Cost | Eligibility vs constraints | Verdict |
|---|---|---|---|
| ~~Certum Open Source Code Signing~~ | ~~€69/€29 renewal~~ | **Ruled out (8 June 2026, per Certum's own terms):** issued only to individuals, CN/Organisation forced to "Open Source Developer" (not Castwright), and — decisive — *"if Certum determines that the certificate is being used to sign software distributed commercially, the certificate will be revoked."* Revocation mid-flight would void SmartScreen trust on every installer already shipped. The Cast Pass makes Castwright commercial distribution; not a grey area | Closed — do not revisit |
| **Certum Cloud Code Signing INDIVIDUAL (SimplySign) — via SSLmentor** | **US$139/yr · $127/yr on 2-yr ($254) · $115/yr on 3-yr ($345)** (verified 8 June 2026) | The variant purchasable **without a registered entity** (invoice to personal name; SSLmentor claims exclusivity on it). No licence test, key in Certum's cloud HSM, `signtool`-compatible so signing automates inside `release.yml`. Validation: ID + face scan + utility bill, ~3+ business days. Publisher shown to users = personal name, not "Castwright" (needs an entity to change) | **THE pick — [sslmentor.com/certum/certumcodecloudindividual](https://www.sslmentor.com/certum/certumcodecloudindividual)** |
| Certum Cloud Code Signing (business) via reseller | from ~US$116/yr multi-year ([SSLmentor](https://www.sslmentor.com/certum/certumcodecloud)) | Requires a registered organisation — relevant later if an ABN/entity is set up so the publisher reads "Castwright" | Future upgrade path |
| Certum direct (shop.certum.eu / certum.store) | €209/yr cloud; €169 set / €139 code (card-based) | Same products, worst prices; card variants mean manual, physically-present signing each release | Reference only — don't |
| **Australian options** | Sectigo/Comodo OV via AU storefronts ([CodeSignCert AU](https://codesigncert.com/au) ~AU$226+/yr, [SSL2Buy AU](https://www.ssl2buy.com/au/code-signing-certificate) AU$317+, [CheapSSLShop AU](https://www.cheapsslshop.com/au/code-signing-certificates) AU$320–367, [TheSSLStore AU](https://www.thesslstores.com.au/products/code-signing-certificates.aspx) teaser "from $89.54" but code-signing lines actually $135–929/yr) | **No Australian CA issues Windows code-signing certificates** — these are AUD-billing storefronts for the same global CAs, mostly business-validated, with USB tokens shipped. All verified options cost more than the Certum Individual cloud route; Azure (the other cloud option) excludes AU | Closed — AUD invoicing is the only benefit, at a premium |
| Sectigo/Comodo OV (individual validation) via resellers | ~$200–250/yr + token | Individuals ✔, no licence test | Only if Certum paths both fail |
| Azure Artifact Signing | ~$120/yr | **Australia not eligible** (orgs US/CA/EU/UK; individuals US/CA) | Re-check at each release; best price-for-product if eligibility expands |
| SignPath Foundation (free OSS signing service) | $0 | Vets projects for genuine OSS status — FSL likely ineligible *(unverified)* | Low-cost lottery ticket; one email |
| DigiCert | ~$400+/yr | — | No reason at this scale |

Two regulatory notes that affect all paths: from **March 2026 certificate validity is capped at ~15 months** (460 days) — budget for renewal admin annually regardless of vendor; and multi-year purchases now mean re-issuance under the same order, not a longer-lived certificate.

**Bottom line (decided 8 June 2026):** **Certum Cloud Code Signing Individual via SSLmentor — US$139/yr (or $345/3-yr ≈ $115/yr)**. The open-source route is closed by the commercial Cast Pass (revocation risk), EV buys nothing since Microsoft dropped its SmartScreen advantage (kernel drivers only), card-based variants trade small savings for manual signing every release, and no Australian option exists — local storefronts resell the same global CAs at a premium with shipped tokens. Beats the $200–400 originally budgeted; the Microsoft Store path (Phase 3, $19 once) removes SmartScreen for store-installed users permanently. One adjacent driver: Windows 11's **Smart App Control hard-blocks unsigned apps** (no click-through), strengthening the sign-at-public-launch requirement. Publisher-name note: an individual cert shows "Mikhail Dudarenok" in UAC/SmartScreen prompts — showing "Castwright" requires a registered entity and the business-variant cert; park alongside the §7.1 trade-mark action.

---

## 5. Core risks & mitigations

| Risk | Mitigation |
|---|---|
| **Gating the spearhead claim** — series consistency is the brand's headline, now behind a gate | The *claim* stays front-and-centre; the gate is one coffee, once. The book-two free taste (above) lets the moat sell itself. Watch alpha-tester reaction before locking |
| OSS reaches series-memory parity (Alexandria adds a library) | Likely eventually. The Pass bundle never rests on one feature — companion app, family voices, auto-repair, and polish travel together |
| Honour-system piracy | Accepted by design; the buyer is buying sustainability and the story, not the bits |
| iOS companion app + paid unlock entanglement | Keep the app free; the Pass unlocks *pairing* server-side (the licence lives in the desktop product, not the app) — re-verify against App Review guidelines before iOS submission |
| "Free tier is too good" (nobody converts) | That's the strategy: the free tier defeats Alexandria, the Pass converts the readers who finish a series — exactly the users with the most accumulated value |

---

## 6. Action items

1. **Decide** the split, price (US$7), and web-only sales channel — this document is the proposal.
2. Add the licence/unlock seam to the backlog as a proper item (touches server settings, companion-app pairing, and the series matcher) — needs a `fs-` plan before any implementation.
3. Test the framing copy on alpha testers alongside the Pillar 4 messaging.
4. Re-verify the "nobody has series memory" claim at each quarterly competitive refresh (now in `brand-guidelines.md` open items) — the Pass bundle composition should evolve as OSS catches up.
5. **Engine licence audit before the repo opens or anything is sold** (Section 7.1) — Coqui XTTS v2's CPML is non-commercial: confirm download-on-demand handling; verify Kokoro and Qwen3-TTS weight licences at release versions.
6. **Repo-opening checklist:** `LICENSE` (FSL-1.1-Apache-2.0) + `brand/LICENSE` carve-out, README source-available statement, secret/history scrub (`.env`, keys, copyrighted fixtures — the canonical Keefe manuscript must not be in git history), DCO/CLA bot, then the licence-key seam as a `fs-` plan.

---

## 7. Distribution & licensing

**The model in one line:** castwright.ai is the front door, GitHub is the warehouse, the licence is source-available (not OSI open source), and the gate is an offline signed key. The public repo is the growth engine — stars are the zero-budget marketing channel this community actually uses (ebook2audiobook ~19k★, Alexandria 580★ and surging), and freemium users arrive through it.

| Layer | Choice | Why |
|---|---|---|
| Front door | **castwright.ai** — demo audio, docs, narrative, Cast Pass checkout | Owned channel; the listen-first demo is the conversion moment |
| Payments | **Paddle** (merchant of record) | Handles AU GST / EU VAT / US sales tax as the seller of record — no tax registrations for a sole operator |
| Artifact hosting | **GitHub Releases** | Free bandwidth, the community's native discovery surface, Issues as the support channel |
| Licence | **FSL-1.1-Apache-2.0** (Functional Source License) | Code fully public; competing redistribution barred; each release auto-converts to Apache-2.0 after two years — credible "we mean it" signal |
| Gate | **Ed25519-signed offline licence key** | No phone-home — the privacy story survives its own business model |
| Companion app | Free on Google Play (now) / App Store (later); the Pass unlocks *pairing* on the desktop side | Keeps Apple IAP rules and the 30% cut entirely out of scope |

**Brand note:** the README must say plainly that this is source-available, not OSI open source, and why — leading with that honesty is the competitive-register rule applied to ourselves. The repo opening also hands rivals the series-matcher source; accepted, per Section 5 — the moat is the finished product, and from day one the licence (not obscurity) is what bars a competing fork.

### 7.1 Technical: licensing

- **Licence file and scope.** `LICENSE` = FSL-1.1-Apache-2.0 (the Apache future-licence variant). FSL permits any use *except* a competing product/service; after two years each release's code becomes plain Apache-2.0. No per-file headers needed beyond a short banner in `README`.
- **Carve-outs that must NOT be FSL'd:**
  - `brand/` (logos, wordmarks, the Castwave mark) — *all rights reserved*, with a `brand/LICENSE` note permitting fair use in articles/reviews. A licence to the code is not a licence to the identity; this is what actually stops a confusing fork, alongside an eventual **trade mark registration for "Castwright"** (AU first via IP Australia, ~AU$250/class self-filed; US later).
  - Test fixtures derived from copyrighted manuscripts — never commit (already the convention).
- **Contributions.** Relicensing rights require owning the copyright. Use **DCO sign-offs plus a lightweight CLA** (cla-assistant bot) from the first external PR — retrofitting a CLA after contributors accumulate is painful. Until then, "issues welcome, PRs by invitation" is a legitimate stance.
- **Engine licence audit (pre-launch blocker).** The product's licence is irrelevant if a bundled model's licence forbids commercial distribution:
  - **Kokoro** — Apache-2.0 (model + code): safe to bundle. *(Verify at release.)*
  - **Coqui XTTS v2** — the model weights are under Coqui's **CPML, a non-commercial licence**, and Coqui-the-company wound down: **do not bundle**. Keep XTTS strictly download-on-demand from the original source, with its licence shown at install, positioned as a user-supplied optional engine. *(Risk: a paid Pass adjacent to a CPML model needs a considered position — flag for legal reading.)*
  - **Qwen3-TTS** — verify the exact model-weight licence (Qwen releases vary between Apache-2.0 and the Qwen licence with use restrictions) before bundling; same download-on-demand fallback if restricted.
  - Rule of thumb: **the installer may fetch weights from their official home; the release zip bundles nothing whose licence is unverified.**

### 7.2 Technical: key management

- **Key format.** An Ed25519-signed token, human-pasteable: `CW1-<base32(payload)>-<base32(signature)>`. Payload (CBOR/JSON, ~100 bytes): `edition: "cast-pass"`, `major: 1` (entitles all v1.x), `issued: <date>`, `licensee: <name or email hash>`, `order: <Paddle order id>`.
- **Issuance pipeline (the only cloud component in the entire product):** Paddle checkout → webhook → a single **Cloudflare Worker** holding the private signing key as a secret → derives the key **deterministically from the order id** (reissue = identical key, support becomes a lookup, no licence database needed) → delivered on the receipt page + email. Keep an append-only issuance log (Workers KV) for support audits.
- **Verification (in-app):** the public key ships embedded in the binary; verify signature + `major` entitlement **offline at startup — no activation, no seat counting, no expiry, no network call ever**. Locked features stay visible with an honest one-line explanation and the price — the locked state *is* the upsell surface.
- **Key security and rotation:** private key lives only in the Worker secret + an offline backup (password manager / hardware token). The app embeds an **array** of valid public keys so a rotation (or a v2 key) is just an append in a patch release.
- **Revocation:** at US$7, don't build it. A refunded order's key keeps working until the next release optionally ships a tiny embedded blocklist; chargeback abuse at this price is noise.
- **Companion-app unlock:** the desktop server validates the local licence and enables pairing endpoints; the mobile app stays free and licence-unaware — nothing for App Review to object to.
- **Failure honesty (on-brand):** if the key file is missing or corrupt, the app says exactly that and keeps every free feature working. A licence problem must never break a render.

### 7.3 Technical: distribution channel roadmap

| Phase | Channel | Effort | Notes |
|---|---|---|---|
| **1 — Launch** | castwright.ai + GitHub Releases | Done by definition | Signed installers; the v1.6.0 rename already forces fresh installs, so launch is the clean break |
| 1 | **Pinokio** listing | Low (one JSON script) | Where Alexandria's users one-click install — meet the kin where they live |
| **2 — Stabilised releases** | **winget** (manifest PR), **Scoop** bucket | Low | Windows dev-adjacent reach; free |
| 2 | **Homebrew cask** | Low | macOS reach once the cross-OS verify is routine |
| 2 | **GHCR Docker image** (headless server) | Medium | The r/selfhosted + Audiobookshelf crowd; pairs with the companion app story |
| **3 — Trust surfaces** | **Microsoft Store** (MSIX) | Medium (US$19 once) | Auto-update + SmartScreen trust for non-technical Windows users — the audience the OSS tools can't reach |
| 3 | **Flathub / AUR** | Medium | Linux credibility; AUR will likely appear community-made once the repo is public — adopt rather than fight it |
| 3 | **Umbrel / CasaOS app stores** | Low-medium | Self-hosted appliance audience (OpenReader precedent) |
| Companion | Google Play (now) → Apple App Store (with iOS release) → **F-Droid** (open repo makes it possible) | Per store | F-Droid listing is a privacy-community trust signal money can't buy |
| **Skip** | Steam, itch.io, Gumroad, Setapp | — | Wrong audiences or duplicate of Paddle |

**Sequencing rule:** a channel earns its slot only when its update path is automated in the release flow (`release.yml`) — every manual-upload channel is a future stale-version complaint.

---

## Sources

Internal: `brand/competitive-brief-2026-06-08.md` (all competitor capability and pricing claims, researched 8 June 2026) · `brand/brand-guidelines.md` (Pillar 4, competitive register) · `docs/project-narrative.md` (non-negotiables: no lock-in, privacy by default, mid-market hardware).
External pricing reference points: ElevenLabs Reader Ultra $11/mo · Speechify ~$139/yr · MyNarratorAI $5–25/mo · Audibloom $39/mo or $29/book · Spoken ~$200/novel · OSS free — see the competitive brief's source list for URLs.
Signing & infrastructure (verified 8 June 2026): [Certum Open Source Code Signing](https://certum.store/open-source-code-signing-code.html) · [Certum required documents](https://support.certum.eu/en/code-signing-required-documents/) · [first-hand Certum OSS write-up (Oct 2025)](https://piers.rocks/2025/10/30/certum-open-source-code-sign.html) · [Certum SimplySign via SSLmentor](https://www.sslmentor.com/certum/certumcodecloud) · [Azure Artifact Signing pricing](https://azure.microsoft.com/en-us/pricing/details/artifact-signing/) · [Azure eligibility FAQ](https://learn.microsoft.com/en-us/azure/artifact-signing/faq) · [SSL Insights provider comparison 2026](https://sslinsights.com/best-code-signing-certificate-providers/) · [GitHub Actions 2026 pricing](https://github.com/resources/insights/2026-pricing-changes-for-github-actions) · [Paddle pricing](https://www.paddle.com/pricing)
