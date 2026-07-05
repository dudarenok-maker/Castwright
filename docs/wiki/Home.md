# Castwright

**Any book, performed by a full cast — kept true, kept yours, book after book.**
*And soon: even in your own voice.*

## The problem this solves

Queue up a novel on most AI narrators today and you get one voice reading everyone — the thirteen-year-old apprentice, the seventy-year-old swordsmith, the dragon, and the narrator describing the dragon, all delivered in the same careful, slightly bored register. The cast collapses into a single observer. The story doesn't end; the *book* does.

Professional human narration is beautiful when it's right, but expensive, slow, and even at its best a single narrator can only hold so many distinct voices before the cast starts to blur. Basic text-to-speech serves accessibility well and serves fiction badly. Voice-cloning tools produce one stunning voice from a sample — not a cast. Fiction has a cast, fiction has tone that swings from furious to broken to deadpan across three pages, and fiction has narration that should recede for dialogue and step forward for a sunset. What most tools offer is dictation. What a book deserves is a performance.

## What Castwright does

A *cast-wright* is the one who builds the cast — that's the whole job. Drop in a manuscript (EPUB, PDF, MOBI, plain text, or paste it straight in) and Castwright reads it, finds the twenty or thirty characters who actually speak, and builds a voice profile for each one — age, gender, accent where the text implies one, personality, the vocal qualities the writer keeps gesturing at. The narrator gets a profile too. Then, chapter by chapter, it renders the audio: every line of dialogue in the right voice, every paragraph of narration carried by the narrator the book has earned, tone read from the surrounding prose so fear sounds like fear and dry humor lands dry.

It performs **five languages today — English, Russian, Spanish, French, and German** — and recognizes which one your manuscript is written in the moment you import it. A cast never crosses languages inside a single book.

Voices carry across a series. The narrator who read Book 1 keeps reading Book 2. A recurring character keeps their voice from one book to the next, even if the author renamed them along the way — the cast merge writes the old name into the new one's aliases, so the next book still finds them.

## It runs on the machine you already own

This is the whole bet: the expensive part — finding the cast, designing the voices, rendering the performance — happens locally, on a gaming PC, a gaming laptop, or an Apple Silicon Mac you already own. Per book, not per listen. The frontier never sees a chapter. No meter, no monthly fee, no server that can take your library away. A 6 GB GPU gets you started; 8 GB is the sweet spot.

## The path through the app

1. **[Getting Started](Getting-Started)** — install, let the app check its own readiness, and hear the bundled demo book before you import anything of your own.
2. **[Uploading a Book](Uploading-a-Book)** and **[Manuscript Management](Manuscript-Management)** — bring in a manuscript and shape it: chapter boundaries, speaker attribution, an LLM script-review pass.
3. **[Analysis & the Analyzer](Analysis-and-the-Analyzer)** and **[Reviewing Low-Confidence Speaker Tags](Reviewing-Low-Confidence-Speaker-Tags)** — Castwright reads the book and finds the cast; you confirm the calls it wasn't sure about.
4. **[Reviewing Cast & Assigning Voices](Reviewing-Cast-and-Assigning-Voices)** and **[Designing a Voice](Designing-a-Voice)** — meet the cast, assign or design a voice for every character.
5. **[Generating Audio](Generating-Audio)** and **[The Quality Gate](The-Quality-Gate)** — render the performance; every line clears an automatic acoustic and transcript check before it counts as done.
6. **[Listening & Revising](Listening-and-Revising)** and **[Exporting](Exporting)** — listen in the app, regenerate anything that doesn't land, then send the finished audiobook to your player, your library, or your phone.

See the sidebar for the full breadth — voice engines, multi-language support, mobile and the Companion app, and more.

## Where it stands

Castwright is a solo, source-available project — public repo, open beta, a fresh release most weeks. It runs end to end on Windows, Linux, and macOS with Apple Silicon acceleration picked up automatically. A fresh install ships with a sample book already cast, so there's something to hear in the first minute. It's in alpha: we'd love more testers, especially on Apple Silicon Macs and non-NVIDIA GPUs, where the fewest miles have been driven so far.

- **License:** source-available under the [Functional Source License](https://fsl.software/) (FSL-1.1-Apache-2.0) — it converts to plain Apache-2.0 two years after each release.
- **Release notes:** the brand-voice summary lives in [RELEASE_NOTES.md](https://github.com/dudarenok-maker/Castwright/blob/main/RELEASE_NOTES.md); the full technical detail for every shipped version is in the wiki's [Release Notes](Release-Notes) section.
- **About & credits:** the in-app `/about` page names the voice engines Castwright builds on — Kokoro, Coqui XTTS, and Qwen3-TTS. Open source is kin, not competition.
