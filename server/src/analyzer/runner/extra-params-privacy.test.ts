import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Agent } from 'undici';
import { z } from 'zod';
import { ApiError, type GoogleGenAI } from '@google/genai';
import { StageRunner } from './stage-runner.js';
import { OLLAMA_RETRY_POLICY } from './retry-policy.js';
import { REDACTED } from './extra-params.js';
import { OllamaTransport } from '../transports/ollama-transport.js';
import { GeminiTransport } from '../transports/gemini-transport.js';
import { OpenAITransport } from '../transports/openai-transport.js';
import { AnalyzerHttpError } from '../errors.js';
import { geminiRateLimiter } from '../rate-limit.js';
import { analyzerEndpointSchema } from '../../workspace/analyzer-endpoints.js';
import { _resetUserSettingsCache, _setUserSettingsCacheForTest, knownAnalyzerSecrets } from '../../workspace/user-settings.js';
import { classifyAnalysisFailure } from '../../routes/failure-taxonomy.js';
import type { ChatTransport, TransportRequest } from './transport.js';

const SENTINEL = 'cw-sentinel-9f3a7c21';
const hoisted = vi.hoisted(() => ({ dirName: `castwright-w5b-privacy-${process.pid}-${Date.now()}` }));
const HANDOFF_DIR = join(tmpdir(), hoisted.dirName);
vi.mock('../../handoff/protocol.js', async (orig) => {
  const actual = await orig<typeof import('../../handoff/protocol.js')>();
  const os = await import('node:os');
  const path = await import('node:path');
  const fs = await import('node:fs/promises');
  const dir = path.join(os.tmpdir(), hoisted.dirName);
  await fs.mkdir(dir, { recursive: true });
  return {
    ...actual,
    writeInbox: async (m: string, k: string, body: string) => { const p = path.join(dir, `${m}-${k}.inbox.md`); await fs.writeFile(p, body); return p; },
    outboxPath: (m: string, k: string) => path.join(dir, `${m}-${k}.json`),
    errorPath: (m: string, k: string) => path.join(dir, `${m}-${k}.errors.json`),
    rawAttemptPath: (m: string, k: string, a: number) => path.join(dir, `${m}-${k}.attempt${a}.raw.txt`),
  };
});

const schema = z.object({ ok: z.literal(true) });
const spec = { manuscriptId: 'm1', key: 'review-ch1' as const, skillName: 'script_review' as const, promptMd: 'p', grammarSchema: schema, validationSchema: schema };
let server: Server | null = null;
const rawBodies: string[] = [];
let consoleSpies: Array<ReturnType<typeof vi.spyOn>> = [];
const savedGeminiEnvKey = process.env.GEMINI_API_KEY;

async function startServer(handler: (raw: string, n: number) => { status: number; type: string; body: string }): Promise<string> {
  server = createServer((r, res) => {
    let raw = '';
    r.on('data', (c) => (raw += c));
    r.on('end', () => {
      rawBodies.push(raw);
      const out = handler(raw, rawBodies.length);
      res.writeHead(out.status, { 'Content-Type': out.type });
      res.end(out.body);
    });
  });
  await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
  return `http://127.0.0.1:${(server!.address() as AddressInfo).port}`;
}
const dispatcher = () => new Agent({ headersTimeout: 0, bodyTimeout: 0, connect: { timeout: 10_000 } });
const ollamaText = (content: string) =>
  JSON.stringify({ message: { role: 'assistant', content }, done: false }) + '\n' +
  JSON.stringify({ message: { role: 'assistant', content: '' }, done: true, done_reason: 'stop' }) + '\n';

function everythingLogged(): string {
  return consoleSpies
    .flatMap((s) => s.mock.calls as unknown[][])
    .map((args) => args.map((a) => (a instanceof Error ? `${a.message}\n${a.stack}` : typeof a === 'string' ? a : JSON.stringify(a))).join(' '))
    .join('\n');
}
function everythingPersisted(): string {
  return readdirSync(HANDOFF_DIR).map((f) => readFileSync(join(HANDOFF_DIR, f), 'utf8')).join('\n');
}
const runnerFor = (transport: ChatTransport, policy = OLLAMA_RETRY_POLICY, extraParams: Record<string, unknown>) =>
  new StageRunner({
    transport, policy,
    settings: () => ({ structuredOutput: 'json', maxOutputTokens: undefined, reasoning: undefined, extraParams }),
    adaptSchema: (s) => ({ schema: s, dropped: [] }),
  });

