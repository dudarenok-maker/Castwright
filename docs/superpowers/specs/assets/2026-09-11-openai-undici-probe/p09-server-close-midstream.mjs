import { startServer, makeClient, runStream, params, sseHead, chunk, sleep, log } from './lib.mjs';

let mode;
const srv = await startServer(async (req, res) => {
  sseHead(res);
  res.write(chunk({ role: 'assistant', content: 'one' }));
  await sleep(30);
  res.write(chunk({ content: 'two' }));
  await sleep(100);
  if (mode === 'destroy') { log('[server] res.destroy()'); res.destroy(); }
  else { log('[server] res.end()'); res.end(); }
});

mode = 'destroy';
{
  const { client, agent } = makeClient(srv.baseURL);
  const r = await runStream('P9a server res.destroy() after 2 chunks (no finish_reason, no [DONE])', client, params());
  log('last finish_reason seen:', r.chunks.at(-1)?.choices?.[0]?.finish_reason);
  await agent.destroy();
}
mode = 'end';
{
  const { client, agent } = makeClient(srv.baseURL);
  const r = await runStream('P9b server res.end() after 2 chunks (no finish_reason, no [DONE])', client, params());
  log('last finish_reason seen:', r.chunks.at(-1)?.choices?.[0]?.finish_reason);
  await agent.destroy();
}
await srv.close();
