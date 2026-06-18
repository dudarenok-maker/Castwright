/* Shared on-disk voice-sample cache primitives.

   The voice-sample player (POST /api/voices/:id/sample) and the Qwen
   design-voice route both render a ~12 s preview MP3 and cache it under the
   SAME deterministic filename. So designing a bespoke Qwen voice from a
   character's own line produces exactly the file the "Play 12s" button later
   reads — one synthesis, not two. Extracted from voice-sample.ts so both
   routes agree on the cache key AND the sample-text selection by construction
   (drift between them would silently miss the cache and re-synthesise). */

import { existsSync, readdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { TtsModelKey } from './index.js';
import type { CharacterHint, VoiceLike } from './voice-mapping.js';
import { stripEdges } from '../util/text-match.js';
import { assertContained } from '../util/safe-path.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

/* Tests override the on-disk cache root via VOICE_SAMPLE_AUDIO_DIR so a run
   doesn't leave files in the dev server's real audio dir. Production uses
   server/audio/voices/ which is also the static mount root in index.ts.
   Read at call time (not a module const) so import order between the two
   routes that share this module can't pin a stale value. */
export function voiceSampleAudioDir(): string {
  return process.env.VOICE_SAMPLE_AUDIO_DIR ?? resolve(__dirname, '..', '..', 'audio', 'voices');
}

/* Every cached sample .mp3 currently on disk (filenames only, not paths).
   The voices aggregator reads this once per Qwen query to stamp the
   `sampled` lifecycle flag: a designed Qwen voice whose
   `<scope>-<modelKey>-<hash>.mp3` audition exists has been "Sampled" even
   though no chapter has rendered. Empty (not throwing) when the dir is
   absent — a fresh workspace has no samples yet. */
export function listVoiceSampleFiles(): string[] {
  const dir = voiceSampleAudioDir();
  if (!existsSync(dir)) return [];
  try {
    return readdirSync(dir).filter((f) => f.endsWith('.mp3'));
  } catch {
    return [];
  }
}

/* Sample script. The analyzer ships ≥3 evidence quotes per character,
   sorted longest-first server-side (see analysis.ts sortEvidence) and
   verified against the manuscript by verifyEvidenceAgainstSource. We
   feed the longest *real* quote to the TTS so each preview sounds like
   that character — even if it's short. We never pad with invented text
   (no "X said:" prefix, no canned intro tacked on); a 40-char real line
   beats a 200-char fabricated one for voice cloning. The canned
   "Hello. I'm…" script is only used when the evidence array is
   genuinely empty (brand-new library voices, all-fabricated rosters
   the verifier swept clean). */
const MAX_CHARS = 320;

export function stripQuoteMarks(s: string): string {
  // Linear two-pointer edge strip — the trailing-anchored `[…]+$` form is
  // polynomial-redos (per-start-position backtracking).
  return stripEdges(s, /[“”"'‘’\s]/).trim();
}

export function buildSampleText(voice: VoiceLike, hint?: CharacterHint): string {
  /* Defensive re-sort — the route also accepts a characterHint from
     the client where the array may not have been through sortEvidence
     (e.g. user edits in the profile drawer that haven't been saved). */
  const cleaned = (hint?.evidence ?? [])
    .map(stripQuoteMarks)
    .filter((s) => s.length > 0)
    .sort((a, b) => b.length - a.length);

  const longest = cleaned[0];
  if (longest) {
    return longest.slice(0, MAX_CHARS);
  }

  const name = voice.character?.trim() || 'an unnamed character';
  const attrs = (voice.attributes ?? []).slice(0, 5).join(', ') || 'no particular style';
  return `Hello. I'm ${name}. ${attrs}. Listen — every voice in this book carries the weight of who I am, and every line I speak should sound like it could only have come from me.`;
}

/* DJB2 — short deterministic hash for cache filenames. We don't need crypto
   strength; we just need the same (text, voiceName) to map to the same file
   so repeat clicks hit cache, and any change to either bust it. */
export function djb2(s: string): number {
  let h = 5381;
  // Constant loop bound (ids/scopes/sample-text are all far under 4096) so the
  // iteration count never derives from a request-controlled length.
  const n = Math.min(s.length, 4096);
  for (let i = 0; i < n; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}

/* Cache filename for a resolved (scope, model, text, voice) sample. Identical
   inputs → identical filename, so a design-time pre-render and a play-time
   lookup land on one file. `cacheScope` is the voiceId for character samples
   or `raw-<engine>-<hash>` for the Base-voices tab; `modelKey` is the
   *effective* key actually synthesised under. */
export function voiceSampleFileName(args: {
  cacheScope: string;
  modelKey: TtsModelKey;
  text: string;
  voiceName: string;
}): string {
  const paramHash = djb2(`${args.text}|${args.voiceName}`).toString(36).slice(0, 8);
  return `${asciiFileScope(args.cacheScope)}-${args.modelKey}-${paramHash}.mp3`;
}

/* Plan 219: keep the on-disk sample filename ASCII even when the cacheScope (a
   voiceId, which can embed a Cyrillic character id) is not. An already-ASCII
   scope is returned unchanged (every pre-219 sample keeps its exact filename);
   a non-ASCII scope is flattened to `[A-Za-z0-9_.-]` and suffixed with a stable
   hash of the ORIGINAL so two distinct Cyrillic scopes can't collide. */
export function asciiFileScope(scope: string): string {
  if (/^[A-Za-z0-9_.-]+$/.test(scope)) return scope;
  const flat = scope.replace(/[^A-Za-z0-9_.-]+/g, '_');
  return `${flat}-${djb2(scope).toString(36).slice(0, 8)}`;
}

/* Public (static-mount) URL for a cached sample file. */
export function voiceSamplePublicUrl(fileName: string): string {
  return `/audio/voices/${fileName}`;
}

/* Absolute on-disk path for a cached sample file. */
export function voiceSampleFilePath(fileName: string): string {
  const p = resolve(voiceSampleAudioDir(), fileName);
  assertContained(voiceSampleAudioDir(), p);
  return p;
}
