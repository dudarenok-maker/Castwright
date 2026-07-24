/* fs-38 Wave 1 — route gate for the whole voice-library surface (Tasks 4-11
   mount their routes behind this). Config-registry-driven so it can be
   flipped off without a restart (registry.ts, key 'voices.library.enabled'). */

import type { Request, Response, NextFunction } from '../http.js';
import { configValue } from '../config/resolver.js';

export function requireVoiceLibraryEnabled(_req: Request, res: Response, next: NextFunction): void {
  if (!configValue<boolean>('voices.library.enabled')) {
    res.status(404).json({ error: 'voice library disabled' });
    return;
  }
  next();
}
