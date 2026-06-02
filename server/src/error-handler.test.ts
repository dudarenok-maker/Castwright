import { describe, it, expect, vi, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { errorHandler } from './error-handler.js';

/* srv-24 — Express 5 forwards a rejected promise from an async handler into the
   error pipeline (Express 4 hung instead). These tests pin that errorHandler
   converts both async rejections and sync throws into a clean 500 JSON body. */

afterEach(() => vi.restoreAllMocks());

function appThatThrows(handler: express.RequestHandler) {
  const app = express();
  app.get('/boom', handler);
  app.use(errorHandler);
  return app;
}

describe('errorHandler (Express 5 global error backstop)', () => {
  it('turns an async-rejecting handler into 500 JSON', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const app = appThatThrows(async () => {
      throw new Error('async boom');
    });
    const res = await request(app).get('/boom');
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'Internal server error.' });
  });

  it('turns a sync-throwing handler into 500 JSON', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const app = appThatThrows(() => {
      throw new Error('sync boom');
    });
    const res = await request(app).get('/boom');
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'Internal server error.' });
  });

  it('delegates (does not write a 500 body) when the response already started', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    // Once headers are sent (e.g. an SSE generation route mid-stream), writing
    // a 500 body would corrupt the in-flight response — so errorHandler must
    // hand the error back to Express's default handler instead.
    const status = vi.fn();
    const json = vi.fn();
    const next = vi.fn();
    const res = { headersSent: true, status, json } as unknown as import('express').Response;
    errorHandler(new Error('after headers'), {} as never, res, next);
    expect(next).toHaveBeenCalledOnce();
    expect(status).not.toHaveBeenCalled();
    expect(json).not.toHaveBeenCalled();
  });
});