beforeAll(() => { process.env.CASTWRIGHT_VRAM_SAMPLE = '0'; });
beforeEach(() => {
  delete process.env.GEMINI_API_KEY;
  rawBodies.length = 0;
  _resetUserSettingsCache();
  geminiRateLimiter._reset();
  rmSync(HANDOFF_DIR, { recursive: true, force: true });
  /* The mock created this directory once, at import. Recreate it per test, or a stage case fails in
     writeInbox (ENOENT) before it ever reaches the transport it is meant to exercise. */
  mkdirSync(HANDOFF_DIR, { recursive: true });
  consoleSpies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => {}));
});
afterEach(async () => {
  consoleSpies.forEach((s) => s.mockRestore());
  _resetUserSettingsCache();
  if (savedGeminiEnvKey === undefined) delete process.env.GEMINI_API_KEY;
  else process.env.GEMINI_API_KEY = savedGeminiEnvKey;
  if (server) { server.closeAllConnections(); await new Promise<void>((r) => server!.close(() => r())); server = null; }
});

describe('the custom payload is never logged or persisted', () => {
  it('a stage with a validation retry sends the payload but writes and logs none of it', async () => {
    const url = await startServer((_raw, n) => ({ status: 200, type: 'application/x-ndjson', body: ollamaText(n === 1 ? 'not json' : '{"ok":true}') }));
    const payload = { user_tag: SENTINEL, options: { note: SENTINEL } };
    await runnerFor(new OllamaTransport({ url, model: 'q:4b', dispatcher: dispatcher() }), OLLAMA_RETRY_POLICY, payload).runStage(spec, {});
    expect(rawBodies.every((b) => b.includes(SENTINEL))).toBe(true); // the payload really was on the wire
    expect(readdirSync(HANDOFF_DIR).length).toBeGreaterThan(0); // inbox, raw attempt, errors and response were written
    expect(everythingPersisted()).not.toContain(SENTINEL);
    expect(everythingLogged()).not.toContain(SENTINEL);
  });

  it('Ollama: a 400 that echoes the request is redacted in the error, the log, and the failure copy', async () => {
    /* The echo omits `messages`: the runner's system turn is the 6.8 KB skill, which would push the payload past
       the 500-character excerpt and make every assertion below vacuous. */
    let echoed = '';
    const url = await startServer((raw) => {
      const body = JSON.parse(raw) as Record<string, unknown>;
      delete body.messages;
      echoed = `invalid options in ${JSON.stringify(body)}`;
      return { status: 400, type: 'application/json', body: JSON.stringify({ error: echoed }) };
    });
    const payload = { user_tag: SENTINEL };
    const err = await runnerFor(new OllamaTransport({ url, model: 'q:4b', dispatcher: dispatcher() }), OLLAMA_RETRY_POLICY, payload)
      .runStage(spec, {})
      .catch((e: unknown) => e);
    /* Precondition: the value really sits inside the excerpt window, so the assertions below can fail. */
    expect(echoed.indexOf(SENTINEL)).toBeGreaterThan(-1);
    expect(echoed.indexOf(SENTINEL)).toBeLessThan(450);
    expect(err).toBeInstanceOf(AnalyzerHttpError);
    expect((err as AnalyzerHttpError).message).not.toContain(SENTINEL);
    expect((err as AnalyzerHttpError).bodyExcerpt).not.toContain(SENTINEL);
    expect((err as AnalyzerHttpError).message).toContain(REDACTED);
    const failure = classifyAnalysisFailure(err, 'Ollama (q:4b)');
    expect(`${failure.userMessage}\n${failure.detail ?? ''}`).not.toContain(SENTINEL);
    expect(everythingLogged()).not.toContain(SENTINEL);
  });

  it('Ollama persona (free-text) call: a 400 that echoes the request is redacted', async () => {
    const url = await startServer((raw) => ({ status: 400, type: 'application/json', body: JSON.stringify({ error: `invalid options in ${raw}` }) }));
    const req: TransportRequest = {
      system: '', messages: [{ role: 'user', content: 'persona please' }], structuredOutput: { mode: 'off' },
      temperature: 0.2, extraParams: { user_tag: SENTINEL }, estimatedInputTokens: 5, call: {}, freeText: { onCpu: false, keepAlive: 0 },
    };
    const err = await new OllamaTransport({ url, model: 'q:4b', dispatcher: dispatcher() }).send(req).catch((e: unknown) => e);
    expect(rawBodies[0]).toContain(SENTINEL);
    expect(err).toBeInstanceOf(AnalyzerHttpError);
    expect(`${(err as AnalyzerHttpError).message}\n${(err as AnalyzerHttpError).bodyExcerpt}`).not.toContain(SENTINEL);
    expect((err as AnalyzerHttpError).message).toContain(REDACTED);
    expect(everythingLogged()).not.toContain(SENTINEL);
  });

  it("Ollama in-stream error: the daemon's echo is redacted against the payload AND the saved secrets (P22, P29)", async () => {
    const SAVED = 'AIzaSy-privacy-saved-secret-1';
    _setUserSettingsCacheForTest({ geminiApiKey: SAVED });
    /* An error line inside an open 200 stream, echoing the request body and a saved key. */
    const url = await startServer((raw) => ({
      status: 200,
      type: 'application/x-ndjson',
      body: `${JSON.stringify({ error: `bad options ${raw} for key ${SAVED}` })}\n`,
    }));
    const req: TransportRequest = {
      system: 's', messages: [{ role: 'user', content: 'p' }], structuredOutput: { mode: 'json' },
      temperature: 0.2, extraParams: { user_tag: SENTINEL }, estimatedInputTokens: 5, call: {},
    };
    const err = await new OllamaTransport({ url, model: 'q:4b', dispatcher: dispatcher() }).send(req).catch((e: unknown) => e);
    expect((err as Error).message).toContain('stream error:');
    expect((err as Error).message).not.toContain(SENTINEL); // this task adds the payload values
    expect((err as Error).message).not.toContain(SAVED); // PR 3b's known secrets are still redacted
    expect((err as Error).message).toContain(REDACTED);
    expect(everythingLogged()).not.toContain(SENTINEL);
  });

  it('Gemini: the SDK error is rebuilt with a redacted message AND stack before it is logged or rethrown', async () => {
    const client = {
      models: {
        generateContentStream: vi.fn(async () => {
          throw new ApiError({
            status: 400,
            message: `got status: 400 INVALID_ARGUMENT. {"error":{"code":400,"message":"Invalid value at 'safety_settings[0].category' (${SENTINEL})","status":"INVALID_ARGUMENT"}}`,
          });
        }),
      },
    } as unknown as GoogleGenAI;
    const req: TransportRequest = {
      system: 's', messages: [{ role: 'user', content: 'p' }], structuredOutput: { mode: 'json' }, temperature: 0.2,
      extraParams: { config: { safetySettings: [{ category: SENTINEL, threshold: 'BLOCK_NONE' }] } }, estimatedInputTokens: 5, call: {},
    };
    const err = await new GeminiTransport({ apiKey: 'k', model: 'gemini-3.6-flash', client }).send(req).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError); // W3b's redactGeminiError rebuilds an ApiError as an ApiError
    expect((err as { status?: number }).status).toBe(400); // the retry classifier and the taxonomy still read it
    expect((err as Error).message).not.toContain(SENTINEL);
    expect((err as Error).message).toContain(REDACTED);
    expect((err as Error).stack ?? '').not.toContain(SENTINEL);
    expect(everythingLogged()).not.toContain(SENTINEL);
  });

  it("a Gemini error from a payload-carrying request stays redacted through classifyAnalysisFailure's envelope detail", async () => {
    const client = {
      models: {
        generateContentStream: vi.fn(async () => {
          throw new ApiError({
            status: 400,
            message: `got status: 400 INVALID_ARGUMENT. {"error":{"code":400,"message":"bad","status":"INVALID_ARGUMENT","details":[{"note":"${SENTINEL}"}]}}`,
          });
        }),
      },
    } as unknown as GoogleGenAI;
    const req: TransportRequest = {
      system: 's', messages: [{ role: 'user', content: 'p' }], structuredOutput: { mode: 'json' }, temperature: 0.2,
      extraParams: { config: { safetySettings: [{ category: SENTINEL, threshold: 'BLOCK_NONE' }] } }, estimatedInputTokens: 5, call: {},
    };
    const err = await new GeminiTransport({ apiKey: 'k', model: 'gemini-3.6-flash', client }).send(req).catch((e: unknown) => e);
    const failure = classifyAnalysisFailure(err, 'Gemini 3.6 Flash');
    expect(`${failure.userMessage}\n${failure.detail ?? ''}`).not.toContain(SENTINEL);
  });

  it('OpenAI-compatible: a 400 naming the parameter value is redacted', async () => {
    const base = await startServer(() => ({
      status: 400, type: 'application/json',
      body: JSON.stringify({ error: { message: `unsupported parameter user_tag=${SENTINEL}`, type: 'invalid_request_error' } }),
    }));
    const endpoint = analyzerEndpointSchema.parse({ id: 'lab', name: 'Lab', baseUrl: `${base}/v1`, gpu: 'none', contextTokens: 32768, extraParams: { user_tag: SENTINEL } });
    /* No saved settings: this request's payload values join the attempt's secrets (P29), which W3b's
       classifyOpenAIOutcome applies to the excerpt, the causeCode and rule 7's rebuild alike. */
    const req: TransportRequest = { system: 's', messages: [{ role: 'user', content: 'p' }], structuredOutput: { mode: 'json' }, temperature: 0.2, extraParams: { user_tag: SENTINEL }, estimatedInputTokens: 5, call: {} };
    const err = await new OpenAITransport({ endpoint, apiKey: null, model: 'm', dispatcher: dispatcher() }).send(req).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AnalyzerHttpError);
    expect(`${(err as AnalyzerHttpError).message}\n${(err as AnalyzerHttpError).bodyExcerpt}`).not.toContain(SENTINEL);
    expect(everythingLogged()).not.toContain(SENTINEL);
  });

  it('OpenAI-compatible: a value straddling the 500-character excerpt cut leaves no fragment', async () => {
    const LONG = `cw-straddle-${'x'.repeat(40)}`;
    const base = await startServer(() => ({
      status: 400, type: 'application/json',
      body: JSON.stringify({ error: { message: `${'p'.repeat(470)}${LONG}`, type: 'invalid_request_error' } }),
    }));
    const endpoint = analyzerEndpointSchema.parse({ id: 'lab', name: 'Lab', baseUrl: `${base}/v1`, gpu: 'none', contextTokens: 32768, extraParams: { user_tag: LONG } });
    /* This request's payload feeds the attempt's secrets, which classifyOpenAIOutcome applies to the whole body before it slices. */
    const req: TransportRequest = { system: 's', messages: [{ role: 'user', content: 'p' }], structuredOutput: { mode: 'json' }, temperature: 0.2, extraParams: { user_tag: LONG }, estimatedInputTokens: 5, call: {} };
    const err = await new OpenAITransport({ endpoint, apiKey: null, model: 'm', dispatcher: dispatcher() }).send(req).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AnalyzerHttpError);
    /* Sliced first, the excerpt ends inside the value, and a partial value matches no redaction. */
    expect(`${(err as AnalyzerHttpError).message}\n${(err as AnalyzerHttpError).bodyExcerpt}`).not.toContain('cw-');
  });

  it("payload values are redacted only from their own request's errors: BLOCK_NONE stays in an unrelated engine's error (N15, P29)", async () => {
    _setUserSettingsCacheForTest({
      analyzerExtraParamsByEngine: { gemini: { config: { safetySettings: [{ category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_NONE' }] } } },
    });
    expect(knownAnalyzerSecrets()).not.toContain('BLOCK_NONE');
    const url = await startServer(() => ({ status: 400, type: 'application/json', body: JSON.stringify({ error: 'unsupported safety threshold BLOCK_NONE' }) }));
    const req: TransportRequest = {
      system: 's', messages: [{ role: 'user', content: 'p' }], structuredOutput: { mode: 'json' }, temperature: 0.2, estimatedInputTokens: 5, call: {},
    };
    const err = await new OllamaTransport({ url, model: 'q:4b', dispatcher: dispatcher() }).send(req).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AnalyzerHttpError);
    expect((err as AnalyzerHttpError).message).toContain('BLOCK_NONE');
    expect((err as AnalyzerHttpError).message).not.toContain(REDACTED);
  });
});
