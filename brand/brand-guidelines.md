# Castwright — brand guidelines

> **Castwright** · `castwright.ai`
> *Any book, performed by a full cast — effortlessly. Even in your own voice.*
> Manifesto line: **Many voices, one machine.**

Companion to: `README.md` (logo/icon assets) and
`../docs/superpowers/specs/2026-06-07-castwright-brand-design.md` (positioning + decisions).
Voice and design language are derived from `../docs/project-narrative.md` — the authoritative
source for how this product already sounds and looks.

---

## 1. Brand essence

**What it is:** the first tool that turns a book into a *full-cast performance* — every
character in their own voice, consistent across a whole series, even rendered in your own or
your family's voice.

**Why it exists:** fiction has a cast; single-narrator audiobooks collapse it into one bored
observer. Castwright gives the story back its voices — on hardware you already own.

**Personality:** a thoughtful craftsperson, not a hype machine. Literary, candid, quietly
confident. Loves the *listener's* experience and says the honest version of everything.

---

## 2. Tagline & messaging hierarchy

The line the brand lives or dies on. It **leads every surface** — don't bury it, don't
paraphrase it per page. Headlines can vary; the tagline is the constant.

- **Primary tagline** *(site hero sub, App Store, social bios, deck covers, email sign-off):*
  > **Any book, performed by a full cast — effortlessly. Even in your own voice.**
- **Manifesto line** *(About/origin, footers, merch):* **Many voices, one machine.**
- **Short form** *(≤ 40 chars — ad headlines, OG alt text, tight UI):* **Any book, fully cast.**
- **Hero headline** *(the on-page H1 — pairs **with** the tagline, never replaces it):*
  *Every character. Their own voice. Every book in the series.* — with the primary tagline
  running as the sub beneath it.

**Rule:** the primary tagline is fixed wording. The hero headline and section heads flex;
the tagline does not.

---

## 3. Verbal voice & tone

Castwright writes like the narrative reads: first person where it fits, specific, sensory,
unhurried, dry-witted, never breathless.

**Principles (do)**
- **Lead with the listening, not the tech.** "Hear a thirteen-year-old apprentice and a
  seventy-year-old swordsmith as two different people" beats "AI multi-voice synthesis."
- **Be specific and sensory.** Name the apprentice, the dragon, the forge. Concrete over abstract.
- **Say the honest version.** State limits plainly ("honest, not alarming"). Trust earns the sale.
- **One idea carries each line.** Mirrors the headline rule: the bold word holds the meaning;
  the rest is context.
- **Confident, opinionated, calm.** "That's the bet I'm taking." Take a position; don't hedge into mush.
- **A little dry wit is on-brand.** Sparingly. (The product is literally a "cast-wright.")

