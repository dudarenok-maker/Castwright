/* #1801 — unit coverage for the shared sidecar-error → HTTP-status mapping. */

import { describe, it, expect } from 'vitest';
import { httpStatusForSidecarError } from './sidecar-error-status.js';
import { SidecarDesignError } from '../tts/design-voice-core.js';
import { NoCapacityError } from '../tts/tts-errors.js';

describe('httpStatusForSidecarError', () => {
  it('passes a SidecarDesignError 503 through (the free-VRAM-and-retry signal)', () => {
    expect(httpStatusForSidecarError(new SidecarDesignError('no capacity', 503))).toBe(503);
  });

  it('passes an upstream 500 through rather than masking it as 502', () => {
    expect(httpStatusForSidecarError(new SidecarDesignError('boom', 500))).toBe(500);
  });

  /* design-voice-core uses status 0 for unreachable / cancelled / timed-out.
     `res.status(0)` throws a RangeError, so anything outside 400–599 must fall
     back to the 502 gateway status. */
  it('clamps the status-0 unreachable case to 502', () => {
    expect(httpStatusForSidecarError(new SidecarDesignError('unreachable', 0))).toBe(502);
  });

  it('clamps a nonsense out-of-range status to 502', () => {
    expect(httpStatusForSidecarError(Object.assign(new Error('x'), { status: 999 }))).toBe(502);
    expect(httpStatusForSidecarError(Object.assign(new Error('x'), { status: 200 }))).toBe(502);
  });

  /* NoCapacityError is the ONE capacity signal that carries no `.status` —
     it's raised by withCapacityRetry after the poll window, not by an HTTP
     response, and it reaches the sample route un-wrapped (unlike the design
     path, where design-voice-core converts it into a SidecarDesignError 503). */
  it('maps a status-less NoCapacityError to 503', () => {
    expect(httpStatusForSidecarError(new NoCapacityError('qwen', 4096, 'cuda:0'))).toBe(503);
  });

  /* The plain-Error shape `tts/sidecar.ts` throwForResponse produces — a
     status the duck-type must honour even though `name` is just 'Error'. */
  it('honours the status on a plain annotated Error (SidecarTtsProvider shape)', () => {
    expect(
      httpStatusForSidecarError(
        Object.assign(new Error('Local voice engine returned 503: loading'), {
          transient: true,
          status: 503,
          poisoned: false,
        }),
      ),
    ).toBe(503);
  });

  it('falls back to 502 for an error with no status at all', () => {
    expect(httpStatusForSidecarError(new Error('sidecar not reachable'))).toBe(502);
    expect(httpStatusForSidecarError(undefined)).toBe(502);
  });

  it('honours an explicit fallback', () => {
    expect(httpStatusForSidecarError(new Error('x'), 500)).toBe(500);
  });
});
