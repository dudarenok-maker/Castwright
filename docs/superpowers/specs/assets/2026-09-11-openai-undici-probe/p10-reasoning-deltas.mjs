import { startServer, makeClient, runStream, params, sseHead, chunk, DONE, log } from './lib.mjs';

let field;
let sent = [];
const srv = await startServer(async (req, res) => {
  sseHead(res);
  sent = [
    chunk({ role: 'assistant', [field]: 'Let me ' }),
    chunk({ [field]: 'think.' }),
    chunk({ content: 'Answer' }),
    chunk({}, 'stop'),
  ];
  for (const s of sent) res.write(s);
  res.write(DONE);
  res.end();
});

for (const f of ['reasoning_content', 'reasoning']) {
  field = f;
  const { client, agent } = makeClient(srv.baseURL);
  const r = await runStream(`P10 delta.${f} passthrough`, client, params());
  r.chunks.forEach((c, i) => {
    const wire = JSON.parse(sent[i].slice('data: '.length));
    log(`chunk ${i}: delta keys=${JSON.stringify(Object.keys(c.choices[0].delta))} delta.${f}=${JSON.stringify(c.choices[0].delta[f])} deepEqualToWire=${JSON.stringify(c) === JSON.stringify(wire)}`);
  });
  await agent.close();
}
await srv.close();
