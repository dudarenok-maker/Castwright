/* Skill loading and system-instruction assembly shared by every analyzer transport. Moved from gemini.ts (#3084 wave 1). */
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readPrompt } from '../../config/prompts.js';
import { isNonEnglish, normaliseBookLanguage } from '../../tts/language.js';
import { getLanguageEntry } from '../../tts/language-registry.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SKILLS_DIR = resolve(__dirname, '..', '..', '..', '..', 'skills');
const SKILL_FILES = {
  /* Legacy whole-book stage 1 — kept for any caller still wiring it.
     Not in the prompt registry so it reads directly from disk. */
  whole_book_stage1: 'audiobook-character-analysis.md',
  /* Phase 0a — per-chapter cast detection (the current default).
     Routes through the prompt-fork loader (prompt.castDetection). */
  per_chapter_stage1: 'audiobook-character-detection-per-chapter.md',
  /* Phase 1 — per-chapter sentence attribution.
     Routes through the prompt-fork loader (prompt.sentenceAttribution). */
  per_chapter_stage2: 'audiobook-sentence-attribution.md',
  /* fs-33 — emotion-only backfill pass (does NOT re-attribute).
     Routes through the prompt-fork loader (prompt.emotionAnnotation). */
  emotion_annotation: 'audiobook-emotion-annotation.md',
  /* fs-58 — per-chapter script review (strip_tag/split/extract_dialogue/merge/fix_emotion).
     Routes through the prompt-fork loader (prompt.scriptReview). */
  script_review: 'audiobook-script-review.md',
  /* fs-57 — per-chapter instruct-annotation pass (delivery directions + vocalizations).
     Routes through the prompt-fork loader (prompt.instructAnnotation). */
  instruct_annotation: 'audiobook-instruct-annotation.md',
  /* #1447 — chapter-level non-story classification (Signal 2). Not user-forkable
     (omitted from SKILL_TO_PROMPT_ID) — reads straight from skills/. */
  non_story_classification: 'audiobook-non-story-classification.md',
} as const;
export type SkillName = keyof typeof SKILL_FILES;

/* Mapping from skill name to prompt-registry id, for the three skills that
   support user-forkable prompts. The legacy whole_book_stage1 isn't in the
   registry and still reads directly from disk. */
const SKILL_TO_PROMPT_ID: Partial<Record<SkillName, string>> = {
  per_chapter_stage1: 'prompt.castDetection',
  per_chapter_stage2: 'prompt.sentenceAttribution',
  emotion_annotation: 'prompt.emotionAnnotation',
  script_review: 'prompt.scriptReview',
  instruct_annotation: 'prompt.instructAnnotation',
};

/* Read the skill file fresh on every request so prompt iteration doesn't
   require a server restart. The files are small (~3-5 KB) and read once
   per analysis — negligible cost.

   For the three registry-backed skills, resolves through readPrompt() so a
   user-forked copy in ~/.castwright/prompts/<id>.md takes effect on the next
   analysis run without a restart (apply:'live'). The legacy whole_book_stage1
   still reads from disk directly. */
export async function loadSkill(skill: SkillName): Promise<string> {
  const promptId = SKILL_TO_PROMPT_ID[skill];
  if (promptId) {
    return (await readPrompt(promptId)).text;
  }
  return readFile(resolve(SKILLS_DIR, SKILL_FILES[skill]), 'utf8');
}

/* The skill text is moved to `systemInstruction` rather than re-sent as
   part of `contents` on every call (see callsite). This shaves ~10 KB off
   each per-chapter stage-2 request and makes the user-turn token count
   actually proportional to the task.

   skillName — when 'instruct_annotation' and the manuscript is non-English,
   appends a short Stage-3 reinforcement clause (mirrors the castFields guards
   in languagePreamble: local models need system-level reinforcement even when
   the skill already states the rule). English output is byte-identical. */
export function buildSystemInstruction(skill: string, language?: string, skillName?: string): string {
  /* Stage-3 reinforcement: fires ONLY for instruct_annotation + non-English.
     The skill already covers this rule, but local models reliably miss it
     without a system-level echo. One sentence, no wholesale duplication. */
  const stage3Clause =
    skillName === 'instruct_annotation' && language && isNonEnglish(language)
      ? '\n\nFor THIS pass: write each vocalization\'s `text` in the manuscript\'s language (using its native orthography and script); write every `instruct` field in English.'
      : '';
  return `You are an automated worker, not a human. Follow the schema, rules, and JSON example in the SKILL section EXACTLY. Use the camelCase field names shown there (e.g. \`name\`, not \`character_name\`; \`chapterId\`, not \`chapter_id\`). Do NOT invent extra fields. Do NOT wrap the response in markdown fences. Your only output is a JSON object that conforms to the schema.${languagePreamble(language)}${stage3Clause}

---

# SKILL

${skill}

---

Return ONLY a single JSON object that matches the schema in the SKILL section. No prose. No code fences.`;
}

