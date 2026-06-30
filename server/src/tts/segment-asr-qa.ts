/* ASR content-QA policy (srv-31) — the trustworthy half of the gate.
   Companion to the signal-based `segment-qa.ts`: that one catches dead /
   silent / wrong-length audio with cheap math; THIS one catches a generation
   that is fluent, right length, right loudness, but says the WRONG WORDS — by
   transcribing it (Whisper, in the sidecar) and word-error-rating the
   transcript against the manuscript sentence.

   The make-or-break for srv-31 is TRUSTWORTHINESS: a gate that false-flags a
   perfectly good "Wren Sparrow" line (Whisper mangles invented names) gets
   switched off, and then garbled chapters ship again. So the verdict logic:

     - normalises both strings hard (case / punctuation / contractions / digits)
       so cosmetic differences never count,
     - decomposes the edit distance into substitution / deletion / insertion
       with asymmetric thresholds (a long DELETION run = truncation/drop drift =
       serious; a single substitution = benign),
     - co-evaluates Whisper's INTRINSIC signals: a high compression_ratio is the
       loop/repeat tell (→ drift even at low WER); a very low avg_logprob / high
       no_speech_prob means the TRANSCRIPT itself is untrustworthy (→
       `inconclusive`, NOT a re-record — re-recording on an untrusted transcript
       is how false-positive loops start),
     - tolerates proper nouns via a per-book name allowlist (the cast roster).

   `classifyTranscript` is PURE (text + signals in, verdict out) so the policy is
   unit-testable without a sidecar; `verifySegmentTranscript` adds the one
   transcribe call. Env-override pattern mirrors `segment-qa.ts`. */

import { transcribeSegment, type TranscribeResult } from './transcribe-client.js';
import { configValue, resolveKnob } from '../config/resolver.js';
import { allKnobs } from '../config/registry.js';

export type AsrVerdict = 'ok' | 'drift' | 'inconclusive';

export interface AsrSignals {
  avgLogprob: number | null;
  noSpeechProb: number | null;
  compressionRatio: number | null;
}

export interface AsrClassification {
  verdict: AsrVerdict;
  /** Word-error-rate after normalization + proper-noun tolerance, in [0, ~1+]. */
  wer: number;
  /** Counted (non-tolerated) substitutions / deletions / insertions. */
  sub: number;
  del: number;
  ins: number;
  /** Longest contiguous run of deletions — the truncation/drop signal. */
  longestDeletionRun: number;
  transcript: string;
  reasons: string[];
}

export interface AsrThresholds {
  /** wer above this is drift. */
  maxWer: number;
  /** A contiguous deletion run longer than this is drift (truncation/drop). */
  maxDeletionRun: number;
  /** Sentences shorter than this (trimmed chars) are not scored (one wrong word
      swamps a short sentence's WER) → inconclusive. */
  minChars: number;
  /** References in the WORD-count band [2, minRefWords] (after normalization)
      where the only error is substitution(s) are routed to `inconclusive` instead
      of `drift`: a single ASR substitution swamps WER on a 2-word line yet is weak
      evidence. 1-word refs are EXCLUDED (a full sub there is strong evidence);
      deletions/insertions are exempt (they stay drift). 0 disables the backstop. */
  minRefWords: number;
  /** Longest adjacent token run `bridgeCompounds` rejoins to a single
      other-stream token (A2d). 3 catches a name Whisper splits into three
      ("Scapegrace" → "scape a grace"); 2 restores pair-only bridging. */
  maxBridgeRun: number;
  /** A2e: a 1-word reference whose only error is a single substitution within
      edit-distance 1 of what was heard ("Uneventfully" → "Unaventfully") is a
      spelling variant, not a content defect → inconclusive. false disables it
      (a 1-word full sub stays drift). Short single words never reach here — the
      minChars floor already returns above. */
  homophone1Word: boolean;
  /** compression_ratio above this → drift (Whisper's loop/repeat hallucination
      tell), regardless of WER. */
  maxCompressionRatio: number;
  /** avg_logprob below this → transcript untrustworthy → inconclusive. */
  minAvgLogprob: number;
  /** no_speech_prob above this → transcript untrustworthy → inconclusive. */
  maxNoSpeechProb: number;
}

