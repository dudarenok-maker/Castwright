---
status: stable
shipped: 2026-05-13
owner: null
---

# Audio tag vocabulary (UI ↔ parser sync)

> Status: stable
> Key files: `src/lib/audio-tags.ts`, `server/src/parsers/audio-tags.ts`
> URL surface: none
> OpenAPI ops: none (tags ride inline inside `Sentence.text`)

## What this covers

Inline `[tag]` markers like `[whispers]` live inside `sentence.text` strings from analysis through to the TTS provider. Both the UI render layer and the server parser layer must share an identical vocabulary so unknown tokens fall through as literal text and known tokens are surfaced as styled spans (UI) and TTS prosody hints (server).

## Invariants to preserve

- `AUDIO_TAGS` array contents must be identical in both files:
  - `src/lib/audio-tags.ts:5-8`
  - `server/src/parsers/audio-tags.ts:6-9`
  - Both export: `['emphatic', 'shouting', 'whispers', 'laughs', 'sighs', 'excited', 'hesitant']` (7 entries, ordered).
- `splitAudioTagSpans` regex is `/\[([a-z]+)\]/gi` — letters only inside brackets, so footnote markers (`[1]`, `[12]`), page refs (`[p.42]`), and citations (`[Doe 2020]`) are NOT eaten by the regex (`src/lib/audio-tags.ts:17`).
- Unknown letter-only tokens fall through to text: `[bracket]` where `bracket` is not in `AUDIO_TAGS` produces a text span containing the literal `[bracket]`, not a `tag` span (`audio-tags.ts:36-37`).
- Tag matching is case-insensitive at parse time but stored lowercase (`audio-tags.ts:36`). `[WHISPERS]`, `[Whispers]`, and `[whispers]` all render identically.
- The `Span` discriminated union is `{ kind: 'text', text } | { kind: 'tag', tag, raw }`. Renderers must handle both; the `raw` field preserves the original bracket form for tooltips/debug.

## Acceptance walkthrough

Run `npm run dev`, open the manuscript view of any book in mock mode.

1. **Known tags render as badges** — a sentence reading `"Foo [whispers] bar [laughs] baz"` shows three text spans split by two badge spans coloured per tag.
2. **Unknown tags pass through** — sentence `"Foo [bracket] bar [unknown] baz"` renders entirely as plain text containing literal `[bracket]` and `[unknown]`. No badge.
3. **Footnotes survive** — sentence `"Foo bar.[1] Baz.[p.42]"` renders without consuming `[1]` or `[p.42]`. Both stay as literal text.
4. **Case insensitivity** — `[WHISPERS]`, `[Whispers]`, `[whispers]` all render as the same badge.
5. **Adjacent tags** — `"[whispers][laughs] foo"` produces two adjacent badges with no text span between.
6. **Vocab sync test (manual)** — diff the two `AUDIO_TAGS` arrays: `diff src/lib/audio-tags.ts server/src/parsers/audio-tags.ts | grep AUDIO_TAGS -A 4`. The seven entries must be identical and in the same order.

## Out of scope

- The TTS provider's interpretation of each tag (varies by engine — Coqui ignores most, Gemini honours emotion tags).
- Custom user-defined tags — v1 vocabulary is closed.
- Inline tag editing in the manuscript view — user-driven retagging is not in v1.
