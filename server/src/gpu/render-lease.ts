/* #4079 — render lease. While a chapter render (or splice / QA repair) is
   registered, renew a short lease on the sidecar so its idle watchdog does not
   unload the 1.7B-Base during the render's ASR-QA gaps. The sidecar expires
   the lease by itself (no renewal => gone after LEASE_TTL_S), so a crashed
   server can never pin VRAM.

   Reaches the render state only through the stateless leaf gate
   (./active-generation-gate.ts) — never by importing routes/generation.ts,
   which would close an import cycle (see that file's header). Imports
   user-settings the same way ./capacity-probe.ts does. */
import { isGenerationKnownActive } from './active-generation-gate.js';
import { getResolvedSidecarUrl } from '../workspace/user-settings.js';

export const LEASE_TTL_S = 90;
export const LEASE_RENEW_MS = 30_000;
const HOLDER = 'castwright-server';

/** One renewal tick: post the lease when a render is known to be in flight.
    Best-effort — an unreachable sidecar is simply not leased. Returns whether
    a lease was posted. */
export async function renewRenderLeaseOnce(): Promise<boolean> {
  if (!isGenerationKnownActive()) return false;
  try {
    const res = await fetch(`${getResolvedSidecarUrl()}/render-lease`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ holder: HOLDER, ttl_seconds: LEASE_TTL_S }),
      signal: AbortSignal.timeout(5_000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/** Start the renewal timer (unref'd, so it never holds the process open). */
export function startRenderLease(): NodeJS.Timeout {
  const t = setInterval(() => void renewRenderLeaseOnce(), LEASE_RENEW_MS);
  t.unref();
  return t;
}
