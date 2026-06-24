# Task 17 Report: ASR vocalization-token tolerance for content-QA (fs-57)

## Status: DONE

**Commit:** `c019fa2d` — `feat(server): ASR vocalization-token tolerance for content-QA (fs-57)`

## What was built

### 1. `segment-asr-qa.ts` — `leadingVocalizationTokens` helper

Added and exported `leadingVocalizationTokens(text: string): string[]`.

Rule (P-M2): match from the start of `text` up to and including the first terminal mark (`!`, `…` U+2026, `.`, `?`), then return the `normalizeForWer`-normalized tokens of that prefix.

Regex: `/^([^!.…?]*[!.…?])/` — both character classes contain the real U+2026 codepoint (verified byte-level: `0x2026`; Write tool did NOT flatten it).

Examples:
- `'Ah! I did not see you walk in.'` → `['ah']`
- `'Haah… so tired.'` → `['haah']`
- `'no terminal mark'` → `[]`

### 2. `segment-asr-qa.ts` — `ClassifyOptions.vocalizationAllowlist`

Added `vocalizationAllowlist?: Iterable<string>` to `ClassifyOptions` with a JSDoc explaining the fs-57/srv-31 carve-out.

Folded into the same `allow` set as `nameAllowlist` — changed from:
```ts
const allow = new Set<string>();
if (opts.nameAllowlist) {
  for (const name of opts.nameAllowlist) { … }
}
```
to:
```ts
const allow = new Set<string>();
for (const src of [opts.nameAllowlist, opts.vocalizationAllowlist]) {
  if (src) { for (const name of src) { … } }
}
```
The tolerance loop (`~line 328`) already honours `allow` for `sub` and `del` ops — no changes needed there.

### 3. `synthesise-chapter.ts` — wiring at the QA call sites

- Imported `leadingVocalizationTokens` from `./segment-asr-qa.js`.
- Changed the `verify` lambda from `(pcm, rate, text)` → `(pcm, rate, group: SentenceGroup)` so it has access to `group.vocalization`.
- When `group.vocalization === true`, spreads `vocalizationAllowlist: leadingVocalizationTokens(group.text)` into the `verifySegmentTranscript` opts.
- Updated both call sites: initial verify loop (line 1526) and the re-record loop (line 1550) to pass `group` instead of `group.text`.

## Tests

7 new test cases in `segment-asr-qa.test.ts`:

**`leadingVocalizationTokens` (4 cases):**
- `'Ah! I did not see you walk in.'` → `['ah']` ✓
- `'Haah… so tired.'` (real U+2026) → `['haah']` ✓
- `'No vocalization here.'` → `['no', 'vocalization', 'here']` (safe: only called under flag) ✓
- `'no terminal mark'` → `[]` ✓

**`classifyTranscript vocalizationAllowlist` (3 cases):**
- Prepended "Ah!" where transcript drops it, WITH allowlist `['ah']` → `ok` ✓
- Heavy word-drop WITHOUT allowlist → `drift` ✓
- Same heavy word-drop WITH allowlist → still `drift` (lexical words ARE still scored) ✓

All 23 tests in the file pass.

## Typecheck

`npm run typecheck` — CLEAN (both frontend and server).

## Key design decisions

1. **`verify` lambda refactor**: Changed from `(pcm, rate, text)` to `(pcm, rate, group)` to give the closure access to `group.vocalization` without changing the `verifySegmentTranscript` signature. Minimal and surgical — the two call sites trivially pass `group` instead of `group.text`.

2. **Token source**: `leadingVocalizationTokens(group.text)` — derives allowlist from the sentence text at synth time, not from a stored span, consistent with the P-M2 spec rule. `normalizeForWer` is reused so the normalization path is identical to how the transcript is scored.

3. **Unified `allow` set**: `vocalizationAllowlist` shares the same `allow` set as `nameAllowlist` — the tolerance loop already handles all allowed tokens uniformly. No second loop or special handling needed.

4. **minChars floor still handles bare vocalizations**: Short standalone sentences like "Ah!" never reach the `allow` set logic at all — they return `inconclusive` at the 12-char floor. This task only covers the edit-in-place long-sentence case where a gasp is prepended to a full sentence.

---

## Critical fix applied (post-review, commit `2102b8a5`)

### Bug: `vocalizationAllowlist` was dropped on the `verifySegmentTranscript` → `classifyTranscript` forward

`verifySegmentTranscript` (the ONLY production entry point — `synthesise-chapter.ts` calls it, not `classifyTranscript` directly) was forwarding only `{ thresholds, nameAllowlist }` to `classifyTranscript`, silently dropping `opts.vocalizationAllowlist`. Every vocalization sentence was scored as if no allowlist were provided.

**Diff summary:**

`server/src/tts/segment-asr-qa.ts` line ~425 — changed from:
```ts
{ thresholds: opts.thresholds, nameAllowlist: opts.nameAllowlist },
```
to:
```ts
{ thresholds: opts.thresholds, nameAllowlist: opts.nameAllowlist, vocalizationAllowlist: opts.vocalizationAllowlist },
```

`server/src/tts/segment-asr-qa.ts` line ~254 — corrected JSDoc example: `'No vocalization here.' → ['no']` was wrong; actual result is `['no', 'vocalization', 'here']`.

`server/src/tts/segment-asr-qa.test.ts` — added `describe('verifySegmentTranscript vocalizationAllowlist integration (fs-57)')` with 2 new tests (25 total, was 23):
1. `vocalizationAllowlist forwarded: suppresses a 5-token deletion run that would otherwise drift` — uses 5-token vocalization prefix (haah/ooh/ah/mm/hmm) that ASR drops. Without the allowlist the deletion run = 5 > maxDeletionRun (4) → drift; with the allowlist those deletions are tolerated → ok.
2. `WITHOUT vocalizationAllowlist the same 5-token drop drifts` — regression guard confirming the flip is caused by the allowlist.

### Test evidence

**Vitest command:** `cd /c/Claude/wt-fs57-spec && cd server && npx vitest run src/tts/segment-asr-qa.test.ts`

**Result after fix:** 25/25 passed

**Fails-before/passes-after confirmed:** With Fix 1 temporarily reverted, 1 test failed with `expected 'drift' to be 'ok'` — exactly the critical integration test. After Fix 1 restored: 25/25 passed.

### Typecheck

`npm run typecheck` from repo root — CLEAN (both frontend and server).

---

## Unicode caveat

The `leadingVocalizationTokens` regex contains real U+2026 (HORIZONTAL ELLIPSIS) in both character classes. Verified byte-level: codepoint `0x2026` present in `segment-asr-qa.ts`. Test string `'Haah… so tired.'` also has real U+2026 (codepoint `0x2026`) in `segment-asr-qa.test.ts` — the Write/Edit tools did NOT flatten to three ASCII dots in this instance (the file encoding was preserved). If this file is re-edited via tools that flatten Unicode, the regex silently breaks. The `normalizeForWer` function calls `.normalize('NFKC')` which maps U+2026 → `'…'` → then strips it as non-alphanumeric, so the token boundary at the ellipsis is correctly handled either way — but the regex itself must match U+2026 in the raw text.
