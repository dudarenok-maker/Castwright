/* #3084 PR 3b, P28 — Ollama's unreachable failures keep main's taxonomy outcome,
   copy and detail EXACTLY. The inline snapshots are CAPTURED on main (this
   branch before Task 3b.1's implementation) with `-u`, then committed alone.
   RE-CAPTURE RULE: only a PR that intentionally changes this copy may re-capture
   them, and its PR body must say so and paste the snapshot diff. Any other PR
   never re-captures them: a red snapshot there is a regression to fix.
   REAL OllamaAnalyzer, real sockets, no fetch stub. */
import { afterAll, describe, expect, it } from 'vitest';
import { createServer as createNetServer, type LookupFunction } from 'node:net';
import { createServer as createHttpServer, type Server } from 'node:http';
import { readdir, rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Agent } from 'undici';
import { OllamaAnalyzer } from './ollama.js';
import { classifyAnalysisFailure } from '../routes/failure-taxonomy.js';

const HANDOFF_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'handoff');
const ID = 'm_unreachable_taxonomy';
const agents: Agent[] = [];
const servers: Server[] = [];

async function closedPortUrl(): Promise<string> {
  const probe = createNetServer();
  await new Promise<void>((r) => probe.listen(0, '127.0.0.1', () => r()));
  const port = (probe.address() as { port: number }).port;
  await new Promise<void>((r) => probe.close(() => r()));
  return `http://127.0.0.1:${port}`;
}

/* The resolver answers ENOTFOUND for every host, whatever this machine's DNS does. */
function enotfoundAgent(): Agent {
  const lookup: LookupFunction = (hostname, _options, callback) =>
    callback(Object.assign(new Error(`getaddrinfo ENOTFOUND ${hostname}`), { code: 'ENOTFOUND', errno: -3008, syscall: 'getaddrinfo', hostname }), []);
  const agent = new Agent({ headersTimeout: 0, bodyTimeout: 0, connect: { timeout: 10_000, lookup } });
  agents.push(agent);
  return agent;
}

/* A daemon that accepts the TCP connection then closes the socket before the
   first body byte, producing a stream-incomplete error from the real transport. */
async function resetBeforeFirstByteUrl(): Promise<string> {
  const server = createHttpServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/x-ndjson' });
    res.flushHeaders();
    setTimeout(() => res.destroy(), 20);
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}

async function outcomeOf(url: string, dispatcher?: Agent) {
  const err = await new OllamaAnalyzer({ url, model: 'qwen3.5:4b', dispatcher })
    .runStage1Chapter(ID, 1, '# p', {})
    .then(() => null, (e: unknown) => e);
  expect(err).not.toBeNull();
  const r = classifyAnalysisFailure(err, 'Ollama (qwen3.5:4b)');
  const scrub = (s: string | undefined) => (s === undefined ? undefined : s.split(url).join('<ollama-url>'));
  return {
    name: (err as Error).name,
    message: scrub((err as Error).message),
    code: r.code,
    userMessage: scrub(r.userMessage),
    remediation: r.remediation,
    detail: scrub(r.detail),
  };
}

afterAll(async () => {
  await Promise.all(agents.splice(0).map((a) => a.destroy()));
  await Promise.all(
    servers.splice(0).map((s) => new Promise<void>((r) => {
      s.closeAllConnections();
      s.close(() => r());
    })),
  );
  for (const sub of ['inbox', 'outbox']) {
    const dir = resolve(HANDOFF_ROOT, sub);
    const names = await readdir(dir).catch(() => [] as string[]);
    await Promise.all(names.filter((n) => n.startsWith(ID)).map((n) => rm(resolve(dir, n), { force: true })));
  }
});

describe('Ollama unreachable → classifyAnalysisFailure (captured from main, #3084 P28)', () => {
  it('closed port', async () => {
    expect(await outcomeOf(await closedPortUrl())).toMatchInlineSnapshot(`
      {
        "code": "analyzer-unreachable",
        "detail": undefined,
        "message": "Ollama at <ollama-url> is unreachable (ECONNREFUSED). Start the daemon or switch to Gemini in Admin → Model Manager.",
        "name": "LocalUnreachableError",
        "remediation": "Check that Ollama is running (ollama serve), or switch the analyzer to Gemini in Admin → Model Manager with a GEMINI_API_KEY. Then retry the chapter or resume the run.",
        "userMessage": "The analyzer could not be reached or stopped responding — the local Ollama daemon is down, or the analyzer service returned a server error.",
      }
    `);
  });

  it('unresolvable host (ENOTFOUND injected through the resolver)', async () => {
    expect(await outcomeOf('http://castwright-unresolvable.test:11434', enotfoundAgent())).toMatchInlineSnapshot(`
      {
        "code": "unknown",
        "detail": undefined,
        "message": "Ollama at <ollama-url> is unreachable (ENOTFOUND). Start the daemon or switch to Gemini in Admin → Model Manager.",
        "name": "LocalUnreachableError",
        "remediation": "Click Retry on this chapter. If it keeps failing, check the server / voice engine logs for the full error and report it.",
        "userMessage": "Ollama at <ollama-url> is unreachable (ENOTFOUND). Start the daemon or switch to Gemini in Admin → Model Manager.",
      }
    `);
  });

  it('reachable daemon that closes the socket before the first body byte', async () => {
    expect(await outcomeOf(await resetBeforeFirstByteUrl())).toMatchInlineSnapshot(`
      {
        "code": "unknown",
        "detail": undefined,
        "message": "Ollama at <ollama-url> is unreachable (UND_ERR_SOCKET). Start the daemon or switch to Gemini in Admin → Model Manager.",
        "name": "LocalUnreachableError",
        "remediation": "Click Retry on this chapter. If it keeps failing, check the server / voice engine logs for the full error and report it.",
        "userMessage": "Ollama at <ollama-url> is unreachable (UND_ERR_SOCKET). Start the daemon or switch to Gemini in Admin → Model Manager.",
      }
    `);
  });
});