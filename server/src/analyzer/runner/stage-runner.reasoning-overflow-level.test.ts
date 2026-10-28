/* #3084 wave 5 — proves the runner forwards settings.reasoning to the overflow error for every
   transport kind: AnalyzerReasoningOverflowError.reasoningLevel is set AT THE THROW SITE (mapFinish,
   inside StageRunner's private send, and runFreeText's own inline check), from the level the request
   actually carried — never re-derived from live settings later (that would race a setting the user
   changes between the overflow and when the failure renders, Task 5.5b). The transport-specific WIRE
   mapping (which literal Ollama/Gemini/OpenAI-compatible field each level becomes) is Task 5.3's job,
   not this test's — a fake transport here only returns a fixed overflowing TransportResult, the same
   shape regardless of kind, so this test is scoped to the runner-to-error plumbing alone. */
import { describe, it, expect, vi } from 'vitest';
import { StageRunner } from './stage-runner.js';
import { OLLAMA_RETRY_POLICY } from './retry-policy.js';
import { AnalyzerReasoningOverflowError } from '../errors.js';
import type { ChatTransport, TransportRequest, TransportResult } from './transport.js';
import { z } from 'zod';

const hoisted = vi.hoisted(() => ({ dirName: `castwright-w5a-handoff-${process.pid}-${Date.now()}` }));
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
/* Real HandoffKey/SkillName literals (W1's own tests use these exact values elsewhere:
   `key: '1-ch1' as const` at stage-runner.test.ts, `skillName: 'whole_book_stage1'` at
   transport-analyzer.ts's stage-1 call) — not placeholder strings, so this compiles against W1's
   actual unions rather than needing an `as never` escape. */
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

describe.each(['ollama', 'gemini', 'openai'] as const)('%s: the runner forwards settings.reasoning to the overflow error', (kind) => {
  it('runStage', async () => {
    const runner = new StageRunner({
      transport: fakeTransport(kind),
      policy: OLLAMA_RETRY_POLICY,
      settings: () => ({ structuredOutput: 'json', maxOutputTokens: undefined, reasoning: 'high' }),
      adaptSchema: (s) => ({ schema: s, dropped: [] }),
    });
    const err = await runner.runStage(stageSpec, {}).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AnalyzerReasoningOverflowError);
    expect((err as AnalyzerReasoningOverflowError).reasoningLevel).toBe('high');
  });

  it('runFreeText', async () => {
    const runner = new StageRunner({
      transport: fakeTransport(kind),
      policy: OLLAMA_RETRY_POLICY,
      settings: () => ({ structuredOutput: 'off', maxOutputTokens: undefined, reasoning: 'medium' }),
      adaptSchema: (s) => ({ schema: s, dropped: [] }),
    });
    const err = await runner.runFreeText({ prompt: 'p' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AnalyzerReasoningOverflowError);
    expect((err as AnalyzerReasoningOverflowError).reasoningLevel).toBe('medium');
  });
});
