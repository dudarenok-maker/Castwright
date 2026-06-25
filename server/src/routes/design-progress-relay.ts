// server/src/routes/design-progress-relay.ts
/* Internal loopback-only relay: the TTS sidecar POSTs single-design phase
   progress here (it can't reach the SSE directly), and we broadcast it onto the
   in-flight single-design job's SSE. Loopback-gated AND token-gated (AR3). */
import { Router } from 'express';
import type { Request, Response } from '../http.js';
import { resolveProgressToken, broadcast, type SingleJob } from './single-design.js';

const PHASES = new Set([
  'freeing-vram', 'loading-model', 'designing', 'anchoring', 'performing', 'distilling', 'rendering',
]);

function isLoopback(req: Request): boolean {
  const ip = req.ip ?? '';
  return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1' || ip === '';
}

export const designProgressRelayRouter = Router();

designProgressRelayRouter.post('/design-progress', (req: Request, res: Response) => {
  if (!isLoopback(req)) return res.status(403).json({ error: 'loopback only' });
  const token = typeof req.body?.token === 'string' ? req.body.token : '';
  const phase = typeof req.body?.phase === 'string' ? req.body.phase : '';
  // An unknown phase is a malformed request (400). An empty token is a
  // well-formed request that simply can't resolve a job — same shape as an
  // unknown token: 200 {ok:false} (spec PR-D; #1092).
  if (!PHASES.has(phase)) return res.status(400).json({ error: 'bad request' });
  if (!token) return res.status(200).json({ ok: false });
  const job = resolveProgressToken(token);
  if (!job) return res.status(200).json({ ok: false });
  job.phase = phase as SingleJob['phase']; // keep the resume-seed current (PR-D)
  broadcast(job, { type: 'phase', phase, characterId: job.characterId });
  return res.status(200).json({ ok: true });
});
