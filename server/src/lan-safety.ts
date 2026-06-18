import type { Express } from 'express';
import { getLanAuthToken } from './lan-auth.js';
import { isLanHttpsEnabled } from './routes/export-lan.js';

/** The loopback gate (isLoopbackRequest) is spoofable if trust proxy honours
 *  X-Forwarded-For. This is the runtime layer that survives a deleted test. */
export function assertNoTrustProxy(app: Express): void {
  if (app.get('trust proxy')) {
    throw new Error('LAN auth requires `trust proxy` unset — the loopback gate would be spoofable.');
  }
}

/** WARN text when the server is bound to the LAN but the guard is a no-op. */
export function lanExposureWarning(): string | null {
  if (isLanHttpsEnabled() && getLanAuthToken() === undefined) {
    return 'WARN: LAN HTTPS is bound to all interfaces but LAN_AUTH_TOKEN is unset — the API is reachable UNAUTHENTICATED from the LAN.';
  }
  return null;
}