export const DEFAULT_ASR_THRESHOLDS: AsrThresholds = {
  maxWer: 0.4,
  maxDeletionRun: 4,
  minChars: 12,
  minRefWords: 2,
  maxBridgeRun: 3,
  homophone1Word: true,
  maxCompressionRatio: 2.4,
  minAvgLogprob: -1.0,
  maxNoSpeechProb: 0.6,
};

/** BCP-47 primary subtag, lower-cased ('es-ES' → 'es', '' for nullish). */
function baseSubtag(language?: string | null): string {
  return (language ?? '').toLowerCase().split('-')[0];
}

/** Per-language ASR `maxWer` override (#1084 scaffold). Returns the configured
    value ONLY when an operator has explicitly set this language's knob (env or
    app override); otherwise undefined, so the global `maxWer` (including its own
    override) applies. The per-language knobs default to the global value, so
    behaviour is unchanged until the owed on-box calibration tunes them. */
function perLanguageMaxWer(language?: string | null): number | undefined {
  const lang = baseSubtag(language);
  if (!lang) return undefined;
  const knob = allKnobs().find((k) => k.key === `qa.asr.maxWer.${lang}`);
  if (!knob) return undefined;
  const state = resolveKnob(knob);
  return state.source === 'default' ? undefined : (state.effective as number);
}

export function resolveAsrThresholds(
  override?: Partial<AsrThresholds>,
  language?: string | null,
): AsrThresholds {
  const base: AsrThresholds = {
    maxWer: perLanguageMaxWer(language) ?? configValue<number>('qa.asr.maxWer'),
    maxDeletionRun: configValue<number>('qa.asr.maxDeletionRun'),
    minChars: configValue<number>('qa.asr.minChars'),
    minRefWords: configValue<number>('qa.asr.minRefWords'),
    maxBridgeRun: configValue<number>('qa.asr.maxBridgeRun'),
    homophone1Word: configValue<boolean>('qa.asr.homophone1Word'),
    maxCompressionRatio: configValue<number>('qa.asr.maxCompression'),
    minAvgLogprob: configValue<number>('qa.asr.minAvgLogprob'),
    maxNoSpeechProb: configValue<number>('qa.asr.maxNoSpeech'),
  };
  return { ...base, ...override };
}

/* --- Config resolvers (shared by generation.ts + the repair route) --- */

/** ASR content-QA is OFF unless the qa.asr.enabled knob is true (env
    SEG_ASR_ENABLED or an app override). */
export function asrEnabled(): boolean {
  return configValue<boolean>('qa.asr.enabled');
}

/** Drift re-record budget (best-of-N by WER). Default 2; 0 = detect + flag only. */
export function resolveAsrRerecords(): number {
  return configValue<number>('qa.asr.maxRerecords');
}

/** Transcribe 1-in-N body groups. Default 1 = every sentence. */
export function resolveAsrSampleEvery(): number {
  return configValue<number>('qa.asr.sampleEvery');
}

/** Proper-noun allowlist from the cast's display names (+ aliases) so Whisper
    mangling invented names ("Wren Sparrow" → "Wren Faster") never reads as
    content drift. Structural input so callers needn't import CastCharacter. */
export function buildCastNameAllowlist(
  characters: readonly { name?: string; aliases?: readonly string[] }[],
): string[] {
  const names = new Set<string>();
  for (const c of characters) {
    if (c.name) names.add(c.name);
    for (const a of c.aliases ?? []) if (a) names.add(a);
  }
  return [...names];
}

/* Voice-design calibration / ref_text signatures. The sidecar speaks a short
   phonetically-rich pangram when cloning a voice (its ICL reference clip);
   source of truth is `server/tts-sidecar/main.py` CALIBRATION_TEXT (English) +
   CALIBRATION_TEXTS (per-language siblings). A runaway / bad clone can echo that
   reference clip into chapter audio (#1074), where it reads as fluent speech the
   word-error gate flags but ships anyway. These distinctive lowercased
   substrings detect the bleed in an ASR transcript. Latin signatures are kept
   ASCII-only (avoiding accent variance in Whisper's output); the Russian one
   stays Cyrillic, the form Whisper emits for Russian audio. */
const CALIBRATION_SIGNATURES: readonly string[] = [
  'quick brown fox', // English
  'wondered what tomorrow would bring', // English (2nd clause)
  'cardillo y kiwi', // Spanish
  'portez ce vieux whisky', // French
  'sylter deich', // German
  'французских булок', // Russian
];

