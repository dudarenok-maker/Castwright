import { startServer, makeClient, runStream, params, sseHead, chunk, sleep, log, describeErr } from './lib.mjs';

const srv = await startServer(async (req, res) => {
  sseHead(res);
  res.write(chunk({ role: 'assistant', content: 'one' }));
  await sleep(20);
  res.write(chunk({ content: 'two' }));
  // then silence, never end
});

for (const [label, reason] of [
  ['P2a caller abort() (no reason) 300ms after first chunk; server silent after 2 chunks', undefined],
  ['P2b caller abort(new Error("custom-reason")) 300ms after first chunk', new Error('custom-reason')],
]) {
  const { client, agent } = makeClient(srv.baseURL);
  const ac = new AbortController();
  let abortedAt;
  const r = await runStream(label, client, params(), { signal: ac.signal }, {
    onChunk: (_c, i) => {
      if (i === 0) setTimeout(() => { abortedAt = Date.now(); log('>>> caller ac.abort()'); if (reason) ac.abort(reason); else ac.abort(); }, 300);
    },
  });
  log(`after loop: loopEnd-abort delta=${abortedAt ? Date.now() - abortedAt : 'n/a'}ms`);
  log('caller signal aborted=', ac.signal.aborted, 'reason=', JSON.stringify(describeErr(ac.signal.reason)));
  log('stream.controller.signal aborted=', r.stream?.controller.signal.aborted, 'reason=', JSON.stringify(describeErr(r.stream?.controller.signal.reason)));
  log('stream.controller.signal === caller signal?', r.stream?.controller.signal === ac.signal);
  await sleep(200);
  await agent.destroy();
}
await srv.close();
