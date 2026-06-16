/* Plan 61 — pull-bootstrap state machine.
 *
 * Drives the NDJSON-progress consumer end-to-end without touching a
 * real Ollama daemon. The fetchFn is fully stubbed; the assertions
 * focus on:
 *   1. allowlist enforcement (the route MUST refuse non-allowlisted tags),
 *   2. progress line consumption (bytesReceived / bytesTotal /
 *      lastStatusMessage all flow through),
 *   3. terminal-state transitions on "success" and on error envelopes. */

import { describe, it, expect, vi } from 'vitest';
import { PullBootstrap, DEFAULT_ALLOWED_MODELS } from './pull-bootstrap.js';

function makeStreamBody(lines: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let i = 0;
  return new ReadableStream({
    pull(controller) {
      if (i >= lines.length) {
        controller.close();
        return;
      }
      controller.enqueue(encoder.encode(lines[i] + '\n'));
      i++;
    },
  });
}

describe('PullBootstrap — allowlist', () => {
  it('rejects models outside the allowlist with an error job', () => {
    const boot = new PullBootstrap();
    const job = boot.start('http://localhost:11434', 'evil:7b');
    expect(job.status).toBe('error');
    expect(job.error).toMatch(/allowlist/i);
  });

  it('accepts every default-allowed tag without going to error before fetch', () => {
    const fetchFn = vi.fn(() =>
      Promise.resolve({
        ok: true,
        status: 200,
        statusText: 'OK',
        body: makeStreamBody(['{"status":"success"}']),
        text: () => Promise.resolve(''),
      }),
    );
    const boot = new PullBootstrap({ fetchFn });
    for (const model of DEFAULT_ALLOWED_MODELS) {
      const job = boot.start('http://localhost:11434', model);
      expect(job.status).toBe('pulling');
    }
  });
});

describe('canonical install list', () => {
  it('includes the gemma-4 E4B edge model', () => {
    expect(DEFAULT_ALLOWED_MODELS.has('gemma-4-E4B-it-GGUF:UD-Q4_K_XL')).toBe(true);
  });

  it('listAllowed() returns the allowlist as an array', () => {
    const pb = new PullBootstrap();
    expect(pb.listAllowed()).toEqual(expect.arrayContaining(['gemma-4-E4B-it-GGUF:UD-Q4_K_XL']));
  });

  it('still rejects an off-list tag', () => {
    const pb = new PullBootstrap();
    expect(pb.isAllowed('totally-made-up:99b')).toBe(false);
  });
});

describe('PullBootstrap — progress streaming', () => {
  it('walks pulling → pulled, surfacing bytesReceived and lastStatusMessage', async () => {
    const fetchFn = vi.fn(() =>
      Promise.resolve({
        ok: true,
        status: 200,
        statusText: 'OK',
        body: makeStreamBody([
          '{"status":"pulling manifest"}',
          '{"status":"downloading","total":4096,"completed":1024}',
          '{"status":"downloading","total":4096,"completed":4096}',
          '{"status":"verifying sha256 digest"}',
          '{"status":"success"}',
        ]),
        text: () => Promise.resolve(''),
      }),
    );
    const boot = new PullBootstrap({ fetchFn });
    const job = boot.start('http://localhost:11434', 'qwen3.5:4b');
    for (let i = 0; i < 200; i++) {
      await new Promise((r) => setImmediate(r));
      if (boot.getJob(job.id)?.status === 'pulled') break;
    }
    const j = boot.getJob(job.id);
    expect(j?.status).toBe('pulled');
    expect(j?.bytesReceived).toBe(4096);
    expect(j?.bytesTotal).toBe(4096);
    expect(j?.lastStatusMessage).toBe('success');
  });

  it('transitions to error when Ollama responds non-2xx', async () => {
    const fetchFn = vi.fn(() =>
      Promise.resolve({
        ok: false,
        status: 500,
        statusText: 'Internal Server Error',
        body: null,
        text: () => Promise.resolve('upstream blew up'),
      }),
    );
    const boot = new PullBootstrap({ fetchFn });
    const job = boot.start('http://localhost:11434', 'qwen3.5:4b');
    for (let i = 0; i < 200; i++) {
      await new Promise((r) => setImmediate(r));
      if (boot.getJob(job.id)?.status === 'error') break;
    }
    const j = boot.getJob(job.id);
    expect(j?.status).toBe('error');
    expect(j?.error).toMatch(/500/);
  });

  it('transitions to error when an NDJSON line carries error', async () => {
    const fetchFn = vi.fn(() =>
      Promise.resolve({
        ok: true,
        status: 200,
        statusText: 'OK',
        body: makeStreamBody([
          '{"status":"pulling manifest"}',
          '{"error":"pull model manifest: file does not exist"}',
        ]),
        text: () => Promise.resolve(''),
      }),
    );
    const boot = new PullBootstrap({ fetchFn });
    const job = boot.start('http://localhost:11434', 'qwen3.5:4b');
    for (let i = 0; i < 200; i++) {
      await new Promise((r) => setImmediate(r));
      if (boot.getJob(job.id)?.status === 'error') break;
    }
    const j = boot.getJob(job.id);
    expect(j?.status).toBe('error');
    expect(j?.error).toMatch(/file does not exist/);
  });

  it('coalesces a second start() for the same model into the active job', () => {
    const fetchFn = vi.fn(() =>
      Promise.resolve({
        ok: true,
        status: 200,
        statusText: 'OK',
        /* Never-emitting stream keeps the job pinned in "pulling". */
        body: new ReadableStream({ pull() { /* idle */ } }),
        text: () => Promise.resolve(''),
      }),
    );
    const boot = new PullBootstrap({ fetchFn });
    const a = boot.start('http://localhost:11434', 'qwen3.5:4b');
    const b = boot.start('http://localhost:11434', 'qwen3.5:4b');
    expect(b.id).toBe(a.id);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('does NOT coalesce a pull for a different model', () => {
    const fetchFn = vi.fn(() =>
      Promise.resolve({
        ok: true,
        status: 200,
        statusText: 'OK',
        body: new ReadableStream({ pull() { /* idle */ } }),
        text: () => Promise.resolve(''),
      }),
    );
    const boot = new PullBootstrap({ fetchFn });
    const a = boot.start('http://localhost:11434', 'qwen3.5:4b');
    const b = boot.start('http://localhost:11434', 'llama3.1:8b');
    expect(b.id).not.toBe(a.id);
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });
});
