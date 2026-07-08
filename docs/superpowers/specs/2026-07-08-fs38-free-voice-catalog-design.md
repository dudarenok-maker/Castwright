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
- **Fetchability:** LibriVox's public API (base feed `librivox.org/api/feed/audiobooks/`,
  queryable by `id`/`title`/`author`/`genre`, with an `extended=1` mode that includes
  per-section reader data — confirmed by reading the API's actual source, not the
  `/api/info` docs page cited in an earlier draft of this spec, which is not itself an
  endpoint) plus archive.org's metadata API, which enumerates stable, direct per-chapter
  MP3 URLs for a given book identifier (confirmed live against a real item). No rehosting
  needed — the wizard fetches live from the resolved URL at clone time. **Neither API
  supports resolving "which books has reader X narrated" directly** — see §3 for how the
  curation model works around that.
- **Coverage:** EN is massive; ES/FR/DE have solid dedicated sections; RU exists but is
  noticeably thinner.

Common Voice, OpenSLR, and M-AILABS were all rejected for the **in-app integration**
specifically (non-commercial-only licensing on some corpora, link-rot risk on dead/mirrored
hosts, bulk-archive-only access with no stable per-clip URL, or a license scope that covers
"voice tech training" but is ambiguous about identifiable-voice cloning specifically). A
separate, lighter research pass for the wiki page (§5) found that Wikimedia Commons'
language-specific spoken-word/Spoken-Wikipedia collections are worth recommending there
(CC-BY-SA is a clear license, and the per-language collections are substantial) — but
Commons is **deliberately kept out of the in-app integration too, for a reason distinct from
the others**: CC-BY-SA carries a ShareAlike clause, and if a voice clone is treated as a
derivative of the source recording, ShareAlike could arguably extend to the *generated
output* — an acceptable judgment call for a user manually cloning their own picked file, but
not a risk to build an automated commercial pipeline around. PD-only (LibriVox) is the
in-app bar; CC-BY-SA is a fine flagged wiki recommendation. Common Voice, OpenSLR, and
M-AILABS did not resurface as competitive against the native-language alternatives the wiki
research pass found, so none of the three appear in the final §5 table.

## 3. Curation model & data shape

**Revision note:** an earlier draft of this section proposed hand-tagging every reader by
ear (a human listens to a clip and judges gender/age). A second adversarial pass quantified
that as 150-200+ subjective, unbounded-labor entries to deliver real per-bucket choice across
5 languages × 3 genders × 4 age-ranges — not "a few dozen," and with no named owner. Rejected
outright. Curation is now a two-stage **automated pipeline**, run as an offline
build/maintenance job (not a live request path, not part of the wizard) that produces a data
file the wizard reads:

```
{ readerId: string, displayName: string, language: 'en'|'es'|'fr'|'de'|'ru',
  gender: 'male'|'female'|'neutral', ageRange: 'child'|'teen'|'adult'|'elderly',
  confidence: 'coarse' | 'refined', bookIds: string[] }
```

`gender`/`ageRange` reuse the exact enum already defined for `characterHint` in
`openapi.yaml` (used today by the Gemini prebuilt-voice picker) — the free-voice catalog
speaks the same persona vocabulary as voice design, not a new one.

**Stage 1 — deterministic reader discovery (no LLM, no manual labor).** Page through
LibriVox's audiobooks feed per language with `extended=1` (confirmed in §2 to include each
section's `readers[].reader_id`/`display_name`); this is what supplies `bookIds` — a reader
is only discoverable *forwards*, per book, so the crawl itself builds the reverse index that
manual research would otherwise have had to construct by hand. Output: every
`{readerId, displayName, language, bookIds[]}` the crawl finds, capped by however large a
scope Wave 3 sizes it to (e.g. top-N readers by catalog size per language, or the full
per-language catalog) — coverage is now bounded by crawl scope and API budget, not by hours
of human listening.

**Stage 2 — classification, tiered by what's configured:**

- **Local tier (always runs, no external dependency):** a deterministic acoustic pass —
  average fundamental frequency (F0/pitch) over one representative clip per candidate reader,
  computed via a lightweight estimator (autocorrelation-based, buildable on the existing
  `numpy` dependency without a new heavy library, or `librosa`'s pitch tracker if that's an
  acceptable new dep — Wave 3's call). F0 is a well-established, reasonably reliable proxy
  for **gender** (adult-male vs. adult-female/child ranges are well separated) and can
  distinguish **child vs. not-child** on elevated pitch, but is honestly **not** capable of
  reliably separating teen/adult/elderly from pitch alone — those default to `adult` at
  `confidence: 'coarse'` when only the local tier ran.
- **Gemini tier (upgrade, when `GEMINI_API_KEY` is configured — same opt-in convention as
  `ANALYZER=gemini` elsewhere in this codebase):** the representative clip is sent to
  Gemini's multimodal audio input (new wiring — today's `server/src/tts/gemini.ts` only
  handles Gemini audio *output*/TTS, not audio-in classification, though it's the same
  `@google/genai` client) with a classification prompt, producing the full
  `gender`/`ageRange` judgment (including teen/elderly distinctions the local tier can't
  make) at `confidence: 'refined'`. This is an **upgrade path, not a symmetric fallback** —
  local and Gemini are not equally capable, and the spec is explicit about that asymmetry
  rather than implying parity.

