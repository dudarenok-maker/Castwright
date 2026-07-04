# Multi-language Support

Castwright isn't an English-only tool that happens to tolerate other languages — it performs **five languages today, with the same full-cast craft as English: English, Russian, Spanish, French, and German**. The manuscript is read in its own language, every character gets a voice that speaks it, and the cast's tone and descriptions stay written in the book's own tongue rather than flattened into something English-shaped.

Language is auto-detected from the manuscript the moment you import it, and shown on the Confirm details screen before you commit to anything — a language Castwright can't perform yet falls back to English rather than guessing and getting it wrong silently.

Pasting in the Russian variant of the Coalfall Commission fixture
(`server/src/__fixtures__/the-coalfall-commission.ru.md`) auto-selects
**Russian** in the Language field and shows the "Auto-detected Russian —
verify" chip, plus a note that Russian books narrate with designed Qwen
voices — you'll design a voice for the narrator and each speaking character
in the cast view (Qwen is the engine behind every non-English cast; see
[Voice Engines](Voice-Engines)). Once analysis finishes, the cast
confirmation screen shows the detected characters with their own-language
names, each ready to design a Qwen voice for.

> Screenshots of language detection and a non-English cast confirmation are tracked as a follow-up.

## Casting a non-English book

For a non-English book, the voice picker hides voices that don't speak the
book's language — a Russian cast doesn't want a Spanish-only voice turning
up as an option. A small note under the list says how many are hidden and
why ("N hidden · can't read Russian"); tap "show all" to bring them back if
you want to browse anyway. English books are unaffected — every voice you
own is available.

## The rule that holds no matter which language

A cast never crosses languages inside a single book — every character and the narrator perform in the manuscript's own language, always. It's the one hard rule the whole feature is built around, and it's why the fallback for an unsupported language is honest English rather than a mixed-language cast nobody asked for.

See [Troubleshooting](Troubleshooting) for more on language detection and
casting edge cases.

Next: [Troubleshooting](Troubleshooting).
