/* fs-38 / #1836 — the cap on a clone-wizard transcript, in UTF-16 units.
 *
 * The transcript is the first CLIENT-controlled value to reach the derive's
 * `ref_text`, which travels to the sidecar as a base64 `X-Ref-Text` header, so
 * it is bounded — and rejected rather than truncated, since a silent trim is
 * the exact bug class #1836 fixed.
 *
 * Deliberately its own module rather than a `src/lib/api.ts` export: the
 * capture panel's tests `vi.mock('../../lib/api')`, and a mock factory that
 * forgot to re-export the constant would leave the panel comparing against
 * `undefined` — disabling the guard silently. Nothing can mock this away.
 *
 * Three OTHER copies of this number exist and are pinned against each other by
 * test, not by prose:
 *   - `MAX_CLONE_TRANSCRIPT_CHARS` in `server/src/routes/voice-library.ts`
 *   - `CloneVoiceRequest.transcript.maxLength` in `openapi.yaml`
 *   - (via that schema) `src/lib/api-types.ts`
 * `api.clone-voice.test.ts` pins this constant against the contract, and
 * `server/src/routes/voice-library.test.ts` pins the route's against it too —
 * so raising one without the others fails on both sides of the wire.
 */
export const MAX_CLONE_TRANSCRIPT_CHARS = 2000;
