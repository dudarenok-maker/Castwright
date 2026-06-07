# Castwright — brand & icon design

_Status: approved · 2026-06-07_

## Context

The product (currently "Audiobook Generator") is being **commercialised** as a consumer
brand and needs a name, a domain, and an app icon. This spec captures the brand decisions
made in the 2026-06-07 brainstorm and the asset set produced from them. Assets live in
`/brand`; exploration sheets in `/brand-concepts`.

## Positioning

A **consumer brand for fiction**, best-in-class for **series** — where the differentiator
shines: the same character keeps the **same voice across an entire series** (consistency +
traceability that single-narrator incumbents can't match).

**Three pillars**
1. **Auto full-cast** — every character gets their own distinct AI voice; a book becomes a
   performed production, not a single-narrator reading.
2. **Series-consistent voices** — voices stay true book after book across a saga.
3. **Your own / your family's voice** *(headline hook)* — custom voice design + personal
   voice cloning: e.g. a book read to your child in your voice, or voiced by your kid.

**Business model:** freemium. Free = Kokoro + basic features (real value, no paywall to
try). Premium = heavier/better models (Qwen, XTTS) + advanced features (custom design,
cloning). Same split on the Android companion app.

> ⚠️ Pillar 3 carries a consent/IP dimension (voice-cloning consent laws are tightening).
> Design in an explicit consent step + a "personal use only" stance for copyrighted books.

## Name

**Castwright** — reads like *playwright / shipwright*: "the one who crafts the cast."
Premium, ownable, implies skilled craft (the auto-casting engine). The `“`/`C` and the
"cast" root tie directly to the multi-voice differentiator.

**Availability (checked 2026-06-07)**
- `castwright.ai` — **registered & owned** (7 June 2026). Primary domain. `.ai` is on-brand for an AI product.
- `castwright.com` — taken (a US construction company, Class 37 — unrelated).
- `.io` — confirm at registrar (no public RDAP for `.io`); grab as defensive redirect.
- Google Play app name — free (user-confirmed). Apple App Store — no exact match.
- Trademark sweep — no software/audio/media/entertainment mark named "Castwright" found;
  only an unrelated construction LLC (Class 37). **Not legal clearance** — run a final
  TMview / USPTO / EUIPO / IP-Australia check (classes 9, 41, 42) before filing/spending.
- Grab typo redirects `castwrite.ai` / `castright.ai` if cheap.

## Tagline

**"Any book, performed by a full cast — effortlessly. Even in your own voice."**

## Icon

**Concept: Castwave.** A **ragged free waveform** — six bars with independent tops *and*
bottoms — in three colours (peach / magenta / white = three distinct voices = a full cast),
**sitting above an open-book "page swoosh."** The uneven bottom edge reaches toward the page,
connecting voice to book. Locked variant: *B2 waveform → deep reach* (tall voices nearly
touch the page) with the book lowered for air.

**Why it works:** the 3-colour, varied-height wave is the differentiator no single-narrator
app can claim; the ragged edge gives it life and connects to the book; it survives to ~16px.

**Geometry** (512×512 viewBox, tile `rx=118`): bars `width=30 rx=15` at
x = 104/158/212/266/320/374; (y,height) = (210,92)(116,256)(160,160)(92,284)(146,202)(200,108);
colours peach,peach,magenta,magenta,white,white. Book swoosh
`M110 416 C 170 392,226 392,256 412 C 286 392,342 392,402 416`, stroke white `15`, round caps.

## Reversible asset set (`/brand`)

| File | Use |
|---|---|
| `castwright-icon.svg` | Primary — colour on ink tile |
| `castwright-favicon.svg` | SVG favicon |
| `castwright-icon-onlight.svg` | Colour, no tile (3rd voice→ink) for light surfaces |
| `castwright-mono-ink.svg` | 1-colour positive |
| `castwright-mono-white.svg` | 1-colour reversed/knockout (dark bg) |
| `castwright-wordmark.svg` / `-reversed.svg` | Horizontal lockups (light / dark) |
| `export-png.html` | Zero-install browser exporter → PNGs at 1024/512/192/180/64/48/32/16 |

Reversibility rule: full-colour (own tile) primary; `-onlight` on light no-tile; `-mono-white`
on dark. Wordmark type previews in Georgia — **outline to paths for production**.

## Out of scope / follow-ups

- Final paid trademark clearance + registration (classes 9/41/42).
- ~~Register `castwright.ai`~~ — **done 7 June 2026.** Still worth grabbing defensive `.io` / typo redirects.
- Outline the wordmark font to paths; choose a production display typeface.
- Wire assets into the app (`index.html` favicon, PWA manifest, app-store icons,
  `apps/android` launcher icons) — separate implementation task, not part of this brand spec.
- Rename surfaces from "Audiobook Generator" → "Castwright" — separate task.