**Human role shrinks to optional spot-checking, not required labor:** no one is required to
listen to every entry before it ships. `confidence: 'coarse'` entries are a known-weaker
signal the UI can surface honestly (e.g., de-emphasized or labeled "approximate" for
non-child age brackets tagged without Gemini). A lightweight "this doesn't match" report
affordance on a catalog entry (Wave 3 UI detail) feeds a re-classification queue instead of
requiring proactive human QA of the whole list up front.

**Freshness:** re-running Stage 1 periodically (a scheduled job, not a live per-request path)
picks up a known reader's newly-published books automatically — still not something a human
has to remember to do by hand, since it's the same deterministic crawl, just re-triggered.

Wave 3 planning owns the exact job/scheduling mechanics, the pitch-estimator implementation
choice, and the Gemini prompt/schema — and should confirm the LibriVox feed responds
successfully to a normal server-side request before building on it (direct fetches during
this spec's review were blocked with a 403, consistent with bot-blocking on the request, not
confirmed evidence of an outage, but unverified either way). This spec fixes the pipeline
shape (deterministic discovery → tiered classification → confidence-tagged output) and the
data shape, not the wire protocol or exact job cadence.

## 4. Wizard flow & rights handling

"Browse free voices" is a third entry point in the existing clone/imported wizard (fs-38
spec §4), alongside "Record" and "Upload your own." **It runs as a preliminary sub-step
ahead of the base wizard's step 1** rather than slotting into step 2 ("Record or upload")
directly: the base spec's step 1 (consent/attestation first) is ordered that way because the
*content* of the attestation needs to be known before the rest of the flow — for a personal
clone that means the person's name (to bake into the reading script); for a catalog entry it
means which reader/book/rights-note apply, which isn't knowable until a specific entry is
picked. So the flow is: **pick a catalog entry first → then enter the base wizard's step 1
with `sourceAttestation` pre-filled** (source: LibriVox, book/reader identity, rights note) —
the user confirms/edits rather than typing from scratch, and every step from there on
(quality-check, Whisper transcript, name & shelve) runs exactly as it does for a manual
upload. Provenance is `imported`, unchanged from the existing spec.

**Fetch failure is a first-class state, not an edge case left to whatever the browser does
by default:** if the archive.org fetch times out, 404s, or the source is otherwise
unreachable, the catalog entry shows an inline error with **Retry** and a **"Switch to
Upload instead"** action that hands off to the existing manual path with no lost context —
never a silent hang, never a dead end.

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
| DE | LibriVox; Wikimedia "Gesprochene Wikipedia" German (mixed CC-BY-SA/CC-BY per file, same as the other languages' Commons entries — largest non-LibriVox collection found for any language by file count, ~1,748 files in the category, though total-hours figures cited elsewhere for this collection are unverified and should be treated as illustrative, not confirmed) | Vorleser.net (reads as "free to listen," not clearly "free to reuse") |
| RU | LibriVox RU (thin — title count cited elsewhere as ~60 is unverified; confirmed only as "visibly smaller than the other 4 languages," not to an exact number) | Internet Archive RU audiobook collection (mixed/unclear per-item provenance); Baza Knig / Babavera (likely restrictive — mentioned as existing, not recommended) |

Russian is called out explicitly as the thinnest language — genuinely ~2 usable options
today. The list is not padded to match the other languages' length; an honest gap is more
useful than false parity. Exact title/hour counts throughout this table are sourced from
research-agent passes, not independently re-verified line-by-line; treat them as directional,
not as numbers to cite externally without a fresh check.

## 6. Phasing

Ships entirely within fs-38 Wave 3 (the clone-pipeline wave, not yet planned in detail) —
both the in-app catalog and the wiki page land together with Wave 3, rather than the wiki
page shipping early as a standalone docs PR. This spec is the input Wave 3's plan absorbs
for the catalog/wiki portion of that wave; it does not itself re-litigate Wave 3's endpoint
contracts, ffmpeg ingest mechanics, or consent-form UI, which remain owned by the base fs-38
spec and the Wave 3 plan.

## 7. Out of scope

- A human QA pass over every catalog entry before it ships (§3) — spot-checking and a
  user-facing "report a mismatch" affordance replace mandatory manual review.
- Any source beyond LibriVox for the **in-app** integration (Common Voice etc. stay
  wiki-only, caution-tier or omitted).
- Expanding language coverage beyond the 5 currently shipped (EN/ES/FR/DE/RU).
- Rehosting any third-party audio ourselves — everything is fetched live from its source at
  clone time.
