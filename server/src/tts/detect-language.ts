/* Server-side manuscript language detection (fs-41/fs-50 seam 2). Runs during
   POST /api/import. The script pre-pass is authoritative (Cyrillic⇒ru, CJK⇒
   zh/ja — both `supported: true` since fs-59 W5, read through the registry
   below rather than a literal); franc disambiguates the Latin set (en/es/fr/de),
   restricted to the registry's ISO-639-3 codes. Front-matter is stripped first
   so an English copyright page can't mask a non-English body. Never silently
   returns `en` for a confidently-detected other language — the `supported`
   flag rides along.

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
   * True on a surrender path — no letters to sample, franc found no Latin
   * match, or franc's restricted-to-the-registry answer was a coercion (an
   * unrestricted franc call landed outside the registry's Latin set, so the
   * restricted match was forced onto the nearest registered language rather
   * than genuinely decided) — where `language` is a confidence-floor guess,
   * not a decision. On the coercion path `language` still carries the
   * restricted best guess, not `'en'`. False whenever the language was
   * genuinely decided (script pre-pass match, or a real franc match) —
   * including the `en` case where franc/pre-pass actually decided English.
   * `supported` cannot distinguish these cases because 'en' is itself
   * `supported: true`; callers that must "never write a language they only
   * guessed" (#2246) need this field, not `supported`.
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
   chapter-aware single-body-chapter prose-unit floor (below) look at.
   Exported so a caller that needs to explain (not decide) a surrender —
   e.g. the repair script's diagnostic reason string — can compute the same
   winning-language prose-unit count voteLanguage itself used, rather than
   drifting from it. */
export function prepareSample(text: string, meta: { author?: string | null; title?: string | null }): string {
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

  /* 3. franc disambiguates Latin, restricted to the registry's Latin codes.
     Restricting franc's `only` set to the four registered Latin languages
     means franc MUST answer with one of them — a book written in a Latin
     language outside that set (Italian, Portuguese, Dutch, …) gets coerced
     onto its nearest registered neighbour (Italian → 'es', Portuguese →
     'es', Dutch → 'de', measured 2026-08-13) and returned as if it were a
     genuine decision. Cross-check with an UNRESTRICTED franc call: if the
     unrestricted answer isn't one of the registry's Latin codes, the
     restricted answer was a coercion, not a decision, so this is a
     surrender — `fallback: true` — even though `language` still carries the
     restricted best guess (so the confirm screen has something to
     pre-select and override). This function runs once per CANDIDATE CHAPTER
     in production (voteLanguage below calls it per chapter, not once per
     book), so that is the unit the cross-check needs measuring against — a
     whole-book figure understates the sample, since per-chapter samples are
     smaller and more numerous. Measured per chapter against all 82 cached
     analyses in the live corpus (server/handoff/cache, 2026-08-13): 607
     franc ballots, 5 disagreements (0.8%), all of them real English prose
     that unrestricted franc labels `sco` (Scots) rather than a genuine
     coercion — absorbed by voteLanguage's mass vote, so 0 outcome changes
     across all 77 books with chapters. */
  const latin = allLanguageEntries().filter((e) => e.detect.script === 'latin');
  const latinIso = latin.map((e) => e.detect.iso6393);
  const iso = franc(sample, { only: latinIso, minLength: 30 });
  const match = latin.find((e) => e.detect.iso6393 === iso);
  // 'und' or no match → fall back to English (the confidence floor).
  if (!match) return resultFor('en', true);
  const unrestrictedIso = franc(sample, { minLength: 30 });
  const coerced = !latinIso.includes(unrestrictedIso);
  return resultFor(match.code, coerced);
}

/* Chapters that look like front/back matter by title, or that are too short
   to be a real chapter, aren't representative of the book's language — drop
   them from the voting pool. Falls back to the full chapter list if that
   leaves nothing (a book that's entirely front-matter-titled is better
   judged than refused outright). */
export function selectBodyChapters<T extends { title: string; body: string }>(chapters: T[]): T[] {
  return chapters.filter(
    (c) => !isLikelyFrontMatterTitle(c.title) && countWords(c.body) >= FRONT_MATTER_WORD_THRESHOLD,
  );
}

