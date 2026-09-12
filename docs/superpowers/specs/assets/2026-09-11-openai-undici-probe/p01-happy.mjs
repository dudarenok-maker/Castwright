import { readFileSync } from 'node:fs';
import { startServer, makeClient, runStream, params, sseHead, chunk, DONE } from './lib.mjs';

const ver = (p) => JSON.parse(readFileSync(new URL(`./node_modules/${p}/package.json`, import.meta.url))).version;
console.log('node', process.version, '| node-bundled undici', process.versions.undici, '| userland undici', ver('undici'), '| openai', ver('openai'));

const srv = await startServer(async (req, res) => {
  sseHead(res);
  res.write(chunk({ role: 'assistant', content: 'hi' }));
  res.write(chunk({ content: ' there' }));
  res.write(chunk({}, 'stop'));
  res.write(DONE);
  res.end();
});

{
  const { client, agent } = makeClient(srv.baseURL);
  await runStream('P1a happy path: fetch=undici.fetch + undici.Agent dispatcher', client, params());
  await agent.close();
}
{
  const { client, agent } = makeClient(srv.baseURL, { useUndiciFetch: false });
  await runStream('P1b userland undici.Agent dispatcher WITHOUT fetch=undici.fetch (Node global fetch)', client, params());
  await agent.destroy();
}
await srv.close();
