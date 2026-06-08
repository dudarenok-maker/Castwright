# Castwright — competitive brief & brand recommendations

**Research date:** 8 June 2026 · **Estimated read time:** 14 minutes
**Companion to:** `brand-guidelines.md` (current state) and `../docs/project-narrative.md` (the story)

---

## Executive summary

**The category Castwright invented is no longer empty — but the position Castwright holds is still unclaimed.** In the last 12 months, automated per-character "full-cast" audiobook generation went from white space to a contested feature: **Spoken** shipped it for authors (Magic Mode, May 2026), **Audibloom** and **MyNarratorAI** ship it in the cloud, and at least **four open-source projects** (led by **Alexandria Audiobook**, on the same Qwen3-TTS stack) ship it locally. **ElevenLabs + Spotify** just made single-voice AI audiobooks free for authors (June 2026 beta).

**Key findings**

- **Nobody combines Castwright's four pillars.** Consumer-facing + full cast + series-consistent + local/private exists nowhere else as one product. Each competitor holds at most two.
- **Two claims remain genuinely unique:** **series-level cast consistency for readers** (Spoken approached it author-side on 5 June 2026 — this window is closing) and **automated per-sentence quality gating** ("the line actually says the right words") — no one, commercial or OSS, markets either.
- **The local/ownership story is unclaimed marketing whitespace.** Every commercial rival meters cloud credits (ElevenLabs hours, Speechify word caps, Spoken per-word, Audibloom hours/month); ElevenReader even **forbids audio export**. Play.ht's shutdown (Meta acquihire; user libraries and voice clones deleted 31 Dec 2025) is a ready-made proof point: *a cloud library can be deleted by someone else's acquisition.*
- **The OSS tier is the most direct threat to the "local" pillar,** not the giants: ebook2audiobook (~19k stars) owns the home-conversion default, and Alexandria (580★, surging) does LLM casting + emotion + cloning on an 8 GB GPU. Their gap is product polish, series memory, and QA — exactly where the brand should plant its flag.

**Decisions sought**

1. **Promote the local/ownership story from supporting detail to a named brand pillar** (currently buried under "your voice").
2. **Claim series consistency loudly and now** — it is the moat with a closing window.
3. **Add a competitive register to the brand guidelines** (how we talk about clouds, giants, and OSS) so future copy stays candid without turning combative.

**Actions proposed:** seven specific edits to `brand-guidelines.md` (Section 8 below) plus a short content plan exploiting the gaps (Section 9).

---

## 1. Landscape overview

Four tiers compete for the same listener-hours, with different business models:

| Tier | Players | Model | Full-cast? | Local? | Threat to Castwright |
|---|---|---|---|---|---|
| **Consumer reader apps** | ElevenLabs Reader, Speechify, MyNarratorAI, CastReader | Subscription, cloud-metered | MyNarratorAI/CastReader yes (cloud); others no | No | **High** — same audience |
| **Author/publisher platforms** | Spoken, Audibloom, ElevenLabs Studio, Wondercraft, Murf, Respeecher | Per-word / per-hour / credits | Spoken & Audibloom yes, automated | No | **Medium** — different buyer, overlapping claims |
| **Platform-native catalogue tools** | Audible Virtual Voice, Spotify×ElevenLabs, Apple Books, Google Play | Free creation, store lock-in | No (single narrator) | No | **Low-medium** — shapes expectations, floods catalogues |
| **Open-source / local** | ebook2audiobook (+E2A-SML), Alexandria, audiobook-creator, abogen, Audiblez | Free, own GPU | Alexandria & E2A-SML yes | **Yes** | **High** — same pillar, same hardware, zero price |

**Consolidation signal:** Play.ht is dead (Meta acquihire, product sunset 31 Dec 2025), DeepZen's site is in maintenance mode, Speechki is flagged out of business. The mid-tier cloud "AI narration bureau" is being squeezed between ElevenLabs and free platform-native tools. The two ends that survive: platform giants and local/free. Castwright sits at the local end with a consumer product — defensible ground.

---

## 2. Competitor profiles (the five that matter most)

### 2.1 ElevenLabs (Reader + Audiobooks/Studio) — the gravity well

