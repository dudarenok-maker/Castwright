# OpenAPI source of truth

> Status: stable
> Key files: `openapi.yaml`, `src/lib/api-types.ts` (generated), `src/lib/types.ts` (overrides + app-domain types)
> URL surface: none
> OpenAPI ops: all of them — this is the contract

## What this covers

`openapi.yaml` is the contract between frontend and backend. `npm run openapi:types` regenerates `src/lib/api-types.ts` from the spec; `src/lib/types.ts` re-exports the generated types under app-friendly names and applies a small number of explicit overrides for shapes the generator widens too loosely. App-domain types not modelled in the spec (e.g. `Stage`, `ChangeLogEvent`, `ListenerApp`) also live in `src/lib/types.ts`.

## Invariants to preserve

- `Character`, `Chapter`, `Sentence`, `Revision`, `DriftEvent`, `MatchFactor`, `GenerationTick`, `ChapterAudio`, `UploadResponse`, `AnalyseResponse`, `VoiceMatchResponse`, `RevisionsResponse`, `VoiceSample`, `VoiceSampleRequest` all re-export from `components['schemas']` in `src/lib/types.ts:1-24`.
- Explicit overrides MUST stay commented to explain why:
  - `Sentence` adds `confidence?: number` — UI-only field for low-confidence flagging (`types.ts:10-12`).
  - `Voice.gradient` narrowed from `string[]` to `[string, string]` — generator widens our tuple; renderer relies on the tuple shape (`types.ts:37-39`).
  - `TtsModelKey = NonNullable<VoiceSampleRequest['modelKey']>` — strips the optional/null off the generated type (`types.ts:24`).
- App-domain types (`Stage`, `Book`, `ImportCandidate`, `ConfirmBookRequest`, `BookStateJson`, `LibraryBook`, `ChangeLogEvent`, `ListenerApp`, `WalkthroughStep`, `RegenReason`, `AnalysisPhase`, `ExportQueueItem`, `View`) live in `src/lib/types.ts` and are NOT in the OpenAPI spec; they're internal-to-frontend.
- `npm run openapi:types` is the only blessed way to regenerate `api-types.ts`. Do not hand-edit the generated file.
- `tsc --noEmit` must stay clean against both the generated types and the explicit overrides; if a regen breaks the build, fix the override or fix the spec — never `@ts-ignore`.

## Acceptance walkthrough

1. **Cold check** — `npm run typecheck` passes on `main`.
2. **Regen round-trip** — `npm run openapi:types` then `npm run typecheck`. Should still pass with no diff (apart from regeneration metadata if any).
3. **Forcing a breakage** — in `openapi.yaml`, change `Character.gender` from `string` enum to `number`. Regen types. `npm run typecheck` should fail in the consumer code that reads `character.gender`. Confirm the failure points at the consumer, not the generated file. Revert.
4. **Override audit** — read `src/lib/types.ts` top-to-bottom; every override carries a comment explaining why. Any new override without a comment is a refactor smell.
5. **App-domain type test** — adding `Stage = ... | { kind: 'newvariant' }` requires no regen — these aren't in the spec by design.
6. **Drift check** — search for `as any` or `// @ts-ignore` near generated types. Should be zero in components.

## Out of scope

- Backend codegen from `openapi.yaml` — server is hand-written and validates by Zod schemas independently. The frontend trusts the spec; the server validates against it.
- Tooling choice (`openapi-typescript` vs alternatives) — fungible behind the npm script.
- Spec-first vs code-first for new endpoints — convention is spec-first; new endpoints land in `openapi.yaml` before types or implementation.
