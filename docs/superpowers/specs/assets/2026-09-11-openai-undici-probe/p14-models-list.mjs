import { startServer, makeClient, log, describeErr } from './lib.mjs';

const srv = await startServer(async (req, res) => {
  log('[server]', req.method, req.url);
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ object: 'list', data: [{ id: 'a', object: 'model', max_model_len: 32768, meta: { n_ctx_train: 131072 } }] }));
});

const { client, agent } = makeClient(srv.baseURL);
console.log('\n===== P14 client.models.list() unknown-field preservation =====');
try {
  const page = await client.models.list();
  log('page ctor=', page.constructor.name, 'page.data=', JSON.stringify(page.data));
  for await (const m of client.models.list()) {
    log('for-await item:', JSON.stringify(m), '| m.max_model_len=', m.max_model_len, '| m.meta?.n_ctx_train=', m.meta?.n_ctx_train);
  }
} catch (e) {
  log('THREW', JSON.stringify(describeErr(e)));
}
await agent.close();
await srv.close();
