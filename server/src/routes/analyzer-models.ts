/* #3084 W3 — GET /api/analyzer/models (catalog), POST /api/analyzer/models/test (Test
   action), POST /api/analyzer/models/preview (list an unsaved endpoint's models so the
   add form can prefill its served context). Keys are never returned or logged. */
import { Router } from 'express';
import { z } from 'zod';
import type { Request, Response } from '../http.js';
import { buildAnalyzerCatalog, previewEndpointModels } from '../analyzer/catalog/analyzer-catalog.js';
import { ModelTestControlFailedError, runModelTest } from '../analyzer/capabilities.js';
import { modelTestDepsFor, GeminiKeyMissingForTestError } from '../analyzer/model-test-deps.js';
import { AnalyzerEndpointMissingError, AnalyzerKeyOriginError } from '../analyzer/errors.js';
import { keyOriginMatches, httpUrlSchema } from '../workspace/analyzer-endpoints.js';
import { readUserSettings, writeAnalyzerCapabilityRecord, type UserSettings } from '../workspace/user-settings.js';
/* Known secrets come through 3b's leaf gate, never from user-settings.ts (A9). */
import { knownAnalyzerSecrets } from '../analyzer/known-secrets-gate.js';
import { redactKnownSecrets } from '../analyzer/redact.js';

export const analyzerModelsRouter = Router();

/* P22: every error text these routes return or log is redacted. Settings read here may not be the
   cache, so their endpoint keys are added to the saved secrets. */
function secretsFor(settings?: UserSettings): string[] {
  return [...knownAnalyzerSecrets(), ...Object.values(settings?.analyzerEndpointKeys ?? {}).map((k) => k.key)];
}

analyzerModelsRouter.get('/models', async (req: Request, res: Response) => {
  try {
    res.json(await buildAnalyzerCatalog({ refresh: req.query.refresh === '1' }));
  } catch (err) {
    console.error('[analyzer-models] GET /models failed:', redactKnownSecrets(err instanceof Error ? (err.stack ?? err.message) : String(err), secretsFor()));
    res.status(500).json({ error: 'Failed to list analyzer models.' });
  }
});

const testBodySchema = z.object({
  modelId: z.string().min(1).max(400),
  scope: z.enum(['configured', 'all']),
});

analyzerModelsRouter.post('/models/test', async (req: Request, res: Response) => {
  const parsed = testBodySchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Invalid payload.', issues: parsed.error.issues });
  const { modelId, scope } = parsed.data;
  const settings = await readUserSettings();
  let deps;
  try {
    deps = modelTestDepsFor(modelId, settings);
  } catch (err) {
    if (err instanceof AnalyzerEndpointMissingError) {
      return res.status(404).json({ error: err.message, code: 'analyzer-endpoint-missing' });
    }
    if (err instanceof AnalyzerKeyOriginError || err instanceof GeminiKeyMissingForTestError) {
      return res.status(401).json({ error: err.message, code: 'auth' });
    }
    throw err;
  }
  /* Spec §2 "Cancelling": leaving the page cancels a queued or running test. */
  const controller = new AbortController();
  res.on('close', () => {
    if (!res.writableEnded) controller.abort();
  });
  try {
    const record = await runModelTest({ modelId, scope }, { ...deps, signal: controller.signal });
    await writeAnalyzerCapabilityRecord(modelId, record);
    return res.json(record);
  } catch (err) {
    if (controller.signal.aborted) return; // the client left: nothing to answer, nothing written
    /* P7: a failed control or an inconclusive step writes nothing, so a previous record stays. */
    const outcome = err instanceof ModelTestControlFailedError ? 'failed' : 'inconclusive';
    console.warn(`[analyzer-models] test of ${modelId} ${outcome}: ${(err as Error).name}`);
    const message = redactKnownSecrets((err as Error).message ?? 'Model test failed.', secretsFor(settings));
    return res.status(502).json({ error: message.slice(0, 800), outcome });
  }
});

const previewBodySchema = z.object({
  baseUrl: httpUrlSchema,
  endpointId: z.string().regex(/^[a-z0-9-]{1,40}$/).optional(),
  apiKey: z.string().min(1).max(4000).optional(),
});

analyzerModelsRouter.post('/models/preview', async (req: Request, res: Response) => {
  const parsed = previewBodySchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Invalid payload.', issues: parsed.error.issues });
  const { baseUrl, endpointId, apiKey } = parsed.data;
  let key: string | null = apiKey ?? null;
  if (key === null && endpointId) {
    const stored = (await readUserSettings()).analyzerEndpointKeys[endpointId];
    if (stored && keyOriginMatches(stored, baseUrl)) key = stored.key;
  }
  res.json(await previewEndpointModels({ baseUrl, apiKey: key }));
});
