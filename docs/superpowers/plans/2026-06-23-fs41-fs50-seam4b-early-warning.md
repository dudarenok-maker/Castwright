# fs-41/fs-50 Seam 4b — Early-warning transport + #/voices language facet Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When a non-English book's generation (or splice re-record) **clears** a designed voice because it was designed for a different language, tell the user instead of clearing it silently (today it only `console.warn`s server-side). And add a language facet to the global `#/voices` view so a user can see which voices read which language.

**Architecture:** `clearMismatchedDesignedVoices` (`server/src/tts/verify-designed-voice-language.ts`) gains a **return value** — the list of cleared characters (id + name + the language they were designed for). Both call sites (`generation.ts`, `chapter-splice.ts`) already have an SSE `send()` in scope and already gate on `nonEnglishBook`; when the returned list is non-empty they emit the **existing `warning` tick** (`{ type: 'warning', message, code }`), which the frontend already turns into a dedup'd toast (`generation-stream-runner.ts`). No new tick type, no openapi change, no new frontend path for Task 1. Task 2 adds a language filter to `voices.tsx` keyed on the `Voice.languageCode` that seam 4a already surfaced.

**Tech Stack:** TypeScript (ESM, `.js` imports), Node 20+ (server), React (Vite), Vitest.

## Global Constraints

- **English/existing behaviour unchanged.** `clearMismatchedDesignedVoices` is only called inside the `if (nonEnglishBook)` branch; English books never reach it. The new return value is additive (callers that ignore it are unaffected); the `console.warn` stays. No existing assertion modified.
- **Reuse the existing `warning` tick** (already in the openapi `GenerationTick` enum + already toasted by `generation-stream-runner.ts`). Dedupe by a stable `code` (`voice_language_mismatch`) so a re-emit doesn't stack toasts.
- ESM `.js`. Commit `<type>(<scope>): <subject>`. Husky pre-commit runs the in-scope legs (green, no `--no-verify`). Work from the worktree `C:/Claude/Audiobook-Generator-wt-fs41`, branch `docs/docs-fs41-fs50-seam4b-early-warning`.

---

### Task 1: `clearMismatchedDesignedVoices` returns cleared chars; call sites warn