/* Mass-weighted vote over the candidate chapters (#2276 — was per-CHAPTER
   voting, which made the answer depend on how the book happens to be split
   into chapters rather than on the text itself: two short chapters could
   outvote a whole novel in one). Each chapter's ballot is weighted by its own
   word count (countWords — the CJK-aware one, shared with selectBodyChapters
   so a chapter can't be counted one way for selection and another for the
   vote), and the winner needs a STRICT majority (> 0.5, not >=) of the
   non-surrendered MASS — see detectManuscriptLanguageFromChapters's own
   comment for why that margin is safe across the live corpus. No majority,
   or zero non-surrendered detections, is a surrender.

   The prose-unit floor is applied here too, to the WINNING language's own
   mass only (not to candidates.length — see detectManuscriptLanguageFromChapters's
   comment for why keying it on chapter count made it unreachable in
   practice). A single candidate is just the n=1 case of this same vote: its
   whole mass "wins" unanimously, and its own prose units are checked against
   the floor exactly as any other winner's are. */
function voteLanguage(
  candidates: Array<{ title: string; body: string }>,
  meta: { author?: string | null; title?: string | null },
): DetectionResult {
  const ballots = candidates.map((c) => ({ chapter: c, detection: detectManuscriptLanguage(c.body, meta) }));
  const nonSurrendered = ballots.filter((b) => !b.detection.fallback);
  if (nonSurrendered.length === 0) return resultFor('en', true);

  const massByLanguage = new Map<string, number>();
  let totalMass = 0;
  for (const { chapter, detection } of nonSurrendered) {
    const mass = countWords(chapter.body);
    massByLanguage.set(detection.language, (massByLanguage.get(detection.language) ?? 0) + mass);
    totalMass += mass;
  }

  let winner: string | null = null;
  let winnerMass = 0;
  for (const [language, mass] of massByLanguage) {
    if (mass > winnerMass) {
      winner = language;
      winnerMass = mass;
    }
  }
  if (!winner || totalMass === 0 || winnerMass / totalMass <= 0.5) return resultFor('en', true);

  const winningProseUnits = nonSurrendered
    .filter((b) => b.detection.language === winner)
    .reduce((sum, b) => sum + countProseUnits(prepareSample(b.chapter.body, meta)), 0);

  return winningProseUnits < PROSE_UNIT_FLOOR ? resultFor('en', true) : resultFor(winner, false);
}

/* #2263/#2276 — chapter-aware entry point, called by POST /api/import instead
   of detectManuscriptLanguage. Detects each body chapter independently
   (dropping likely front/back matter first, see selectBodyChapters) and
   votes, so a front-matter chapter in a different language than the body
   can't decide the whole book.

   #2276 — the vote (and the PROSE_UNIT_FLOOR gate) must be chapter-count
   INVARIANT: splitting or merging chapters must never change the detected
   language, because a chapter is an arbitrary container. The old
   implementation voted one ballot per CHAPTER and only applied the floor when
   there was exactly one candidate — both are chapter-count-shaped, not
   text-shaped, so re-chaptering the same text (which any real analysis cache
   does, being keyed by chapter) could flip the answer. voteLanguage above
   fixes both: every chapter's ballot is weighted by its own word mass, and
   the floor sums the WINNING language's mass regardless of how many chapters
   it came from — so a single surviving body chapter is just the n=1 case of
   the same vote, not a separate code path.

   Strict majority (> 0.5) is safe: measured 2026-08-11 against the live
   20-book corpus (server/handoff/cache), voting every non-excluded chapter
   with NO front-matter/word-count SELECTION at all (as if selectBodyChapters
   failed completely) still resolves every book to its correct language, with
   the lowest winning-language mass share measured at 100% — this corpus's
   cached chapters already exclude non-body material, so selectBodyChapters
   is a defense against contamination this corpus hasn't needed yet, not
   evidence the margin is thin. Do not lower this margin without
   re-measuring. */
export function detectManuscriptLanguageFromChapters(
  chapters: Array<{ title: string; body: string }>,
  meta: { author?: string | null; title?: string | null } = {},
): DetectionResult {
  const bodyChapters = selectBodyChapters(chapters);
  const candidates = bodyChapters.length > 0 ? bodyChapters : chapters;
  if (candidates.length === 0) return resultFor('en', true);

  return voteLanguage(candidates, meta);
}