/** True when an ASR transcript is the voice-design calibration clip bleeding
    into audio (#1083) — it contains a calibration signature that the manuscript
    sentence does NOT (so a book legitimately quoting the pangram is not a bleed). */
export function looksLikeCalibrationBleed(transcript: string, expectedText: string): boolean {
  const norm = (s: string): string =>
    (s ?? '').normalize('NFKC').toLowerCase().replace(/\s+/g, ' ');
  const t = norm(transcript);
  if (!t) return false;
  const e = norm(expectedText);
  return CALIBRATION_SIGNATURES.some((sig) => t.includes(sig) && !e.includes(sig));
}

/* --- Normalization --- */

const SMART_QUOTES = /[‘’‚‛′‵]/g; // ' ' ‚ ‛ ′ ‵
const SMART_DQUOTES = /[“”„‟″]/g; // " " „ ‟ ″
const DASHES = /[‐-―−]/g; // hyphen variants + minus

/* Curated contraction expansions — both Whisper and the manuscript may pick
   either form; expanding to a canonical form makes them comparable. */
const CONTRACTIONS: Record<string, string> = {
  "don't": 'do not', "doesn't": 'does not', "didn't": 'did not',
  "can't": 'cannot', "won't": 'will not', "wouldn't": 'would not',
  "shouldn't": 'should not', "couldn't": 'could not', "isn't": 'is not',
  "aren't": 'are not', "wasn't": 'was not', "weren't": 'were not',
  "hasn't": 'has not', "haven't": 'have not', "hadn't": 'had not',
  "i'm": 'i am', "i've": 'i have', "i'll": 'i will', "i'd": 'i would',
  "you're": 'you are', "you've": 'you have', "you'll": 'you will', "you'd": 'you would',
  "he's": 'he is', "she's": 'she is', "it's": 'it is', "that's": 'that is',
  "there's": 'there is', "here's": 'here is', "what's": 'what is', "let's": 'let us',
  "we're": 'we are', "we've": 'we have', "we'll": 'we will', "we'd": 'we would',
  "they're": 'they are', "they've": 'they have', "they'll": 'they will', "they'd": 'they would',
};

const ONES = [
  'zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine',
  'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen',
  'seventeen', 'eighteen', 'nineteen',
];
const TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];

/* Spell an integer 0..99 to match Whisper's word output ("3" → "three"). Larger
   numbers are left as the digit string (Whisper usually emits digits for them
   anyway, and year/decimal reading is too variable to canonicalise cheaply). */
function spellInteger(n: number): string | null {
  if (n < 20) return ONES[n];
  if (n < 100) {
    const t = TENS[Math.floor(n / 10)];
    const o = n % 10;
    return o === 0 ? t : `${t} ${ONES[o]}`;
  }
  return null;
}

/** Normalise to a token array: lowercase, NFKC, smart-punctuation→ascii, and
    — for English (or unspecified language) only — contraction expansion and
    integer 0..99 → words. The English number-speller ("3" → "three") matches
    Whisper's English word output; on a non-English book Whisper hears "tres" /
    "три", so spelling the digit in English injects a false substitution, hence
    it is gated on `language` (#1084). Full per-language number spelling is owed
    on-box calibration. */
export function normalizeForWer(text: string, language?: string | null): string[] {
  const english = baseSubtag(language) === 'en' || !language;
  let s = (text ?? '').normalize('NFKC').toLowerCase();
  s = s.replace(SMART_QUOTES, "'").replace(SMART_DQUOTES, '"').replace(DASHES, '-');
  // Expand contractions before stripping apostrophes (English-only forms).
  if (english) {
    for (const [from, to] of Object.entries(CONTRACTIONS)) {
      s = s.replace(new RegExp(`\\b${from.replace(/'/g, "['’]")}\\b`, 'g'), to);
    }
  }
  // Drop possessive 's and any remaining apostrophes inside words.
  s = s.replace(/'s\b/g, '').replace(/'/g, '');
  // Replace every non-alphanumeric with a space, then tokenise. Letters/digits
  // are matched script-agnostically (\p{L}\p{N}, NOT [a-z0-9]) — an ASCII-only
  // strip erased all Cyrillic/CJK, so a non-English sentence normalised to []
  // and the WER gate silently no-op'd ('inconclusive') on every line
  // (2026-06-15; mirrors the stage2-coverage.ts fix). English is unchanged.
  s = s.replace(/[^\p{L}\p{N}]+/gu, ' ');
  const tokens = s.split(/\s+/).filter(Boolean);
  if (!english) return tokens; // skip English integer-spelling for other languages
  const out: string[] = [];
  for (const tok of tokens) {
    if (/^\d+$/.test(tok)) {
      const spelled = spellInteger(Number(tok));
      if (spelled) {
        out.push(...spelled.split(' '));
        continue;
      }
    }
    out.push(tok);
  }
  return out;
}

