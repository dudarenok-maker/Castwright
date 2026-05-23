/* Audit the hand-rolled COQUI_PROFILE_VOICES catalog against the speaker
   manifest the loaded XTTS v2 model actually ships with.

   Background: the catalog in voice-mapping.ts was authored "best-effort"
   without verification against the real model — see the comment on
   COQUI_PROFILE_VOICES. Any drift between catalog and manifest manifests
   as a "Local TTS sidecar returned 500: index out of range in self" mid-
   chapter (XTTS's embedding lookup raises a cryptic PyTorch error when
   asked for an unknown speaker). The sidecar now substitutes a safe
   fallback so chapters keep generating, but that ships the wrong voice
   in the audio — far better to surface the drift at boot, loud and
   explicit, so the user knows to fix the catalog instead of discovering
   it after a 90-minute generate run completes with the wrong narrator.

   This module:
   - Polls the sidecar's GET /speakers endpoint with backoff (sidecar
     model load takes 30–60s, so a single shot would miss it).
   - Diffs the live manifest against COQUI_PROFILE_VOICES — both
     directions: which catalog names are bogus, which model speakers are
     unused.
   - Caches the result so the Node-side audit endpoint can serve it
     without re-polling.
   - Logs a structured summary to stdout the moment the audit completes. */

import { COQUI_PROFILE_VOICES } from './voice-mapping.js';

export interface CoquiCatalogAudit {
  /** ISO timestamp the audit ran. */
  ranAt: string;
  /** Sidecar URL we hit for /speakers. */
  sidecarUrl: string;
  /** Speaker names XTTS v2 actually has loaded right now. */
  modelSpeakers: string[];
  /** Catalog names that ARE in the model — safe to keep using. */
  validInCatalog: string[];
  /** Catalog names that are NOT in the model — will cause silent
      substitutions. Trim these from voice-mapping.ts. */
  invalidInCatalog: string[];
  /** Model speakers that aren't referenced anywhere in the catalog —
      potential additions if their gender/register fits a profile bucket
      that's under-represented. */
  unusedInModel: string[];
  /** Profiles whose options are entirely valid (no broken names). */
  healthyProfiles: string[];
  /** Profiles where at least one option is invalid — these will degrade
      to the per-profile fallback or to the sidecar's substitution. */
  degradedProfiles: string[];
}

interface AuditOptions {
  sidecarUrl: string;
  /** Max attempts before giving up. Default: 24 (≈ 2 minutes at 5s gap). */
  maxAttempts?: number;
  /** Pause between attempts, ms. Default: 5000. */
  attemptDelayMs?: number;
  /** Per-attempt HTTP timeout, ms. Default: 2000. */
  probeTimeoutMs?: number;
}

let cached: CoquiCatalogAudit | null = null;

/** Returns the last completed audit, or null if it hasn't finished yet. */
export function getCachedCatalogAudit(): CoquiCatalogAudit | null {
  return cached;
}

/** Pure: given the model's speaker list, diff it against the hardcoded
    COQUI_PROFILE_VOICES catalog and produce a structured audit. No I/O.
    This is the unit-testable core. */
export function diffCatalogAgainstModel(
  modelSpeakers: string[],
  sidecarUrl: string,
): CoquiCatalogAudit {
  const modelSet = new Set(modelSpeakers);
  const catalogNames = new Set<string>();
  for (const options of Object.values(COQUI_PROFILE_VOICES)) {
    for (const name of options) catalogNames.add(name);
  }

  const validInCatalog: string[] = [];
  const invalidInCatalog: string[] = [];
  for (const name of catalogNames) {
    (modelSet.has(name) ? validInCatalog : invalidInCatalog).push(name);
  }

  const unusedInModel = modelSpeakers.filter((s) => !catalogNames.has(s));

  const healthyProfiles: string[] = [];
  const degradedProfiles: string[] = [];
  for (const [profile, options] of Object.entries(COQUI_PROFILE_VOICES)) {
    const anyInvalid = options.some((o) => !modelSet.has(o));
    (anyInvalid ? degradedProfiles : healthyProfiles).push(profile);
  }

  return {
    ranAt: new Date().toISOString(),
    sidecarUrl,
    modelSpeakers: [...modelSpeakers].sort(),
    validInCatalog: validInCatalog.sort(),
    invalidInCatalog: invalidInCatalog.sort(),
    unusedInModel: unusedInModel.sort(),
    healthyProfiles: healthyProfiles.sort(),
    degradedProfiles: degradedProfiles.sort(),
  };
}