- **Positioning:** *"Turn your manuscript into a studio-quality audiobook in minutes"* / Reader: *"Listen to anything with stunningly natural voices."* End-to-end create→publish→earn loop.
- **Pricing:** Reader Ultra **$11/mo**; creation Free→$5→$22→$99→~$330/mo, credit-metered (~"Free–$200 per book" by their own table).
- **Full-cast:** v3 Dialogue mode + Studio multi-speaker exist, but casting is **manual hand-tagging by the rights-holder**. No consumer feature auto-casts a novel you own; the Reader is single-narrator and **blocks audio export**.
- **Recent moves:** Spotify for Authors integration (21 May 2026), 200K human-narrated titles licensed into Reader (May 2026), Iconic Voices marketplace.
- **Weaknesses:** credit metering confuses and compounds on book-length work; cloud-only; everything locked in their ecosystem.
- **Tone:** polished, superlative-heavy ("stunningly natural," "studio-quality") — the exact register Castwright's guidelines already ban.

### 2.2 Spoken (spoken.press) — closest claim overlap

- **Positioning:** *"The AI Audiobook Company™"*, *"Free to use. Pay when Perfect."* — full-cast AI audiobooks for **authors**, ethics-forward.
- **Pricing:** **$20 per 5,000 finished words** (≈$200 for a 46k-word novel); $50/mo halves it.
- **Full-cast:** yes — Magic Mode (20 May 2026) auto-orchestrates the whole performance. **v2.1 (5 June 2026) added cross-project continuity for series** — the direct overlap with Castwright's "book two sounds like book one."
- **Weaknesses:** author-side only (readers can't convert books they don't hold rights to), cloud, per-word costs scale steeply across a series, small bootstrapped team.
- **Tone:** warm, writerly, anti-big-tech — the most Castwright-like voice in the field. Differentiate by audience (readers vs authors) and by locality, not by tone.

### 2.3 Audibloom — closest pipeline analogue

- **Positioning:** *"Novel to Audiobook AI — a full cast for your characters."* LLM auto-casting for indie authors; claims 80–90% first-pass attribution accuracy.
- **Pricing:** $15–$99/mo tiers; full multi-character from **$39/mo**; **$29 per-book** pack.
- **Weaknesses:** cloud-only, no M4B yet, no distribution, unproven at book length, no independent reviews.
- **Note:** its marketing ("the first audiobook tool that actually understands your characters") is a direct collision with Castwright's essence statement. Expect copy conflict.

### 2.4 MyNarratorAI — the consumer cloud twin

- **Positioning:** *"Transform Your E-books into Full Cast Audiobooks with AI"* — the only other **reader-facing** full-cast product found.
- **Pricing:** Free (watermarked) / $5 / $10 / $25 per month.
- **Weaknesses:** ePub-only, web-only, cloud, watermark-gated free tier, unknown voice quality, small/bootstrapped, and it inherits the unanswered legal question of uploading purchased books to a third-party server — which **local rendering structurally avoids**.

### 2.5 Alexandria Audiobook (OSS) — the direct local threat

- **What:** open-source, same **Qwen3-TTS** family as Castwright; LLM script annotation with a second review pass, voice design from text, cloning, LoRA voice persistence, emotion/instruct control, browser editor, M4B export. **8 GB VRAM minimum.** 580★ and surging; single maintainer.
- **Gaps vs Castwright:** no series memory (within-book roster continuity only), no ASR/acoustic QA gate, no manuscript/cast/listen product UX, no companion app, no installer-grade onboarding, hobbyist support model.
- **Flanking it:** ebook2audiobook (~19k★) is single-voice but owns the community default and could absorb multi-voice via E2A-SML; abogen (~4.7k★) is adding "theatrical" multi-voice and ships Audiobookshelf integration.

**Honourable mentions:** Speechify ($29/mo headline, $139/yr effective; billing-complaint magnet; no per-character casting), Audible Virtual Voice (single-narrator catalogue flooding; its **human** full-cast Harry Potter productions define the premium benchmark), CastReader and Narratemi (young cloud full-cast entrants — watch list), NotebookLM (taught consumers that "AI can do two voices").

---

## 3. Messaging comparison matrix

| Dimension | **Castwright** | ElevenLabs | Spoken | Audibloom | MyNarratorAI | Alexandria (OSS) |
|---|---|---|---|---|---|---|
| Tagline | *Any book, performed by a full cast — effortlessly. Even in your own voice.* | "Turn your manuscript into a studio-quality audiobook in minutes" | "Free to use. Pay when Perfect." | "A full cast for your characters" | "Transform Your E-books into Full Cast Audiobooks" | (README, no brand) |
| Buyer | **Readers/listeners** | Authors + listeners (two-sided) | Authors | Indie authors | Readers | Hobbyist self-hosters |
| Hero claim | Full cast, series-true, on your machine | Most expressive voices | Ethical full-cast at scale | "Understands your characters" | Full cast + customisation | Free + local |
| Series consistency | **Yes — reader-side, automated** | No | Author-side (v2.1, new) | No | No | Within-book only |
| Local/private | **Yes — synthesis never leaves the machine** | No (no export from Reader) | No | No | No | Yes |
| Cost model | **Per book, once — electricity** | Credits/subscription | Per-word | Subscription/hours | Subscription | Free |
| Voice | Literary craftsperson, candid | Superlative tech | Warm writerly | Pragmatic indie | Enthusiast/feature-listy | None |
| Villain in their story | The one bored narrator; the metered cloud | Slow expensive studios | Big-tech exploitation | Manual copy-paste TTS | Boring narration | ElevenLabs pricing |