/* Known Whisper hallucinations — boilerplate the model emits from its training
   data on short / ambiguous audio (pirate-EPUB watermarks, subtitle credits,
   video sign-offs). It emits these CONFIDENTLY, so they pass the avg_logprob /
   no_speech_prob guards and would otherwise land as content drift. They are
   never real book content, so a match → `inconclusive` (never a re-record). */
const HALLUCINATION_PATTERNS: readonly RegExp[] = [
  /oceansofpdf/i,
  /\bsub(title|titles|s)?\s+by\b/i,
  /\bcaptions?\s+by\b/i,
  /\btranscri(bed|ption)\s+by\b/i,
  /\bamara\.org\b/i,
  /\bthanks?\s+(you\s+)?for\s+watching\b/i,
  /\b(please\s+)?(like\s+and\s+)?subscribe\b/i,
];

/** True when the transcript is dominated by known Whisper boilerplate. */
export function looksLikeHallucination(transcript: string): boolean {
  const s = (transcript ?? '').trim();
  return s.length > 0 && HALLUCINATION_PATTERNS.some((re) => re.test(s));
}

/** True when `a` and `b` are within Levenshtein distance 1 (equal, one
    substitution, or one insertion/deletion). Bounded short-circuit — no full DP
    matrix. Used by bridgeCompounds to tolerate the one-character drift Whisper
    introduces re-segmenting a compound ("skulduggery" → "skull duggery"). */
export function editDistanceAtMost1(a: string, b: string): boolean {
  if (a === b) return true;
  const la = a.length;
  const lb = b.length;
  if (Math.abs(la - lb) > 1) return false;
  let i = 0;
  while (i < la && i < lb && a[i] === b[i]) i += 1;
  if (la === lb) return a.slice(i + 1) === b.slice(i + 1); // one substitution
  if (la > lb) return a.slice(i + 1) === b.slice(i); // one deletion from a
  return a.slice(i) === b.slice(i + 1); // one insertion into a
}

/* Reconcile solid↔split compound forms between the expected and actual token
   streams. Whisper routinely splits a closed compound the manuscript writes
   solid ("curvebuster" → "curve buster") or joins an open one the manuscript
   writes apart ("good bye" → "goodbye"); on a short sentence that single
   re-tokenisation is 1 sub + 1 ins on a tiny denominator → WER over the cap → a
   false 'drift' on audio that says exactly the right words. We collapse an
   adjacent RUN only when its concatenation appears as a single token in the
   OTHER stream — a genuinely wrong word won't concatenate to the expected
   token, so this can never mask real drift.

   A2d (PR-1.1): the run was originally pairs only (2↔1), which missed an
   invented name Whisper splits into THREE tokens ("Scapegrace" → "scape a
   grace", whose concat "scapeagrace" is 1 deletion from "scapegrace"). We now
   try runs of length 2..`maxRun` (default 3), preferring the SHORTEST run that
   joins so a 2-token compound is never greedily swallowed into a 3-run. Set
   `maxRun` to 2 (env SEG_ASR_MAX_BRIDGE_RUN) to restore the pair-only
   behaviour exactly. */
