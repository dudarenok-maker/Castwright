import { startServer, makeClient, runStream, params, sseHead, chunk, OpenAI, log } from './lib.mjs';

let cfg;
const srv = await startServer(async (req, res) => {
  if (cfg.inStream) {
    sseHead(res);
    res.write(chunk({ role: 'assistant', content: 'partial' }));
    res.write(`data: ${JSON.stringify({ error: { message: 'context exceeded', type: 'exceed_context_size_error', code: 400 } })}\n\n`);
    res.end();
    return;
  }
  res.writeHead(cfg.status, { 'content-type': 'application/json', 'x-request-id': 'req_123', ...(cfg.headers ?? {}) });
  res.end(JSON.stringify({ error: { message: `bad thing ${cfg.status}`, type: 'invalid_request_error', code: 'some_code', param: 'p' } }));
});

const classes = ['BadRequestError', 'AuthenticationError', 'RateLimitError', 'InternalServerError', 'APIError'];
for (const c of [{ status: 400 }, { status: 401 }, { status: 429, headers: { 'retry-after': '2' } }, { status: 503 }, { inStream: true }]) {
  cfg = c;
  const { client, agent } = makeClient(srv.baseURL);
  const r = await runStream(c.inStream ? 'P11e in-stream SSE `data: {"error":{...}}` after 1 chunk' : `P11 HTTP ${c.status}`, client, params());
  const e = r.err;
  if (e) {
    log('instanceof:', classes.filter((k) => e instanceof OpenAI[k]).join(','));
    log('.status=', e.status, '.code=', e.code, '.type=', e.type, '.param=', e.param, '.requestID=', e.requestID);
    log('.error=', JSON.stringify(e.error));
    log('.headers ctor=', e.headers?.constructor?.name, "headers.get('retry-after')=", e.headers?.get?.('retry-after'), "headers.get('x-request-id')=", e.headers?.get?.('x-request-id'));
  }
  await agent.close();
}
await srv.close();
