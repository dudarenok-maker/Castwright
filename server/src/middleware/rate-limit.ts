import rateLimit, { type Options } from 'express-rate-limit';

/* Anti-DoS + scanner-clearing only — NOT an auth control (single-user, no-auth
   by design; see docs/security/2026-05-31-security-review.md). 1000/min sits far
   above the app's worst legitimate burst (1.5s install polls, 4s stats, gpu/queue/
   health pills, revisions fan-out). An open SSE stream is a single hit against the
   window, so no per-route skip is needed. Skipped under Vitest (which sets
   process.env.VITEST) so the server suite's request bursts/header asserts stay
   green — the mount is still unconditional so CodeQL credits route dominance. */
export function makeApiLimiter(overrides: Partial<Options> = {}) {
  return rateLimit({
    windowMs: 60_000,
    max: 1000,
    standardHeaders: true,
    legacyHeaders: false,
    skip: () => !!process.env.VITEST,
    ...overrides,
  });
}

export const apiLimiter = makeApiLimiter();