export function bridgeCompounds(
  expected: string[],
  actual: string[],
  maxRun = 3,
): [string[], string[]] {
  // Collapse an adjacent run when its concatenation matches a token in the OTHER
  // stream — EXACT match preferred (byte-identical to the legacy Set behaviour),
  // else within edit-distance 1 — and emit that matched token so the two streams
  // align as a `match` rather than a residual substitution. A genuinely wrong run
  // won't concatenate near an other-stream token, so this can't mask real drift.
  const collapse = (tokens: string[], other: readonly string[]): string[] => {
    const out: string[] = [];
    for (let i = 0; i < tokens.length; ) {
      let joined = false;
      // Shortest run first (2 before 3) so a 2-compound isn't swallowed into a 3-run.
      for (let run = 2; run <= maxRun && i + run <= tokens.length; run += 1) {
        const concat = tokens.slice(i, i + run).join('');
        const match = other.find((o) => o === concat) ?? other.find((o) => editDistanceAtMost1(concat, o));
        if (match !== undefined) {
          out.push(match);
          i += run; // consumed the whole run
          joined = true;
          break;
        }
      }
      if (!joined) {
        out.push(tokens[i]);
        i += 1;
      }
    }
    return out;
  };
  return [collapse(expected, actual), collapse(actual, expected)];
}

/* --- Word-level alignment (Levenshtein with backtrace) --- */

type Op = { type: 'match' | 'sub' | 'del' | 'ins'; expected?: string };

/** Align expected → actual token arrays, returning the edit ops in expected
    order. `del` = an expected token missing from the transcript; `ins` = an
    extra transcript token; `sub` = a swapped token. */
function alignTokens(expected: string[], actual: string[]): Op[] {
  const m = expected.length;
  const n = actual.length;
  // dp[i][j] = edit distance of expected[0..i) vs actual[0..j).
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0));
  for (let i = 0; i <= m; i += 1) dp[i][0] = i;
  for (let j = 0; j <= n; j += 1) dp[0][j] = j;
  for (let i = 1; i <= m; i += 1) {
    for (let j = 1; j <= n; j += 1) {
      if (expected[i - 1] === actual[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1];
      } else {
        dp[i][j] = 1 + Math.min(dp[i - 1][j - 1], dp[i - 1][j], dp[i][j - 1]);
      }
    }
  }
  // Backtrace.
  const ops: Op[] = [];
  let i = m;
  let j = n;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && expected[i - 1] === actual[j - 1] && dp[i][j] === dp[i - 1][j - 1]) {
      ops.push({ type: 'match', expected: expected[i - 1] });
      i -= 1;
      j -= 1;
    } else if (i > 0 && j > 0 && dp[i][j] === dp[i - 1][j - 1] + 1) {
      ops.push({ type: 'sub', expected: expected[i - 1] });
      i -= 1;
      j -= 1;
    } else if (i > 0 && dp[i][j] === dp[i - 1][j] + 1) {
      ops.push({ type: 'del', expected: expected[i - 1] });
      i -= 1;
    } else {
      ops.push({ type: 'ins' });
      j -= 1;
    }
  }
  ops.reverse();
  return ops;
}

/** fs-57 / srv-31 — return the normalized tokens of the leading vocalization
    run in `text`: the characters up to and including the first terminal mark
    (`!`, U+2026 ellipsis, `.`, `?`).  Called only when the synthesised
    group has `vocalization === true` so the leading gasp token(s) are folded
    into the ASR `allow` set rather than counted as content drift.

    Examples:
      'Ah! I did not see you.'         → ['ah']
      'Haah… so tired.'           → ['haah']
      'No vocalization here.'          → ['no', 'vocalization', 'here']   (safe: only called when flag set)
*/
export function leadingVocalizationTokens(text: string): string[] {
  // Match from the start up to and including the first !, … (…), ., or ?
  const m = /^([^!.…?]*[!.…?])/.exec(text);
  if (!m) return [];
  return normalizeForWer(m[1]);
}

export interface ClassifyOptions {
  thresholds?: Partial<AsrThresholds>;
  /** Per-book proper-noun allowlist (cast names). Tokens here don't count as
      drift when substituted/deleted — Whisper mangles invented names. */
  nameAllowlist?: Iterable<string>;
  /** fs-57 / srv-31 vocalization carve-out. Normalized tokens of the leading
      vocalization prepended by Stage 3 (e.g. `['ah']` for `"Ah! I didn't see
      you…"`). Folded into the same `allow` set as `nameAllowlist` so the gasp
      token doesn't count as drift while the lexical words ARE still scored. */
  vocalizationAllowlist?: Iterable<string>;
  /** BCP-47 base subtag of the book. Gates English-only normalization (integer
      spelling / contractions) and selects the per-language `maxWer` (#1084).
      Unset → English behaviour, byte-identical to before. */
  language?: string | null;
}

