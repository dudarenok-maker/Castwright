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