**Files:**
- Modify: `server/src/tts/verify-designed-voice-language.ts` (return the cleared list)
- Modify: `server/src/routes/generation.ts` (~line 566) + `server/src/routes/chapter-splice.ts` (~line 252) — emit the `warning` tick
- Test: `server/src/tts/verify-designed-voice-language.test.ts` (+ a generation-route assertion if a harness exists; otherwise unit-test the function's return)

**Interfaces:**
- `clearMismatchedDesignedVoices(cast, expectedLang, bookLanguage): Promise<ClearedVoice[]>` where `ClearedVoice = { id: string; name: string; designedLanguage: string }` (`designedLanguage` = the manifest's language word, or a sentinel like `'unknown'` when the manifest was missing). Returns `[]` when nothing was cleared.

- [ ] **Step 1: Write the failing test** — in `server/src/tts/verify-designed-voice-language.test.ts` (mirror its existing fixtures — read them):

```typescript
it('returns the characters whose mismatched voices were cleared', async () => {
  // A cast with one qwen voice designed for English on a Russian ('ru') book.
  const cast = [
    makeCastChar({ id: 'ivan', name: 'Ivan', overrideTtsVoices: { qwen: { name: 'qwen-ivan' } } }),
  ];
  // (set up the manifest read so qwen-ivan's manifest.language === 'English')
  const cleared = await clearMismatchedDesignedVoices(cast, 'Russian', 'ru');
  expect(cleared).toEqual([{ id: 'ivan', name: 'Ivan', designedLanguage: 'English' }]);
  expect(cast[0].overrideTtsVoices?.qwen).toBeUndefined(); // still cleared in place
});

it('returns [] when every designed voice matches the book language', async () => {
  const cast = [makeCastChar({ id: 'ivan', name: 'Ivan', overrideTtsVoices: { qwen: { name: 'qwen-ivan' } } })];
  // (manifest.language === 'Russian')
  expect(await clearMismatchedDesignedVoices(cast, 'Russian', 'ru')).toEqual([]);
});
```

(Read the existing test for how it stubs the manifest read — `readJson`/`qwenVoiceSidecarPath`. Match the real fixture style. If the existing test already mocks the manifest, reuse that mock.)

- [ ] **Step 2: Run → fail.** `cd C:/Claude/Audiobook-Generator-wt-fs41/server && npx vitest run src/tts/verify-designed-voice-language.test.ts` → FAIL (function returns void).

- [ ] **Step 3: Implement the return** — in `verify-designed-voice-language.ts`:
- Change the signature to `Promise<ClearedVoice[]>` (export the `ClearedVoice` type).
- Accumulate a `cleared: ClearedVoice[]` as you clear each character: push `{ id: c.id, name: c.name ?? c.id, designedLanguage: manifest?.language ?? 'unknown' }` at the same point you `delete c.overrideTtsVoices.qwen` + `console.warn` (keep the warn).
- `return cleared;` at the end.

- [ ] **Step 4: Run → pass.** Same command → PASS (the cleared-list + the empty case).

- [ ] **Step 5: Emit the warning tick at both call sites.** In `generation.ts` (~566) and `chapter-splice.ts` (~252), capture the return + emit:

```typescript
const cleared = await clearMismatchedDesignedVoices(
  cast.characters,
  sidecarLanguageName(bookLanguage),
  bookLanguage,
);
if (cleared.length > 0) {
  const names = cleared.map((c) => c.name).join(', ');
  send({
    type: 'warning',
    code: 'voice_language_mismatch',
    message:
      `${cleared.length} designed voice(s) were cleared because they were designed for a ` +
      `different language than this book — re-design ${names} before generating.`,
  });
}
```

Use the `send` function already in scope at each handler (generation.ts ~line 488; chapter-splice.ts ~line 98). Confirm the `warning` tick shape matches the openapi `GenerationTick` (`type`, `message`, `code`) — it does; no schema change.

- [ ] **Step 6: Verify the frontend already toasts it (no change) + the splice consumer.** Read `src/store/generation-stream-runner.ts` (~line 367) to confirm the `warning` handler dispatches `pushToast` with `dedupeKey` from `ev.code` — the generation path is covered. CHECK whether the **splice** SSE is consumed by the same runner (search for the splice stream consumer); if a different consumer handles the splice stream and does NOT handle `warning`, note it in your report as a known gap (the generation path is the primary surface; do not build a second toast path in this task).

- [ ] **Step 7: Run server tests + typecheck**

Run: `cd C:/Claude/Audiobook-Generator-wt-fs41/server && npx vitest run src/tts/verify-designed-voice-language.test.ts && cd C:/Claude/Audiobook-Generator-wt-fs41 && npm run typecheck`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add server/src/tts/verify-designed-voice-language.ts server/src/routes/generation.ts server/src/routes/chapter-splice.ts server/src/tts/verify-designed-voice-language.test.ts
git commit -m "feat(server): warn when a designed voice is cleared for a language mismatch"
```

---

### Task 2: `#/voices` language facet

**Files:**
- Modify: `src/views/voices.tsx` (add a language filter keyed on `Voice.languageCode`)
- Test: `src/views/voices.test.tsx` (create if absent; or the nearest voices-view test)

**Interfaces:** `Voice.languageCode?: string` already exists (seam 4a). The facet filters the displayed voices by language.

- [ ] **Step 1: Write the failing test** — in `src/views/voices.test.tsx` (mirror existing voices-view test fixtures — read them):

```tsx
it('filters the voice list by language when a language facet is selected', async () => {
  // voices: one ru-designed (languageCode 'ru'), one preset (no languageCode = English)
  renderVoicesView({ voices: [makeVoice({ character: 'Ivan', languageCode: 'ru' }), makeVoice({ character: 'Preset', languageCode: undefined })] });
  // default: both visible
  expect(screen.getByText('Ivan')).toBeInTheDocument();
  expect(screen.getByText('Preset')).toBeInTheDocument();
  // pick the Russian facet → only the ru voice
  await userEvent.click(screen.getByRole('button', { name: /Russian/i }));
  expect(screen.getByText('Ivan')).toBeInTheDocument();
  expect(screen.queryByText('Preset')).not.toBeInTheDocument();
});
```

(Adapt to the actual voices-view render harness + the families/tab structure — read `voices.tsx` + any existing test. If the view groups into families, assert on the family/voice the language filter keeps.)

- [ ] **Step 2: Run → fail.** `cd C:/Claude/Audiobook-Generator-wt-fs41 && npx vitest run src/views/voices.test.tsx` → FAIL.

- [ ] **Step 3: Implement** — in `src/views/voices.tsx`:
- Add `const [languageFilter, setLanguageFilter] = useState<string | null>(null);` (null = all).
- Compute the unique languages present: `const languages = useMemo(() => [...new Set(voices.map((v) => v.languageCode).filter(Boolean))], [voices]);` — only render the facet when `languages.length > 0` (an all-English library shows no facet → English view unchanged).
- Apply the filter alongside the existing tab/variant filters: a voice is kept when `languageFilter === null || v.languageCode === languageFilter`. Thread it through the families/members computation the same way `variantFilter` is applied (read the existing cascade and mirror it — don't invent a parallel structure).
- Render the facet next to the existing `variantFilter` row: an "All" button + one button per present language (label via a code→word map `{ ru:'Russian', es:'Spanish', fr:'French', de:'German' }[code] ?? code`). Touch target `min-h-[44px] sm:min-h-0`, design tokens, no hex literals.

- [ ] **Step 4: Run → pass + typecheck**

Run: `cd C:/Claude/Audiobook-Generator-wt-fs41 && npx vitest run src/views/voices.test.tsx && npm run typecheck`
Expected: PASS — the facet filters; an all-English library renders no facet (unchanged).

- [ ] **Step 5: Commit**

```bash
git add src/views/voices.tsx src/views/voices.test.tsx
git commit -m "feat(frontend): language facet on the global voices view"
```

---

## Self-Review

- **Spec coverage (seam 4b):** the silent voice-clearing is surfaced to the user via the existing `warning`→toast path ✓ (T1); the global `#/voices` view gains a language facet ✓ (T2). No new SSE tick type, no openapi change, no second toast path.
- **Placeholder scan:** the test snippets say "read the existing fixtures / mirror the cascade" — concrete adapt-to-real-code instructions. Each code step shows the change.
- **Type consistency:** `ClearedVoice` exported from the verify module + consumed at both call sites; the `warning` tick shape (`type`/`message`/`code`) matches the openapi union; `languageCode` (seam 4a) drives the facet.
- **English-unchanged check:** T1 only runs inside `nonEnglishBook`; T2's facet renders only when ≥1 non-English voice is present, so an English-only library is byte-identical.

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-06-23-fs41-fs50-seam4b-early-warning.md`. Subagent-Driven recommended. After 4b, seam 4 (voice-library filtering + early-warning) is complete. Remaining fs-41/fs-50: seam 5 rest (`sidecarLanguageName`-throw + attribution-eval harness — calibration already shipped) + the Spanish canary flip.