/** Fetch /speakers from the sidecar with a short timeout. Returns null when
    the sidecar is unreachable, still loading the model, or returns an
    empty manifest (which can happen right after process start before
    `_ensure_loaded` populates `_speakers`). */
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
    return list;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Background driver: poll /speakers until the sidecar's model has
    loaded, then run the diff and cache it. Logs a structured summary
    when it completes. Safe to call once at server startup — returns a
    Promise that resolves with the final audit (or null if all attempts
    failed within the window). Never throws. */
export async function runCatalogAudit(opts: AuditOptions): Promise<CoquiCatalogAudit | null> {
  const { sidecarUrl, maxAttempts = 24, attemptDelayMs = 5_000, probeTimeoutMs = 2_000 } = opts;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const speakers = await fetchSpeakersOnce(sidecarUrl, probeTimeoutMs);
    if (speakers && speakers.length > 0) {
      const audit = diffCatalogAgainstModel(speakers, sidecarUrl);
      cached = audit;
      logAudit(audit);
      return audit;
    }
    if (attempt < maxAttempts - 1) {
      await new Promise((r) => setTimeout(r, attemptDelayMs));
    }
  }

  console.warn(
    `[tts:catalog-audit] Could not reach ${sidecarUrl}/speakers within ` +
      `${((maxAttempts * attemptDelayMs) / 1000).toFixed(0)}s — skipping audit. ` +
      `Start the sidecar and run \`curl ${sidecarUrl}/api/sidecar/catalog-audit\` ` +
      `(or restart the server) to retry.`,
  );
  return null;
}

function logAudit(audit: CoquiCatalogAudit): void {
  /* Compact, scannable summary. Bold-ish ASCII separators so it stands
     out in a fast-scrolling dev log; this only runs once per server
     start, so cost is negligible. */
  const line = '─'.repeat(64);
  const log = (s: string) => {
    console.log(s);
  };
  log('');
  log(line);
  log(`[tts:catalog-audit] XTTS v2 manifest check — ${audit.modelSpeakers.length} speakers loaded`);
  log(line);

  if (audit.invalidInCatalog.length === 0) {
    log(`  ✓ All ${audit.validInCatalog.length} catalog names are present in the model.`);
  } else {
    log(
      `  ✗ ${audit.invalidInCatalog.length} catalog name(s) NOT in the model — fix server/src/tts/voice-mapping.ts:`,
    );
    for (const name of audit.invalidInCatalog) {
      log(`      • "${name}"`);
    }
    log('');
    log(`  ✓ ${audit.validInCatalog.length} catalog name(s) confirmed against the manifest.`);
  }

  if (audit.degradedProfiles.length > 0) {
    log('');
    log(`  ! Degraded profiles (at least one bogus option — picker may substitute mid-run):`);
    for (const p of audit.degradedProfiles) log(`      • ${p}`);
  }

  if (audit.unusedInModel.length > 0 && audit.unusedInModel.length <= 12) {
    log('');
    log(
      `  i ${audit.unusedInModel.length} model speaker(s) unused by the catalog (candidates if you need more variety):`,
    );
    log(`      ${audit.unusedInModel.join(', ')}`);
  } else if (audit.unusedInModel.length > 12) {
    log('');
    log(
      `  i ${audit.unusedInModel.length} model speaker(s) unused by the catalog — see GET /api/sidecar/catalog-audit.`,
    );
  }
  log(line);
  log('');
}
