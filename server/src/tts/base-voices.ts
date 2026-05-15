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
   - piper, kokoro: empty for now — those engines don't have static
     catalogs in voice-mapping.ts. The base-voice list grows as those
     tables land.

   The catalog is cached in-process for the lifetime of the Node server.
   The cache is small (~50 entries today) and changes only when the
   sidecar's loaded model changes, which the user does explicitly. */

import {
  COQUI_PROFILE_VOICES,
  COQUI_VOICE_DESCRIPTIONS,
  GEMINI_VOICE_DESCRIPTIONS,
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
  const coqui = await listCoquiSpeakers(opts.sidecarUrl, opts.probeTimeoutMs ?? 2_000);
  const merged: BaseVoiceEntry[] = [];
  merged.push(...coqui.voices);
  merged.push(...listGeminiVoices());
  /* Piper/Kokoro intentionally omitted — their catalogs aren't wired into
     voice-mapping.ts yet. Adding them is a follow-up when those engines
     land their own PROFILE_VOICES tables. */
  cache = {
    voices: merged,
    coquiFromSidecar: coqui.fromSidecar,
    fetchedAt: Date.now(),
  };
  return merged;
}

interface CoquiResult {
  voices: BaseVoiceEntry[];
  fromSidecar: boolean;
}

async function listCoquiSpeakers(sidecarUrl: string, timeoutMs: number): Promise<CoquiResult> {
  const fromSidecar = await fetchSpeakersOnce(sidecarUrl, timeoutMs);
  if (fromSidecar) {
    return {
      voices: fromSidecar.map(name => ({ engine: 'coqui' as TtsEngine, name })),
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
    voices: [...fallback].sort().map(name => ({ engine: 'coqui' as TtsEngine, name })),
    fromSidecar: false,
  };
}

async function fetchSpeakersOnce(url: string, timeoutMs: number): Promise<string[] | null> {
  const target = `${url.replace(/\/+$/, '')}/speakers`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const r = await fetch(target, { signal: controller.signal });
    if (!r.ok) return null;
    const body = (await r.json().catch(() => null)) as { coqui?: string[] } | null;
    const list = body?.coqui;
    if (!Array.isArray(list) || list.length === 0) return null;
    return [...list].sort();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function listGeminiVoices(): BaseVoiceEntry[] {
  return Object.keys(GEMINI_VOICE_DESCRIPTIONS)
    .sort()
    .map(name => ({ engine: 'gemini' as TtsEngine, name }));
}
