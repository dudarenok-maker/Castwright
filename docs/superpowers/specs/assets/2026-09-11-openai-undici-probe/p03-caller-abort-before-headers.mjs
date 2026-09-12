import { startServer, makeClient, runStream, params, sleep, log } from './lib.mjs';

const srv = await startServer(async () => {
  // accept, never write headers
});

for (const [label, reason] of [
  ['P3a caller abort() 300ms after create, server never writes headers', undefined],
  ['P3b caller abort(new Error("custom-reason")) 300ms, no headers', new Error('custom-reason')],
]) {
  const { client, agent } = makeClient(srv.baseURL);
  const ac = new AbortController();
  setTimeout(() => { log('>>> caller ac.abort()'); if (reason) ac.abort(reason); else ac.abort(); }, 300);
  const r = await runStream(label, client, params(), { signal: ac.signal });
  log('err.cause === ac.signal.reason ?', r.err?.cause === ac.signal.reason);
  await sleep(200);
  await agent.destroy();
}
await srv.close();
