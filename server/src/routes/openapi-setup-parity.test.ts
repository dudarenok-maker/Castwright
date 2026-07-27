/* fe-57 (#1883) — openapi.yaml is the published contract for /api/setup/*, but
   the server keeps its own TypeScript unions and never imports the generated
   frontend types (see workspace/voice-library.ts:9-10). Nothing else makes the
   two agree — a member added to setup-readiness.ts (or the sibling union files
   below) otherwise ships silently. That is the #1881 incident this issue was
   filed about. **This test is the only thing that prevents it.**

   Reads openapi.yaml at RUNTIME (no module-graph edge) — safe because
   openapi.yaml is already in vitest.config.ts's forceRerunTriggers (pinned by
   force-rerun-triggers.test.ts:108), so the ops-30/#1848 pin-inertness trap is
   already closed for this file. Mirrors the string-match mechanism
   voice-library.test.ts:1761 already uses against this same file — no YAML
   parser, no new dependency. */
import { describe, it, expect, beforeAll } from 'vitest';
import { readFile } from 'node:fs/promises';

let yaml: string;

beforeAll(async () => {
  yaml = await readFile(new URL('../../../openapi.yaml', import.meta.url), 'utf8');
});

/** The text of one `components.schemas` entry: from its own anchor up to (but
    not including) the next sibling schema at the same 4-space indent. */
function schemaBlock(schemaName: string): string {
  const anchor = `\n    ${schemaName}:\n`;
  const start = yaml.indexOf(anchor);
  expect(start, `schema ${schemaName} not found in openapi.yaml`).toBeGreaterThan(-1);
  const bodyStart = start + anchor.length;
  const rest = yaml.slice(bodyStart);
  const next = /\n {4}[A-Za-z][A-Za-z0-9]*:\n/.exec(rest);
  return rest.slice(0, next ? next.index : undefined);
}

/** The sorted members of the first `enum: [...]` in a block — inline
    (`{ type: string, enum: [...] }`) or on its own line, single- or
    multi-line (BlockerCause's enum wraps across several lines). */
function extractEnum(block: string): string[] {
  const m = /enum:\s*\[([\s\S]*?)\]/.exec(block);
  expect(m, `no enum: [...] found in block starting:\n${block.slice(0, 200)}`).not.toBeNull();
  return m![1]
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .sort();
}

/** A top-level schema whose OWN `type: string` carries the enum directly
    (BlockerCause, BlockerActionKind). */
function schemaEnum(schemaName: string): string[] {
  return extractEnum(schemaBlock(schemaName));
}

/** A union openapi.yaml describes inline on one property of a bigger schema
    rather than as its own named component — everything Tasks 2-3 added
    (RuntimeStatus.process, EngineStatus.state, EngineRecommendation.engine,
    VenvDetectResult.state, VenvBootstrapJob.status). */
function propertyEnum(schemaName: string, propertyName: string): string[] {
  const block = schemaBlock(schemaName);
  const idx = block.indexOf(`${propertyName}:`);
  expect(idx, `property ${propertyName} not found on schema ${schemaName}`).toBeGreaterThan(-1);
  return extractEnum(block.slice(idx));
}

/** Every `/api/setup/*` path key under `paths:` (2-space indent). Keeps
    `{id}`-style params literal, matching app.ts's `:id` param 1:1 in prose. */
function describedSetupPaths(): string[] {
  return [...yaml.matchAll(/^ {2}(\/api\/setup\/\S*):$/gm)].map((m) => m[1]);
}

/* The server-side unions restated as runtime arrays — the only hand-maintained
   duplicates left. When you add a member to the union in the cited file, add
   it here AND to openapi.yaml; this test is what tells you that you must. */
const SERVER_UNIONS: Record<
  string,
  { source: string; members: readonly string[]; read: () => string[] }
> = {
  BlockerCause: {
    source: 'server/src/routes/setup-readiness.ts',
    members: [
      'python-missing', 'venv-missing', 'venv-broken', 'supervisor-exhausted',
      'supervisor-tripped', 'unreachable-transient', 'unreachable-no-supervisor',
      'sidecar-blocked', 'no-engine-installed', 'weights-missing',
      'cannot-confirm-engine', 'package-broken', 'ffmpeg-missing',
      'ffprobe-missing', 'both-missing', 'ffmpeg-too-old', 'ollama-unreachable',
      'model-not-pulled', 'no-gemini-key', 'pass',
    ],
    read: () => schemaEnum('BlockerCause'),
  },
  BlockerActionKind: {
    source: 'server/src/routes/setup-readiness.ts',
    members: [
      'venv-bootstrap', 'qwen-install', 'kokoro-install', 'coqui-install',
      'sidecar-restart', 'ollama-install', 'ollama-pull', 'navigate',
    ],
    read: () => schemaEnum('BlockerActionKind'),
  },
  RuntimeProcessState: {
    source: 'server/src/tts/models-status.ts',
    members: ['ready', 'starting', 'down', 'crashed'],
    read: () => propertyEnum('RuntimeStatus', 'process'),
  },
  EngineHealthState: {
    source: 'server/src/tts/engine-health.ts',
    members: ['ready', 'package-missing', 'weights-missing', 'not-installed', 'loaded'],
    read: () => propertyEnum('EngineStatus', 'state'),
  },
  VoiceEngineId: {
    source: 'server/src/tts/voice-engine-registry.ts',
    members: ['kokoro', 'qwen', 'coqui'],
    read: () => propertyEnum('EngineRecommendation', 'engine'),
  },
  VenvBootstrapState: {
    source: 'server/src/tts/venv-bootstrap.ts',
    members: ['present', 'absent'],
    read: () => propertyEnum('VenvDetectResult', 'state'),
  },
  VenvBootstrapJobStatus: {
    source: 'server/src/tts/venv-bootstrap.ts',
    members: ['detecting', 'bootstrapping', 'installed', 'error'],
    read: () => propertyEnum('VenvBootstrapJob', 'status'),
  },
};

describe('openapi.yaml describes the /api/setup/* surface accurately', () => {
  it.each(Object.entries(SERVER_UNIONS))(
    '%s matches its TypeScript union',
    (name, { source, members, read }) => {
      expect(read(), `openapi.yaml's ${name} drifted from ${source}`).toEqual(
        [...members].sort(),
      );
    },
  );

  it('every /api/setup/* route the server mounts is described', () => {
    // Guards against a NEW endpoint shipping undescribed — the failure mode
    // that created this issue in the first place. Mounted in server/src/app.ts
    // via setupReadinessRouter, modelsStatusRouter, venvBootstrapRouter.
    expect(describedSetupPaths().sort()).toEqual([
      '/api/setup/complete',
      '/api/setup/models-status',
      '/api/setup/readiness',
      '/api/setup/smoke',
      '/api/setup/venv/bootstrap',
      '/api/setup/venv/bootstrap/{id}',
      '/api/setup/venv/bootstrap/{id}/recheck',
      '/api/setup/venv/detect',
    ]);
  });
});