**Read of the matrix:** the tone lane Castwright occupies (literary, candid, anti-hype) is shared only with Spoken — but Spoken sells to authors. In the **reader** market, no one talks the way Castwright talks, and no one makes the ownership argument at all.

---

## 4. Pricing landscape

| Product | Model | Cost for a heavy reader (10 novels/yr) |
|---|---|---|
| ElevenLabs Reader Ultra | $11/mo sub, no export | $132/yr, **own nothing** |
| ElevenLabs creation | credits | "Free–$200 **per book**" (their words) |
| Speechify Premium | $139/yr effective | $139/yr, single narrator, word caps |
| Spoken | $20/5,000 words | ≈ **$1,600–2,000/yr** for 10 novels (author-side) |
| Audibloom | $39/mo or $29/book | $290–468/yr |
| MyNarratorAI | $5–25/mo | $60–300/yr |
| Audible Premium Plus | $14.95/mo | $179/yr, 12 credits |
| OSS (Alexandria etc.) | free + GPU | electricity |
| **Castwright** | **per book, on your GPU** | **electricity — and you own the files forever** |

**Implication:** Castwright's economics are an order of magnitude better for exactly its target buyer (the heavy series reader) — but the brand currently states this once, mid-narrative. It should be a front-line message with the arithmetic shown, in the candid register the guidelines already mandate.

---

## 5. Positioning map

Axes that split this market most cleanly: **who it's for** (rights-holders vs readers) × **where it runs** (cloud-metered vs your machine).

- **Rights-holders × cloud:** ElevenLabs Studio, Spoken, Audibloom, Wondercraft, platform-native tools — crowded.
- **Readers × cloud:** ElevenLabs Reader, Speechify, MyNarratorAI, CastReader — crowded, single-narrator or quality-unproven.
- **Rights-holders × local:** empty (no demand — authors want distribution).
- **Readers × local:** **Audiblez/ebook2audiobook (single-voice, hobbyist UX) … and Castwright.** The only occupant with a full-cast product and consumer polish.

The quadrant is real, growing (OSS star counts prove demand), and the only credible co-occupants are open-source projects whose gaps — series memory, QA gating, finished UX, a companion app — are precisely Castwright's strengths. **Category strategy: niche-to-own, not category-war.** Don't out-shout ElevenLabs; own "the reader's machine."

---

## 6. Gap analysis — unclaimed messaging whitespace

1. **Series consistency, reader-side.** "Book two sounds like book one" — no consumer product claims it. Spoken claims it for authors as of 5 June 2026. **Closing window; claim it first and loudest.**
2. **Ownership/permanence.** "Rendered once on your machine; no meter, no monthly fee, no server that can delete your library." Play.ht users lost every clone and render on 31 Dec 2025. ElevenReader forbids export. Unclaimed by anyone.
3. **The quality gate.** Every sentence acoustically checked and ASR-verified before assembly. No competitor — including Pozotron, which sells QA for *human* narration — markets automated content QA on AI renders. "The plainly broken lines never reach your ears" is honest, specific, and unique.
4. **The clean legal story.** Cloud consumer rivals quietly dodge "can I upload a book I bought?" Local rendering for personal use is structurally the cleanest position in the category. State it plainly, in the honest register.
5. **Family voices done right.** Voice cloning is table stakes everywhere — but *consent-tracked, on-device, never-leaves-home* family voices are claimed by no one. fs-38's differentiation is the privacy architecture, not the cloning.

---

## 7. Threats