/** Pure verdict from a transcript + signals. No I/O — inject the transcript. */
export function classifyTranscript(
  expectedText: string,
  transcript: string,
  signals: AsrSignals,
  opts: ClassifyOptions = {},
): AsrClassification {
  const t = resolveAsrThresholds(opts.thresholds, opts.language);
  const reasons: string[] = [];
  const base = (verdict: AsrVerdict, extra: Partial<AsrClassification> = {}): AsrClassification => ({
    verdict,
    wer: 0,
    sub: 0,
    del: 0,
    ins: 0,
    longestDeletionRun: 0,
    transcript,
    reasons,
    ...extra,
  });

  // Too short to WER-score reliably — don't act on it. EXCEPT a loop/repeat (high
  // compression) is intrinsic to the transcript and needs no minimum reference
  // length, so catch it even on a short line (A2c): A1's duration floor no longer
  // covers a sub-3s short-line loop, and this is the only gate that can.
  if ((expectedText ?? '').trim().length < t.minChars) {
    if (signals.compressionRatio != null && signals.compressionRatio > t.maxCompressionRatio) {
      reasons.push(
        `Loop/repeat — compression ratio ${signals.compressionRatio.toFixed(2)} exceeds the ${
          t.maxCompressionRatio
        } cap (likely repeated/garbled synthesis).`,
      );
      return base('drift');
    }
    reasons.push(`Not scored — sentence under the ${t.minChars}-char ASR floor.`);
    return base('inconclusive');
  }

  // Known Whisper boilerplate hallucination → untrustworthy transcript, never a
  // re-record (it's emitted confidently, so the signal guards below miss it).
  if (looksLikeHallucination(transcript)) {
    reasons.push(
      'Transcript is known Whisper boilerplate/hallucination (not book content); not scoring.',
    );
    return base('inconclusive');
  }

  // Loop/repeat hallucination is positive drift evidence even at low WER.
  if (signals.compressionRatio != null && signals.compressionRatio > t.maxCompressionRatio) {
    reasons.push(
      `Loop/repeat — compression ratio ${signals.compressionRatio.toFixed(2)} exceeds the ${
        t.maxCompressionRatio
      } cap (likely repeated/garbled synthesis).`,
    );
    // Still compute WER below for observability, but the verdict is drift.
  } else {
    // Untrustworthy transcript → inconclusive (do NOT re-record on a guess).
    if (signals.avgLogprob != null && signals.avgLogprob < t.minAvgLogprob) {
      reasons.push(
        `Transcript untrustworthy — avg logprob ${signals.avgLogprob.toFixed(
          2,
        )} below ${t.minAvgLogprob}; not scoring.`,
      );
      return base('inconclusive');
    }
    if (signals.noSpeechProb != null && signals.noSpeechProb > t.maxNoSpeechProb) {
      reasons.push(
        `Transcript untrustworthy — no-speech prob ${signals.noSpeechProb.toFixed(
          2,
        )} above ${t.maxNoSpeechProb}; not scoring.`,
      );
      return base('inconclusive');
    }
  }

  const [expectedTokens, actualTokens] = bridgeCompounds(
    normalizeForWer(expectedText, opts.language),
    normalizeForWer(transcript, opts.language),
    t.maxBridgeRun,
  );
  if (expectedTokens.length === 0) {
    reasons.push('Not scored — expected text normalised to empty.');
    return base('inconclusive');
  }

  const allow = new Set<string>();
  for (const src of [opts.nameAllowlist, opts.vocalizationAllowlist]) {
    if (src) {
      for (const name of src) {
        for (const tok of normalizeForWer(name, opts.language)) allow.add(tok);
      }
    }
  }

  const ops = alignTokens(expectedTokens, actualTokens);
  let sub = 0;
  let del = 0;
  let ins = 0;
  let curDelRun = 0;
  let longestDeletionRun = 0;
  for (const op of ops) {
    const tolerated = op.expected != null && allow.has(op.expected);
    if (op.type === 'sub') {
      if (!tolerated) sub += 1;
      curDelRun = 0;
    } else if (op.type === 'del') {
      if (!tolerated) {
        del += 1;
        curDelRun += 1;
        if (curDelRun > longestDeletionRun) longestDeletionRun = curDelRun;
      } else {
        curDelRun = 0;
      }
    } else if (op.type === 'ins') {
      ins += 1;
      curDelRun = 0;
    } else {
      curDelRun = 0;
    }
  }

  const wer = (sub + del + ins) / expectedTokens.length;
  const metrics = { wer, sub, del, ins, longestDeletionRun };

  // Compression-ratio drift was flagged above.
  if (signals.compressionRatio != null && signals.compressionRatio > t.maxCompressionRatio) {
    return base('drift', metrics);
  }
  if (longestDeletionRun > t.maxDeletionRun) {
    reasons.push(
      `Truncation/drop — ${longestDeletionRun} consecutive words missing (> ${t.maxDeletionRun}).`,
    );
    return base('drift', metrics);
  }
  // Short-reference substitution backstop (A2b). On a 2-word reference a single
  // ASR substitution (homophone, misheard name) drives WER over the cap yet is
  // weak evidence — route to inconclusive (flag, do NOT re-record). 1-word refs
  // are excluded (length >= 2): a full sub there is strong evidence. A deletion
  // (negation flip "did not"→"did", a dropped word) or insertion still flags.
  if (
    t.minRefWords > 0 &&
    expectedTokens.length >= 2 &&
    expectedTokens.length <= t.minRefWords &&
    del === 0 &&
    ins === 0 &&
    longestDeletionRun === 0 &&
    sub <= 1 &&
    wer > t.maxWer
  ) {
    reasons.push(
      `Short reference (${expectedTokens.length} words) with a single substitution; ` +
        `WER ${wer.toFixed(2)} is weak evidence — not scoring.`,
    );
    return base('inconclusive', metrics);
  }
  // 1-word near-homophone backstop (A2e). A single-token reference whose only
  // error is a substitution within edit-distance 1 of what was heard
  // ("Uneventfully" → "Unaventfully") is a spelling/schwa variant of one whole
  // word — the audio said the right phonemes, Whisper misspelled. Weak evidence
  // → inconclusive (flag, don't re-record). A far-apart substitution
  // ("Extraordinarily" → "Coincidentally") fails the edit-1 guard and stays
  // drift. Short single words never reach here — the minChars floor returned above.
  if (
    t.homophone1Word &&
    expectedTokens.length === 1 &&
    actualTokens.length === 1 &&
    sub === 1 &&
    del === 0 &&
    ins === 0 &&
    wer > t.maxWer &&
    editDistanceAtMost1(expectedTokens[0], actualTokens[0])
  ) {
    reasons.push(
      `Single-word reference misheard within one edit ("${expectedTokens[0]}" vs ` +
        `"${actualTokens[0]}"); likely a spelling variant — not scoring.`,
    );
    return base('inconclusive', metrics);
  }
  if (wer > t.maxWer) {
    reasons.push(
      `Content drift — word-error-rate ${wer.toFixed(2)} exceeds ${t.maxWer} ` +
        `(${sub} sub, ${del} del, ${ins} ins vs ${expectedTokens.length} words).`,
    );
    return base('drift', metrics);
  }
  return base('ok', metrics);
}

