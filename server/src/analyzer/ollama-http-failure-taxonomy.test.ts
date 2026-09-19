/* #3084 wave 1 — pins how a non-OK Ollama response classifies at the run level,
   captured from main BEFORE the plain Error at ollama.ts:710-717 became
   AnalyzerHttpError. The snapshots are the contract: the swap must not move
   any of them (spec §1 "Typed HTTP errors"; plan-29 rule, index.ts:250-255). */
import { describe, it, expect, vi, afterAll } from 'vitest';
import { rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HANDOFF_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'handoff');

const { fetchMock } = vi.hoisted(() => ({ fetchMock: vi.fn() }));
vi.mock('undici', async (importOriginal) => {
  const actual = await importOriginal<typeof import('undici')>();
  return { ...actual, fetch: fetchMock };
});

async function classifyOllamaHttp(status: number, statusText: string, body: string) {
  fetchMock.mockReset();
  fetchMock.mockResolvedValueOnce(new Response(body, { status, statusText }));
  const { OllamaAnalyzer, LocalUnreachableError } = await import('./ollama.js');
  const { classifyAnalysisFailure } = await import('../routes/failure-taxonomy.js');
  const err = await new OllamaAnalyzer({ url: 'http://localhost:11434', model: 'qwen3.5:9b' })
    .runStage1Chapter(`m_ollama_http_${status}`, 1, '# p', {})
    .then(() => null, (e: unknown) => e);
  expect(err).not.toBeNull();
  expect(err).not.toBeInstanceOf(LocalUnreachableError);
  const r = classifyAnalysisFailure(err, 'Ollama (qwen3.5:9b)');
  return { err: err as Error, outcome: { code: r.code, userMessage: r.userMessage, detail: r.detail } };
}

afterAll(async () => {
  for (const s of [400, 404, 500, 503]) {
    await rm(resolve(HANDOFF_ROOT, 'inbox', `m_ollama_http_${s}-stage1-ch1.md`), { force: true });
  }
});

describe('Ollama non-OK responses → classifyAnalysisFailure (captured from main)', () => {
  it('400 invalid format', async () => {
    const { outcome } = await classifyOllamaHttp(400, 'Bad Request', '{"error":"invalid format: expected \\"json\\" or a valid JSON schema"}');
    expect(outcome).toMatchInlineSnapshot(`
      {
        "code": "unknown",
        "detail": undefined,
        "userMessage": "Ollama http://localhost:11434 returned 400 Bad Request: {"error":"invalid format: expected \\"json\\" or a valid JSON schema"}",
      }
    `);
  });
  it('404 model not found', async () => {
    const { outcome } = await classifyOllamaHttp(404, 'Not Found', '{"error":"model \\"qwen3.5:9b\\" not found, try pulling it first"}');
    expect(outcome).toMatchInlineSnapshot(`
      {
        "code": "unknown",
        "detail": undefined,
        "userMessage": "Ollama http://localhost:11434 returned 404 Not Found: {"error":"model \\"qwen3.5:9b\\" not found, try pulling it first"}",
      }
    `);
  });
  it('500 runner terminated', async () => {
    const { outcome } = await classifyOllamaHttp(500, 'Internal Server Error', '{"error":"llama runner process has terminated: exit status 2"}');
    expect(outcome).toMatchInlineSnapshot(`
      {
        "code": "unknown",
        "detail": undefined,
        "userMessage": "Ollama http://localhost:11434 returned 500 Internal Server Error: {"error":"llama runner process has terminated: exit status 2"}",
      }
    `);
  });
  it('503 server busy', async () => {
    const { outcome } = await classifyOllamaHttp(503, 'Service Unavailable', '{"error":"server busy, please try again.  maximum pending requests exceeded"}');
    expect(outcome).toMatchInlineSnapshot(`
      {
        "code": "unknown",
        "detail": undefined,
        "userMessage": "Ollama http://localhost:11434 returned 503 Service Unavailable: {"error":"server busy, please try again.  maximum pending requests exceeded"}",
      }
    `);
  });
  it.each([
    [400, 'Bad Request'],
    [404, 'Not Found'],
    [500, 'Internal Server Error'],
    [503, 'Service Unavailable'],
  ] as const)('%i surfaces as AnalyzerHttpError with the unchanged message and no status', async (status, statusText) => {
    const body = '{"error":"boom"}';
    const { err } = await classifyOllamaHttp(status, statusText, body);
    const { AnalyzerHttpError } = await import('./errors.js');
    expect(err).toBeInstanceOf(AnalyzerHttpError);
    const typed = err as InstanceType<typeof AnalyzerHttpError>;
    expect(typed.httpStatus).toBe(status);
    expect(typed.bodyExcerpt).toBe(body);
    expect(typed.transport).toBe('ollama');
    expect('status' in err).toBe(false);
    expect(err.message).toBe(`Ollama http://localhost:11434 returned ${status} ${statusText}: ${body}`);
  });
});
