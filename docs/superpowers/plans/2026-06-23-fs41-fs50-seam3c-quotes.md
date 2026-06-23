# fs-41/fs-50 Seam 3c — Language-aware quotes (§4.2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the parse-time audio-tag detectors and the spoken-vs-narration check recognise non-English dialogue quotes (`«»` for ES/FR, `„“` for DE) and move the all-caps "shout" heuristic to Unicode case — fixing a latent bug where shouting in Russian/German (non-ASCII caps) is never tagged — without changing English behaviour.

**Architecture:** The audio-tag detectors run at **parse time, where the book language is unknown** (same constraint as seams 3a/3b), so the quote sets are a **universal union** of all Latin+Cyrillic dialogue quotes, not a per-language lookup. `isShoutingRun`/`denormaliseShouting` switch from `[A-Za-z]`/`[A-Z]` to Unicode `\p{L}`/`\p{Lu}`. `isSpokenLine` (narrator-default) gains the German `„…“` form (it already handles `«»`, smart/straight quotes, and dashes from fs-2).

**Tech Stack:** TypeScript (ESM, `.js` imports), Node 20+, Vitest.

## Global Constraints

- **English behaviour unchanged.** Existing `audio-tags.test.ts` and `narrator-default.test.ts` English assertions stay green (the union only ADDS non-English quotes; `\p{L}`/`\p{Lu}` are supersets of `[A-Za-z]`/`[A-Z]`). No English test inverted.
- **No registry change, no language threading into parse-time code** — the quote sets are universal constants (a monolingual book contains only its own quotes, so the union is safe).
- **German quote forms:** opener `„` (U+201E), closer `“` (U+201C). Note `“` (U+201C) is also the English *opening* smart quote already in `QUOTE_OPENS`; adding it to `QUOTE_CLOSES` is safe for monolingual books (the scanner finds the first closer after an opener: English `“…”` closes on `”` U+201D before any stray `“`; German `„…“` closes on `“`).
- Use the `u` flag on the new Unicode regexes. ESM `.js` imports. Commit `<type>(<scope>): <subject>`. Husky pre-commit runs the server test leg (green, no `--no-verify`). Work from the worktree `C:/Claude/Audiobook-Generator-wt-fs41`, branch `docs/docs-fs41-fs50-seam3c-quotes`.

---

### Task 1: Audio-tag detectors — union quote sets + Unicode shout case

**Files:**
- Modify: `server/src/parsers/audio-tags.ts` (`QUOTE_OPENS`/`QUOTE_CLOSES`, `isShoutingRun`, `denormaliseShouting`, the hesitation trailing regex)
- Test: `server/src/parsers/audio-tags.test.ts`

**Interfaces:** No exported-signature change; the tag detectors now fire inside `«»`/`„“` spans and tag non-ASCII-caps shouting.

- [ ] **Step 1: Write the failing tests** — append to `server/src/parsers/audio-tags.test.ts`:

```typescript
describe('audio-tags — non-English quotes + Unicode case (seam 3c)', () => {
  it('tags shouting inside German „…“ quotes (umlaut caps)', () => {
    // „SCHNELL!“ — German low/high quotes, all-caps incl. no umlaut here but Unicode-cap path
    const out = tagShoutingDialog('Er rief „SCHNELL!“');
    expect(out).toContain('[shouting]');
    expect(out).not.toContain('SCHNELL'); // denormalised to Schnell
  });
  it('tags shouting inside Russian «…» quotes (Cyrillic caps) — previously a silent miss', () => {
    const out = tagShoutingDialog('Он крикнул «БЫСТРО!»');
    expect(out).toContain('[shouting]');
  });
  it('tags excited dialogue inside Spanish «…!» quotes', () => {
    const out = tagExcitedDialog('Ella dijo «¡Cuidado!»');
    expect(out).toContain('[excited]');
  });
  it('leaves English smart-quote behaviour unchanged', () => {
    expect(tagShoutingDialog('She yelled “GET OUT”.')).toBe('She yelled “[shouting] Get Out”.');
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd C:/Claude/Audiobook-Generator-wt-fs41/server && npx vitest run src/parsers/audio-tags.test.ts`
Expected: FAIL — the non-English-quote cases don't tag (guillemets/`„“` not in the quote sets; Cyrillic caps not matched by `[A-Za-z]`).

- [ ] **Step 3: Implement** — in `server/src/parsers/audio-tags.ts`:

(a) Extend the quote sets (line 17-19) to the universal union (keep the existing straight+smart, ADD `«`/`„` opens and `»`/`“` closes):

```typescript
/* Dialogue-wrapping quotes across English + Latin-script + Cyrillic books.
   A monolingual manuscript contains only its own pair, so the union is safe.
   Opens: " (straight) “ (smart) « (ES/FR/RU guillemet) „ (DE low-9).
   Closes: " (straight) ” (smart) » (guillemet) “ (DE high-6 = also EN open;
   safe for monolingual — the scanner closes on the first closer after an open). */
const QUOTE_OPENS = '"“«„';
const QUOTE_CLOSES = '"”»“';
```

