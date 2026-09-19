import http from 'node:http';
import OpenAI from 'openai';
import * as undici from 'undici';

export { OpenAI, undici };

let T0 = Date.now();
export const resetClock = () => (T0 = Date.now());
export const ts = () => `+${String(Date.now() - T0).padStart(5)}ms`;
export const log = (...a) => console.log(ts(), ...a);

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function chunk(delta, finish_reason = null, extra = {}) {
  return `data: ${JSON.stringify({ id: 'x', object: 'chat.completion.chunk', choices: [{ index: 0, delta, finish_reason }], ...extra })}\n\n`;
}
export const DONE = 'data: [DONE]\n\n';

export function sseHead(res) {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
  res.flushHeaders();
}

/** handler(req, res, bodyJson) */
export async function startServer(handler) {
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (d) => (raw += d));
    req.on('end', async () => {
      let body;
      try { body = raw ? JSON.parse(raw) : undefined; } catch { body = raw; }
      res.on('close', () => log(`[server] res close (writableFinished=${res.writableFinished})`));
      try { await handler(req, res, body); } catch (e) { log('[server] handler error', e.message); }
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  return {
    port,
    baseURL: `http://127.0.0.1:${port}/v1`,
    close: () => { server.closeAllConnections(); return new Promise((r) => server.close(r)); },
  };
}

export function makeClient(baseURL, { timeout = 60_000, connectTimeout = 10_000, useUndiciFetch = true } = {}) {
  const agent = new undici.Agent({ headersTimeout: 0, bodyTimeout: 0, connect: { timeout: connectTimeout } });
  const client = new OpenAI({
    baseURL,
    apiKey: 'k',
    maxRetries: 0,
    timeout,
    ...(useUndiciFetch ? { fetch: undici.fetch } : {}),
    fetchOptions: { dispatcher: agent },
  });
  return { client, agent };
}

export function describeErr(e) {
  if (e === undefined) return undefined;
  const d = {
    ctor: e?.constructor?.name,
    name: e?.name,
    message: e?.message,
    status: e?.status,
  };
  if (e && 'error' in e) d.error = e.error;
  if (e && 'code' in e && e.code !== undefined) d.code = e.code;
  const chain = [];
  let c = e?.cause;
  for (let i = 0; c && i < 8; i++) {
    const lvl = { ctor: c?.constructor?.name, name: c?.name, code: c?.code, message: c?.message };
    if (Array.isArray(c?.errors)) lvl.errors = c.errors.map((x) => ({ ctor: x?.constructor?.name, code: x?.code, message: x?.message }));
    chain.push(lvl);
    c = c?.cause;
  }
  d.causeChain = chain;
  return d;
}

export const params = (extra = {}) => ({ model: 'm', messages: [{ role: 'user', content: 'x' }], stream: true, ...extra });

/**
 * Runs create() + for-await. Records phase of a throw (create vs loop), chunks, clean end.
 * hooks.onChunk(chunk, index, stream)
 */
export async function runStream(label, client, p, opts = {}, hooks = {}) {
  console.log(`\n===== ${label} =====`);
  resetClock();
  let stream, thrown = false, phase, err, clean = false;
  const chunks = [];
  try {
    log('create() called');
    stream = await client.chat.completions.create(p, opts);
    log('create() resolved ->', stream?.constructor?.name);
    let i = 0;
    for await (const ch of stream) {
      chunks.push(ch);
      log('chunk', i, JSON.stringify(ch));
      hooks.onChunk?.(ch, i, stream);
      i++;
    }
    clean = true;
    log('for-await ended WITHOUT throwing');
  } catch (e) {
    thrown = true;
    err = e;
    phase = stream ? 'loop' : 'create';
    log(`THREW in ${phase}:`, JSON.stringify(describeErr(e), null, 1));
  } finally {
    log(`finally: thrown=${thrown} clean=${clean} chunks=${chunks.length} stream.controller.signal.aborted=${stream?.controller?.signal?.aborted}`);
  }
  return { stream, thrown, phase, err, clean, chunks };
}

// Safety net so a hung probe never blocks forever.
setTimeout(() => { console.log('!!! global probe watchdog fired (30s) — exiting'); process.exit(2); }, 30_000).unref();
