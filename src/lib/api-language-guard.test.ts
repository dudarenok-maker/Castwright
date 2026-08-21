/* #2246 Task 9c — the two value-returning 409 sites wire to the language-guard
   bus with a selector and a parked-promise retry/dismiss contract:

     - analysis (realAnalyseManuscript) is manuscript-scoped → selector
       { manuscriptId }, saving retries and delivering the AnalyseResponse to
       the awaiting caller (acceptance 5);
     - qwen voice-design (realDesignQwenVoice) is book-scoped → selector
       { bookId }, saving retries and delivering the DesignQwenVoiceResponse —
       the caller receives the resolved voiceId (acceptance 6);
     - dismissing either modal rejects the awaiting caller with the original
       error, never a hang (acceptance 7);
     - emitLanguageGuard returns false for an unresolvable selector, so the
       caller keeps its existing error path (acceptance 8);
     - a 409 that is not language-unset still surfaces as today (acceptance 9). */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, type DesignQwenVoiceArgs } from './api';
import {
  setLanguageGuardHandler,
  type LanguageGuardRequest,
} from './language-guard-bus';

afterEach(() => {
  setLanguageGuardHandler(null);
  vi.unstubAllGlobals();
});

function jsonRes(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function sseRes(frames: string[]): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      frames.forEach((f) => controller.enqueue(encoder.encode(f)));
      controller.close();
    },
  });
  return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
}

const sse = (payload: unknown) => `data: ${JSON.stringify(payload)}\n\n`;

const qwenArgs = { sampleVoiceId: 's1', modelKey: 'coqui-xtts-v2' } as DesignQwenVoiceArgs;

describe('analysis 409 → language-guard (acceptance 5, 7, 8, 9)', () => {
  it('opens the guard for the manuscriptId book; saving retries and delivers its result', async () => {
    const requests: LanguageGuardRequest[] = [];
    setLanguageGuardHandler((req) => {
      requests.push(req);
      return true;
    });
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(new Response('{"error":"language_unset"}', { status: 409 }))
        .mockResolvedValueOnce(
          sseRes([
            sse({
              kind: 'result',
              response: {
                manuscriptId: 'm_hamlet',
                bookId: 'b_x',
                title: 'T',
                phaseTimings: [],
                characters: [],
                chapters: [],
                sentences: [],
              },
            }),
          ]),
        ),
    );

    const resultPromise = api.analyseManuscript('m_hamlet', { model: 'x' });
    await vi.waitFor(() => expect(requests.length).toBe(1));
    expect(requests[0].selector).toEqual({ manuscriptId: 'm_hamlet' });
    expect(requests[0].shape).toBe('409');

    requests[0].onRetry();
    const result = await resultPromise;
    expect(result.manuscriptId).toBe('m_hamlet');
  });

  it('dismissing the modal rejects the awaiting caller with the original error (acceptance 7)', async () => {
    const requests: LanguageGuardRequest[] = [];
    setLanguageGuardHandler((req) => {
      requests.push(req);
      return true;
    });
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response('{"error":"language_unset"}', { status: 409 })),
    );

    const resultPromise = api.analyseManuscript('m_hamlet', { model: 'x' });
    await vi.waitFor(() => expect(requests.length).toBe(1));

    const errPromise = resultPromise.then(
      () => {
        throw new Error('expected rejection, got a result');
      },
      (e) => e,
    );
    requests[0].onDismiss?.();
    const err = await errPromise;
    expect((err as Error).message).toBe('Analysis stream failed (409).');
  });

  it('an unresolvable selector falls back to the caller error path (acceptance 8)', async () => {
    setLanguageGuardHandler(() => false);
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response('{"error":"language_unset"}', { status: 409 })),
    );

    await expect(api.analyseManuscript('m_hamlet', { model: 'x' })).rejects.toThrow(
      'Analysis stream failed (409).',
    );
  });

  it('a non-language 409 still surfaces as an error (acceptance 9)', async () => {
    const requests: LanguageGuardRequest[] = [];
    setLanguageGuardHandler((req) => {
      requests.push(req);
      return true;
    });
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(jsonRes({ error: 'analysis already running' }, 409)),
    );

    await expect(api.analyseManuscript('m_hamlet', { model: 'x' })).rejects.toThrow(
      'Analysis stream failed (409).',
    );
    expect(requests.length).toBe(0);
  });
});

describe('qwen voice-design 409 → language-guard (acceptance 6, 7, 8, 9)', () => {
  it('opens the guard for the bookId; saving retries and delivers the resolved voiceId', async () => {
    const requests: LanguageGuardRequest[] = [];
    setLanguageGuardHandler((req) => {
      requests.push(req);
      return true;
    });
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(
          new Response('{"error":"Voices need a language first","code":"language_unset"}', {
            status: 409,
          }),
        )
        .mockResolvedValueOnce(jsonRes({ voiceId: 'v_new', url: 'u' })),
    );

    const resultPromise = api.designQwenVoice('b_q', 'c1', qwenArgs);
    await vi.waitFor(() => expect(requests.length).toBe(1));
    expect(requests[0].selector).toEqual({ bookId: 'b_q' });
    expect(requests[0].shape).toBe('409');

    requests[0].onRetry();
    const result = await resultPromise;
    expect(result.voiceId).toBe('v_new');
  });

  it('dismissing the modal rejects the awaiting caller with the original message (acceptance 7)', async () => {
    const requests: LanguageGuardRequest[] = [];
    setLanguageGuardHandler((req) => {
      requests.push(req);
      return true;
    });
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response('{"error":"Voices need a language first","code":"language_unset"}', { status: 409 })),
    );

    const resultPromise = api.designQwenVoice('b_q', 'c1', qwenArgs);
    await vi.waitFor(() => expect(requests.length).toBe(1));

    const errPromise = resultPromise.then(
      () => {
        throw new Error('expected rejection, got a result');
      },
      (e) => e,
    );
    requests[0].onDismiss?.();
    const err = await errPromise;
    expect((err as Error).message).toBe('Voices need a language first');
  });

  it('an unresolvable selector falls back to the caller error path (acceptance 8)', async () => {
    setLanguageGuardHandler(() => false);
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response('{"error":"Voices need a language first","code":"language_unset"}', { status: 409 })),
    );

    await expect(api.designQwenVoice('b_q', 'c1', qwenArgs)).rejects.toThrow(
      'Voices need a language first',
    );
  });

  it('a non-language 409 still surfaces as an error (acceptance 9)', async () => {
    const requests: LanguageGuardRequest[] = [];
    setLanguageGuardHandler((req) => {
      requests.push(req);
      return true;
    });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonRes({ error: 'already running' }, 409)));

    await expect(api.designQwenVoice('b_q', 'c1', qwenArgs)).rejects.toThrow('already running');
    expect(requests.length).toBe(0);
  });

  it('handles non-string error fields without toString() conversion (M4 regression)', async () => {
    // When the server response has a non-string error field (e.g., an object),
    // the error message should NOT contain "[object Object]"
    setLanguageGuardHandler(() => false);
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response('{"error":{"code":"DESIGN_ERROR","message":"failed"}}', { status: 500 }),
      ),
    );

    const promise = api.designQwenVoice('b_q', 'c1', qwenArgs);
    await expect(promise).rejects.toThrow();
    const err = await promise.catch((e) => e);
    // The error message should not contain the lossy "[object Object]" string
    expect((err as Error).message).not.toContain('[object Object]');
  });
});