(b) `isShoutingRun` (line 33-40) → Unicode:

```typescript
function isShoutingRun(s: string): boolean {
  const letters = s.replace(/[^\p{L}]/gu, '');
  if (letters.length < 2) return false;
  if (letters !== letters.toUpperCase()) return false;
  if (!/\p{Lu}{2,}/u.test(s)) return false;
  if (letters.length >= 4) return true;
  return s.includes('!');
}
```

(c) `denormaliseShouting` (line 45-47) → Unicode:

```typescript
function denormaliseShouting(s: string): string {
  return s.replace(/(\p{Lu})([\p{Lu}']+)/gu, (_m, head, tail) => head + tail.toLowerCase());
}
```

(d) If a hesitation trailing regex hardcodes the closer quotes (the explore noted `[“”]?` near the end-of-span check), widen its optional trailing-quote class to include `»“` as well (so a hesitant German/guillemet line still matches). Read the actual regex and extend its character class only; do not change its structure.

- [ ] **Step 4: Run to verify pass — non-English AND the full English suite**

Run: `cd C:/Claude/Audiobook-Generator-wt-fs41/server && npx vitest run src/parsers/audio-tags.test.ts`
Expected: PASS — the 4 new cases + every pre-existing English `tagShouting`/`tagExcited`/`tagHesitant`/emphasis assertion.

- [ ] **Step 5: Broader parser suite (no regression where the detectors are chained)**

Run: `cd C:/Claude/Audiobook-Generator-wt-fs41/server && npx vitest run src/parsers`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add server/src/parsers/audio-tags.ts server/src/parsers/audio-tags.test.ts
git commit -m "feat(server): audio-tag detectors recognise non-English quotes + Unicode-case shouting"
```

---

### Task 2: `isSpokenLine` — recognise German `„…“` dialogue

**Files:**
- Modify: `server/src/analyzer/narrator-default.ts` (`isSpokenLine`)
- Test: `server/src/analyzer/narrator-default.test.ts`

**Interfaces:** `isSpokenLine(text: string): boolean` unchanged; now returns true for a German `„…“` line.

- [ ] **Step 1: Write the failing tests** — append to the `isSpokenLine` describe in `server/src/analyzer/narrator-default.test.ts`:

```typescript
it('treats German „…“ dialogue as spoken (leading and embedded)', () => {
  expect(isSpokenLine('„Schnell!“')).toBe(true);                 // leading German open-quote
  expect(isSpokenLine('Er sagte „komm her“ leise.')).toBe(true); // embedded German span
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd C:/Claude/Audiobook-Generator-wt-fs41/server && npx vitest run src/analyzer/narrator-default.test.ts`
Expected: FAIL — `„` (U+201E) is not in the opening-quote class and there's no `„…“` embedded check.

- [ ] **Step 3: Implement** — in `server/src/analyzer/narrator-default.ts`, in `isSpokenLine`:
- Add `„` (U+201E) to the leading opening-quote character class (the regex that currently matches `^[«“"‘'…]`-style openers).
- Add an embedded-span alternative `„[^“]+“` alongside the existing `«[^»]+»` / `“[^”]+”` embedded checks.

Mirror the EXACT structure of the existing `«…»` handling (read the current regexes and add the German pair the same way). Do not alter the English/Russian/dash branches.

- [ ] **Step 4: Run to verify pass — new + the full English/Russian suite**

Run: `cd C:/Claude/Audiobook-Generator-wt-fs41/server && npx vitest run src/analyzer/narrator-default.test.ts`
Expected: PASS — the 2 new German cases + every pre-existing English/Russian `isSpokenLine` + `applyNarratorDefault` assertion (incl. the apostrophe-not-spoken and Russian-guillemet cases).

- [ ] **Step 5: Commit**

```bash
git add server/src/analyzer/narrator-default.ts server/src/analyzer/narrator-default.test.ts
git commit -m "feat(server): isSpokenLine recognises German „…“ dialogue"
```

---

## Self-Review

- **Spec coverage (§4.2):** audio-tag detectors fire inside `«»`/`„“` ✓ (T1a); shout heuristic Unicode-cased (fixes the latent Russian/German miss) ✓ (T1b,c); `isSpokenLine` handles German `„…“` ✓ (T2). Universal-union approach honours the parse-time-language constraint; no registry change.
- **Placeholder scan:** none — code + commands + expected output. The two "read the actual regex and extend its class" steps (T1d, T2) are concrete extend-only instructions, not vague directives.
- **English-unchanged check:** T1 Step 4 + T2 Step 4 re-run the full English suites; the unions only add non-English quotes and `\p{L}`/`\p{Lu}` are ASCII supersets.

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-06-23-fs41-fs50-seam3c-quotes.md`. Subagent-Driven recommended. Remaining analyze-half PRs after this: §4.3 attribution/roster (the four `[A-Z]+verb` sites), §4.4 minor-cast folding, §4.5 token divisor, §4.6 prompt skills.
