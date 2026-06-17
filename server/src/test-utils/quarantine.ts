// server/src/test-utils/quarantine.ts  (and src/test/quarantine.ts — identical)
// Quarantined tests run ONLY in the explicit lane (RUN_QUARANTINE=1). EVERY
// gating run — local pre-push AND CI — leaves the flag unset → skipped.
// Import this; never add it to setupFiles (it must eval after vitest globals).
import { it, describe } from 'vitest';

export const RUN_QUARANTINE = process.env.RUN_QUARANTINE === '1';
export const quarantinedIt = RUN_QUARANTINE ? it : it.skip;
export const quarantinedDescribe = RUN_QUARANTINE ? describe : describe.skip;
