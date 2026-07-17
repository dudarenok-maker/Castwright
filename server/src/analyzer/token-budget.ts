/* Script-aware token budgeting shared by the estimator (gemini.ts) and the
   cloud chunk sizers (stage1/2-chunk, chapter-chunker). The 429 that motivated
   this carries no promptTokenCount, so the ratio is a bounded approximation, not
   a measurement — size conservatively; the rate-limiter fail-fast guard backstops. */
import { configValue } from '../config/resolver.js';
import { countCjkChars } from '../util/cjk.js';

export const LATIN_CHARS_PER_TOKEN = 4;
export const CYRILLIC_CHARS_PER_TOKEN = 2.5;
export const HAN_KANA_CHARS_PER_TOKEN = 1.2;

export function countCyrillic(s: string): number {
  const m = s.match(/[Ѐ-ӿ]/g);
  return m ? m.length : 0;
}

/** Interpolated chars-per-token for `text` from its Cyrillic / CJK fraction. */
export function charsPerTokenForText(text: string): number {
  const chars = text.length;
  if (chars === 0) return LATIN_CHARS_PER_TOKEN;
  const cyr = countCyrillic(text) / chars;
  const han = countCjkChars(text) / chars;
  return (
    LATIN_CHARS_PER_TOKEN -
    cyr * (LATIN_CHARS_PER_TOKEN - CYRILLIC_CHARS_PER_TOKEN) -
    han * (LATIN_CHARS_PER_TOKEN - HAN_KANA_CHARS_PER_TOKEN)
  );
}

export function resolveMaxInputTokensPerRequest(): number {
  return configValue<number>('analyzer.gemini.maxInputTokensPerRequest');
}

/** Char budget for a cloud request body sized to the per-request token cap,
    minus fixed per-call overhead (roster/context/system). 2000-char floor.

    Two ways to reserve overhead:
    - `reservedTokens` — TOKEN-space: subtracted from the cap BEFORE it is
      converted to chars, so the reservation is script-correct (the remaining
      token budget is expanded at the BODY's own chars/token rate). Use this for
      a fixed, script-agnostic overhead like a large system instruction, whose
      token cost is the same whatever script the body is in.
    - `reservedChars` — CHAR-space: subtracted AFTER the char conversion. A
      cruder approximation (it can't be right across scripts — see the header),
      kept for the existing roster-length callers (script review / output-heavy
      passes) that already pass a char count. */
export function cloudBodyCharBudget(body: string, reservedChars = 0, reservedTokens = 0): number {
  const availableTokens = Math.max(0, resolveMaxInputTokensPerRequest() - reservedTokens);
  const perRequestChars = Math.floor(availableTokens * charsPerTokenForText(body));
  return Math.max(2000, perRequestChars - reservedChars);
}
