# Castwright MCP agent surface (`fs-44`) — design

_Status: approved · 2026-06-11_

## Context

Users increasingly run agents (Claude Cowork, Claude Code, Codex, Copilot CLI, Gemini
CLI, Cursor…) as their primary working surface. Today the only way an agent can drive
Castwright is computer-use button-clicking against the web UI — slow, brittle, and
impossible headless. Castwright already has everything an agent needs underneath:
a complete REST API (`openapi.yaml` is the contract), server-owned long-running jobs
with progress state, and a local-first single-user trust model.

This spec defines an **MCP (Model Context Protocol) server surface** so any MCP-capable
agent can drive the full pipeline — upload → analyze → cast → generate → export —
programmatically. MCP is the right vehicle because it is the one integration standard
all the major agent harnesses share.

**Decisions made in the 2026-06-11 brainstorm:**

- **Scope: full pipeline parity** — the agent is a true alternative driver, including
  cast editing and voice design, not just a happy-path trigger.
- **Architecture: in-process Streamable-HTTP endpoint first, stdio shim as a planned
  wave** ("both" option) — HTTP endpoint is the single source of truth; the shim exists
  for clients with weak/no HTTP-transport support.
- **Priority: Should** (top of bucket) — strategic capability, not a v1 ship blocker.
- **Client-agnostic by requirement:** must work with whatever agent the user already
  uses — Claude family, Codex, Copilot, Gemini CLI, Cursor, etc. Therefore the surface
  uses **core-spec MCP only** (tools + JSON/text results). No reliance on
  client-optional features: no sampling, no elicitation, no roots; tool annotations
  (`readOnlyHint`/`destructiveHint`) are attached but treated as advisory hints, never
  load-bearing.

## Goals / non-goals

**Goals**

1. An MCP client can take a manuscript file and end with an exported audiobook without
   the web UI ever opening.
2. An MCP client can inspect everything it needs to act intelligently: book/pipeline
   state, cast + voice assignments, job progress + errors, system/engine health.
3. Long-running operations (analysis ≈ minutes, generation ≈ hours) are first-class:
   job handles, progress polling, and an efficient long-poll wait.
4. Works with any MCP client the user already has, over both supported transports.

**Non-goals (v1)**

- No second implementation of business logic — every tool calls the same route/service
  layer the REST API uses. `openapi.yaml` stays the single contract; MCP is a curated
  façade.
- No new auth system — the endpoint sits behind the existing `requireLanToken` guard
  (localhost free, LAN needs token, TLS via `start:lan`), identical to `/api`.
- No multi-user/concurrency model beyond what the app has (single user per workspace;
  the UI and an agent are the same trust domain — last-writer-wins, same as two tabs).
- No MCP resources/prompts in v1 (tools only). Resources (`state.json`, `cast.json` as
  readable resources) are a noted follow-up.
- No destructive library operations (delete book, replace manuscript) in v1 — keep the
  blast radius small; add later behind `destructiveHint` if demand shows.

## Architecture

```
agent (any MCP client)
  │  streamable HTTP            │  stdio (wave 4 shim)
  ▼                             ▼
POST /mcp  ◄──────────  castwright-mcp bin (thin proxy → HTTP endpoint)
  │
  Express server (server/src/index.ts, :8080 / :8443)
  │   @modelcontextprotocol/sdk  StreamableHTTPServerTransport (stateless mode)
  ▼
server/src/mcp/  (new)
  ├─ register-tools.ts   — tool defs: zod schemas + descriptions + annotations
  ├─ tool-handlers/      — thin adapters onto the existing route/service layer
  └─ job-view.ts         — uniform job-status projection (analysis / generation /
                            cast-design / export job state → one shape)
```

- **Mount:** `app.use('/mcp', mcpRouter)` after `requireLanToken` joins the guard list
  (`app.use(['/api', '/workspace', '/mcp'], requireLanToken)`).
- **Transport:** stateless `StreamableHTTPServerTransport` — no session affinity needed
  (single-user server), maximally compatible across clients.
- **Connect (docs ship per-client snippets):**
  - Claude Code: `claude mcp add --transport http castwright http://localhost:8080/mcp`
  - Codex: `[mcp_servers.castwright]` TOML entry (stdio shim if HTTP unsupported)
  - Copilot CLI / Gemini CLI / Cursor: respective MCP config JSON.
- **stdio shim (wave 4):** a `castwright-mcp` bin in the server package that bridges
  stdio ↔ the local HTTP endpoint. It contains zero tool logic — pure transport proxy —
  so the tool surface can never fork between transports.

## Tool surface (v1 — ~15 hand-designed, workflow-level tools)

Hand-curated, not auto-generated from `openapi.yaml`: the REST surface is ~60 routes of
UI-grained CRUD; agents need fewer, fatter, goal-shaped tools with strong descriptions.
All results are structured JSON content plus a one-line text summary (works in every
client). All IDs (`bookId`, `chapterId`, `characterId`, `voiceId`, `jobId`) round-trip
through tool results so the agent never guesses.

**Read / inspect** (`readOnlyHint: true`)

