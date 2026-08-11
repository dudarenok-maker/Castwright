/* Server-side manuscript language detection (fs-41/fs-50 seam 2). Runs during
   POST /api/import. The script pre-pass is authoritative (Cyrillic⇒ru, CJK⇒
   unsupported); franc disambiguates the Latin set (en/es/fr/de), restricted to
   the registry's ISO-639-3 codes. Front-matter is stripped first so an English
   copyright page can't mask a non-English body. Never silently returns `en` for
   a confidently-detected other language — the `supported` flag rides along.

   #2263 — `detectManuscriptLanguage` samples the first SAMPLE_CHARS of the
   WHOLE document, which is exactly where front matter (title page, copyright,
   dedication, TOC, epigraph, foreword) lives — the part of a book least
   likely to be written in the book's own language. `detectManuscriptLanguageFromChapters`
   below detects each body chapter independently and votes, so a
   non-representative front-matter chapter can't outvote the real body. Both
   entry points stay exported: the single-text one is unchanged (the repair
   script and its own tests call it directly), the chapter-aware one is what
   POST /api/import now calls. */
import { franc } from 'franc';
import { allLanguageEntries } from './language-registry.js';
import { stripFrontMatterBoilerplate } from '../analyzer/strip-front-matter.js';
import { isLikelyFrontMatterTitle, FRONT_MATTER_WORD_THRESHOLD, countWords } from '../parsers/front-matter.js';
import { countProseUnits, PROSE_UNIT_FLOOR } from './prose-units.js';

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
  /**
   * True on a surrender path (no letters to sample, or franc found no Latin
   * match) where `language: 'en'` is a confidence-floor guess, not a decision.
   * False whenever the language was genuinely decided (script pre-pass match,
   * or a real franc match) — including the `en` case where franc/pre-pass
   * actually decided English. `supported` cannot distinguish these cases
   * because 'en' is itself `supported: true`; callers that must "never write
   * a language they only guessed" (#2246) need this field, not `supported`.
   */
  fallback: boolean;
}

/* Shared by both entry points below (moved out of detectManuscriptLanguage's
   own closure, #2263, so detectManuscriptLanguageFromChapters's voting can
   build a DetectionResult too — same { language, supported, fallback } shape
   either way, read THROUGH the registry so a future registry change
   propagates to both). */
function resultFor(code: string, fallback: boolean): DetectionResult {
  const e = allLanguageEntries().find((x) => x.code === code);
  return { language: code, supported: e?.supported ?? false, fallback };
}

/* Front-matter strip, then sample a prefix — the exact text both
   detectManuscriptLanguage's own script-pre-pass/franc steps and the
   chapter-aware single-body-chapter prose-unit floor (below) look at. */
function prepareSample(text: string, meta: { author?: string | null; title?: string | null }): string {
  const cleaned = stripFrontMatterBoilerplate(text, {
    author: meta.author ?? undefined,
    title: meta.title ?? undefined,
  });
  return cleaned.length > SAMPLE_CHARS ? cleaned.slice(0, SAMPLE_CHARS) : cleaned;
}

export function detectManuscriptLanguage(
  text: string,
  meta: { author?: string | null; title?: string | null } = {},
): DetectionResult {
  /* 1. Front-matter strip, then sample a prefix. */
  const sample = prepareSample(text, meta);

  /* 2. Script pre-pass (authoritative, deterministic). */
  const letters = sample.match(LETTER_RE)?.length ?? 0;
  if (letters === 0) return resultFor('en', true);
  const cyrillic = sample.match(CYRILLIC_RE)?.length ?? 0;
  if (cyrillic / letters >= SCRIPT_THRESHOLD) return resultFor('ru', false);
  const han = sample.match(HAN_RE)?.length ?? 0;
  const kana = sample.match(KANA_RE)?.length ?? 0;
  if ((han + kana) / letters >= SCRIPT_THRESHOLD) {
    // zh/ja are supported:true since fs-59 W5 — read THROUGH the registry
    // (not a literal) so any future registry change propagates here too.
    return resultFor(kana > han ? 'ja' : 'zh', false);
  }

  /* 3. franc disambiguates Latin, restricted to the registry's Latin codes. */
  const latin = allLanguageEntries().filter((e) => e.detect.script === 'latin');
  const iso = franc(sample, { only: latin.map((e) => e.detect.iso6393), minLength: 30 });
  const match = latin.find((e) => e.detect.iso6393 === iso);
  // 'und' or no match → fall back to English (the confidence floor).
  return match ? resultFor(match.code, false) : resultFor('en', true);
}

/* Chapters that look like front/back matter by title, or that are too short
   to be a real chapter, aren't representative of the book's language — drop
   them from the voting pool. Falls back to the full chapter list if that
   leaves nothing (a book that's entirely front-matter-titled is better
   judged than refused outright). */
function selectBodyChapters<T extends { title: string; body: string }>(chapters: T[]): T[] {
  return chapters.filter(
    (c) => !isLikelyFrontMatterTitle(c.title) && countWords(c.body) >= FRONT_MATTER_WORD_THRESHOLD,
  );
}

/* Modal language over the chapters whose detection didn't surrender, gated on
   a STRICT majority (> 0.5, not >=) — see detectManuscriptLanguageFromChapters's
   own comment for why that margin is safe across the live corpus. No majority,
   or zero non-surrendered detections, is a surrender. */
function voteLanguage(detections: DetectionResult[]): DetectionResult {
  const nonSurrendered = detections.filter((d) => !d.fallback);
  if (nonSurrendered.length === 0) return resultFor('en', true);

  const counts = new Map<string, number>();
  for (const d of nonSurrendered) counts.set(d.language, (counts.get(d.language) ?? 0) + 1);
  let modalLanguage: string | null = null;
  let modalCount = 0;
  for (const [language, count] of counts) {
    if (count > modalCount) {
      modalLanguage = language;
      modalCount = count;
    }
  }

  return modalLanguage && modalCount / nonSurrendered.length > 0.5
    ? resultFor(modalLanguage, false)
    : resultFor('en', true);
}

/* #2263 — chapter-aware entry point, called by POST /api/import instead of
   detectManuscriptLanguage. Detects each body chapter independently (dropping
   likely front/back matter first, see selectBodyChapters) and votes, so a
   front-matter chapter in a different language than the body can't decide the
   whole book. A single surviving body chapter can't corroborate itself, so it
   goes through the same PROSE_UNIT_FLOOR gate the language-repair script uses
   for its own single-sample case (server/src/tts/prose-units.ts) instead of
   voting.

   Strict majority (> 0.5) is safe: measured against the live 20-book corpus,
   voting every chapter with NO front-matter selection at all (the worst case —
   as if that filter failed completely) still gives every book's correct
   language, with the lowest modal share still 67% (well clear of the 50%
   line). Do not lower this margin without re-measuring against that corpus. */
export function detectManuscriptLanguageFromChapters(
  chapters: Array<{ title: string; body: string }>,
  meta: { author?: string | null; title?: string | null } = {},
): DetectionResult {
  const bodyChapters = selectBodyChapters(chapters);
  const candidates = bodyChapters.length > 0 ? bodyChapters : chapters;
  if (candidates.length === 0) return resultFor('en', true);

  if (candidates.length === 1) {
    const detection = detectManuscriptLanguage(candidates[0].body, meta);
    if (detection.fallback) return detection;
    const units = countProseUnits(prepareSample(candidates[0].body, meta));
    return units < PROSE_UNIT_FLOOR ? resultFor('en', true) : detection;
  }

  return voteLanguage(candidates.map((c) => detectManuscriptLanguage(c.body, meta)));
}
