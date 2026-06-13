/* Base-voice catalog — the unmodified speakers each TTS engine exposes.
   Backs `GET /api/voices/base`, the Voices view's "Base voices" tab, and
   the Profile Drawer's voice-override picker.

   Per engine:
   - coqui: live XTTS speaker manifest from the sidecar's `GET /speakers`
     (`server/tts-sidecar/main.py`). Reflects whatever the model actually
     has loaded today — tolerates speaker_manager API drift the same way
     coqui-catalog-audit.ts does. Falls back to the COQUI_PROFILE_VOICES
     constants when the sidecar is unreachable so the UI doesn't go empty
     during a sidecar restart.
   - gemini: all 30 prebuilt voices from GEMINI_VOICE_DESCRIPTIONS (the
     full published catalog, not just the 16 currently bucketed by
     GEMINI_PROFILE_VOICES). The user might want to override Brann to an
     unbucketed voice like Fenrir.
   - kokoro: live English-subset voice manifest from the sidecar's
     `GET /speakers` `kokoro` key (filtered to af_/am_/bf_/bm_ at the
     sidecar boundary). Falls back to KOKORO_PROFILE_VOICES + KOKORO_
     VOICE_DESCRIPTIONS when the sidecar is unreachable, same shape as
     the Coqui fallback.
   - piper: empty for now — no static catalog yet.

   The catalog is cached in-process for the lifetime of the Node server.
   The cache is small (~50 entries today) and changes only when the
   sidecar's loaded model changes, which the user does explicitly. */

import {
  COQUI_PROFILE_VOICES,
  COQUI_VOICE_DESCRIPTIONS,
  GEMINI_VOICE_DESCRIPTIONS,
  KOKORO_PROFILE_VOICES,
  KOKORO_VOICE_DESCRIPTIONS,
} from './voice-mapping.js';
import type { TtsEngine } from './index.js';

export interface BaseVoiceEntry {
  engine: TtsEngine;
  name: string;
  language?: string;
  gender?: 'male' | 'female' | 'neutral';
}

interface CacheState {
  voices: BaseVoiceEntry[];
  coquiFromSidecar: boolean;
  fetchedAt: number;
}

let cache: CacheState | null = null;

/** Invalidate the cache. Called by the sidecar load/unload routes since the
    Coqui speaker list can change when the loaded model changes. */
export function invalidateBaseVoiceCache(): void {
  cache = null;
}

/** Returns the merged base-voice catalog across every engine. Returns from
    cache when possible; otherwise refreshes from the sidecar. Never throws —
    if the sidecar is unreachable, the Coqui section falls back to the static
    catalog so the UI still renders something useful. */
export async function listBaseVoices(opts: {
  sidecarUrl: string;
  probeTimeoutMs?: number;
}): Promise<BaseVoiceEntry[]> {
  if (cache && Date.now() - cache.fetchedAt < CACHE_TTL_MS) {
    return cache.voices;
  }
  const fetched = await refreshBaseVoices(opts);
  return fetched;
}

const CACHE_TTL_MS = 5 * 60_000;

async function refreshBaseVoices(opts: {
  sidecarUrl: string;
  probeTimeoutMs?: number;
}): Promise<BaseVoiceEntry[]> {
  const timeoutMs = opts.probeTimeoutMs ?? 2_000;
  /* Both Coqui and Kokoro share the same /speakers endpoint — fetch once
     and split into the per-engine slots. Saves a round-trip and means a
     stale/cold sidecar fails both engines together rather than racing. */
  const speakers = await fetchSpeakersOnce(opts.sidecarUrl, timeoutMs);
  const coqui = buildCoquiVoices(speakers?.coqui);
  const kokoro = buildKokoroVoices(speakers?.kokoro);
  const merged: BaseVoiceEntry[] = [];
  merged.push(...coqui.voices);
  merged.push(...kokoro.voices);
  merged.push(...listGeminiVoices());
  /* Piper intentionally omitted — no static catalog yet. Adding it is a
     follow-up when Piper lands its own PROFILE_VOICES table. */
  cache = {
    voices: merged,
    coquiFromSidecar: coqui.fromSidecar,
    fetchedAt: Date.now(),
  };
  return merged;
}

interface EngineFetchResult {
  voices: BaseVoiceEntry[];
  fromSidecar: boolean;
}

function buildCoquiVoices(liveSpeakers: string[] | undefined): EngineFetchResult {
  if (liveSpeakers && liveSpeakers.length > 0) {
    return {
      voices: [...liveSpeakers].sort().map((name) => ({ engine: 'coqui' as TtsEngine, name })),
      fromSidecar: true,
    };
  }
  /* Sidecar unreachable / model still loading — fall back to the static
     catalog so the picker still has something to offer. The user can
     reload the page once the sidecar comes up to get the live list. */
  const fallback = new Set<string>();
  for (const opts of Object.values(COQUI_PROFILE_VOICES)) {
    for (const n of opts) fallback.add(n);
  }
  for (const n of Object.keys(COQUI_VOICE_DESCRIPTIONS)) fallback.add(n);
  return {
    voices: [...fallback].sort().map((name) => ({ engine: 'coqui' as TtsEngine, name })),
    fromSidecar: false,
  };
}

function buildKokoroVoices(liveVoices: string[] | undefined): EngineFetchResult {
  if (liveVoices && liveVoices.length > 0) {
    return {
      voices: [...liveVoices].sort().map((name) => ({ engine: 'kokoro' as TtsEngine, name })),
      fromSidecar: true,
    };
  }
  /* Sidecar unreachable or Kokoro weights not yet installed — fall back
     to the static catalog tables so the picker still has the curated
     English subset. The sidecar's English-only filter is the source of
     truth for the *live* list; the static fallback mirrors what those
     filtered names should be. */
  const fallback = new Set<string>();
  for (const opts of Object.values(KOKORO_PROFILE_VOICES)) {
    for (const n of opts) fallback.add(n);
  }
  for (const n of Object.keys(KOKORO_VOICE_DESCRIPTIONS)) fallback.add(n);
  return {
    voices: [...fallback].sort().map((name) => ({ engine: 'kokoro' as TtsEngine, name })),
    fromSidecar: false,
  };
}

interface SpeakersResponse {
  coqui?: string[];
  kokoro?: string[];
}

async function fetchSpeakersOnce(url: string, timeoutMs: number): Promise<SpeakersResponse | null> {
  const target = `${url.replace(/\/+$/, '')}/speakers`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const r = await fetch(target, { signal: controller.signal });
    if (!r.ok) return null;
    const body = (await r.json().catch(() => null)) as SpeakersResponse | null;
    return body ?? null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function listGeminiVoices(): BaseVoiceEntry[] {
  return Object.keys(GEMINI_VOICE_DESCRIPTIONS)
    .sort()
    .map((name) => ({ engine: 'gemini' as TtsEngine, name }));
}
