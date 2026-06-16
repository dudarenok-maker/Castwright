/* Task 5 (fs-45): Verify that a successful OllamaAnalyzer.runStage1Chapter call
   records a VRAM sample when CASTWRIGHT_VRAM_SAMPLE is '1'.

   Isolation:
   - WORKSPACE_DIR is redirected to a tmp dir so telemetryDir() / vramStatsFilePath()
     land in a throw-away location, not the real workspace.
   - ollama.js and model-vram-stats.js are dynamically imported AFTER the env is set
     so module-init paths see the tmp dir.
   - The handoff inbox/outbox dirs (hardcoded inside protocol.ts) are created so
     runStage1Chapter can write its prompt trace without failing. */

import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
// Handoff dirs are resolved by protocol.ts relative to its own __dirname.
// protocol.ts lives at server/src/handoff/, so HANDOFF_ROOT = server/handoff/.
const HANDOFF_ROOT = resolve(__dirname, '..', '..', 'handoff');

let stats: typeof import('./model-vram-stats.js');
let mod: typeof import('./ollama.js');

beforeAll(async () => {
  process.env.WORKSPACE_DIR = mkdtempSync(join(tmpdir(), 'vram-ollama-'));
  process.env.CASTWRIGHT_VRAM_SAMPLE = '1'; // sampling ON for this file
  stats = await import('./model-vram-stats.js');
  mod = await import('./ollama.js');
});

beforeEach(async () => {
  // Clear any previous sample file so each test starts clean.
  await rm(stats.vramStatsFilePath(), { force: true });
  // Ensure the handoff protocol dirs exist (protocol.ts writes prompts here).
  await mkdir(resolve(HANDOFF_ROOT, 'inbox'), { recursive: true });
  await mkdir(resolve(HANDOFF_ROOT, 'outbox'), { recursive: true });
});

afterEach(() => {
  vi.restoreAllMocks();
});

/* ── Helpers copied from ollama.test.ts ─────────────────────────────────── */

/* A valid stage-1 chapter response — characters[] only, no chapters[] (the
   per-chapter shape forbids chapters via .strict()). */
const VALID_RESPONSE = JSON.stringify({
  characters: [
    {
      id: 'narrator',
      name: 'Narrator',
      role: 'narrator',
      color: 'narrator',
      evidence: [{ quote: 'a' }, { quote: 'bb' }, { quote: 'ccc' }],
    },
    {
      id: 'wren',
      name: 'Wren',
      role: 'protagonist',
      color: 'orange',
      evidence: [{ quote: 'dd' }, { quote: 'eee' }, { quote: 'ffff' }],
    },
  ],
});

/* Build a ReadableStream that emits Ollama-style NDJSON. */
function ndjsonStream(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let i = 0;
  return new ReadableStream({
    pull(controller) {
      if (i < chunks.length) {
        const line = JSON.stringify({
          message: { role: 'assistant', content: chunks[i] },
          done: false,
        });
        controller.enqueue(encoder.encode(line + '\n'));
        i += 1;
      } else if (i === chunks.length) {
        const done = JSON.stringify({ message: { role: 'assistant', content: '' }, done: true });
        controller.enqueue(encoder.encode(done + '\n'));
        i += 1;
      } else {
        controller.close();
      }
    },
  });
}

function chunksOf(text: string, size: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size));
  return out;
}

function okResponse(stream: ReadableStream<Uint8Array>): Response {
  return new Response(stream, { status: 200, headers: { 'Content-Type': 'application/x-ndjson' } });
}

function chatResponse(): Response {
  return okResponse(ndjsonStream(chunksOf(VALID_RESPONSE, 32)));
}

/* ── Tests ───────────────────────────────────────────────────────────────── */

describe('OllamaAnalyzer — VRAM sampling (CASTWRIGHT_VRAM_SAMPLE=1)', () => {
  it('records an analyzer VRAM sample after a successful chat', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (String(url).endsWith('/api/ps')) {
        return {
          ok: true,
          json: async () => ({
            models: [{ name: 'qwen3.5:9b', size: 6e9, size_vram: 6e9 }],
          }),
        } as unknown as Response;
      }
      return chatResponse(); // /api/chat
    });
    vi.stubGlobal('fetch', fetchMock);

    const analyzer = new mod.OllamaAnalyzer({
      url: 'http://localhost:11434',
      model: 'qwen3.5:9b',
    });
    await analyzer.runStage1Chapter('m_id', 1, '# stage1 prompt', {});

    const recs = await stats.readAllVramRecords();
    expect(recs.some((r) => r.key === 'qwen3.5:9b@32768')).toBe(true);
  });
});