| Tool | What it returns |
| --- | --- |
| `list_books` | Library: id, title/author/series, pipeline stage, chapter counts (analyzed/generated), last activity |
| `get_book` | One book in depth: stage, per-chapter status + durations, cast summary, exports, active jobs |
| `get_cast` | Characters: id, name, aliases, engine + assigned voice, designed-voice/variant status, line counts |
| `list_voices` | Voice library: engine, language, base vs designed, pinned, in-use-by |
| `get_job` | Any job's status: phase, progress %, per-chapter detail, errors, timestamps |
| `get_system_status` | Sidecar/engine/VRAM/analyzer health + active-job overview (wraps diagnostics + health) |

**Pipeline actions**

| Tool | Behaviour |
| --- | --- |
| `upload_manuscript` | File path (server-local) or inline text + title/author/series → `bookId` |
| `start_analysis` | Whole book or chapter subset → `jobId` |
| `start_generation` | Whole book or chapter subset → `jobId`; refuses with a clear message if cast has blocking gaps |
| `export_audiobook` | Format (m4b/mp3/ogg/zip) → `jobId` → result carries the output file path |

**Cast & voice (the parity part)**

| Tool | Behaviour |
| --- | --- |
| `update_character` | Rename / set engine + voice assignment for one character |
| `merge_characters` | Merge source character into target (same op as the UI merge) |
| `design_voice` | Qwen voice design for one character (optionally from a persona brief) → `jobId` |
| `design_full_cast` | Bulk design for every "needs voice" character (scope: bases/variants/both) → `jobId` |

**Job control**

| Tool | Behaviour |
| --- | --- |
| `wait_for_job` | Long-poll: blocks up to `timeoutSec` (cap ~120 s), returns early on completion/failure/phase change. Agents chain calls instead of busy-looping `get_job`. |

**Long-running job model.** Every long op already runs as a server-owned job with
progress state (SSE feeds the UI). MCP adds a uniform projection (`job-view.ts`) over
the per-domain job shapes and exposes it via `get_job`/`wait_for_job`. SSE stays
UI-only; agents poll — robust in every client, no dependence on MCP progress
notifications (client support varies).

**Error shape.** Tool errors return `isError: true` with a structured payload:
`{ code, message, remediation }` — e.g. a generation start while the sidecar is down
returns the health detail and "load the engine via get_system_status / retry", so the
agent can self-serve recovery.

## Security

- Same trust boundary as the UI: behind `requireLanToken`; localhost unauthenticated
  (matches today's UI posture), LAN requires the token, HTTPS in `start:lan` mode.
- No new write primitives beyond what `/api` already exposes; v1 omits destructive ops.
- `upload_manuscript` file-path mode reads server-local paths only (it is the same
  machine/trust domain); no URL fetch — no SSRF surface.
- Tool annotations mark read-only vs mutating tools so cautious clients can gate
  approvals; never relied on for safety.

## Testing

- **Unit/integration (vitest, server):** drive the mounted endpoint with the real
  `@modelcontextprotocol/sdk` client over an in-memory/supertest transport. Cover: tool
  listing, each tool happy path, error shapes, guard behaviour (LAN token), job
  projection over each job family.
- **Pipeline e2e (mock engines):** one spec that runs upload → analyze → generate →
  export entirely through the MCP client against mock analyzer/sidecar — doubling as
  the pipeline integration test the server suite currently lacks.
- **Manual acceptance:** from a real agent (Claude Code + one non-Claude client, e.g.
  Codex or Copilot CLI), drive a small public-domain manuscript end-to-end (pairs
  naturally with the `fs-22` bundled demo book).

## Delivery roadmap / v1 DoD

- **Wave 1 — endpoint + read parity:** `/mcp` mount, SDK wiring, the six read tools,
  `get_job`/`wait_for_job`. _Gate:_ vitest suite green; an agent can narrate full
  library + job state.
- **Wave 2 — pipeline actions:** `upload_manuscript`, `start_analysis`,
  `start_generation`, `export_audiobook`. _Gate:_ mock-mode pipeline e2e green.
- **Wave 3 — cast & voice parity + docs:** `update_character`, `merge_characters`,
  `design_voice`, `design_full_cast`; README/INSTALL "Driving Castwright from an agent"
  with per-client connect snippets. _Gate:_ manual acceptance from two different agent
  harnesses (one Claude, one non-Claude).
- **Wave 4 (follow-up) — stdio shim:** `castwright-mcp` bin proxying to the HTTP
  endpoint, for clients without solid HTTP-transport support.
- **Follow-ups (not v1):** MCP resources (`state.json`/`cast.json`), destructive ops
  behind `destructiveHint`, prompts (canned "produce this book" recipes).

**v1 DoD:** waves 1–3 shipped; a fresh agent session (Claude + one non-Claude harness)
takes a manuscript to an exported audiobook with zero UI interaction; full vitest +
pipeline-e2e coverage; docs published.

## Key files

- `server/src/index.ts` — mount + guard wiring
- `server/src/mcp/` (new) — registration, handlers, job projection
- `server/src/routes/*` — the service seams the handlers call
- `openapi.yaml` — contract the façade stays aligned with
- `server/package.json` — `@modelcontextprotocol/sdk` dep (+ wave-4 `castwright-mcp` bin)

## Open questions (resolve at implementation time)

1. Whether any extracted route logic needs a service-layer refactor first (several
   routes inline their logic; handlers may need small extractions — keep surgical).
2. `wait_for_job` long-poll vs client timeout defaults across harnesses (cap below the
   most impatient client default).
3. Whether `start_generation` should auto-queue behind an active generation (reuse the
   existing queue) or refuse — lean: enqueue, report queue position.
