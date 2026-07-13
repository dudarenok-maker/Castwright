/* fs-61 guard — every `supported:true` language in the registry must ship a
   Coalfall sample in samples/, so adding a language forces adding its sample.
   The check is language-driven (each sample's state.json `language`), not slug-
   driven, so English's bare `the-coalfall-commission` slug counts the same as
   the per-language `the-coalfall-commission-<lang>` captures. */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { allLanguageEntries } from './language-registry.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SAMPLES_ROOT = resolve(__dirname, '..', '..', '..', 'samples');

/** Map every committed sample's language → its slug (a language may, in
    principle, have more than one sample; we only need one). */
function samplesByLanguage(): Map<string, string[]> {
  const byLang = new Map<string, string[]>();
  if (!existsSync(SAMPLES_ROOT)) return byLang;
  for (const entry of readdirSync(SAMPLES_ROOT, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const statePath = join(SAMPLES_ROOT, entry.name, '.audiobook', 'state.json');
    if (!existsSync(statePath)) continue;
    const state = JSON.parse(readFileSync(statePath, 'utf8'));
    const lang = state.language;
    if (!lang) continue;
    (byLang.get(lang) ?? byLang.set(lang, []).get(lang)!).push(entry.name);
  }
  return byLang;
}

describe('supported-language sample coverage (fs-61)', () => {
  const byLang = samplesByLanguage();
  const supported = allLanguageEntries().filter((e) => e.supported);

  it.each(supported.map((e) => [e.code, e.sidecarName] as const))(
    'ships a runnable sample book for supported language %s (%s)',
    (code) => {
      const slugs = byLang.get(code);
      expect(
        slugs && slugs.length > 0,
        `No samples/ book has language "${code}". Every supported:true language in ` +
          `language-registry.ts must ship a Coalfall sample (capture one into ` +
          `samples/the-coalfall-commission-${code}/ and slim its cover).`,
      ).toBe(true);

      // The sample must actually be loadable: manuscript + cast present.
      const slug = slugs![0];
      const dir = join(SAMPLES_ROOT, slug);
      const state = JSON.parse(readFileSync(join(dir, '.audiobook', 'state.json'), 'utf8'));
      expect(existsSync(join(dir, state.manuscriptFile)), `${slug}: manuscript missing`).toBe(true);
      expect(existsSync(join(dir, '.audiobook', 'cast.json')), `${slug}: cast.json missing`).toBe(true);
    },
  );
});
