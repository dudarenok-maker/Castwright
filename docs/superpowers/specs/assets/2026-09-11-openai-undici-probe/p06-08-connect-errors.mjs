import http from 'node:http';
import { makeClient, runStream, params, OpenAI } from './lib.mjs';

const kinds = (e) => `instanceof APIConnectionTimeoutError=${e instanceof OpenAI.APIConnectionTimeoutError} instanceof APIConnectionError=${e instanceof OpenAI.APIConnectionError} instanceof APIUserAbortError=${e instanceof OpenAI.APIUserAbortError}`;

// P6: closed port
const tmp = http.createServer();
await new Promise((r) => tmp.listen(0, '127.0.0.1', r));
const closedPort = tmp.address().port;
await new Promise((r) => tmp.close(r));
{
  const { client, agent } = makeClient(`http://127.0.0.1:${closedPort}/v1`, { timeout: 10_000 });
  const r = await runStream(`P6 connection refused (closed port ${closedPort})`, client, params());
  console.log(kinds(r.err));
  await agent.destroy();
}
// P7a: unroutable, dispatcher connect.timeout 1500 < SDK timeout 10000
{
  const { client, agent } = makeClient('http://10.255.255.1:9/v1', { timeout: 10_000, connectTimeout: 1500 });
  const r = await runStream('P7a unroutable 10.255.255.1:9, connect.timeout=1500, SDK timeout=10000', client, params());
  console.log(kinds(r.err));
  await agent.destroy();
}
// P7b: unroutable, SDK timeout 800 < connect.timeout 10000
{
  const { client, agent } = makeClient('http://10.255.255.1:9/v1', { timeout: 800, connectTimeout: 10_000 });
  const r = await runStream('P7b unroutable 10.255.255.1:9, connect.timeout=10000, SDK timeout=800', client, params());
  console.log(kinds(r.err));
  await agent.destroy();
}
// P8: ENOTFOUND
{
  const { client, agent } = makeClient('http://nonexistent-host-xyz.invalid/v1', { timeout: 10_000 });
  const r = await runStream('P8 ENOTFOUND nonexistent-host-xyz.invalid', client, params());
  console.log(kinds(r.err));
  await agent.destroy();
}
