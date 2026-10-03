import { afterAll, describe, expect, it } from 'vitest';
import { readdir, rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { StageRunner } from './stage-runner.js';
import { OLLAMA_RETRY_POLICY, GEMINI_RETRY_POLICY } from './retry-policy.js';
import type { ChatTransport, TransportRequest, TransportResult } from './transport.js';
import { AnalyzerInvalidOutputError } from '../errors.js';
import { stage1ChapterGrammarSchema, stage1ChapterSchema } from '../../handoff/schemas.js';
import type { HandoffKey } from '../../handoff/protocol.js';
import { classifyAnalysisFailure } from '../../routes/failure-taxonomy.js';

const HANDOFF_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'handoff');
const ID = 'm_invalid_output_error';

afterAll(async () => {
  for (const sub of ['inbox', 'outbox']) {
    const dir = resolve(HANDOFF_ROOT, sub);
    const names = await readdir(dir).catch(() => [] as string[]);
    await Promise.all(names.filter((n) => n.startsWith(ID)).map((n) => rm(resolve(dir, n), { force: true })));
  }
});

function fakeTransport(kind: 'ollama' | 'gemini') {
  const requests: TransportRequest[] = [];
  const transport: ChatTransport = {
    kind,
    model: 'fake-model',
    async send(req): Promise<TransportResult> {
      requests.push(req);
      return { text: 'not json at all', reasoningSeen: false, finish: 'stop', receivedBytes: 15 };
    },
  };
  return { transport, requests };
}

/* Today's exact final-failure text (ollama.ts:609-611, gemini.ts:515-517). */
const TODAY = {
  ollama: (model: string, key: string, detail: string) =>
    `Ollama ${model} ${key} failed validation after retry: ${detail}`,
  gemini: (_model: string, key: string, detail: string) =>
    `Gemini ${key} failed validation after retry: ${detail}`,
};

describe('StageRunner — final validation failure (#3084 PR 3b)', () => {
  it.each([
    ['ollama', OLLAMA_RETRY_POLICY, 'schema'],
    ['gemini', GEMINI_RETRY_POLICY, 'json'],
  ] as const)('%s throws AnalyzerInvalidOutputError carrying today\'s message', async (kind, policy, mode) => {
    const { transport, requests } = fakeTransport(kind);
    const runner = new StageRunner({
      transport,
      policy,
      settings: () => ({ structuredOutput: mode, maxOutputTokens: undefined }),
      adaptSchema: (s) => ({ schema: s, dropped: [] }),
    });
    const key = '1-ch1' as HandoffKey;
    const err = await runner
      .runStage(
        {
          manuscriptId: ID,
          key,
          skillName: 'per_chapter_stage1',
          promptMd: '# p',
          grammarSchema: stage1ChapterGrammarSchema,
          validationSchema: stage1ChapterSchema,
        },
        {},
      )
      .then(
        () => null,
        (e: unknown) => e,
      );

    expect(err).toBeInstanceOf(AnalyzerInvalidOutputError);
    const e = err as AnalyzerInvalidOutputError;
    expect(e.transport).toBe(kind);
    expect(e.structuredOutputMode).toBe(mode);
    expect(e.detail.startsWith('invalid-json — ')).toBe(true);
    expect(e.message).toBe(TODAY[kind]('fake-model', '1-ch1', e.detail));
    expect(requests).toHaveLength(2);
    expect(classifyAnalysisFailure(e, 'Fake').code).toBe('analyzer-invalid-output');
  });
});
