import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, type Server } from 'node:http';
import express, { type Express } from 'express';
import request from 'supertest';
import { ollamaHealthRouter } from './ollama-health.js';
import {
  _resetUserSettingsCache,
  _setUserSettingsCacheForTest,
} from '../workspace/user-settings.js';

let app: Express;
let ollama: Server;
let hits = 0;
const savedUrl = process.env.OLLAMA_URL;

beforeAll(async () => {
  ollama = createServer((_req, res) => {
    hits += 1;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{}');
  });
  await new Promise<void>((r) => ollama.listen(0, '127.0.0.1', () => r()));
  const addr = ollama.address();
  const url = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
  process.env.OLLAMA_URL = url;
  /* #3084 A3 (re-pin to 80be2f1d) — `ollamaUrl` is not a settings field any
     more (getResolvedOllamaUrl() resolves via the config resolver); the env
     var above already covers what this seed call used to do, and seeding a
     field the schema no longer has would be a no-op at best. */
  app = express();
  app.use(express.json());
  app.use('/api/ollama', ollamaHealthRouter);
});

afterAll(async () => {
  ollama.closeAllConnections();
  await new Promise<void>((r) => ollama.close(() => r()));
  if (savedUrl === undefined) delete process.env.OLLAMA_URL;
  else process.env.OLLAMA_URL = savedUrl;
  _resetUserSettingsCache();
});

describe('POST /api/ollama/load — endpoint ids (#3084 PR 3a)', () => {
  it('refuses an openai:<endpoint>::<model> id without contacting Ollama', async () => {
    const res = await request(app).post('/api/ollama/load').send({ model: 'openai:lab::qwen3:30b' });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ status: 'error', kind: 'error' });
    expect(res.body.error).toMatch(/not an Ollama model/i);
    expect(hits).toBe(0);
  });
});
