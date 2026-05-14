/* Single source of truth for user-level account defaults + non-secret env
   overrides. Persisted to `server/user-settings.json` (gitignored).

   The file holds only the writable subset. The route layer derives the
   read-only fields (apiKeyStatus, workspaceRoot, workspaceSource) before
   returning to the client.

   Secrets never land here — the Gemini API key stays in `server/.env`. The
   PUT validator silently drops any `geminiApiKey`-shaped field. */

import { z } from 'zod';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readJson, writeJsonAtomic } from './state-io.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SERVER_ROOT = resolve(__dirname, '..', '..');

export const USER_SETTINGS_PATH = join(SERVER_ROOT, 'user-settings.json');

export const TTS_ENGINE_VALUES = ['local', 'gemini'] as const;
export const ANALYSIS_ENGINE_VALUES = ['local', 'gemini'] as const;
export const TTS_MODEL_KEY_VALUES = [
  'coqui-xtts-v2',
  'gemini-2.5-flash',
  'gemini-3.1-flash',
] as const;

export const userSettingsSchema = z.object({
  displayName:          z.string().max(120),
  defaultAnalysisModel: z.string().min(1).max(120),
  defaultTtsEngine:     z.enum(TTS_ENGINE_VALUES),
  defaultTtsModelKey:   z.enum(TTS_MODEL_KEY_VALUES),
  sidecarUrl:           z.string().min(1).max(2000),
  /* Analyzer dispatch. `local` routes through OllamaAnalyzer (with Gemini
     as automatic fallback iff GEMINI_API_KEY is set and the local daemon
     is unreachable — see selectAnalyzer). `gemini` always goes direct. */
  analysisEngine:       z.enum(ANALYSIS_ENGINE_VALUES),
  /* Base URL of the local Ollama daemon. Falls through to OLLAMA_URL env
     and then http://localhost:11434 in getResolvedOllamaUrl. */
  ollamaUrl:            z.string().min(1).max(2000),
  /* Model tag passed to /api/chat. Default qwen3.5:9b is the recommended
     pick for 8 GB VRAM — see plan 29. The analysis route honours a
     per-request `model` override on top of this default. */
  ollamaModel:          z.string().min(1).max(120),
  workspaceDirOverride: z.string().max(2000).nullable(),
  /* Threshold for the minor-cast fold pass — see
     server/src/analyzer/fold-minor-cast.ts. A character with FEWER than
     this many attributed sentences gets folded into Unknown male /
     female. 0 disables the line-count trigger (Unknown-named characters
     still fold). Cap at 50 since beyond that the bucket would swallow
     genuine cast members and the UI loses meaning. */
  minorCastMinLines:    z.number().int().min(0).max(50),
});

export type UserSettings = z.infer<typeof userSettingsSchema>;

export const DEFAULT_USER_SETTINGS: UserSettings = {
  displayName:          'Mike Dudarenok',
  defaultAnalysisModel: 'gemma-4-31b-it',
  defaultTtsEngine:     'local',
  defaultTtsModelKey:   'coqui-xtts-v2',
  sidecarUrl:           'http://localhost:9000',
  analysisEngine:       'local',
  ollamaUrl:            'http://localhost:11434',
  ollamaModel:          'qwen3.5:9b',
  workspaceDirOverride: null,
  minorCastMinLines:    3,
};

let cached: UserSettings | null = null;
let writeChain: Promise<unknown> = Promise.resolve();

/** Reads from disk; falls back to defaults when the file is missing or
    malformed. Cached in-process so the hot paths (selectAnalyzer, sidecar
    URL resolution) don't re-parse JSON on every request. */
export async function readUserSettings(): Promise<UserSettings> {
  if (cached) return cached;
  const raw = await readJson<unknown>(USER_SETTINGS_PATH);
  if (!raw) {
    cached = { ...DEFAULT_USER_SETTINGS };
    return cached;
  }
  const parsed = userSettingsSchema.safeParse({ ...DEFAULT_USER_SETTINGS, ...(raw as object) });
  cached = parsed.success ? parsed.data : { ...DEFAULT_USER_SETTINGS };
  return cached;
}

/** Synchronous cached view. Returns the in-memory copy if any prior
    `readUserSettings()` has run; otherwise the static defaults. Used by
    code paths that can't `await` (e.g. the module-load workspace root
    resolution in paths.ts), with a side-effect call to readUserSettings()
    upstream to warm the cache. */
export function getCachedUserSettings(): UserSettings {
  return cached ?? { ...DEFAULT_USER_SETTINGS };
}

const patchSchema = userSettingsSchema.partial();

/** Merges `patch` into the on-disk file, validating each field. Returns the
    new merged settings. Concurrent PUTs are serialised through `writeChain`
    so two near-simultaneous saves can't race the temp-file-then-rename. */
export async function writeUserSettings(patch: unknown): Promise<UserSettings> {
  const sanitised = stripForbiddenKeys(patch);
  const validated = patchSchema.parse(sanitised);
  const next = writeChain.then(async () => {
    const current = await readUserSettings();
    const merged: UserSettings = { ...current, ...validated };
    await writeJsonAtomic(USER_SETTINGS_PATH, merged);
    cached = merged;
    return merged;
  });
  writeChain = next.catch(() => undefined);
  return next;
}

/* Strip server-derived (read-only) fields and any secret-shaped field name.
   The frontend should never need to send these, but defending against a
   malformed/abusive client keeps the .env-only invariant honest. */
const FORBIDDEN_KEYS = new Set([
  'apiKeyStatus', 'workspaceRoot', 'workspaceSource',
  'geminiApiKey', 'apiKey', 'gemini_api_key', 'GEMINI_API_KEY',
]);

function stripForbiddenKeys(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object') return {};
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (FORBIDDEN_KEYS.has(k)) continue;
    out[k] = v;
  }
  return out;
}

/** Synchronous resolver: returns sidecarUrl from the in-memory user-settings
    cache, falling back to the LOCAL_TTS_URL env var, then localhost:9000.
    Strips trailing slashes for consistency with prior call-site behaviour. */
export function getResolvedSidecarUrl(): string {
  const c = cached;
  const raw = c?.sidecarUrl ?? process.env.LOCAL_TTS_URL ?? 'http://localhost:9000';
  return raw.replace(/\/+$/, '');
}

/** Same fallback chain as getResolvedSidecarUrl, but for the local Ollama
    daemon: cached user-settings → OLLAMA_URL env → localhost:11434. */
export function getResolvedOllamaUrl(): string {
  const c = cached;
  const raw = c?.ollamaUrl ?? process.env.OLLAMA_URL ?? 'http://localhost:11434';
  return raw.replace(/\/+$/, '');
}

/** Ollama model tag passed to /api/chat. Mirrors getResolvedOllamaUrl's
    fallback chain: cached settings → OLLAMA_MODEL env → static default. */
export function getResolvedOllamaModel(): string {
  const c = cached;
  return c?.ollamaModel ?? process.env.OLLAMA_MODEL ?? 'qwen3.5:9b';
}

/** Analyzer engine selector: cached settings → ANALYZER env → 'local'.
    Defended against legacy values ('manual' was the old default and is
    no longer routable) by coercing anything outside the schema to 'local'. */
export function getResolvedAnalysisEngine(): 'local' | 'gemini' {
  const c = cached;
  const raw = c?.analysisEngine ?? process.env.ANALYZER ?? 'local';
  return raw === 'gemini' ? 'gemini' : 'local';
}

/** Test-only: drop the in-process cache so the next read re-parses disk. */
export function _resetUserSettingsCache(): void {
  cached = null;
  writeChain = Promise.resolve();
}
