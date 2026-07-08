# fs-38 addendum — Free voice catalog (LibriVox) + free-voice-sources wiki page

> Spec (validated design) · 2026-07-08 · fs-38 / [#624](https://github.com/dudarenok-maker/AudioBook-Generator/issues/624)
> Extends: [`docs/superpowers/specs/2026-07-04-fs38-voices-library-design.md`](2026-07-04-fs38-voices-library-design.md) (§4 "Capture & consent wizard", `imported` provenance)
> Ships as part of: fs-38 Wave 3 (clone pipeline) — see that spec's "Wave sequencing" section. Does not block Waves 1/2, and is not itself blocked by anything already merged.

## 1. Goal & scope

The `imported` provenance class already exists in the fs-38 spec ("cloned from a
freely-available/public sample") but has no actual source of samples wired to it. This
addendum adds one: a curated, persona-taggable catalog of free voices a user can clone
*instead of* recording/uploading their own — positioned as a third option alongside the
existing "Record" / "Upload your own" entry points in the clone wizard, never replacing or
gating them.

The trigger use case: a user casting a character (e.g. "a 12-year-old girl", "a 70-year-old
grandma") wants a *real* voice matching that archetype as an alternative to Qwen's synthetic
voice design — not "pick a narrator I like the sound of," but "find a voice that fits this
persona." Covers the 5 currently-shipped languages (EN, ES, FR, DE, RU); Russian is expected
to have visibly fewer catalog entries than the other four (see §5) — a real coverage gap
worth surfacing to the user rather than papering over.

A companion wiki page (§5) covers a broader, non-integrated set of free-voice sources per
language, for anyone who wants to hunt manually — most useful precisely where the in-app
catalog is thin (Russian above all).

## 2. Source selection (researched, not guessed)

Candidates evaluated: LibriVox, Mozilla Common Voice, OpenSLR, M-AILABS Speech Dataset,
Wikimedia Commons spoken-word. Only **LibriVox** clears the bar for in-app integration:

- **License:** explicit public-domain dedication on the recordings themselves — "people can
  do anything they like with them." Cleanest verdict of any candidate. Still not the same as
  a reader explicitly consenting to *being AI-cloned* — see §4.
- **Shape:** one narrator reads continuously for a whole chapter — exactly what cloning
  needs. (Common Voice, by contrast, is thousands of anonymous speakers each reading one
  unrelated few-second sentence — no "narrator" to pick, and no single speaker has enough
  continuous audio to clone well.)
- **Fetchability:** official catalog API (`librivox.org/api/info`, queryable by language/
  reader) plus archive.org's metadata API, which enumerates stable, direct per-chapter MP3
  URLs for a given book identifier. No rehosting needed — the wizard fetches live from the
  resolved URL at clone time.
- **Coverage:** EN is massive; ES/FR/DE have solid dedicated sections; RU exists but is
  noticeably thinner.

Common Voice, OpenSLR, M-AILABS, and Wikimedia Commons were all rejected for the **in-app
integration** specifically (non-commercial-only licensing on some corpora, link-rot risk on
dead/mirrored hosts, bulk-archive-only access with no stable per-clip URL, or a license scope
that covers "voice tech training" but is ambiguous about identifiable-voice cloning
specifically). A separate, lighter research pass for the wiki page (§5) found that
Wikimedia Commons' language-specific spoken-word/Spoken-Wikipedia collections are in fact
worth recommending there (CC-BY-SA is a clear, if attribution-bound, license, and the
per-language collections are substantial) even though they didn't clear the in-app bar;
Common Voice, OpenSLR, and M-AILABS did not resurface as competitive against the
native-language alternatives that pass found, so none of the three appear in the final §5
table.

## 3. Curation model & data shape

One small hand-maintained list is the only curated artifact:

```
{ readerId: string, language: 'en'|'es'|'fr'|'de'|'ru',
  gender: 'male'|'female'|'neutral', ageRange: 'child'|'teen'|'adult'|'elderly' }
```

`gender`/`ageRange` reuse the exact enum already defined for `characterHint` in
`openapi.yaml` (used today by the Gemini prebuilt-voice picker) — the free-voice catalog
speaks the same persona vocabulary as voice design, not a new one.

This list is vetted by hand, per reader, once — a few dozen entries across 5 languages is
the expected scale, fewer for Russian. It is **not** a list of specific clip URLs: the
actual books/chapters available for a tagged reader are resolved live via LibriVox's catalog
API (by readerId) and archive.org's metadata API (direct chapter URLs from a book
identifier), so the content itself stays current without repeated manual re-curation.
Wave 3 planning owns the exact endpoint/caching contract for this resolution step; this spec
fixes the data shape and the "hand-tag readers, live-fetch content" split, not the wire
protocol.

## 4. Wizard flow & rights handling

"Browse free voices" is a third entry point in the existing clone/imported wizard (fs-38
spec §4), alongside "Record" and "Upload your own." It opens a filter — language (defaults
to the book's language) × gender × age-range — over the tagged-reader list, with a preview
player per reader streamed live from the resolved archive.org URL. Selecting a reader/clip
feeds it into the **same** ffmpeg-ingest → quality-check/Whisper-transcript →
consent-attestation → clone pipeline as a manual upload; from the pipeline's perspective this
is just another audio source, not a new mechanism. Provenance is `imported`, unchanged from
the existing spec.

The consent/attestation screen pre-fills the existing `sourceAttestation: { source, rightsNote,
attestedAt }` field (no new consent mechanism) with a standard note making explicit: the
recording is public-domain-dedicated, but the reader did not specifically consent to being
AI-cloned. Same caveat on every catalog-sourced entry, surfaced the same way any other
`imported` voice's attestation is surfaced.

Manual record/upload remain the default, primary path in the wizard and are functionally
unchanged by this addition — the catalog is strictly additive.

## 5. Wiki page: broader per-language source list

A new wiki page (e.g. `Free-Voice-Sources.md`) lists free/open voice sources per language for
manual use outside the app — most useful when the in-app LibriVox catalog is thin for a
user's language. Sources are researched (WebSearch/WebFetch-verified live, not guessed) and
split into two tiers per language, because **licensing has to actually clear before a source
gets recommended, not just "exists and is free":**

- **Recommended** — clear, favorable license (public domain or CC-BY-SA with attribution).
  Safe to use without further digging.
- **Use with caution** — the site's own reuse rights are unclear or restrictive-leaning.
  Listed only as a manual starting point with an explicit "verify the license yourself"
  caveat — never presented as cleared.

| Language | Recommended | Use with caution |
|---|---|---|
| EN | LibriVox; Wikimedia Commons Spoken Wikipedia (CC-BY-SA); LoyalBooks (mirrors PD); Project Gutenberg audiobooks (PD) | Internet Archive general spoken-word collections (mixed per-item licensing) |
| ES | LibriVox; LoyalBooks ES; Wikimedia Commons Spanish spoken-word (CC-BY-SA) | AlbaLearning (site framing is "personal use," reuse rights unclear) |
| FR | LibriVox; Wikimedia Commons French spoken-word (CC-BY-SA) | Litteratureaudio.com (no stated reuse license); Audiocité (cites CC/PD sources but pulls content on complaint — verify per recording); BnF/Gallica PD holdings (not deeply verified) |
| DE | LibriVox; Wikimedia "Gesprochene Wikipedia" German (CC-BY-SA, ~400+ hrs — the largest non-LibriVox option found for any language) | Vorleser.net (reads as "free to listen," not clearly "free to reuse") |
| RU | LibriVox RU (thin — ~60 titles, but the cleanest license) | Internet Archive RU audiobook collection (mixed/unclear per-item provenance); Baza Knig / Babavera (likely restrictive — mentioned as existing, not recommended) |

Russian is called out explicitly as the thinnest language — genuinely ~2 usable options
today. The list is not padded to match the other languages' length; an honest gap is more
useful than false parity.

## 6. Phasing

Ships entirely within fs-38 Wave 3 (the clone-pipeline wave, not yet planned in detail) —
both the in-app catalog and the wiki page land together with Wave 3, rather than the wiki
page shipping early as a standalone docs PR. This spec is the input Wave 3's plan absorbs
for the catalog/wiki portion of that wave; it does not itself re-litigate Wave 3's endpoint
contracts, ffmpeg ingest mechanics, or consent-form UI, which remain owned by the base fs-38
spec and the Wave 3 plan.

## 7. Out of scope

- Automated voice-characteristic analysis (pitch/age heuristics) to auto-derive tags —
  rejected in favor of hand-maintained tags; revisit only if the hand-maintained list proves
  too costly to keep current.
- Any source beyond LibriVox for the **in-app** integration (Common Voice etc. stay
  wiki-only, caution-tier or omitted).
- Expanding language coverage beyond the 5 currently shipped (EN/ES/FR/DE/RU).
- Rehosting any third-party audio ourselves — everything is fetched live from its source at
  clone time.
