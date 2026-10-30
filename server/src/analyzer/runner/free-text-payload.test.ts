/* #3084 wave 5 (A4) — a persona request carries the engine's payload, minus the keys that set the
   output cap: a cap chosen for chapter work must not shorten a voice description. P19 keeps every
   other key, and the stage path (the control below) keeps the cap. */
import { describe, it, expect, vi } from 'vitest';
import { z } from 'zod';
import { StageRunner } from './stage-runner.js';
import { OLLAMA_RETRY_POLICY } from './retry-policy.js';
import { withoutPayloadOutputCap } from './extra-params.js';
import type { TransportKind } from '../errors.js';
import type { ChatTransport, TransportRequest, TransportResult } from './transport.js';

const hoisted = vi.hoisted(() => ({ dirName: `castwright-w5b-freetext-${process.pid}-${Date.now()}` }));
vi.mock('../../handoff/protocol.js', async (orig) => {
  const actual = await orig<typeof import('../../handoff/protocol.js')>();
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { mkdir, writeFile } = await import('node:fs/promises');
  const dir = join(tmpdir(), hoisted.dirName);
  await mkdir(dir, { recursive: true });
  return {
    ...actual,
    writeInbox: async (m: string, k: string, body: string) => { const p = join(dir, `${m}-${k}.inbox.md`); await writeFile(p, body); return p; },
    outboxPath: (m: string, k: string) => join(dir, `${m}-${k}.json`),
    errorPath: (m: string, k: string) => join(dir, `${m}-${k}.errors.json`),
    rawAttemptPath: (m: string, k: string, a: number) => join(dir, `${m}-${k}.attempt${a}.raw.txt`),
  };
});

class Recording implements ChatTransport {
  readonly requests: TransportRequest[] = [];
  constructor(readonly kind: TransportKind, readonly model = 'm') {}
  async send(req: TransportRequest): Promise<TransportResult> {
    this.requests.push(req);
    return { text: 'A warm voice.', reasoningSeen: false, finish: 'stop', receivedBytes: 13 };
  }
}
const runnerFor = (transport: ChatTransport, extraParams: Record<string, unknown>) =>
  new StageRunner({
    transport,
    policy: OLLAMA_RETRY_POLICY,
    settings: () => ({ structuredOutput: 'off', maxOutputTokens: 4096, extraParams }),
    adaptSchema: (s) => ({ schema: s, dropped: [] }),
  });

describe('withoutPayloadOutputCap', () => {
  it('drops every cap key of that kind and nothing else', () => {
    expect(withoutPayloadOutputCap('openai', { max_tokens: 64, max_completion_tokens: 64, n_predict: 64, top_k: 20 })).toEqual({ top_k: 20 });
    expect(withoutPayloadOutputCap('ollama', { top_k: 40, options: { num_predict: 64, min_p: 0.05 } })).toEqual({ top_k: 40, options: { min_p: 0.05 } });
    expect(withoutPayloadOutputCap('gemini', { config: { maxOutputTokens: 64, topK: 40 } })).toEqual({ config: { topK: 40 } });
    /* A cap the payload removes (`null`) is a cap key too. */
    expect(withoutPayloadOutputCap('openai', { max_tokens: null, top_k: 20 })).toEqual({ top_k: 20 });
  });
  it('returns the same object when the payload sets no cap, and undefined for none', () => {
    const params = { top_k: 20 };
    expect(withoutPayloadOutputCap('openai', params)).toBe(params);
    expect(withoutPayloadOutputCap('ollama', undefined)).toBeUndefined();
  });
});

describe('runFreeText and the payload output cap (A4)', () => {
  it('sends the payload without its cap keys, and still no engine output cap of its own', async () => {
    const transport = new Recording('ollama');
    await runnerFor(transport, { top_k: 40, options: { num_predict: 64, min_p: 0.05 } }).runFreeText({ prompt: 'persona please' });
    expect(transport.requests[0].extraParams).toEqual({ top_k: 40, options: { min_p: 0.05 } });
    expect(transport.requests[0].maxOutputTokens).toBeUndefined();
  });

  it('the escalation single attempt keeps the payload cap (CONTROL: only free text strips it)', async () => {
    const transport = new Recording('ollama');
    const schema = z.object({ ok: z.literal(true) });
    await runnerFor(transport, { options: { num_predict: 64, min_p: 0.05 } }).runSingleAttempt(
      { manuscriptId: 'm1', key: 'escalation-ch1-w0', promptMd: 'p', grammarSchema: schema, validationSchema: schema },
      {},
    );
    expect((transport.requests[0].extraParams as { options: Record<string, unknown> }).options.num_predict).toBe(64);
  });
});
