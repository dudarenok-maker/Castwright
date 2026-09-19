import { startServer, makeClient, runStream, params, sseHead, sleep, log, describeErr } from './lib.mjs';

let mode = 'headers-silence';
const srv = await startServer(async (req, res) => {
  if (mode === 'headers-silence') sseHead(res); // headers, then silence, never end
  // mode 'no-headers': nothing
});

const show = (name, s) => log(`${name}: aborted=${s.aborted} reason=${JSON.stringify(describeErr(s.reason))}`);

async function run(label, { serverMode, callerAbortMs }) {
  mode = serverMode;
  const { client, agent } = makeClient(srv.baseURL);
  const caller = new AbortController();
  const ceiling = AbortSignal.timeout(800);
  const any = AbortSignal.any([caller.signal, ceiling]);
  if (callerAbortMs) setTimeout(() => { log('>>> caller.abort()'); caller.abort(); }, callerAbortMs);
  const r = await runStream(label, client, params(), { signal: any });
  show('caller.signal', caller.signal);
  show('ceiling (AbortSignal.timeout(800))', ceiling);
  show('any', any);
  if (r.stream) show('stream.controller.signal', r.stream.controller.signal);
  log('any.reason === ceiling.reason ?', any.reason === ceiling.reason, '| err.cause === ceiling.reason ?', r.err?.cause === ceiling.reason);
  await sleep(150);
  await agent.destroy();
}

await run('P4a ceiling=AbortSignal.any([caller, timeout(800)]); server headers then silence', { serverMode: 'headers-silence' });
await run('P4b same ceiling; server NEVER sends headers', { serverMode: 'no-headers' });
await run('P4c same ceiling; headers then silence; caller aborts at 300ms (before ceiling)', { serverMode: 'headers-silence', callerAbortMs: 300 });
await srv.close();
