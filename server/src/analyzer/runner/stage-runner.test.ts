import { describe, it, expect, vi, afterAll } from 'vitest';
import { existsSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { StageRunner, identitySchemaAdapter, type EngineRequestSettings, type SchemaAdapter } from './stage-runner.js';
import { GEMINI_RETRY_POLICY, OLLAMA_RETRY_POLICY, type ValidationRetryPolicy } from './retry-policy.js';
import type { ChatTransport, TransportRequest, TransportResult } from './transport.js';
import { AnalysisAbortedError } from '../errors.js';

const HANDOFF_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'handoff');
const IDS = ['m_sr_first', 'm_sr_json', 'm_sr_retry', 'm_sr_noraw', 'm_sr_raw', 'm_sr_single', 'm_sr_cap'];

class FakeTransport implements ChatTransport {
  readonly kind = 'ollama' as const;
  readonly model = 'fake:1';
  readonly requests: TransportRequest[] = [];
  constructor(private readonly replies: Array<string | Error>) {}
  async send(req: TransportRequest): Promise<TransportResult> {
    this.requests.push(req);
    const next = this.replies.shift();
    if (next === undefined) throw new Error('no scripted reply');
    if (next instanceof Error) throw next;
    return { text: next, reasoningSeen: false, finish: 'stop', receivedBytes: next.length };
  }
}

const schema = z.object({ a: z.string() });
const SCHEMA_MODE: EngineRequestSettings = { structuredOutput: 'schema', maxOutputTokens: undefined };
const JSON_MODE: EngineRequestSettings = { structuredOutput: 'json', maxOutputTokens: undefined };
function makeRunner(
  transport: ChatTransport,
  policy: ValidationRetryPolicy = OLLAMA_RETRY_POLICY,
  settings: EngineRequestSettings = SCHEMA_MODE,
  adaptSchema: SchemaAdapter = identitySchemaAdapter,
) {
  return new StageRunner({ transport, policy, settings: () => settings, adaptSchema });
}
const spec = (manuscriptId: string) => ({
  manuscriptId,
  key: '1-ch1' as const,
  skillName: 'whole_book_stage1' as const,
  promptMd: '# p',
  grammarSchema: schema,
  validationSchema: schema,
});
const outbox = (id: string, suffix: string) => resolve(HANDOFF_ROOT, 'outbox', `${id}-stage1-ch1${suffix}`);

afterAll(async () => {
  for (const id of IDS) {
    for (const key of ['stage1-ch1', 'stageescalation-ch1-w0']) {
      await rm(resolve(HANDOFF_ROOT, 'inbox', `${id}-${key}.md`), { force: true });
      for (const s of ['.json', '.errors.json', '.attempt1.raw.txt', '.attempt2.raw.txt']) {
        await rm(resolve(HANDOFF_ROOT, 'outbox', `${id}-${key}${s}`), { force: true });
      }
    }
  }
});


