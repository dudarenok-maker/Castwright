/* #3084 W4 — StageRunner.runFreeText (spec §10): one unstructured, single-attempt call.
   A fake transport records the request, so every field the persona path depends on is pinned. */
import { describe, it, expect } from 'vitest';
import { StageRunner } from './stage-runner.js';
import { OLLAMA_RETRY_POLICY } from './retry-policy.js';
import type { ChatTransport, TransportRequest, TransportResult } from './transport.js';
import { AnalyzerReasoningOverflowError, GeminiContentBlockedError } from '../errors.js';

class FakeTransport implements ChatTransport {
  readonly kind = 'openai' as const;
  readonly model = 'fake-model';
  readonly requests: TransportRequest[] = [];
  constructor(private readonly result: TransportResult) {}
  async send(req: TransportRequest): Promise<TransportResult> {
    this.requests.push(req);
    return this.result;
  }
}

function result(text: string, over: Partial<TransportResult> = {}): TransportResult {
  return { text, reasoningSeen: false, finish: 'stop', receivedBytes: text.length, ...over };
}

function runnerFor(r: TransportResult) {
  const transport = new FakeTransport(r);
  const runner = new StageRunner({
    transport,
    policy: OLLAMA_RETRY_POLICY,
    settings: () => ({ structuredOutput: 'schema', maxOutputTokens: 4096 }),
    adaptSchema: (s) => ({ schema: s, dropped: [] }),
  });
  return { transport, runner };
}

describe('StageRunner.runFreeText', () => {
  it('sends ONE unstructured request with no output cap, no temperature and the persona token estimate', async () => {
    const { transport, runner } = runnerFor(result('not json at all'));
    await expect(runner.runFreeText({ prompt: 'PROMPT' })).resolves.toBe('not json at all');
    expect(transport.requests).toHaveLength(1);
    const req = transport.requests[0];
    expect(req.system).toBe('');
    expect(req.messages).toEqual([{ role: 'user', content: 'PROMPT' }]);
    expect(req.structuredOutput).toEqual({ mode: 'off' });
    expect(req.maxOutputTokens).toBeUndefined(); // the engine's 4096 cap is NOT applied to free text
    expect(req.temperature).toBeUndefined();
    expect(req.freeText).toEqual({});
    expect(req.call).toEqual({});
    expect(req.estimatedInputTokens).toBe(Math.ceil('PROMPT'.length / 4) + 200);
  });

  it('counts the system text in the estimate and forwards it', async () => {
    const { transport, runner } = runnerFor(result('ok'));
    await runner.runFreeText({ system: 'SYS', prompt: 'PROMPT' });
    expect(transport.requests[0].system).toBe('SYS');
    expect(transport.requests[0].estimatedInputTokens).toBe(Math.ceil(('SYS'.length + 'PROMPT'.length) / 4) + 200);
  });

  it('forwards temperature and Ollama placement', async () => {
    const { transport, runner } = runnerFor(result('ok'));
    await runner.runFreeText({ prompt: 'P', temperature: 0.2, ollama: { onCpu: true, keepAlive: 300, absoluteMaxMs: 250 } });
    const req = transport.requests[0];
    expect(req.temperature).toBe(0.2);
    expect(req.freeText).toEqual({ onCpu: true, keepAlive: 300, absoluteMaxMs: 250 });
  });

  it('forwards a top-level absoluteMaxMs into req.freeText for every engine (the persona ceiling)', async () => {
    const { transport, runner } = runnerFor(result('ok'));
    await runner.runFreeText({ prompt: 'P', absoluteMaxMs: 250 });
    expect(transport.requests[0].freeText).toEqual({ absoluteMaxMs: 250 });
  });

  it('strips a leading <think> block from the answer', async () => {
    const { runner } = runnerFor(result('<think>plan the voice</think>A warm voice.'));
    await expect(runner.runFreeText({ prompt: 'P' })).resolves.toBe('A warm voice.');
  });

  it('returns an empty string for a clean stop with an unterminated <think> (the caller judges emptiness)', async () => {
    const { runner } = runnerFor(result('<think>still thinking'));
    await expect(runner.runFreeText({ prompt: 'P' })).resolves.toBe('');
  });

  it('returns the text of a length stop that has answer text (free text never splits)', async () => {
    const { runner } = runnerFor(result('A warm, low', { finish: 'length' }));
    await expect(runner.runFreeText({ prompt: 'P' })).resolves.toBe('A warm, low');
  });

  it('throws AnalyzerReasoningOverflowError for an empty length stop with reasoning tokens', async () => {
    const { runner } = runnerFor(result('', { finish: 'length', usage: { reasoningTokens: 900 } }));
    const err = await runner.runFreeText({ prompt: 'P' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AnalyzerReasoningOverflowError);
  });

  it('treats an unterminated <think> on a length stop as reasoning evidence', async () => {
    const { runner } = runnerFor(result('<think>and on and on', { finish: 'length' }));
    await expect(runner.runFreeText({ prompt: 'P' })).rejects.toBeInstanceOf(AnalyzerReasoningOverflowError);
  });

  it('throws GeminiContentBlockedError for a blocked response instead of returning empty text', async () => {
    const { runner } = runnerFor(result('', { finish: 'blocked', blockReason: 'SAFETY' }));
    const err = (await runner.runFreeText({ prompt: 'P' }).catch((e: unknown) => e)) as GeminiContentBlockedError;
    expect(err).toBeInstanceOf(GeminiContentBlockedError);
    expect(err.model).toBe('fake-model');
    expect(err.reason).toBe('SAFETY');
  });

  it('awaits the transport prepare(signal) with the caller signal before sending (Gemini catalog warm-up)', async () => {
    const order: string[] = [];
    let prepareSignal: AbortSignal | undefined;
    const transport: ChatTransport = {
      kind: 'gemini',
      model: 'fake-model',
      prepare: async (signal?: AbortSignal) => {
        prepareSignal = signal;
        await Promise.resolve();
        order.push('prepare');
      },
      send: async () => {
        order.push('send');
        return result('ok');
      },
    };
    const runner = new StageRunner({
      transport,
      policy: OLLAMA_RETRY_POLICY,
      settings: () => ({ structuredOutput: 'schema', maxOutputTokens: 4096 }),
      adaptSchema: (s) => ({ schema: s, dropped: [] }),
    });
    const ac = new AbortController();
    await runner.runFreeText({ prompt: 'P', signal: ac.signal });
    expect(order).toEqual(['prepare', 'send']);
    /* P26: a pause must be able to release a stalled warm-up, so the warm-up gets the caller's signal. */
    expect(prepareSignal).toBe(ac.signal);
  });
});
