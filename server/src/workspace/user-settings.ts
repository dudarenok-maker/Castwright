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
  'kokoro-v1',
  'coqui-xtts-v2',
  'gemini-2.5-flash',
  'gemini-3.1-flash',
] as const;
export const COVER_PICKER_TAB_VALUES = ['search', 'upload'] as const;
export const THEME_PREFERENCE_VALUES = ['light', 'dark', 'system'] as const;

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
  workspaceDirOverride: z.string().max(2000).nullable(),
  /* Optional folder the export pipeline copies finished audiobooks into,
     e.g. a OneDrive / Syncthing watch path so the file lands on the user's
     phone automatically. Null = "save-to-folder" tab is disabled in the
     export modal until the user picks one. Path is not validated for
     existence here — the writer mkdirs on demand. */
  exportSyncFolder:     z.string().max(2000).nullable(),
  /* Threshold for the minor-cast fold pass — see
     server/src/analyzer/fold-minor-cast.ts. A character with FEWER than
     this many attributed sentences gets folded into Unknown male /
     female. 0 disables the line-count trigger (Unknown-named characters
     still fold). Cap at 50 since beyond that the bucket would swallow
     genuine cast members and the UI loses meaning. */
  minorCastMinLines:    z.number().int().min(0).max(50),
  /* Plan 40 — which tab the CoverPicker modal opens on by default.
     `search` preserves the pre-plan-40 behaviour (OpenLibrary
     candidates first); `upload` is for users who routinely bring
     their own art. Optional with a 'search' default so legacy
     user-settings.json files load unchanged. */
  coverPickerDefaultTab: z.enum(COVER_PICKER_TAB_VALUES).optional(),
  /* Plan 41 — first-visit / default theme. The top-bar quick toggle
     writes a device-local override to the UI slice (redux-persist);
     this field is the fallback when no override is set, and the
     account default any new device inherits. Optional with a
     'system' default so legacy user-settings.json files load
     unchanged. */
  defaultThemePreference: z.enum(THEME_PREFERENCE_VALUES).optional(),
});

export type UserSettings = z.infer<typeof userSettingsSchema>;

export const DEFAULT_USER_SETTINGS: UserSettings = {
  displayName:          'Mike Dudarenok',
  /* Default to Gemini 3.1 Flash Lite over a Google API key — the free
     tier (15 RPM, 250K TPM, 500/day) comfortably parses a full novel,
     dispatch is async-friendly so it doesn't tax the local GPU, and
     no `ollama pull` is required before first run. Local Ollama
     models stay one click away in the picker for users who want to
     run analysis on-device. Flip in lockstep with
     src/lib/account-defaults.ts FRONTEND_ACCOUNT_DEFAULTS. */
  defaultAnalysisModel: 'gemini-3.1-flash-lite',
  defaultTtsEngine:     'local',
  /* Kokoro v1 is the new default — TTS-Arena #1 for its size, ~1 GB
     VRAM (vs ~3 GB for XTTS), and small enough to be eagerly preloaded
     by the sidecar so the Load/Stop pill stops being a daily friction
     point. XTTS stays available as an alternate in the picker for the
     30-voice catalog and zero-shot cloning. Flip in lockstep with
     src/lib/account-defaults.ts FRONTEND_ACCOUNT_DEFAULTS. */
  defaultTtsModelKey:   'kokoro-v1',
  sidecarUrl:           'http://localhost:9000',
  /* Gemini matches the analysis-model default. Picking 'local' falls
     through to the Ollama daemon — kept as an opt-in for users who
     want analysis on-device. */
  analysisEngine:       'gemini',
  ollamaUrl:            'http://localhost:11434',
  workspaceDirOverride: null,
  exportSyncFolder:     null,
  minorCastMinLines:    3,
  coverPickerDefaultTab: 'search',
  /* 'system' follows the OS's prefers-color-scheme at runtime so a
     fresh install paints the way the device does after sundown.
     Users can pin Light or Dark from the Account view or via the
     top-bar quick toggle. Flip in lockstep with
     src/lib/account-defaults.ts FRONTEND_ACCOUNT_DEFAULTS. */
  defaultThemePreference: 'system',
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
    cache, falling back to the LOCAL_TTS_URL env var, then
    DEFAULT_USER_SETTINGS.sidecarUrl. Strips trailing slashes for
    consistency with prior call-site behaviour. The final fallback comes
    from the same defaults document that seeds a fresh user-settings.json
    — one source of truth, no duplicated URL literals. */
export function getResolvedSidecarUrl(): string {
  const c = cached;
  const raw = c?.sidecarUrl ?? process.env.LOCAL_TTS_URL ?? DEFAULT_USER_SETTINGS.sidecarUrl;
  return raw.replace(/\/+$/, '');
}

/** Same fallback chain as getResolvedSidecarUrl, but for the local Ollama
    daemon: cached user-settings → OLLAMA_URL env → DEFAULT_USER_SETTINGS. */
export function getResolvedOllamaUrl(): string {
  const c = cached;
  const raw = c?.ollamaUrl ?? process.env.OLLAMA_URL ?? DEFAULT_USER_SETTINGS.ollamaUrl;
  return raw.replace(/\/+$/, '');
}

/** Hardcoded Ollama tag used as the terminal fallback in
    getResolvedOllamaModel. Cannot be derived from
    DEFAULT_USER_SETTINGS.defaultAnalysisModel any more — that default
    is now a Gemini id (no colon, see DEFAULT_USER_SETTINGS above), and
    Ollama's /api/chat would 404 on it. Keep this in sync with
    src/lib/models.ts MODEL_OPTIONS local entries (qwen3.5:4b is still
    the smallest local option). */
export const DEFAULT_OLLAMA_MODEL = 'qwen3.5:4b';

/** Ollama model tag passed to /api/chat. Resolution chain:
      1. cached `defaultAnalysisModel` if it has Ollama tag shape (':')
      2. process.env.OLLAMA_MODEL
      3. DEFAULT_OLLAMA_MODEL ('qwen3.5:4b')
    The per-request `model` override (see selectAnalyzer) trumps all
    three. We intentionally do NOT fall through to
    DEFAULT_USER_SETTINGS.defaultAnalysisModel any more, because that
    default is now a Gemini id and would break Ollama dispatch. */
export function getResolvedOllamaModel(): string {
  const c = cached;
  const fromSettings = c?.defaultAnalysisModel;
  if (fromSettings && fromSettings.includes(':')) return fromSettings;
  return process.env.OLLAMA_MODEL ?? DEFAULT_OLLAMA_MODEL;
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
