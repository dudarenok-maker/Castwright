import { startServer, makeClient, runStream, params, sseHead, chunk, DONE, log } from './lib.mjs';

let usageMode = false;
const srv = await startServer(async (req, res, body) => {
  log('[server] received body:', JSON.stringify(body));
  log('[server] selected headers:', JSON.stringify(Object.fromEntries(['content-type', 'accept', 'authorization', 'x-stainless-timeout', 'x-stainless-retry-count'].map((h) => [h, req.headers[h]]))));
  sseHead(res);
  res.write(chunk({ role: 'assistant', content: 'hi' }));
  res.write(chunk({}, 'stop'));
  if (usageMode) {
    res.write(`data: ${JSON.stringify({ id: 'x', object: 'chat.completion.chunk', choices: [], usage: { prompt_tokens: 3, completion_tokens: 7, total_tokens: 10, completion_tokens_details: { reasoning_tokens: 5 } } })}\n\n`);
  }
  res.write(DONE);
  res.end();
});

{
  const { client, agent } = makeClient(srv.baseURL);
  await runStream('P12 extra body fields passthrough', client, params({
    chat_template_kwargs: { enable_thinking: false },
    top_k: 20,
    reasoning_effort: 'low',
    response_format: { type: 'json_schema', json_schema: { name: 's', schema: { type: 'object' }, strict: false } },
  }));
  await agent.close();
}
usageMode = true;
{
  const { client, agent } = makeClient(srv.baseURL);
  const r = await runStream('P13 stream_options.include_usage final choices:[] usage chunk', client, params({ stream_options: { include_usage: true } }));
  const last = r.chunks.at(-1);
  log('last yielded chunk choices.length=', last?.choices?.length, 'usage=', JSON.stringify(last?.usage));
  await agent.close();
}
await srv.close();
