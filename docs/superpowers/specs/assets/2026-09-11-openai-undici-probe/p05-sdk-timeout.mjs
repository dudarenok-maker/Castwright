import { startServer, makeClient, runStream, params, sseHead, chunk, sleep, log } from './lib.mjs';

let mode;
const srv = await startServer(async (req, res) => {
  if (mode === 'no-headers') return;
  sseHead(res);
  log('[server] headers sent; silent for 3000ms');
  await sleep(3000);
  if (res.destroyed) { log('[server] res already destroyed after silence'); return; }
  res.write(chunk({ role: 'assistant', content: 'late' }));
  res.write(chunk({}, 'stop'));
  res.write('data: [DONE]\n\n');
  res.end();
  log('[server] wrote late chunk + stop + DONE + end');
});

mode = 'no-headers';
{
  const { client, agent } = makeClient(srv.baseURL, { timeout: 800 });
  await runStream('P5a SDK timeout:800, no ceiling signal; server never sends headers', client, params());
  await sleep(100);
  await agent.destroy();
}
mode = 'headers-then-silence';
{
  const { client, agent } = makeClient(srv.baseURL, { timeout: 800 });
  await runStream('P5b SDK timeout:800, no ceiling; headers then 3s silence then chunk+stop+DONE', client, params());
  await sleep(100);
  await agent.destroy();
}
await srv.close();
