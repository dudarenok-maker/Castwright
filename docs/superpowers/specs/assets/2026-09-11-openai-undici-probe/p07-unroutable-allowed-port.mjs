// P7 re-run: port 9 is on the fetch spec's "bad port" list (see p06-08 output: cause "bad port"),
// so it never reaches connect. Use an allowed port on the same unroutable host.
import { makeClient, runStream, params, OpenAI } from './lib.mjs';

const kinds = (e) => `instanceof APIConnectionTimeoutError=${e instanceof OpenAI.APIConnectionTimeoutError} instanceof APIConnectionError=${e instanceof OpenAI.APIConnectionError}`;

{
  const { client, agent } = makeClient('http://10.255.255.1:8080/v1', { timeout: 10_000, connectTimeout: 1500 });
  const r = await runStream('P7c unroutable 10.255.255.1:8080, dispatcher connect.timeout=1500, SDK timeout=10000', client, params());
  console.log(kinds(r.err));
  await agent.destroy();
}
{
  const { client, agent } = makeClient('http://10.255.255.1:8080/v1', { timeout: 800, connectTimeout: 10_000 });
  const r = await runStream('P7d unroutable 10.255.255.1:8080, dispatcher connect.timeout=10000, SDK timeout=800', client, params());
  console.log(kinds(r.err));
  await agent.destroy();
}