| Threat | Likelihood | Impact | Mitigation |
|---|---|---|---|
| **ElevenLabs adds auto-casting to Reader** (they have v3 Dialogue + 200K-title library + $11/mo) | Medium-high, 6–18 mo | High | Own the lanes they can't follow: local, export-free ownership, series memory across *your* library. Speed on fs-38. |
| **Spoken extends series continuity and pivots reader-side** | Medium | Medium-high | Claim reader-side series consistency in all brand surfaces now; it's shipped product, not roadmap. |
| **Alexandria/ebook2audiobook reach feature parity locally, free** | High (capability), medium (polish) | Medium | Never compete on price with free. Compete on finished product: onboarding, cast UX, QA gate, companion app, series memory. Treat OSS with respect in all copy — its users are Castwright's earliest adopters. |
| **Platform catalogue flooding cheapens "AI audiobook"** (Virtual Voice complaints: robotic, flat) | Already happening | Medium | Don't market as "AI audiobook." Market as a **performance**. The brand lexicon already does this — enforce it harder. |
| **Big-tech multi-speaker models restricted or withdrawn** (Microsoft pulled VibeVoice weights) | Ongoing | Low-medium (opportunity) | Curated-engine approach + local weights = stability story. |

---

## 8. Recommended brand iterations (edits to `brand-guidelines.md`)

These preserve the tagline, voice, and visual system — the research validates all three. The changes sharpen *what we claim* and *against whom*, not *how we sound*.

1. **Add a fourth message pillar — Ownership.** Current pillars: full cast, series-consistent, your voice. Add: **"Yours, on your machine."** Draft copy in the house register: *"Rendered once, on hardware you own. No meter, no monthly fee, no server that can take your library away. The frontier never sees a chapter."* The narrative already says this beautifully; the guidelines never made it a pillar — and it is the least copyable claim in the field.
2. **Sharpen the series pillar into the spearhead claim.** Reorder pillars: series consistency second only to full cast, with the explicit line *"No one else does this for readers."* Window is closing (Spoken v2.1); first-claim advantage is real.
3. **Add a "proof, not promises" section.** The guidelines mandate honesty; give copywriters the receipts to be honest *with*: every line acoustically checked and transcript-verified; per-book cost arithmetic vs $11/mo–$200/book clouds; the Play.ht shutdown as the ownership cautionary tale (referenced factually, never gleefully).
4. **Add a competitive register ("how we speak about others").** Three rules consistent with the craftsperson persona: **(a)** name clouds' tradeoffs factually, never mock ("ElevenLabs makes stunning voices. It also meters them by the hour and keeps your audio." — both clauses true); **(b)** treat open source as kin, not competition — credit engines (Kokoro, XTTS, Qwen) visibly; the OSS community is the early-adopter base; **(c)** never punch at human narrators — the villain is the *one bored narrator forced to play everyone*, i.e. the economics, not the person. (The Audible full-cast Potter productions are the benchmark to honour, not deride.)
5. **Extend the lexicon.** Add: the conversion is a **performance**, never "AI narration" (catalogue-flooding has poisoned that term); the machine is **"your machine"/"at home"**, never "on-prem"/"edge"/"local-first" in consumer copy; cloning is **"your voice, with consent, kept at home"** — "deepfake" stays banned; avoid "open-source-powered" as a value claim (credit specifically instead).
6. **Add a positioning statement to anchor Section 1:** *For readers who love stories — especially series — Castwright is the only tool that turns any book into a full-cast performance on a machine they already own: every character in their own voice, consistent from book one to the last, with nothing leaving home.*
7. **Add a watch-list note to "Open items":** quarterly competitive refresh (Spoken releases, ElevenLabs Reader features, Alexandria/abogen capability) — this brief as the baseline.

**Risk of inaction:** the story ("nobody builds the cast") drifts out of date as Spoken/Audibloom market exactly that — the narrative's "why nobody's built it" framing should evolve to *"why nobody builds it for readers, at home"* at the next refresh.

---

## 9. Action items & next steps

**Quick wins (this week)**

1. Apply edits 1–7 above to `brand-guidelines.md` — I can draft the diff on approval.
2. Update `project-narrative.md`'s "Why this is broken" to acknowledge the 2025–26 full-cast wave and re-anchor the gap on *readers + home hardware* (keeps the candid contract intact).
3. Reserve the comparison claims while true: "the only full-cast audiobook tool that runs on your machine" — verify quarterly.

**Strategic (next quarter)**

4. Ship fs-38 (your voice) with the consent/privacy story front-and-centre — it converts the tagline's open promise before a cloud rival claims "family voices."
5. Content plan against the whitespace: a "why your audiobooks should live at home" essay (Play.ht case), a listen-first demo page (apprentice/swordsmith/dragon A-B against single-narrator), and an honest benchmark post (RTF, VRAM, cost arithmetic) — the register the OSS community respects and shares.
6. Decide the OSS relationship posture (acknowledge kinship in About page vs stay quiet) — recommend acknowledgment; it pre-empts "closed app built on open models" criticism.