**Avoid (don't)**
- AI hype words: *revolutionary, game-changing, unleash, supercharge, next-gen, magical.*
- Feature lists with no "why." Every feature names the listener payoff.
- Overselling or hiding tradeoffs. No exclamation-mark energy.
- Corporate filler: *seamless, robust, cutting-edge, solutions, leverage, empower.*
- Talking down. The reader is a reader — smart, time-poor, allergic to fluff.

**Naming the things**
- The product: **Castwright** (one word, capital C). Domain shown as *Castwright.ai* only in
  lockups/footers.
- The output: a **full-cast audiobook** / a **performance** (not "a render," not "a file") in
  consumer copy; "render" is fine in technical/dev contexts.
- The people in a book: the **cast**; the lead reader is the **narrator**.
- The personal-voice feature: **your voice** / **family voices** (with consent) — never "deepfake."

### Sample copy (use as the reference register)

- **Hero headline:** *Every character. Their own voice. Every book in the series.*
- **Hero sub:** *Castwright turns a book into a full-cast performance — and keeps each voice
  true from book one to the last. Even in your own voice.*
- **Primary CTA:** *Cast your first book* · **Secondary:** *Hear a sample*
- **Pillar 1 (full cast):** *No more one bored narrator. The apprentice sounds thirteen; the
  swordsmith sounds seventy and a forge.*
- **Pillar 2 (series-consistent):** *Book two should sound like book one. Castwright remembers
  your cast — even when an author renames someone mid-series.*
- **Pillar 3 (your voice):** *Read a bedtime story in your own voice, even when you're away —
  or let your kid be the hero. Your voices, with your permission, stay on your machine.*
- **Empty state (library):** *No books yet. Drop in an EPUB, PDF, or paste a chapter — we'll
  find the cast.*
- **Error (analysis hiccup):** *That chapter didn't parse cleanly. We kept the rest; retry just
  this one.* (Honest, scoped, no blame, no jargon.)
- **App Store short:** *Turn any novel into a full-cast audiobook. Every character gets their
  own voice, consistent across a whole series — rendered on your own device, even in your voice.*

---

## 4. Typography

Inherited from the running app's design language — keep it.

- **Primary (UI + display): General Sans** (Fontshare) — the typeface the app actually loads; Neue Montreal / Inter sit in the CSS stack as fallbacks (`--font-sans` in `../src/styles.css`).
- **Editorial / book-title serif: Lora** (Google Fonts) — already loaded by the app (`--font-serif`);
  for book/album covers, titles, and the logotype; **Georgia** is the system fallback.
  **Outline it to paths in exported logos.**
- **Headline rule (signature):** every h1/h2 is an otherwise medium-weight sentence with **one
  bold span** — the bold word carries the meaning, the rest is context. Do this everywhere copy
  appears; it's a recognisable verbal-visual tic.
- **Hierarchy:** medium for headings, regular for body, bold reserved for the one-word emphasis
  and primary buttons. Don't bold whole headlines.

---

## 5. Colour system

Authoritative tokens live in `../src/styles.css`. Five colours, each with **one job** — restraint
is the brand.

| Token | Hex | Job |
|---|---|---|
| **Canvas** (cream) | `#FFFDFB` | background |
| **Ink** | `#0F0E0D` | text / dark surfaces |
| **Peach** | `#F79A83` | **action only** — buttons, drag rings, drop indicators, selected/active state. Nothing idle uses peach. |
| **Magenta** | `#A43C6C` | **brand** + the horizontal accent gradient |
| **Deep purple** | `#3C194F` | **series-context** — reused voices, library matches, anything belonging to a book beyond the current one |

**Signature gradient (the hero device):** the four-stop vertical
`#0F0E0D → #3C194F → #A43C6C → #F79A83`. Use it **no more than three times per page** — an
end-of-page CTA / album-cover hero, the active progress bar, and one "magic moment" (analysis,
cast confirmation, or the Listen hero). It is the single most recognisable brand asset; scarcity
keeps it special.

**Rules**
- No hex literals in app code — reference the CSS custom properties.
- Peach is sacred to *action*. If it isn't clickable or actively-happening, it isn't peach.
- The icon's "three voices" use peach / magenta / (canvas or ink, per theme). Deep purple is for
  series/library context, not the mark.
- Accessibility: ink-on-canvas and canvas-on-ink both clear AA. Peach and magenta on canvas are
  for large text / UI accents, not body copy; pair with ink for text.

---

## 6. Logo (summary)

The **Castwave** mark — a ragged free waveform (three voices) above an open-book page swoosh.
Full reversible set + theme-responsive pair in `README.md`. Clear space ≥ one bar width; holds
to ~16px; outline wordmark type for production.

---

## 7. Open items

- Outline the editorial serif (**Lora**) to paths in the wordmark export (the SVGs declare
  `'Lora', Georgia, serif` and fall back to Georgia until outlined).
- Reframe `../docs/project-narrative.md` into the Castwright brand once this is signed off
  (retitle, weave the name + pillars in — keep the candid first-person voice intact).
- Optional later: sonic identity / audio logo + a "house narrator" voice persona.
