/* GET / PUT /api/user/settings

   The frontend's Account view round-trips through here. GET returns the
   on-disk user-settings.json merged with env-derived read-only fields
   (apiKeyStatus, workspaceRoot, workspaceSource). PUT validates a partial
   patch, strips secret-shaped keys, persists, and returns the new shape.

   Secrets stay in server/.env — the API key value never crosses this
   boundary, only the binary "is it set" flag. */

import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import {
  readUserSettings,
  writeUserSettings,
  type UserSettings,
} from '../workspace/user-settings.js';
import { WORKSPACE_ROOT, WORKSPACE_SOURCE } from '../workspace/paths.js';

export const userSettingsRouter = Router();

interface UserSettingsResponse extends UserSettings {
  apiKeyStatus: 'set' | 'unset';
  workspaceRoot: string;
  workspaceSource: 'env' | 'default' | 'override';
}

function envDerived(settings: UserSettings): UserSettingsResponse {
  const key = process.env.GEMINI_API_KEY?.trim();
  return {
    ...settings,
    apiKeyStatus: key && key.length > 0 ? 'set' : 'unset',
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
