/* #3084 PR 3b — analyzer endpoint CRUD and the per-endpoint key write
   (Task 3b.8 adds Detect to this router).

   Every write goes through mutateUserSettings, so each refusal (duplicate id,
   still referenced, …) is decided against exactly the settings it would
   overwrite. Writes answer with the GET /api/user/settings body (envDerived),
   so the account slice swaps it in without a follow-up GET — the same contract
   as PUT /api/user/settings/gemini-key. Keys are never echoed or logged. */

import { Router } from 'express';
import type { Request, Response } from '../http.js';
import { z } from 'zod';
import { knownAnalyzerSecrets, mutateUserSettings, type UserSettings } from '../workspace/user-settings.js';
import { redactKnownSecrets } from '../analyzer/redact.js';
import {
  AnalyzerEndpointRefusal,
  applyCreate,
  applyDelete,
  applyKey,
  applyUpdate,
  type EndpointState,
} from '../workspace/analyzer-endpoints.js';
import { envDerived } from './user-settings.js';

export const analyzerEndpointsRouter = Router();

function stateOf(s: UserSettings): EndpointState {
  return { analyzerEndpoints: s.analyzerEndpoints, analyzerEndpointKeys: s.analyzerEndpointKeys };
}

/** Sends a refusal and returns true, or returns false for any other error.
    #3084 F5 — the body is `{ error, code, issues }`: `issues` is the decided
    save-time-validation shape ({path, message}[]), never a field or key value
    (AnalyzerEndpointRefusal.issues already carries that shape); `code` stays
    as an additional machine-readable refusal kind for existing callers. */
function sendRefusal(res: Response, err: unknown): boolean {
  if (!(err instanceof AnalyzerEndpointRefusal)) return false;
  res.status(err.status).json({ error: err.message, code: err.refusal, issues: err.issues });
  return true;
}

/** #3084 P22 — the log line for an unexpected route failure: the error's name and
    message with every known secret removed. Never the stack or the cause chain,
    which a logged Error object would print. */
export function redactedFailureLine(what: string, err: unknown, secrets: readonly string[]): string {
  const name = err instanceof Error ? err.name : typeof err;
  const message = err instanceof Error ? err.message : String(err);
  return redactKnownSecrets(`[analyzer-endpoints] ${what} failed: ${name}: ${message}`, secrets);
}

/* `extraSecrets`: a key this request carries that is not saved yet (the key route). */
function fail(res: Response, what: string, err: unknown, extraSecrets: readonly string[] = []): void {
  console.error(redactedFailureLine(what, err, [...extraSecrets, ...knownAnalyzerSecrets()]));
  res.status(500).json({ error: `Failed to ${what}.` });
}

analyzerEndpointsRouter.post('/', async (req: Request, res: Response) => {
  try {
    const updated = await mutateUserSettings((current) => applyCreate(stateOf(current), req.body));
    res.status(201).json(envDerived(updated));
  } catch (err) {
    if (!sendRefusal(res, err)) fail(res, 'save the analyzer endpoint', err);
  }
});

analyzerEndpointsRouter.put('/:endpointId', async (req: Request, res: Response) => {
  try {
    const updated = await mutateUserSettings((current) =>
      applyUpdate(stateOf(current), req.params.endpointId, req.body),
    );
    res.json(envDerived(updated));
  } catch (err) {
    if (!sendRefusal(res, err)) fail(res, 'update the analyzer endpoint', err);
  }
});

analyzerEndpointsRouter.delete('/:endpointId', async (req: Request, res: Response) => {
  try {
    const updated = await mutateUserSettings((current) =>
      applyDelete(stateOf(current), current, req.params.endpointId),
    );
    res.json(envDerived(updated));
  } catch (err) {
    if (!sendRefusal(res, err)) fail(res, 'delete the analyzer endpoint', err);
  }
});

const keyPayloadSchema = z.object({ key: z.string().nullable() });

/* PUT /api/analyzer/endpoints/:endpointId/key { key: string | null }
   Stores { origin: new URL(endpoint.baseUrl).origin, key }; null clears it.
   Changing the base URL later does not move the key — its status turns
   'origin-mismatch' and it is not sent until re-entered (decision 3c). */
analyzerEndpointsRouter.put('/:endpointId/key', async (req: Request, res: Response) => {
  const parsed = keyPayloadSchema.safeParse(req.body);
  if (!parsed.success) {
    /* #3084 F5 — same shape as sendRefusal: {path, message}, never the value. */
    return res.status(400).json({
      error: 'Invalid payload.',
      code: 'invalid',
      issues: parsed.error.issues.map((i) => ({ path: i.path.map(String), message: i.message })),
    });
  }
  try {
    const updated = await mutateUserSettings((current) =>
      applyKey(stateOf(current), req.params.endpointId, parsed.data.key),
    );
    res.json(envDerived(updated));
  } catch (err) {
    if (!sendRefusal(res, err)) fail(res, 'save the analyzer endpoint key', err, parsed.data.key ? [parsed.data.key] : []);
  }
});
