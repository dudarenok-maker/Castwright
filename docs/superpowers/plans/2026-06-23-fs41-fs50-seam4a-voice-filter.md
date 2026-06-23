# fs-41/fs-50 Seam 4a — Voice-library language filtering Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** In a non-English book, the cast/reuse voice picker hides voices that can't read the book's language (English presets + cross-language designed voices) behind a non-silent **"N hidden · can't read &lt;Language&gt;" + "show all"** toggle — so a user can't pick a voice that gets silently cleared at generation. (This is the fs-41 "filter the voice library" deliverable.)

**Architecture:** The server surfaces a per-voice BCP-47 `languageCode` on `DerivedVoice` (derived from the designed Qwen voice's baked manifest language; presets/non-designed → undefined = English-only). The frontend `VoiceLibraryPanel` already receives `bookLanguage`; when the book is non-English, it filters to language-eligible voices with a hide-count + "show all" escape hatch. English books are unaffected (no filter).

**Tech Stack:** TypeScript (ESM, `.js` imports), Node 20+ (server), React (Vite), Vitest.

## Global Constraints

- **English books unchanged.** The filter only activates when `bookLanguage !== 'en'`; an English book's picker is byte-identical. No existing English assertion modified.
- **Eligibility (Qwen-only, current invariant):** for a non-English book, a voice is eligible iff it is a designed voice whose `languageCode === bookLanguage`; presets/English-designed/cross-language voices are ineligible. (es/fr/de aren't `supported` yet, so today this activates for Russian books and is forward-compatible.)
- **Non-silent:** ineligible voices are hidden but counted, with a "show all" override (the issue's required escape hatch) — never a silent drop.
- The per-voice language is **derived server-side** (the manifest is authoritative; the frontend can't read it). ESM `.js`. Commit `<type>(<scope>): <subject>`. Husky pre-commit runs the in-scope test legs (green, no `--no-verify`). Work from the worktree `C:/Claude/Audiobook-Generator-wt-fs41`, branch `docs/docs-fs41-fs50-seam4-voice-filter`.

---

### Task 1: Surface a per-voice `languageCode` on `DerivedVoice`

**Files:**
- Modify: `server/src/tts/language-registry.ts` (add a `codeForSidecarName` reverse helper)
- Modify: `server/src/routes/voices.ts` (`DerivedVoice` interface + the aggregation that reads Qwen manifests)
- Modify: `openapi.yaml` (`Voice` schema gains `languageCode`) + regen `src/lib/api-types.ts`
- Test: `server/src/routes/voices.test.ts` (+ a `language-registry` test for the reverse helper)

**Interfaces:**
- `codeForSidecarName(word: string): string | undefined` — reverse of `sidecarName` (e.g. `'Russian' → 'ru'`, `'Spanish' → 'es'`).
- `DerivedVoice.languageCode?: string` — BCP-47 code of a designed voice's baked language; absent for presets/non-designed voices.

- [ ] **Step 1: Write the failing registry-helper test** — append to `server/src/tts/language-registry.test.ts`:

```typescript
import { codeForSidecarName } from './language-registry.js';
describe('codeForSidecarName', () => {
  it('maps sidecar words back to BCP-47 codes', () => {
    expect(codeForSidecarName('Russian')).toBe('ru');
    expect(codeForSidecarName('Spanish')).toBe('es');
    expect(codeForSidecarName('German')).toBe('de');
    expect(codeForSidecarName('English')).toBe('en');
    expect(codeForSidecarName('Klingon')).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run → fail.** `cd C:/Claude/Audiobook-Generator-wt-fs41/server && npx vitest run src/tts/language-registry.test.ts` → FAIL (export missing).

- [ ] **Step 3: Implement the helper** — in `server/src/tts/language-registry.ts`:

```typescript
/** Reverse of `sidecarName` — the BCP-47 code for a sidecar/manifest language word. */
export function codeForSidecarName(word: string): string | undefined {
  return ENTRIES.find((e) => e.sidecarName === word)?.code;
}
```

- [ ] **Step 4: Run → pass.** Same command → PASS.

- [ ] **Step 5: Surface `languageCode` on `DerivedVoice`** — in `server/src/routes/voices.ts`:

(a) Add to the `DerivedVoice` interface: `languageCode?: string;` (with a comment: BCP-47 of a designed Qwen voice's baked manifest language; absent for presets).

(b) In the aggregation, for a designed Qwen voice, read the manifest language (the code already reads Qwen manifests for `generated`/`sampled` — reuse that path; the manifest carries `{ language?: string }` as a sidecar WORD). Map it via `codeForSidecarName(manifest.language)` and set `languageCode`. For non-Qwen/preset voices, leave `languageCode` undefined. (If the manifest read already happens once, attach `languageCode` there; do not add a second disk read.)

(c) Add a server test (`server/src/routes/voices.test.ts`, mirror an existing case): a designed Qwen voice with a Russian manifest surfaces `languageCode: 'ru'`; a preset voice has no `languageCode`.

- [ ] **Step 6: openapi + api-types** — add `languageCode` (optional string) to the `Voice` schema in `openapi.yaml`, then:

Run: `cd C:/Claude/Audiobook-Generator-wt-fs41 && npm run openapi:types`
Expected: `src/lib/api-types.ts` regenerates with `languageCode?: string` on `Voice`.

- [ ] **Step 7: Run server tests + typecheck**

Run: `cd C:/Claude/Audiobook-Generator-wt-fs41/server && npx vitest run src/routes/voices.test.ts src/tts/language-registry.test.ts && cd C:/Claude/Audiobook-Generator-wt-fs41 && npm run typecheck`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add server/src/tts/language-registry.ts server/src/routes/voices.ts openapi.yaml src/lib/api-types.ts server/src/routes/voices.test.ts server/src/tts/language-registry.test.ts
git commit -m "feat(server): surface per-voice languageCode on derived voices (from the Qwen manifest)"
```

---

### Task 2: Filter the cast/reuse picker by language (hide-with-count)

**Files:**
- Modify: `src/components/voice-library-panel.tsx` (add the language filter + the hidden-count affordance)
- Test: `src/components/voice-library-panel.test.tsx` (create if absent)

**Interfaces:** `VoiceLibraryPanel` already receives `library: Voice[]` + `bookLanguage?: string`. Now `voice.languageCode` (Task 1) drives eligibility.

- [ ] **Step 1: Write the failing test** — in `src/components/voice-library-panel.test.tsx`:

```tsx
// A Russian book: an English preset + an English-designed Qwen voice are hidden;
// a Russian-designed voice shows. The hidden count + "show all" appear.
it('hides language-ineligible voices in a non-English book, with a show-all toggle', async () => {
  const library = [
    makeVoice({ character: 'Ivan', languageCode: 'ru' }),          // eligible
    makeVoice({ character: 'John', languageCode: 'en' }),          // ineligible (English-designed)
    makeVoice({ character: 'Preset', languageCode: undefined }),   // ineligible (preset → English)
  ];
  render(<VoiceLibraryPanel library={library} bookLanguage="ru" {...noopProps} />);
  expect(screen.getByText('Ivan')).toBeInTheDocument();
  expect(screen.queryByText('John')).not.toBeInTheDocument();
  expect(screen.getByText(/2 hidden/i)).toBeInTheDocument();
  await userEvent.click(screen.getByRole('button', { name: /show all/i }));
  expect(screen.getByText('John')).toBeInTheDocument();           // override reveals
});

it('does not filter in an English book', () => {
  const library = [makeVoice({ character: 'John', languageCode: 'en' }), makeVoice({ character: 'Preset', languageCode: undefined })];
  render(<VoiceLibraryPanel library={library} bookLanguage="en" {...noopProps} />);
  expect(screen.getByText('John')).toBeInTheDocument();
  expect(screen.queryByText(/hidden/i)).not.toBeInTheDocument();
});
```

(Provide `makeVoice` + `noopProps` helpers mirroring existing panel/voice test fixtures — read them.)

- [ ] **Step 2: Run → fail.** `cd C:/Claude/Audiobook-Generator-wt-fs41 && npx vitest run src/components/voice-library-panel.test.tsx` → FAIL (no language filter).

- [ ] **Step 3: Implement** — in `src/components/voice-library-panel.tsx`:

(a) Compute eligibility: `const filterByLanguage = !!bookLanguage && bookLanguage !== 'en';` and `const isEligible = (v: Voice) => !filterByLanguage || v.languageCode === bookLanguage;`.

(b) Apply it AFTER the existing tab + search filter; partition into shown (eligible) vs hidden (ineligible). A `showAll` `useState(false)` reveals the hidden ones.

(c) Render the hidden-count affordance below the list when `filterByLanguage && hidden.length > 0 && !showAll`:

```tsx
{filterByLanguage && hiddenCount > 0 && !showAll && (
  <button type="button" onClick={() => setShowAll(true)}
    className="w-full text-center text-xs text-ink/50 hover:text-ink py-2 min-h-[44px] sm:min-h-0">
    {hiddenCount} hidden · can't read {languageLabel} · <span className="underline">show all</span>
  </button>
)}
```

Derive `languageLabel` from the supported-list the confirm screen already uses, or a minimal code→label (`{ ru: 'Russian', es: 'Spanish', fr: 'French', de: 'German' }[bookLanguage] ?? bookLanguage`).

- [ ] **Step 4: Run → pass + the frontend suite + typecheck**

Run: `cd C:/Claude/Audiobook-Generator-wt-fs41 && npx vitest run src/components/voice-library-panel.test.tsx && npm run typecheck`
Expected: PASS — the filter cases + an English book unaffected.

- [ ] **Step 5: Commit**

```bash
git add src/components/voice-library-panel.tsx src/components/voice-library-panel.test.tsx
git commit -m "feat(frontend): hide language-ineligible voices in the cast picker (hide-with-count + show-all)"
```

---

## Self-Review

- **Spec coverage (§6 filter):** per-voice language signal server-side ✓ (T1); cast-picker hides ineligible voices with "N hidden · show all" ✓ (T2); English books unaffected ✓. The early-warning transport + global `#/voices` facet are explicitly deferred to seam 4b.
- **Placeholder scan:** the test snippets say "mirror existing fixtures / read them" — concrete instructions, not TODOs. Each code step shows the change.
- **Type consistency:** `languageCode` spelled identically on `DerivedVoice` (T1), the openapi `Voice`, and the frontend filter (T2); `codeForSidecarName` is the reverse of `sidecarName`.
- **English-unchanged check:** the filter is gated on `bookLanguage !== 'en'`; T2's second test pins an English book showing all voices with no "hidden" affordance.

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-06-23-fs41-fs50-seam4a-voice-filter.md`. Subagent-Driven recommended (T1 spans server + openapi, T2 is the UI). Seam 4b (next) = the early-warning transport (surface `clearMismatchedDesignedVoices` to the cast view via the `notifications` toast / generation stream) + the global `#/voices` language facet.
