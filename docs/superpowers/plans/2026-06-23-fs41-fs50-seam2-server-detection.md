# fs-41/fs-50 Seam 2 — Server-side language detection + confirm rebuild Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Detect a manuscript's language **on the server during `POST /api/import`** (script pre-pass + `franc` for Latin, front-matter stripped first), return `{ language, languageSupported, supportedLanguages }`, and rebuild the confirm-screen selector to consume that result — retiring the client-side `detect-language.ts`.

**Architecture:** A new server detection module reads the seam-1 language registry (extended here with a `detect` field + es/fr/de entries) and `franc`, reusing the existing `stripFrontMatterBoilerplate`. `import.ts` calls it and stamps the result onto the import response. The confirm screen builds its `<select>` from the server-supplied supported-list and shows a "detected-but-unsupported" banner instead of ever silently defaulting to `en`.

**Tech Stack:** TypeScript (ESM, `.js` imports), Node 20+ (server), `franc` (new server dep), Vitest (server + frontend), Playwright (e2e).

## Global Constraints

- **Detection is server-side** (spec §3, revised). `franc` is a **server** dependency (`server/package.json`), never in the browser bundle. The client `detect-language.ts` + `detect-language.test.ts` are **removed** in Task 4.
- **Script pre-pass is authoritative and preserves the shipped Russian path**: ≥30% Cyrillic ⇒ `ru` deterministically, never via `franc`.
- **`en`/`ru` stay `supported: true`; es/fr/de are added `supported: false`** (they flip true only at their rollout phase's operator gate — not in this seam).
- **Fail safe — never silent `en`.** A confident detection of a non-`supported` language returns `languageSupported: false`; the confirm screen surfaces it. `en` is never the silent fallback for a *detected* other language.
- **`franc` is restricted to the registry's Latin ISO-639-3 set** via its `only` option, and maps back to registry codes via `detect.iso6393`.
- ESM `.js` import extensions. Commit convention `<type>(<scope>): <subject>`; husky pre-commit runs the in-scope test legs (must be green, no `--no-verify`).
- Work from the worktree `C:/Claude/Audiobook-Generator-wt-fs41` (junctioned `node_modules`), branch `docs/docs-fs41-fs50-language`.

---

### Task 1: Extend the registry with a `detect` field + es/fr/de entries

**Files:**
- Modify: `server/src/tts/language-registry.ts`
- Test: `server/src/tts/language-registry.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces:
  - `LanguageEntry` gains `detect: { script: 'latin' | 'cyrillic'; iso6393: string }`.
  - `allLanguageEntries(): readonly LanguageEntry[]`
  - `supportedLanguages(): Array<{ code: string; label: string }>` — `supported` entries mapped to `{ code, label: sidecarName }`, for the confirm selector.

- [ ] **Step 1: Write the failing tests** — append to `server/src/tts/language-registry.test.ts`:

```typescript
import {
  getLanguageEntry,
  isSupportedLanguage,
  allLanguageEntries,
  supportedLanguages,
  type LanguageEntry,
} from './language-registry.js';

describe('detect field + Latin entries', () => {
  it('en/ru carry a detect script + iso6393', () => {
    expect(getLanguageEntry('en')?.detect).toEqual({ script: 'latin', iso6393: 'eng' });
    expect(getLanguageEntry('ru')?.detect).toEqual({ script: 'cyrillic', iso6393: 'rus' });
  });

  it('es/fr/de exist, are Latin, and are NOT yet supported', () => {
    for (const [code, iso] of [['es', 'spa'], ['fr', 'fra'], ['de', 'deu']] as const) {
      const e = getLanguageEntry(code);
      expect(e?.detect).toEqual({ script: 'latin', iso6393: iso });
      expect(e?.supported).toBe(false);
    }
  });
});

describe('isSupportedLanguage with a present-but-unsupported entry', () => {
  it('is false for es (present, supported:false) — not just for absent codes', () => {
    expect(getLanguageEntry('es')).toBeDefined();
    expect(isSupportedLanguage('es')).toBe(false);
  });
});

describe('supportedLanguages', () => {
  it('returns only supported entries as {code,label}', () => {
    const list = supportedLanguages();
    expect(list).toEqual([
      { code: 'en', label: 'English' },
      { code: 'ru', label: 'Russian' },
    ]);
  });
});

describe('allLanguageEntries', () => {
  it('includes all five codes', () => {
    expect(allLanguageEntries().map((e) => e.code).sort()).toEqual(['de', 'en', 'es', 'fr', 'ru']);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd C:/Claude/Audiobook-Generator-wt-fs41/server && npx vitest run src/tts/language-registry.test.ts`
Expected: FAIL — `detect` undefined on entries, `allLanguageEntries`/`supportedLanguages` not exported, es/fr/de absent.

- [ ] **Step 3: Implement** — replace the `LanguageEntry` interface, `ENTRIES`, and exports in `server/src/tts/language-registry.ts`:

```typescript
export interface LanguageEntry {
  /** BCP-47 primary subtag, lower-cased (e.g. 'en', 'ru', 'es'). */
  code: string;
  /** Sidecar/analyzer language word — also the confirm-selector label. */
  sidecarName: string;
  /** True only once the language has passed its validation gate. */
  supported: boolean;
  /** Detection routing: the script class + the franc ISO-639-3 code for this language. */
  detect: { script: 'latin' | 'cyrillic'; iso6393: string };
}

const ENTRIES: readonly LanguageEntry[] = [
  { code: 'en', sidecarName: 'English', supported: true,  detect: { script: 'latin',    iso6393: 'eng' } },
  { code: 'ru', sidecarName: 'Russian', supported: true,  detect: { script: 'cyrillic', iso6393: 'rus' } },
  // es/fr/de: detection identifies them, but they are not claimed until their
  // rollout phase's operator gate flips `supported` (not in this seam).
  { code: 'es', sidecarName: 'Spanish', supported: false, detect: { script: 'latin',    iso6393: 'spa' } },
  { code: 'fr', sidecarName: 'French',  supported: false, detect: { script: 'latin',    iso6393: 'fra' } },
  { code: 'de', sidecarName: 'German',  supported: false, detect: { script: 'latin',    iso6393: 'deu' } },
];
```

Keep `BY_CODE`, `getLanguageEntry`, `isSupportedLanguage` as-is, and add:

```typescript
/** All registry entries (e.g. to build the franc `only`-set or the supported-list). */
export function allLanguageEntries(): readonly LanguageEntry[] {
  return ENTRIES;
}

/** Supported languages as {code,label} for the confirm-screen selector. */
export function supportedLanguages(): Array<{ code: string; label: string }> {
  return ENTRIES.filter((e) => e.supported).map((e) => ({ code: e.code, label: e.sidecarName }));
}
```

- [ ] **Step 4: Run to verify pass**

Run: `cd C:/Claude/Audiobook-Generator-wt-fs41/server && npx vitest run src/tts/language-registry.test.ts`
Expected: PASS (all blocks).

- [ ] **Step 5: Confirm no consumer broke** — `getLanguageEntry`/`isSupportedLanguage`/`sidecarLanguageName` are unchanged in signature; the new `detect` field is additive.

Run: `cd C:/Claude/Audiobook-Generator-wt-fs41/server && npx vitest run src/tts/language.test.ts`
Expected: PASS (seam-1 behavior intact).

- [ ] **Step 6: Commit**

```bash
git add server/src/tts/language-registry.ts server/src/tts/language-registry.test.ts
git commit -m "feat(server): add detect field + es/fr/de entries to the language registry"
```

---

### Task 2: Server-side detection module

**Files:**
- Create: `server/src/tts/detect-language.ts`
- Test: `server/src/tts/detect-language.test.ts`
- Modify: `server/package.json` (add `franc`)

**Interfaces:**
- Consumes: `allLanguageEntries` (Task 1); `stripFrontMatterBoilerplate` from `server/src/analyzer/strip-front-matter.js`; `franc` from `franc`.
- Produces: `detectManuscriptLanguage(text: string, meta?: { author?: string | null; title?: string | null }): { language: string; supported: boolean }`.

- [ ] **Step 1: Add the `franc` dependency**

Run: `cd C:/Claude/Audiobook-Generator-wt-fs41/server && npm install franc`
Expected: `franc` added to `server/package.json` dependencies. (`franc` is pure-ESM; the server is ESM, so `import { franc } from 'franc'` resolves.)

- [ ] **Step 2: Write the failing test** — create `server/src/tts/detect-language.test.ts`:

```typescript
/* Server-side manuscript language detection (fs-41/fs-50 seam 2).
   Script pre-pass is authoritative; franc disambiguates Latin; front-matter
   stripped before detecting; es/fr/de detected but not yet `supported`. */
import { describe, it, expect } from 'vitest';
import { detectManuscriptLanguage } from './detect-language.js';

describe('detectManuscriptLanguage', () => {
  it('detects Russian via the Cyrillic pre-pass (supported)', () => {
    const ru =
      'Горн остыл до цвета подёрнутого пеплом заката, и Рен выскребала последнюю окалину, когда раздался стук в дверь её мастерской.';
    expect(detectManuscriptLanguage(ru)).toEqual({ language: 'ru', supported: true });
  });

  it('detects Spanish (present in the registry, not yet supported)', () => {
    const es =
      'El horno se había enfriado hasta el color de un atardecer cubierto de ceniza, y Wren raspaba la última escoria cuando alguien llamó a la puerta de su taller.';
    expect(detectManuscriptLanguage(es)).toEqual({ language: 'es', supported: false });
  });

  it('detects French (not yet supported)', () => {
    const fr =
      "Le four avait refroidi jusqu'à la couleur d'un coucher de soleil couvert de cendre, et Wren raclait la dernière scorie lorsque l'on frappa à la porte de son atelier.";
    expect(detectManuscriptLanguage(fr)).toEqual({ language: 'fr', supported: false });
  });

  it('detects German (not yet supported)', () => {
    const de =
      'Der Ofen war bis zur Farbe eines aschbedeckten Sonnenuntergangs abgekühlt, und Wren kratzte die letzte Schlacke ab, als es an der Tür ihrer Werkstatt klopfte.';
    expect(detectManuscriptLanguage(de)).toEqual({ language: 'de', supported: false });
  });

  it('keeps an English manuscript English even when dense with French proper nouns', () => {
    const en =
      'Marcel Beaumont and Geneviève Dubois walked along the Champs-Élysées toward the Café de Flore, where Henri Toussaint waited beneath the awning with the morning papers.';
    expect(detectManuscriptLanguage(en)).toEqual({ language: 'en', supported: true });
  });

  it('returns English for empty / letter-less input', () => {
    expect(detectManuscriptLanguage('')).toEqual({ language: 'en', supported: true });
    expect(detectManuscriptLanguage('1234 — ... !!!')).toEqual({ language: 'en', supported: true });
  });

  it('strips an English front-matter page before detecting the Spanish body', () => {
    const text =
      'Copyright © 2026 Some Publisher. All rights reserved.\nFirst published as an ebook.\nhttps://example.com/book\n\n' +
      'El horno se había enfriado hasta el color de un atardecer cubierto de ceniza, y Wren raspaba la última escoria cuando alguien llamó a la puerta de su taller, una y otra vez, hasta que abrió.';
    // stripFrontMatterBoilerplate drops the bare-URL + copyright lines; the Spanish
    // body dominates the sample, so franc must return Spanish, not English.
    expect(detectManuscriptLanguage(text)).toEqual({ language: 'es', supported: false });
  });

  it('flags a CJK manuscript as detected-but-unsupported (no zh/ja registry entry yet)', () => {
    const zh = '熔炉已经冷却到被灰烬覆盖的落日的颜色，当有人敲响她作坊的门时，雷恩正在刮掉最后的炉渣。';
    const r = detectManuscriptLanguage(zh);
    expect(r.supported).toBe(false);
    expect(['zh', 'ja']).toContain(r.language);
  });
});
```

- [ ] **Step 3: Run to verify failure**

Run: `cd C:/Claude/Audiobook-Generator-wt-fs41/server && npx vitest run src/tts/detect-language.test.ts`
Expected: FAIL — `./detect-language.js` not found.

- [ ] **Step 4: Implement** — create `server/src/tts/detect-language.ts`:

```typescript
/* Server-side manuscript language detection (fs-41/fs-50 seam 2). Runs during
   POST /api/import. The script pre-pass is authoritative (Cyrillic⇒ru, CJK⇒
   unsupported); franc disambiguates the Latin set (en/es/fr/de), restricted to
   the registry's ISO-639-3 codes. Front-matter is stripped first so an English
   copyright page can't mask a non-English body. Never silently returns `en` for
   a confidently-detected other language — the `supported` flag rides along. */
import { franc } from 'franc';
import { allLanguageEntries } from './language-registry.js';
import { stripFrontMatterBoilerplate } from '../analyzer/strip-front-matter.js';

const SAMPLE_CHARS = 20_000;
const SCRIPT_THRESHOLD = 0.3; // matches the shipped Cyrillic-ratio gate (fs-2)
const CYRILLIC_RE = /[Ѐ-ӿ]/g;
const HAN_RE = /\p{Script=Han}/gu;
const KANA_RE = /[\p{Script=Hiragana}\p{Script=Katakana}]/gu;
const LETTER_RE = /\p{L}/gu;

export interface DetectionResult {
  /** BCP-47 primary subtag (a registry code, or 'zh'/'ja' for detected CJK). */
  language: string;
  /** Whether that language has passed its validation gate (registry `supported`). */
  supported: boolean;
}

export function detectManuscriptLanguage(
  text: string,
  meta: { author?: string | null; title?: string | null } = {},
): DetectionResult {
  const entries = allLanguageEntries();
  const result = (code: string): DetectionResult => {
    const e = entries.find((x) => x.code === code);
    return { language: code, supported: e?.supported ?? false };
  };

  /* 1. Front-matter strip, then sample a prefix. */
  const cleaned = stripFrontMatterBoilerplate(text, {
    author: meta.author ?? undefined,
    title: meta.title ?? undefined,
  });
  const sample = cleaned.length > SAMPLE_CHARS ? cleaned.slice(0, SAMPLE_CHARS) : cleaned;

  /* 2. Script pre-pass (authoritative, deterministic). */
  const letters = sample.match(LETTER_RE)?.length ?? 0;
  if (letters === 0) return result('en');
  const cyrillic = sample.match(CYRILLIC_RE)?.length ?? 0;
  if (cyrillic / letters >= SCRIPT_THRESHOLD) return result('ru');
  const cjk = (sample.match(HAN_RE)?.length ?? 0) + (sample.match(KANA_RE)?.length ?? 0);
  if (cjk / letters >= SCRIPT_THRESHOLD) {
    // CJK has no registry entry in this tranche → detected-but-unsupported (fs-59).
    const han = sample.match(HAN_RE)?.length ?? 0;
    const kana = sample.match(KANA_RE)?.length ?? 0;
    return { language: kana > han ? 'ja' : 'zh', supported: false };
  }

  /* 3. franc disambiguates Latin, restricted to the registry's Latin codes. */
  const latin = entries.filter((e) => e.detect.script === 'latin');
  const iso = franc(sample, { only: latin.map((e) => e.detect.iso6393), minLength: 30 });
  const match = latin.find((e) => e.detect.iso6393 === iso);
  // 'und' or no match → fall back to English (the confidence floor).
  return match ? result(match.code) : result('en');
}
```

- [ ] **Step 5: Run to verify pass**

Run: `cd C:/Claude/Audiobook-Generator-wt-fs41/server && npx vitest run src/tts/detect-language.test.ts`
Expected: PASS (all cases). If the "English never misdetects" case is flaky on the short sample, lengthen the English fixture (a fuller paragraph) rather than weakening the assertion — `franc`'s n-gram model is reliable on more text; do NOT special-case it.

- [ ] **Step 6: Commit**

```bash
git add server/package.json server/package-lock.json server/src/tts/detect-language.ts server/src/tts/detect-language.test.ts
git commit -m "feat(server): server-side manuscript language detection (script + franc)"
```

---

### Task 3: Wire detection into `POST /api/import`

**Files:**
- Modify: `server/src/routes/import.ts` (the `res.json({ tempId, candidate: {...} })` build, ~lines 126-148)
- Modify: `src/lib/types.ts` (the `ImportCandidate` interface, ~lines 150-173)
- Test: `server/src/routes/import.test.ts` (add a detection assertion; create if absent)

**Interfaces:**
- Consumes: `detectManuscriptLanguage` (Task 2), `supportedLanguages` (Task 1).
- Produces: the import response `candidate` gains `language: string`, `languageSupported: boolean`, and `supportedLanguages: Array<{ code: string; label: string }>`.

- [ ] **Step 1: Extend the frontend type** — in `src/lib/types.ts`, add to `interface ImportCandidate` (alongside the existing optional `language?: string`):

```typescript
  /** fs-41/fs-50 — server-detected BCP-47 language (always set since seam 2). */
  language?: string;
  /** Whether the detected language is supported (false ⇒ detected-but-unsupported). */
  languageSupported?: boolean;
  /** Languages offered in the confirm selector (registry-supplied). */
  supportedLanguages?: Array<{ code: string; label: string }>;
```

(Keep the existing `language?: string` line; add the two new fields. If `openapi.yaml` defines the import response schema — grep it for the import response / `ImportCandidate` shape — mirror these three fields there and run `npm run openapi:types`; otherwise the hand-written `types.ts` is the contract.)

- [ ] **Step 2: Write the failing route test** — add to `server/src/routes/import.test.ts` (mirror the file's existing import-request setup; if the file does not exist, create it following `server/src/routes/*.test.ts` conventions — supertest against the `importRouter`):

```typescript
it('detects the manuscript language and stamps the supported-list on the candidate', async () => {
  const es =
    'El horno se había enfriado hasta el color de un atardecer cubierto de ceniza, y Wren raspaba la última escoria cuando alguien llamó a la puerta de su taller.';
  const res = await request(app).post('/api/import').send({ text: es }).expect(200);
  expect(res.body.candidate.language).toBe('es');
  expect(res.body.candidate.languageSupported).toBe(false);
  expect(res.body.candidate.supportedLanguages).toEqual([
    { code: 'en', label: 'English' },
    { code: 'ru', label: 'Russian' },
  ]);
});
```

- [ ] **Step 3: Run to verify failure**

Run: `cd C:/Claude/Audiobook-Generator-wt-fs41/server && npx vitest run src/routes/import.test.ts`
Expected: FAIL — `candidate.language` undefined (server doesn't detect yet).

- [ ] **Step 4: Implement** — in `server/src/routes/import.ts`:

Add imports at the top (with the other `../tts` / `../analyzer` imports):

```typescript
import { detectManuscriptLanguage } from '../tts/detect-language.js';
import { supportedLanguages } from '../tts/language-registry.js';
```

In the `res.json({ tempId, candidate: { … } })` build, compute detection once and add the three fields to `candidate`:

```typescript
const detected = detectManuscriptLanguage(entry.sourceText, {
  author: entry.author,
  title: entry.title,
});
// … inside candidate: { … existing fields … }
  language: detected.language,
  languageSupported: detected.supported,
  supportedLanguages: supportedLanguages(),
```

- [ ] **Step 5: Run to verify pass**

Run: `cd C:/Claude/Audiobook-Generator-wt-fs41/server && npx vitest run src/routes/import.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add server/src/routes/import.ts src/lib/types.ts server/src/routes/import.test.ts openapi.yaml src/lib/api-types.ts
git commit -m "feat(server): detect manuscript language on import and return the supported-list"
```

(Only `git add` `openapi.yaml`/`api-types.ts` if Step 1 found + updated an import schema there.)

---

### Task 4: Rebuild the confirm selector + retire the client detector

**Files:**
- Modify: `src/views/confirm-metadata.tsx` (LANGUAGE_OPTIONS, language seed, the Russian-specific copy, the new banner)
- Delete: `src/lib/detect-language.ts`, `src/lib/detect-language.test.ts`
- Test: `src/views/confirm-metadata.test.tsx`, `e2e/language-detection.spec.ts`

**Interfaces:**
- Consumes: `candidate.language`, `candidate.languageSupported`, `candidate.supportedLanguages` (Task 3).
- Produces: no new exports; the confirm view is server-driven.

- [ ] **Step 1: Confirm the client detector has no other importers**

Run: `cd C:/Claude/Audiobook-Generator-wt-fs41 && grep -rn "detect-language" src e2e`
Expected: only `src/views/confirm-metadata.tsx` (import + use), `src/lib/detect-language.ts`, and `src/lib/detect-language.test.ts`. If any OTHER importer appears, STOP and report (NEEDS_CONTEXT) — the deletion scope changed.

- [ ] **Step 2: Update the component tests first (new contract)** — in `src/views/confirm-metadata.test.tsx`, the `renderWithCandidate` helper must now provide the server fields instead of relying on `sourceText`→detect. Replace the three fs-2 selector tests (lines ~208-254) with:

```typescript
describe('ConfirmMetadataView — fs-41/fs-50 language selector (server-detected)', () => {
  it('seeds the selector from the server-detected language, no chip for English', () => {
    renderWithCandidate({ language: 'en', languageSupported: true,
      supportedLanguages: [{ code: 'en', label: 'English' }, { code: 'ru', label: 'Russian' }] });
    const select = screen.getByTestId('confirm-language') as HTMLSelectElement;
    expect(select.value).toBe('en');
    expect(screen.queryByText(/auto-detected/i)).not.toBeInTheDocument();
  });

  it('shows the auto-detected chip + Qwen note for a supported non-English detection', () => {
    renderWithCandidate({ language: 'ru', languageSupported: true,
      supportedLanguages: [{ code: 'en', label: 'English' }, { code: 'ru', label: 'Russian' }] });
    const select = screen.getByTestId('confirm-language') as HTMLSelectElement;
    expect(select.value).toBe('ru');
    expect(screen.getByText(/auto-detected russian/i)).toBeInTheDocument();
    expect(screen.getByText(/designed Qwen voices/i)).toBeInTheDocument();
  });

  it('shows a detected-but-unsupported banner and defaults to English when the detection is unsupported', () => {
    renderWithCandidate({ language: 'es', languageSupported: false,
      supportedLanguages: [{ code: 'en', label: 'English' }, { code: 'ru', label: 'Russian' }] });
    const select = screen.getByTestId('confirm-language') as HTMLSelectElement;
    expect(select.value).toBe('en'); // not yet supported → user must pick a supported language
    expect(screen.getByText(/spanish.*not.*supported/i)).toBeInTheDocument();
    // the unsupported language is NOT a selectable option
    expect(within(select).queryByText('Spanish')).not.toBeInTheDocument();
  });

  it('clears the auto-detected chip once the user changes the selector', async () => {
    const user = userEvent.setup();
    renderWithCandidate({ language: 'ru', languageSupported: true,
      supportedLanguages: [{ code: 'en', label: 'English' }, { code: 'ru', label: 'Russian' }] });
    expect(screen.getByText(/auto-detected russian/i)).toBeInTheDocument();
    await user.selectOptions(screen.getByTestId('confirm-language'), 'en');
    expect(screen.queryByText(/auto-detected russian/i)).not.toBeInTheDocument();
  });
});
```

(Add `within` to the existing `@testing-library/react` import if not present. Ensure `renderWithCandidate` spreads the provided fields onto the candidate.)

- [ ] **Step 3: Run to verify failure**

Run: `cd C:/Claude/Audiobook-Generator-wt-fs41 && npx vitest run src/views/confirm-metadata.test.tsx`
Expected: FAIL — component still imports `detectLanguage` and has hardcoded `LANGUAGE_OPTIONS`/`ru`-only copy; the unsupported-banner + dynamic options don't exist.

- [ ] **Step 4: Implement the component changes** in `src/views/confirm-metadata.tsx`:

(a) Remove `import { detectLanguage } from '../lib/detect-language';` and delete the hardcoded `LANGUAGE_OPTIONS` const.

(b) Seed `language` from the server, and derive options + the detected label/supported flag:

```typescript
const options = candidate?.supportedLanguages ?? [{ code: 'en', label: 'English' }];
const detectedSupported = candidate?.languageSupported !== false;
// Unsupported detection ⇒ start on English; the user must pick a supported language.
const [language, setLanguage] = useState<string>(
  () => (detectedSupported ? (candidate?.language ?? 'en') : 'en'),
);
const [languageTouched, setLanguageTouched] = useState(false);
const detectedLabel =
  options.find((o) => o.code === candidate?.language)?.label ?? candidate?.language ?? '';
const unsupportedLabel = candidate?.languageSupported === false
  ? (candidate?.language ?? '').toUpperCase()
  : null;
```

(c) Build the `<option>`s from `options` (label per entry); keep `data-testid="confirm-language"`. Generalise the chip + Qwen note from `ru`-specific to the detected supported language:

```tsx
{LANGUAGE_OPTIONS /* now: */ }
{options.map((o) => (
  <option key={o.code} value={o.code}>{o.label}</option>
))}
```
```tsx
{!languageTouched && detectedSupported && candidate?.language && candidate.language !== 'en' && (
  <p className="mt-1.5">
    <span className="inline-block text-[10px] uppercase tracking-widest font-semibold text-magenta bg-magenta/10 border border-magenta/20 rounded-full px-2.5 py-0.5">
      Auto-detected {detectedLabel} — verify
    </span>
  </p>
)}
{language !== 'en' && (
  <p className="mt-1.5 text-[11px] text-ink/55">
    {detectedLabel || 'Non-English'} books narrate with designed Qwen voices — you'll design a
    voice for the narrator and each speaking character in the cast view.
  </p>
)}
{unsupportedLabel && (
  <p className="mt-1.5 text-[11px] text-magenta">
    We detected {unsupportedLabel}, which isn't supported yet — pick a supported language below,
    or this book can't be generated.
  </p>
)}
```

- [ ] **Step 5: Delete the retired client detector**

```bash
cd C:/Claude/Audiobook-Generator-wt-fs41 && git rm src/lib/detect-language.ts src/lib/detect-language.test.ts
```

- [ ] **Step 6: Update the e2e spec** — in `e2e/language-detection.spec.ts`, the tests upload real text and rely on the (now server-side) detection; they should still pass unchanged IF the mock server runs the real detection. Confirm the e2e mock mode hits the real `/api/import` detection. Update the assertions only if the copy text changed (the Russian chip/Qwen note wording is preserved). Run:

Run: `cd C:/Claude/Audiobook-Generator-wt-fs41 && npx playwright test e2e/language-detection.spec.ts --project=chromium`
Expected: PASS (Cyrillic → ru chip + Qwen note; English → no Russian chrome). If e2e mock mode does NOT exercise server detection, add a `language`/`supportedLanguages` stub to the mock import response so the spec drives the new server-driven path; note the change.

- [ ] **Step 7: Run the frontend suite + typecheck**

Run: `cd C:/Claude/Audiobook-Generator-wt-fs41 && npx vitest run src/views/confirm-metadata.test.tsx && npm run typecheck`
Expected: PASS — confirm tests green, no dangling `detect-language` import, types resolve.

- [ ] **Step 8: Commit**

```bash
git add src/views/confirm-metadata.tsx src/views/confirm-metadata.test.tsx e2e/language-detection.spec.ts
git commit -m "feat(frontend): server-driven confirm language selector + detected-but-unsupported banner"
```

---

## Self-Review

- **Spec coverage (§2 sharing seam, §3 detection, §7 seam 2, §10):** registry `detect` field + es/fr/de ✓ (T1); server detection — script pre-pass authoritative, franc-for-Latin restricted + confidence floor, front-matter strip before detect, English-never-misdetects, fail-safe (`languageSupported:false`, no silent `en`) ✓ (T2); import response carries `{language, languageSupported, supportedLanguages}` ✓ (T3); selector built from supported-list + generalised copy + detected-but-unsupported banner + client detector retired ✓ (T4). `ru` path preserved by the Cyrillic pre-pass + the unchanged seam-1 tests. The deferred seam-1 Minor (`isSupportedLanguage` present-but-`supported:false` test) is closed in T1.
- **Placeholder scan:** none — code + commands + expected output throughout. The two conditional steps (openapi import schema in T3; e2e mock-detection in T4) are concrete checks with a defined action per branch, not vague directives.
- **Type consistency:** `detectManuscriptLanguage` / `DetectionResult` / `allLanguageEntries` / `supportedLanguages` are spelled identically across T1-T3; `{ code, label }` is the supported-list shape in the registry (T1), the import response (T3), and the selector (T4); `languageSupported` (not `supported`) is the response field name throughout.

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-06-23-fs41-fs50-seam2-server-detection.md`. Two execution options:

1. **Subagent-Driven (recommended)** — fresh subagent per task, review gate between tasks (T2's detection logic + T4's UI warrant the gate).
2. **Inline Execution** — execute the four tasks here with a checkpoint after each.

Note: T2 adds a runtime dependency (`franc`) and T4 spans frontend + e2e — both heavier than seam 1, so the per-task review gate earns its keep.
