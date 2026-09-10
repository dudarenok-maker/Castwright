/* GET / PUT /api/user/settings

   The frontend's Account view round-trips through here. GET returns the
   on-disk user-settings.json merged with env-derived read-only fields
   (apiKeyStatus, workspaceRoot, workspaceSource). PUT validates a partial
   patch, strips secret-shaped keys, persists, and returns the new shape.

   Plan 49 — the Gemini API key is now UI-managed via a dedicated
   PUT /api/user/settings/gemini-key endpoint (kept off the general PUT
   so a misaddressed payload can't leak the secret into an unrelated
   field). The general GET still surfaces only apiKeyStatus 'set'|'unset',
   never the plaintext. Env-var GEMINI_API_KEY still wins when set. */

import { Router } from 'express';
import type { Request, Response } from '../http.js';
import { z } from 'zod';
import { lstat, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  readUserSettings,
  writeUserSettings,
  writeGeminiApiKey,
  getResolvedGeminiApiKey,
  getResolvedGenerationWorkers,
  getResolvedTtsModelKey,
  getResolvedOllamaUrl,
  type UserSettings,
} from '../workspace/user-settings.js';
import { configValue } from '../config/resolver.js';
import { WORKSPACE_ROOT, WORKSPACE_SOURCE } from '../workspace/paths.js';

export const userSettingsRouter = Router();

/* #3141 step 2 — these four fields are no longer stored on the settings
   document (step 1 moved every server reader onto the config resolver
   against the matching registry key). The Account UI still needs to show
   them, so GET populates them from the resolver's effective value
   (env > saved Advanced Settings override > registry default) instead of a
   stored field, and the PUT handler below rejects the keys outright rather
   than silently stripping them (see REJECTED_LEGACY_ANALYZER_FIELDS). */
const RETIRED_ANALYZER_FIELDS = [
  'ollamaUrl',
  'analyzerPhase0Model',
  'analyzerPhase1Model',
  'analyzerPhase1MinLagChapters',
] as const;

interface UserSettingsResponse extends Omit<UserSettings, 'geminiApiKey'> {
  apiKeyStatus: 'set' | 'unset';
  workspaceRoot: string;
  workspaceSource: 'env' | 'default' | 'override';
  /* The EFFECTIVE default TTS model after the Qwen-when-installed resolution
     (getResolvedTtsModelKey). Distinct from the STORED `defaultTtsModelKey`
     (which the Account picker shows + round-trips): the frontend seeds the
     session engine from this so a fresh box with Qwen installed defaults to
     Qwen, while the stored key stays Kokoro until the user explicitly picks. */
  resolvedTtsModelKey: UserSettings['defaultTtsModelKey'];
  /* Read-only, resolver-derived (#3141 step 2) — see RETIRED_ANALYZER_FIELDS. */
  ollamaUrl: string;
  analyzerPhase0Model: string | null;
  analyzerPhase1Model: string | null;
  analyzerPhase1MinLagChapters: number;
}

function envDerived(settings: UserSettings): UserSettingsResponse {
  /* Drop the plaintext key — frontend only ever sees apiKeyStatus. */
  const rest = { ...settings } as Partial<UserSettings>;
  delete rest.geminiApiKey;
  const phase0Model = configValue<string>('analyzer.phase0.model');
  const phase1Model = configValue<string>('analyzer.phase1.model');
  return {
    ...(rest as Omit<UserSettings, 'geminiApiKey'>),
    apiKeyStatus: getResolvedGeminiApiKey() ? 'set' : 'unset',
    /* Surface the ENV-resolved worker count (GEN_WORKERS env > account setting >
       default 2), mirroring apiKeyStatus. The client queue-dispatcher reads
       `account.generationWorkers` from this response, so without this overlay
       the GEN_WORKERS env never reaches the dispatcher and can't cap concurrency
       — it was a deploy knob that did nothing. When the env is unset,
       getResolvedGenerationWorkers() returns the on-disk account value, so the
       Account-tab UI is unchanged. */
    generationWorkers: getResolvedGenerationWorkers(),
    /* Read-only effective default (Qwen-when-installed, else Kokoro). The
       stored `defaultTtsModelKey` above is left untouched so the Account
       picker shows what's saved and a no-op round-trip can't pollute it. */
    resolvedTtsModelKey: getResolvedTtsModelKey(),
    /* #3141 step 2 — resolver-derived, read-only (env > Advanced Settings
       override > registry default). Empty phase-model strings surface as
       null to match the pre-step-2 response shape. */
    ollamaUrl: getResolvedOllamaUrl(),
    analyzerPhase0Model: phase0Model.trim().length > 0 ? phase0Model : null,
    analyzerPhase1Model: phase1Model.trim().length > 0 ? phase1Model : null,
    analyzerPhase1MinLagChapters: configValue<number>('analyzer.phase1.minLagChapters'),
    workspaceRoot: WORKSPACE_ROOT,
    workspaceSource: WORKSPACE_SOURCE,
  };
}

