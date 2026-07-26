/* fs-38 / #1836 — the cap on a clone-wizard transcript, in UTF-16 units.
 *
 * The transcript is the first CLIENT-controlled value to reach the derive's
 * `ref_text`, which travels to the sidecar as a base64 `X-Ref-Text` header, so
 * it is bounded — and rejected rather than truncated, since a silent trim is
 * the exact bug class #1836 fixed.
 *
 * Deliberately its own module rather than a `src/lib/api.ts` export, for two
 * reasons: `e2e/voice-library.spec.ts` needs the value in a Node/Playwright
 * process, and dragging ~9,900 lines of browser-facing api.ts in for one
 * number is not viable; and 81 files under `src/` do `vi.mock('…lib/api')`, so
 * an api.ts export would be one forgotten factory key away from resolving to
 * `undefined` in some future test. (That failure would be loud, not silent —
 * the capture panel's own cap test would time out — but a constant nothing can
 * mock away is simply cheaper than relying on that.)
 *
 * TWO other copies of this number exist:
 *   - `MAX_CLONE_TRANSCRIPT_CHARS` in `server/src/routes/voice-library.ts`
 *   - `CloneVoiceRequest.transcript.maxLength` in `openapi.yaml` (plus the
 *     byte arithmetic in that schema's description)
 * `src/lib/api-types.ts` is NOT a third: openapi-typescript does not encode
 * `maxLength`, so the generated type carries no bound and cannot drift.
 * `api.clone-voice.test.ts` pins this constant against the contract, and
 * `server/src/routes/voice-library.test.ts` pins the route's against it too —
 * so raising one without the others fails on both sides of the wire.
 */
export const MAX_CLONE_TRANSCRIPT_CHARS = 2000;
