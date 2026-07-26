/* #1801 — one place that decides what HTTP status a sidecar-boundary failure
   should surface as.

   The routes that call the TTS sidecar used to answer a flat 502 for every
   failure, which threw away the one distinction a caller can actually act on:
   a **503** means "no GPU capacity right now — free VRAM and retry", i.e. the
   request is worth repeating, while a 502 reads as "the gateway is broken".

   Two different error shapes reach these catches, so the mapping duck-types on
   SHAPE rather than `instanceof`:

   - `SidecarDesignError` (tts/design-voice-core.ts) — from the design path.
     `instanceof` is unreliable here because the error crosses a module
     boundary and route tests reject structurally-equal fakes; the same
     reasoning already documented on the /clone route's inline catch.
   - A plain `Error` annotated `{ transient, status, poisoned }` by
     `throwForResponse` (tts/sidecar.ts) — from the synth path. Its `name` is
     just 'Error', so any name-based check would miss it entirely.

   `NoCapacityError` is the exception that proves the rule: it is the capacity
   signal but carries no `.status`, because it's raised by `withCapacityRetry`
   after its poll window rather than by an HTTP response. The design path
   converts it into a `SidecarDesignError(…, 503)`; the synth path does not, so
   it reaches the sample route un-wrapped and is matched by name here. */
export function httpStatusForSidecarError(e: unknown): number {
  const err = e as { name?: string; status?: number } | undefined;
  if (err?.name === 'NoCapacityError') return 503;
  const status = err?.status;
  /* Only 5xx passes through — deliberately NOT 4xx.

     A 4xx from the sidecar describes OUR request to IT, not the caller's
     request to us, so forwarding it misattributes the fault and collides with
     meanings these routes already assign. The sidecar answers 409 for
     `voice_not_designed`, but /design-voice already uses 409 for "a Design
     full cast run is in progress" and for `gpu_busy` — a client treating 409
     as "busy, retry shortly" would retry forever on a condition that waiting
     never resolves. Likewise a sidecar 400 ("instruct too long") would tell
     the caller its own valid request was malformed. Those stay 502: the
     gateway leg failed, which is exactly what 502 means.

     (The sibling POST /api/voices/:voiceId/sample in voice-sample.ts maps
     `voice_not_designed` to a 409 with a friendly message and a `code` field
     rather than echoing the sidecar's body. Giving the library routes that
     same treatment is worth doing, but it's a separate change from #1801.)

     Anything outside the range also falls back — notably the `0`
     design-voice-core stamps on its unreachable / cancelled / timed-out
     branches, which would make `res.status(0)` throw a RangeError and degrade
     into a generic HTML 500, defeating the whole point of preserving the
     status. */
  return typeof status === 'number' && status >= 500 && status <= 599 ? status : 502;
}