userSettingsRouter.get('/', async (_req: Request, res: Response) => {
  try {
    const settings = await readUserSettings();
    res.json(envDerived(settings));
  } catch (err) {
    console.error('[user-settings] GET failed', err);
    res.status(500).json({ error: 'Failed to read user settings.' });
  }
});

userSettingsRouter.put('/', async (req: Request, res: Response) => {
  try {
    /* #3141 step 2 — reject outright, before any other stripping/validation,
       so the caller is never told the save succeeded when these fields are
       actually managed in Advanced Settings (configOverrides). Runs first
       because writeUserSettings' own FORBIDDEN_KEYS mechanism silently
       strips fields, which would swallow the offending keys before we ever
       got a chance to name them. */
    const body = req.body as Record<string, unknown> | null | undefined;
    const offending = body && typeof body === 'object'
      ? RETIRED_ANALYZER_FIELDS.filter((field) => field in body)
      : [];
    if (offending.length > 0) {
      return res.status(400).json({
        error: `${offending.join(', ')} ${offending.length > 1 ? 'are' : 'is'} managed in Advanced Settings and cannot be set here.`,
      });
    }
    const updated = await writeUserSettings(req.body);
    res.json(envDerived(updated));
  } catch (err) {
    if (err instanceof z.ZodError) {
      return res.status(400).json({ error: 'Invalid user settings.', issues: err.issues });
    }
    console.error('[user-settings] PUT failed', err);
    res.status(500).json({ error: 'Failed to write user settings.' });
  }
});

const geminiKeyPayloadSchema = z.object({
  key: z.string().nullable(),
});

/* PUT /api/user/settings/gemini-key { key: string | null }
   - Sets the UI-managed Gemini API key (Account view → Server configuration).
   - Pass `null` to clear it.
   - Response is the same shape as GET /api/user/settings — caller can swap
     it into local state without a follow-up GET.
   - Env GEMINI_API_KEY still wins; setting the key here is a no-op visually
     when env is already present (apiKeyStatus stays 'set' either way). */
userSettingsRouter.put('/gemini-key', async (req: Request, res: Response) => {
  try {
    const { key } = geminiKeyPayloadSchema.parse(req.body);
    const updated = await writeGeminiApiKey(key);
    res.json(envDerived(updated));
  } catch (err) {
    if (err instanceof z.ZodError) {
      return res.status(400).json({ error: 'Invalid payload.', issues: err.issues });
    }
    console.error('[user-settings] PUT /gemini-key failed', err);
    res.status(500).json({ error: 'Failed to save Gemini API key.' });
  }
});

const syncFolderTestPayloadSchema = z.object({
  path: z.string().min(1).max(2000),
});

/* POST /api/user/settings/sync-folder/test { path }
   Plan 79 — write-probe so the export modal's "Test" button can tell the
   user immediately whether the folder they typed is actually writable.
   The likely failure mode is a Google Drive path that doesn't resolve
   (Drive not running, wrong drive letter, legacy Backup-and-Sync layout)
   or a folder the user doesn't have write access to (Shared with me
   vs. My Drive). The probe does mkdir + writeFile + unlink with a
   short test buffer; success means "Node can write here right now",
   not "your sync app will mirror it" — that part is on the user. */
userSettingsRouter.post('/sync-folder/test', async (req: Request, res: Response) => {
  let parsed: { path: string };
  try {
    parsed = syncFolderTestPayloadSchema.parse(req.body);
  } catch (err) {
    if (err instanceof z.ZodError) {
      return res.status(400).json({ error: 'Invalid payload.', issues: err.issues });
    }
    throw err;
  }
  /* srv-22 — require an existing directory and probe its writability; do NOT
     `mkdir(recursive)` an arbitrary tree (that was an unauthenticated
     arbitrary-directory-creation primitive). `lstat` (not `stat`) so a symlink
     at an existing path can't redirect the probe outside the dir the user typed. */
  let st;
  try {
    st = await lstat(parsed.path);
  } catch {
    return res.json({ ok: false, code: 'ENOENT' });
  }
  if (!st.isDirectory()) {
    return res.json({ ok: false, code: 'ENOENT' });
  }
  const probePath = join(parsed.path, '.audiobook-write-probe');
  try {
    await writeFile(probePath, 'ok');
    await unlink(probePath).catch(() => {});
    return res.json({ ok: true });
  } catch (err) {
    /* swallow probe-file cleanup failure separately so it doesn't mask
       the real diagnosis */
    await unlink(probePath).catch(() => {});
    const code = (err as { code?: string }).code;
    const message = (err as Error).message ?? 'unknown error';
    return res.json({ ok: false, code, message });
  }
});
