/* #3084 wave 5b (N13, 5b-D1/D3) — the shared runner stamps the payload's output-cap key (and whether
   that key's own value removes the cap) on AnalyzerReasoningOverflowError AT THE THROW SITE, from the
   payload the overflowing request actually sent. Modelled on stage-runner.reasoning-overflow-level.test.ts:
   the fake transport only returns a fixed overflowing TransportResult, whatever its kind. */
import { describe, it, expect, vi } from 'vitest';
import { StageRunner } from './stage-runner.js';
import { OLLAMA_RETRY_POLICY } from './retry-policy.js';
import { AnalyzerReasoningOverflowError } from '../errors.js';
import type { ChatTransport, TransportRequest, TransportResult } from './transport.js';
import { z } from 'zod';

const hoisted = vi.hoisted(() => ({ dirName: `castwright-w5b-capstamp-${process.pid}-${Date.now()}` }));
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

const OVERFLOW: TransportResult = { text: '', reasoningSeen: true, finish: 'length', receivedBytes: 0, usage: { reasoningTokens: 900 } };
const schema = z.object({ ok: z.literal(true) });
const stageSpec = { manuscriptId: 'm1', key: '1-ch1' as const, skillName: 'whole_book_stage1' as const, promptMd: 'p', grammarSchema: schema, validationSchema: schema };

function fakeTransport(kind: 'ollama' | 'gemini' | 'openai'): ChatTransport {
  return {
    kind,
    model: `${kind}-model`,
    async send(_req: TransportRequest): Promise<TransportResult> {
      return OVERFLOW;
    },
  };
}

const CAP: Record<'ollama' | 'gemini' | 'openai', [Record<string, unknown>, string]> = {
  ollama: [{ options: { num_predict: 512 } }, 'options.num_predict'],
  gemini: [{ config: { maxOutputTokens: 2048 } }, 'config.maxOutputTokens'],
  openai: [{ max_completion_tokens: 4096 }, 'max_completion_tokens'],
};
const runnerFor = (kind: 'ollama' | 'gemini' | 'openai', extraParams: Record<string, unknown> | undefined) =>
  new StageRunner({
    transport: fakeTransport(kind),
    policy: OLLAMA_RETRY_POLICY,
    settings: () => ({ structuredOutput: 'json', maxOutputTokens: undefined, extraParams }),
    adaptSchema: (s) => ({ schema: s, dropped: [] }),
  });

describe.each(['ollama', 'gemini', 'openai'] as const)('%s: the overflow error carries the payload cap key (5b-D1)', (kind) => {
  it('runStage: the key of the cap the payload set', async () => {
    const [payload, key] = CAP[kind];
    const err = await runnerFor(kind, payload).runStage(stageSpec, {}).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AnalyzerReasoningOverflowError);
    expect((err as AnalyzerReasoningOverflowError).payloadCapKey).toBe(key);
    expect((err as AnalyzerReasoningOverflowError).payloadCapRemoved).toBe(false);
  });
  it('runStage: a payload that sets no cap stamps no key', async () => {
    const err = await runnerFor(kind, { top_k: 1 }).runStage(stageSpec, {}).catch((e: unknown) => e);
    expect((err as AnalyzerReasoningOverflowError).payloadCapKey).toBeUndefined();
  });
});

it.each<[string, 'ollama' | 'openai', Record<string, unknown>, string]>([
  ['null', 'openai', { max_tokens: null }, 'max_tokens'],
  ['-1', 'ollama', { options: { num_predict: -1 } }, 'options.num_predict'],
])('a cap value of %s is stamped as removed (5b-D3)', async (_v, kind, payload, key) => {
  const err = await runnerFor(kind, payload).runStage(stageSpec, {}).catch((e: unknown) => e);
  expect((err as AnalyzerReasoningOverflowError).payloadCapKey).toBe(key);
  expect((err as AnalyzerReasoningOverflowError).payloadCapRemoved).toBe(true);
});

it('any other non-cap value (here 0) is not "removed": the copy keeps "Raise" (5b-D3, narrowed)', async () => {
  const err = await runnerFor('openai', { max_tokens: 0 }).runStage(stageSpec, {}).catch((e: unknown) => e);
  expect((err as AnalyzerReasoningOverflowError).payloadCapKey).toBe('max_tokens');
  expect((err as AnalyzerReasoningOverflowError).payloadCapRemoved).toBe(false);
});