/* fs-2 — language preamble for non-English manuscripts. Appended to the system
   instruction so character/dialogue attribution respects the script's
   conventions. Empty for English (and absent language) so English analysis is
   byte-identical to pre-fs-2. Only Russian is wired in v1; other non-English
   languages get a generic preamble. The JSON field names + values stay English
   regardless — only the manuscript text is in another language. */
export function languagePreamble(language?: string): string {
  if (!language || !isNonEnglish(language)) return '';
  const primary = normaliseBookLanguage(language);
  const ru = primary === 'ru';
  const entry = getLanguageEntry(primary);
  const where = entry
    ? `${entry.sidecarName}${entry.detect.script === 'cyrillic' ? ' (Cyrillic script)' : entry.detect.script === 'cjk' ? ' (Chinese/Japanese script)' : ''}`
    : `${language} (a non-English language)`;
  /* Per-language dialogue conventions for the Latin tranche (Russian keeps its own
     tuned string below). The German caution is load-bearing: every German noun is
     capitalised, so the model must not infer a speaker from capitalisation. */
  const LATIN_CONVENTIONS: Record<string, string> = {
    es: ' Dialogue is marked with «…» or an em-dash —, and questions/exclamations open with ¿ ¡. Characters may be named by first name or surname.',
    fr: ' Dialogue is marked with « … » (with spaces) or an em-dash —, not English "quotes".',
    de: ' Dialogue is marked with „…" (low/high quotes) or «…». NOTE: every German noun is capitalised, so a capitalised word is NOT necessarily a character name.',
  };
  /* CJK dialogue conventions (fs-59 W3, Task 3.3). Chinese and Japanese mark
     dialogue with corner brackets 「…」/『…』 (nested quotes) or, for Chinese,
     fullwidth "…" — never a dash-dialogue line like Russian/French. The
     tag-is-narrator note targets the §2.1 hard case: when a single spoken turn
     is split by a narrator tag (e.g. 她说 / 彼女は言った), BOTH halves belong to
     the speaker — the tag itself is the narrator, but the second spoken half
     after the tag is NOT the narrator's; it continues the same speaker's line. */
  const CJK_CONVENTIONS =
    ' Dialogue is marked with corner brackets 「…」 or 『…』 (Japanese/nested), or fullwidth quotes "…" (Chinese) — not a dash-dialogue line. IMPORTANT: when a spoken turn is split by a narrative tag naming who spoke (e.g. 她说 / 彼女は言った), that tag is the narrator, NOT the speaker — but the SECOND spoken half after the tag still belongs to the same speaker, not the narrator.';
  const conventions = ru
    ? ' Dialogue is often marked with guillemets «…» or an em-dash —, not English "quotes". Characters may be named by first name, patronymic, surname, or diminutive (e.g. "Соня" for "Софья") — treat these as the same person. IMPORTANT: a dashed line that is a narrative TAG describing who spoke or what they did — e.g. «— сказал юноша.», «— тихо произнесла девушка.», «— Девушка улыбнулась.» (verbs like сказал/произнёс(ла)/воскликнул(а)/спросил(а)/засмеялся/улыбнулась/нахмурился) — is the narrator, NOT the speaker. Only the actually-spoken words belong to the speaker.'
    : entry?.detect.script === 'cjk'
      ? CJK_CONVENTIONS
      : (LATIN_CONVENTIONS[primary] ?? '');
  /* In-language few-shot roster + attribution examples (fs-59 W3, Task 3.3).
     Registered on the language-registry entry per-language (unset for languages
     without an example yet), written IN the target language/script so the model
     sees a worked example rather than only an English rule statement. */
  const examples = entry?.promptExamples
    ? ` Roster example: ${entry.promptExamples.roster} Attribution example: ${entry.promptExamples.attribution}`
    : '';
  /* Cast-field guards for any non-English manuscript (validated on Russian +
     gemma4-e4b, 2026-06-19: without these the local model emits gender/age
     100% but `tone` 0% and writes role/description in mixed English/target
     language). Phrased "when you output a character" so it is a no-op for the
     stage-2 attribution pass (which lists sentences, not characters). Field
     NAMES + enum values stay English as the line above already mandates. */
  const castFields = ` When you output a character, ALWAYS include the \`tone\` object (integers 0–100 for warmth, pace, authority, emotion) estimated from how they speak — never omit it. Write the human-readable text — \`role\`, \`description\`, and each \`attributes\` tag, for every character INCLUDING the narrator — in ${where} (the manuscript's language), and always include a \`description\`.`;
  return `\n\nIMPORTANT: the manuscript text is in ${where}. Quote evidence VERBATIM from the manuscript (do not translate or transliterate it). Keep all JSON field names and enum values in English exactly as the schema shows.${castFields}${conventions}${examples}`;
}
