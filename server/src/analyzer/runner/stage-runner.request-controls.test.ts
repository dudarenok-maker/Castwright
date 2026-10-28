import { describe, it, expect, vi } from 'vitest';
import { z } from 'zod';
import { StageRunner } from './stage-runner.js';
import { OLLAMA_RETRY_POLICY } from './retry-policy.js';
import type { ChatTransport, TransportRequest, TransportResult } from './transport.js';

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

class RecordingTransport implements ChatTransport {
  readonly kind = 'ollama' as const;
  readonly model = 'q:4b';
  readonly requests: TransportRequest[] = [];
  prepare?: (signal?: AbortSignal) => Promise<void>;
  constructor(private readonly texts: string[]) {}
  async send(req: TransportRequest): Promise<TransportResult> {
    this.requests.push(req);
    return { text: this.texts[this.requests.length - 1] ?? '', reasoningSeen: false, finish: 'stop', receivedBytes: 0 };
  }
}
const schema = z.object({ ok: z.literal(true) });
const PAYLOAD = { top_k: 20 };
const runnerWith = (t: RecordingTransport) =>
  new StageRunner({
    transport: t,
    policy: OLLAMA_RETRY_POLICY,
    settings: () => ({ structuredOutput: 'json', maxOutputTokens: undefined, reasoning: 'high', extraParams: PAYLOAD }),
    adaptSchema: (s) => ({ schema: s, dropped: [] }),
  });
const stageSpec = { manuscriptId: 'm1', key: '1-ch1' as const, skillName: 'whole_book_stage1' as const, promptMd: 'p', grammarSchema: schema, validationSchema: schema } as const;
const escalationSpec = { manuscriptId: 'm1', key: 'escalation-ch1-w0', promptMd: 'p', grammarSchema: schema, validationSchema: schema } as const;

describe('StageRunner forwards the configured reasoning level and custom payload (#3084 wave 5)', () => {
  it('first attempt and the validation retry both carry them', async () => {
    const t = new RecordingTransport(['not json', '{"ok":true}']);
    await runnerWith(t).runStage(stageSpec, {});
    expect(t.requests.map((r) => r.reasoning)).toEqual(['high', 'high']);
    expect(t.requests.map((r) => r.extraParams)).toEqual([PAYLOAD, PAYLOAD]);
  });

  it('the escalation single attempt carries them', async () => {
    const t = new RecordingTransport(['{"ok":true}']);
    await runnerWith(t).runSingleAttempt(escalationSpec, {});
    expect(t.requests[0].reasoning).toBe('high');
    expect(t.requests[0].extraParams).toEqual(PAYLOAD);
  });

  it('the persona free-text path carries them', async () => {
    const t = new RecordingTransport(['A warm, low voice for audiobook narration.']);
    await runnerWith(t).runFreeText({ prompt: 'persona please' });
    expect(t.requests[0].reasoning).toBe('high');
    expect(t.requests[0].extraParams).toEqual(PAYLOAD);
  });

  it('the free-text path reads settings AFTER prepare(signal), and hands prepare the caller signal (P26)', async () => {
    const t = new RecordingTransport(['A voice.']);
    let level: 'low' | 'high' = 'low';
    const seen: Array<AbortSignal | undefined> = [];
    t.prepare = async (signal) => {
      seen.push(signal);
      level = 'high'; // a warm-up that changes what the settings resolve to, as the catalog warm-up does
    };
    const runner = new StageRunner({
      transport: t,
      policy: OLLAMA_RETRY_POLICY,
      settings: () => ({ structuredOutput: 'json', maxOutputTokens: undefined, reasoning: level }),
      adaptSchema: (s) => ({ schema: s, dropped: [] }),
    });
    const ac = new AbortController();
    await runner.runFreeText({ prompt: 'persona please', signal: ac.signal });
    expect(t.requests[0].reasoning).toBe('high');
    expect(seen).toEqual([ac.signal]);
  });

  it('settings that omit both fields leave them undefined on every request (the pre-W5 wire)', async () => {
    const t = new RecordingTransport(['{"ok":true}', 'A voice.']);
    const runner = new StageRunner({
      transport: t,
      policy: OLLAMA_RETRY_POLICY,
      settings: () => ({ structuredOutput: 'json', maxOutputTokens: undefined }),
      adaptSchema: (s) => ({ schema: s, dropped: [] }),
    });
    await runner.runSingleAttempt(escalationSpec, {});
    await runner.runFreeText({ prompt: 'persona please' });
    expect(t.requests.map((r) => [r.reasoning, r.extraParams])).toEqual([
      [undefined, undefined],
      [undefined, undefined],
    ]);
  });
});