**Key people worth consulting:** none internal (solo project); externally, alpha testers are the proxy panel for testing the new pillar copy.

---

## Sources

**Internal:** `brand/brand-guidelines.md` · `docs/project-narrative.md`

**Consumer tier:** [elevenreader.io/pricing](https://elevenreader.io/pricing) · [elevenlabs.io/audiobooks](https://elevenlabs.io/audiobooks) · [elevenlabs.io/v3](https://elevenlabs.io/v3) · [TechCrunch — Spotify×ElevenLabs (21 May 2026)](https://techcrunch.com/2026/05/21/spotify-launches-an-elevenlabs-powered-audiobook-creation-tool/) · [TechTimes — 200K titles on ElevenReader](https://www.techtimes.com/articles/317030/20260522/elevenreader-lands-200000-human-narrated-titles-11-subscription-takes-aim-audible.htm) · [speechify.com/pricing](https://speechify.com/pricing/) · [9to5Mac — Speechify celebrity voices](https://9to5mac.com/2026/02/02/speechify-adds-celebrity-voices-to-its-ai-voice-assistant/) · [KDP Virtual Voice](https://kdp.amazon.com/en_US/help/topic/GMPQGZAZJH6FF456) · [ACX Voice Replicas](https://www.acx.com/mp/blog/now-in-beta-narrator-voice-replicas-on-acx) · [Audible newsroom — AI narration & translation](https://www.audible.com/about/newsroom/audible-expands-catalog-with-ai-narration-and-translation-for-publishers) · [authors.apple.com — digital narration](https://authors.apple.com/support/4519-digital-narration-audiobooks) · [Google Play auto-narrated](https://play.google.com/books/publish/autonarrated/) · [mynarratorai.com](https://mynarratorai.com/)

**Author/publisher tier:** [spoken.press](https://www.spoken.press/) · [Spoken pricing](https://www.spoken.press/pricing) · [Spoken Studio V2 / Magic Mode](https://www.spoken.press/the-spoken-chronicle/spoken-studio-v2-magic-mode-amp-turnkey-full-cast-audiobook-creation) · [Spoken v2.1 release notes](https://www.spoken.press/the-spoken-chronicle/spoken-v21-release-notes-continuity-amp-creative-control) · [audibloom.io](https://audibloom.io/novel-to-audiobook/) · [audibloom.io/pricing](https://audibloom.io/pricing) · [murf.ai/pricing](https://murf.ai/pricing) · [wondercraft.ai/audiobook](https://www.wondercraft.ai/audiobook) · [TechCrunch — Meta acquires Play AI](https://techcrunch.com/2025/07/13/meta-acquires-voice-startup-play-ai/) · [Play.ht shutdown notice (kore.ai community)](https://community.kore.ai/t/important-update-playht-tts-support-discontinued-heres-what-to-do/5001) · [deepzen.io (maintenance)](https://deepzen.io/) · [pozotron.com](https://www.pozotron.com/) · [narakeet.com pricing](https://www.narakeet.com/docs/pricing/) · [respeecher.com — audiobooks](https://www.respeecher.com/podcasts-audiobooks) · [camb.ai](https://www.camb.ai/) · [Speechki — PitchBook](https://pitchbook.com/profiles/company/490990-60)

**Local/OSS tier:** [Alexandria Audiobook](https://github.com/Finrandojin/alexandria-audiobook) · [prakharsr/audiobook-creator](https://github.com/prakharsr/audiobook-creator) · [ebook2audiobook](https://github.com/DrewThomasson/ebook2audiobook) · [E2A-SML](https://github.com/DrewThomasson/E2A-SML) · [abogen](https://github.com/denizsafak/abogen) · [Audiblez](https://github.com/santinic/audiblez) · [epub2tts](https://github.com/aedocw/epub2tts) · [Pandrator](https://github.com/lukaszliniewicz/Pandrator) · [Microsoft VibeVoice](https://github.com/microsoft/VibeVoice) · [NotebookLM updates](https://blog.google/innovation-and-ai/models-and-research/google-labs/notebooklm-video-overviews-studio-upgrades/) · [HN — converter frustrations](https://news.ycombinator.com/item?id=44386097)

**Freshness caveats:** Speechify Premium+ cloning price and word caps are from third-party reviews; Play.ht sunset timeline is from migration guides, not first-party; DeepZen/Speechki statuses inferred (maintenance page / PitchBook flag); OSS star counts are point-in-time. Audible's third-party AI-narration policy shifts frequently — re-verify before citing publicly.