export interface VerifyOptions extends ClassifyOptions {
  language?: string | null;
  signal?: AbortSignal;
  sidecarUrl?: string;
  /** Inject a transcribe fn (tests); defaults to the real sidecar client. */
  transcribeFn?: (
    pcm: Buffer,
    sampleRate: number,
    o: { language?: string | null; signal?: AbortSignal; sidecarUrl?: string },
  ) => Promise<TranscribeResult>;
}

/** Transcribe one sentence's PCM and classify it. The single impure entry. */
export async function verifySegmentTranscript(
  pcm: Buffer,
  sampleRate: number,
  expectedText: string,
  opts: VerifyOptions = {},
): Promise<AsrClassification> {
  const transcribe = opts.transcribeFn ?? transcribeSegment;
  const r = await transcribe(pcm, sampleRate, {
    language: opts.language,
    signal: opts.signal,
    sidecarUrl: opts.sidecarUrl,
  });
  return classifyTranscript(
    expectedText,
    r.text,
    { avgLogprob: r.avgLogprob, noSpeechProb: r.noSpeechProb, compressionRatio: r.compressionRatio },
    {
      thresholds: opts.thresholds,
      nameAllowlist: opts.nameAllowlist,
      vocalizationAllowlist: opts.vocalizationAllowlist,
      language: opts.language,
    },
  );
}
