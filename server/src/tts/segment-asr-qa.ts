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
import { configValue } from '../config/resolver.js';

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
  maxCompressionRatio: 2.4,
  minAvgLogprob: -1.0,
  maxNoSpeechProb: 0.6,
};

export function resolveAsrThresholds(override?: Partial<AsrThresholds>): AsrThresholds {
  const base: AsrThresholds = {
    maxWer: configValue<number>('qa.asr.maxWer'),
    maxDeletionRun: configValue<number>('qa.asr.maxDeletionRun'),
    minChars: configValue<number>('qa.asr.minChars'),
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

/** Normalise to a token array: lowercase, NFKC, smart-punctuation→ascii,
    contraction expansion, integer 0..99 → words, strip residual punctuation. */
export function normalizeForWer(text: string): string[] {
  let s = (text ?? '').normalize('NFKC').toLowerCase();
  s = s.replace(SMART_QUOTES, "'").replace(SMART_DQUOTES, '"').replace(DASHES, '-');
  // Expand contractions before stripping apostrophes.
  for (const [from, to] of Object.entries(CONTRACTIONS)) {
    s = s.replace(new RegExp(`\\b${from.replace(/'/g, "['’]")}\\b`, 'g'), to);
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

/* Reconcile solid↔split compound forms between the expected and actual token
   streams. Whisper routinely splits a closed compound the manuscript writes
   solid ("curvebuster" → "curve buster") or joins an open one the manuscript
   writes apart ("good bye" → "goodbye"); on a short sentence that single
   re-tokenisation is 1 sub + 1 ins on a tiny denominator → WER over the cap → a
   false 'drift' on audio that says exactly the right words. We collapse an
   adjacent PAIR only when its concatenation appears as a single token in the
   OTHER stream — a genuinely wrong word won't concatenate to the expected
   token, so this can never mask real drift. Pairs only (2↔1); 3+ token
   compounds are rare and out of scope. */
export function bridgeCompounds(expected: string[], actual: string[]): [string[], string[]] {
  const collapse = (tokens: string[], other: ReadonlySet<string>): string[] => {
    const out: string[] = [];
    for (let i = 0; i < tokens.length; i += 1) {
      if (i + 1 < tokens.length && other.has(tokens[i] + tokens[i + 1])) {
        out.push(tokens[i] + tokens[i + 1]);
        i += 1; // consumed the pair
      } else {
        out.push(tokens[i]);
      }
    }
    return out;
  };
  const expSet = new Set(expected);
  const actSet = new Set(actual);
  return [collapse(expected, actSet), collapse(actual, expSet)];
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

export interface ClassifyOptions {
  thresholds?: Partial<AsrThresholds>;
  /** Per-book proper-noun allowlist (cast names). Tokens here don't count as
      drift when substituted/deleted — Whisper mangles invented names. */
  nameAllowlist?: Iterable<string>;
}

/** Pure verdict from a transcript + signals. No I/O — inject the transcript. */
export function classifyTranscript(
  expectedText: string,
  transcript: string,
  signals: AsrSignals,
  opts: ClassifyOptions = {},
): AsrClassification {
  const t = resolveAsrThresholds(opts.thresholds);
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

  // Too short to score reliably — don't act on it.
  if ((expectedText ?? '').trim().length < t.minChars) {
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
    normalizeForWer(expectedText),
    normalizeForWer(transcript),
  );
  if (expectedTokens.length === 0) {
    reasons.push('Not scored — expected text normalised to empty.');
    return base('inconclusive');
  }

  const allow = new Set<string>();
  if (opts.nameAllowlist) {
    for (const name of opts.nameAllowlist) {
      for (const tok of normalizeForWer(name)) allow.add(tok);
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
    { thresholds: opts.thresholds, nameAllowlist: opts.nameAllowlist },
  );
}
