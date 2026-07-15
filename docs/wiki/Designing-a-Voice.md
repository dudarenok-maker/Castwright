# Designing a Voice

Kokoro reads from a fixed catalogue and Coqui clones from a sample — both work, but neither handles a twenty-plus-character book without a few voices starting to repeat. Qwen VoiceDesign takes a different approach: describe a persona, and it designs a bespoke voice to match, built from how that character actually speaks in your book rather than picked off a shelf.

Open a cast member's profile drawer — a character with no voice yet is flagged "Needs voice" — and Castwright drafts a starting **voice persona** straight from the text: age, accent, the vocal qualities the writer kept gesturing at. Below, Insp. Cray — carried across from *The Drowning Bell* into *Saltgrave* at 97% match confidence — shows the same drawer mid-series: engine set to **Qwen (bespoke)**, a persona textarea with **Regenerate** for a fresh draft, and a **Play 12s sample** button to audition the current voice before touching anything.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="images/designing-a-voice/01-persona-input-dark.png">
  <source media="(prefers-color-scheme: light)" srcset="images/designing-a-voice/01-persona-input.png">
  <img alt="Voice profile drawer — persona and engine picker" src="images/designing-a-voice/01-persona-input.png">
</picture>

Edit the persona text (or click "Regenerate" for a fresh draft), pick **Qwen
(bespoke)** as the voice engine, and click **Design & preview**. Generating
persona text needs a `GEMINI_API_KEY` set from Account → Server
Configuration (or in `server/.env` for CI / power users) — the drawer warns
inline when it's missing.

Design runs on the GPU, one character at a time. The top bar shows a
"Designing · N%" pill while it works, and it's safe to close the drawer —
progress keeps going in the background, so you can move on to the next character while this one finishes.

The **narrator** is the one exception to "Needs voice": a newly analysed book seeds it with a consistent folkloric Qwen voice (and a name in the book's own language) up front, so it starts out designed rather than blank. You can still redesign it like any other character, and a rename or redesign survives a re-parse.

## Emotion variants

A single flat voice gets you *who's* speaking; emotion variants get you *how*. Once a character has a designed base voice, the profile samples directly from that design (no library voice matched yet) and the button becomes **Design & compare** for another pass. Saving pins the voice across the whole series, so it travels with this character into book two the way it should. Approving a redesign from **Design & compare** replaces the base voice in place — and because a character's emotion variants are derived from that base, they're cleared at the same time and re-mint from the new voice, rather than lingering on the old embedding they no longer match. From here, per-emotion variants — Whisper, Angry, and any other tags used in the manuscript — become available to design individually, so a character who's furious in chapter three actually sounds furious. Below, Wren — a thirteen-year-old apprentice, designed from 13 lines of dialogue — already carries 4 emotion variants.

![Character drawer showing a designed base voice with 4 emotion variants](images/designing-a-voice/02-emotion-variants.png)

## Designing for one character vs. the full cast

Doing this one character at a time works, but a twenty-voice cast makes for twenty errands. **"Design full cast"** (next to the cast table) opens a scope picker instead: **Base voices** for whoever still needs one, **Emotion variants** for tagged emotions missing a take, or **Both** — bases first, then their variants — with live counts of exactly how much work each choice queues. Designs still run one at a time on the GPU under the hood; the picker itself is safe to close while the queue works through it. Below, *The Harborlight Ledger* — one character (Harbor Clerk) still needs a base voice, so that's the only live option; emotion variants are already "all done" for the rest of the cast:

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="images/designing-a-voice/full-cast-scope-picker-dark.png">
  <source media="(prefers-color-scheme: light)" srcset="images/designing-a-voice/full-cast-scope-picker.png">
  <img alt="Full-cast scope picker — Base voices, Emotion variants, and Both, each with a live task count" src="images/designing-a-voice/full-cast-scope-picker.png">
</picture>

Picking a scope starts the queue immediately — no separate confirm step. The top bar's "Designing · N%" pill tracks overall progress, and the character's own profile drawer shows its own waveform while its turn comes up:

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="images/designing-a-voice/design-in-progress-dark.png">
  <source media="(prefers-color-scheme: light)" srcset="images/designing-a-voice/design-in-progress.png">
  <img alt="Voice profile drawer mid-design — "Designing voice…" with a live waveform" src="images/designing-a-voice/design-in-progress.png">
</picture>

Next: [Voice Engines](Voice-Engines).