describe('StageRunner (#3084 wave 1)', () => {
  it('first attempt: skill system instruction, one user turn, policy temperature, adapted schema, full call hooks', async () => {
    const t = new FakeTransport(['{"a":"ok"}']);
    const adapt = vi.fn((s: Record<string, unknown>) => ({ schema: { adapted: true, from: s.type }, dropped: [] }));
    const onEvalTiming = vi.fn();
    const onChunk = vi.fn();
    const out = await makeRunner(t, OLLAMA_RETRY_POLICY, SCHEMA_MODE, adapt).runStage(spec('m_sr_first'), { onEvalTiming, onChunk });
    expect(out).toEqual({ a: 'ok' });
    const req = t.requests[0];
    expect(req.system).toMatch(/# SKILL/);
    expect(req.messages).toEqual([{ role: 'user', content: '# p' }]);
    expect(req.temperature).toBe(OLLAMA_RETRY_POLICY.initialTemperature());
    expect(req.structuredOutput).toMatchObject({ mode: 'schema', schema: { adapted: true, from: 'object' } });
    expect(adapt).toHaveBeenCalledTimes(1);
    expect(req.call.onEvalTiming).toBe(onEvalTiming);
    expect(req.call.onChunk).toBe(onChunk);
    expect(existsSync(outbox('m_sr_first', '.json'))).toBe(true);
  });

  it('an adapter that drops keys logs them — pr-review-gate pass 1 finding 7 (dropped was computed and discarded)', async () => {
    const t = new FakeTransport(['{"a":"ok"}']);
    const adapt = vi.fn((s: Record<string, unknown>) => ({ schema: { adapted: true, from: s.type }, dropped: ['additionalProperties', 'minLength'] }));
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await makeRunner(t, OLLAMA_RETRY_POLICY, SCHEMA_MODE, adapt).runStage(spec('m_sr_dropped'), {});
      expect(warnSpy).toHaveBeenCalledWith('[ollama] fake:1 1-ch1 schema adapter dropped: additionalProperties, minLength');
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('identitySchemaAdapter drops nothing — no warning', async () => {
    const t = new FakeTransport(['{"a":"ok"}']);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await makeRunner(t, OLLAMA_RETRY_POLICY, SCHEMA_MODE, identitySchemaAdapter).runStage(spec('m_sr_nodrop'), {});
      expect(warnSpy).not.toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('json mode sends { mode: "json" } and never builds a schema', async () => {
    const t = new FakeTransport(['{"a":"ok"}']);
    const adapt = vi.fn(identitySchemaAdapter);
    await makeRunner(t, GEMINI_RETRY_POLICY, JSON_MODE, adapt).runStage(spec('m_sr_json'), {});
    expect(t.requests[0].structuredOutput).toEqual({ mode: 'json' });
    expect(adapt).not.toHaveBeenCalled();
  });

  it('the retry uses exactly what policy.buildRetry returns, with the same system and structured output', async () => {
    const t = new FakeTransport(['{"a":1}', '{"a":"fixed"}']);
    const buildRetry = vi.fn(() => ({ messages: [{ role: 'user' as const, content: 'RETRY' }], temperature: 0.9 }));
    const policy: ValidationRetryPolicy = { ...GEMINI_RETRY_POLICY, buildRetry };
    const out = await makeRunner(t, policy, JSON_MODE).runStage(spec('m_sr_retry'), {});
    expect(out).toEqual({ a: 'fixed' });
    expect(buildRetry).toHaveBeenCalledWith(
      expect.objectContaining({ messages: [{ role: 'user', content: '# p' }], firstRaw: '{"a":1}', failure: expect.objectContaining({ kind: 'schema-validation' }) }),
    );
    expect(t.requests[1].messages).toEqual([{ role: 'user', content: 'RETRY' }]);
    expect(t.requests[1].temperature).toBe(0.9);
    expect(t.requests[1].system).toBe(t.requests[0].system);
    expect(t.requests[1].structuredOutput).toEqual(t.requests[0].structuredOutput);
  });

  it('writesRawAttempts=false writes errors.json only, and throws the policy message', async () => {
    const t = new FakeTransport(['{"a":1}', '{"a":2}']);
    const err = await makeRunner(t, GEMINI_RETRY_POLICY, JSON_MODE).runStage(spec('m_sr_noraw'), {}).then(() => null, (e: Error) => e);
    expect(err?.message.startsWith('Gemini 1-ch1 failed validation after retry: schema-validation — ')).toBe(true);
    expect(existsSync(outbox('m_sr_noraw', '.errors.json'))).toBe(true);
    expect(existsSync(outbox('m_sr_noraw', '.attempt1.raw.txt'))).toBe(false);
    expect(existsSync(outbox('m_sr_noraw', '.attempt2.raw.txt'))).toBe(false);
  });

  it('writesRawAttempts=true writes both raw attempts', async () => {
    const t = new FakeTransport(['{"a":1}', '{"a":2}']);
    await makeRunner(t).runStage(spec('m_sr_raw'), {}).catch(() => undefined);
    expect(existsSync(outbox('m_sr_raw', '.attempt1.raw.txt'))).toBe(true);
    expect(existsSync(outbox('m_sr_raw', '.attempt2.raw.txt'))).toBe(true);
  });

  it('single attempt: empty system, no onEvalTiming, null on failure, policy decides what rethrows', async () => {
    const single = (id: string) => ({ manuscriptId: id, key: 'escalation-ch1-w0' as const, promptMd: 'p', grammarSchema: schema, validationSchema: schema });
    const ok = new FakeTransport(['{"a":"x"}']);
    expect(await makeRunner(ok).runSingleAttempt(single('m_sr_single'), { onEvalTiming: vi.fn() })).toEqual({ a: 'x' });
    expect(ok.requests[0].system).toBe('');
    expect(ok.requests[0].call.onEvalTiming).toBeUndefined();
    expect(await makeRunner(new FakeTransport([new Error('boom')])).runSingleAttempt(single('m_sr_single'), {})).toBeNull();
    expect(await makeRunner(new FakeTransport(['not json'])).runSingleAttempt(single('m_sr_single'), {})).toBeNull();
    await expect(
      makeRunner(new FakeTransport([new AnalysisAbortedError('gone')])).runSingleAttempt(single('m_sr_single'), {}),
    ).rejects.toBeInstanceOf(AnalysisAbortedError);
  });

  it('forwards settings().maxOutputTokens to the transport', async () => {
    const t = new FakeTransport(['{"a":"ok"}']);
    await makeRunner(t, GEMINI_RETRY_POLICY, { structuredOutput: 'json', maxOutputTokens: 1234 }).runStage(spec('m_sr_cap'), {});
    expect(t.requests[0].maxOutputTokens).toBe(1234);
  });
});
