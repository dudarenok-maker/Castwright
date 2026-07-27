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
/* Type-only imports — fully erased at runtime, so they add no module-graph
   edge (the runtime read of openapi.yaml stays the only file dependency).
   These are what turn the member lists below from a THIRD hardcoded literal
   into a compile-time assertion against the server's real unions. */
import type { BlockerCause, BlockerActionKind } from './setup-readiness.js';
import type { RuntimeProcessState } from '../tts/models-status.js';
import type { EngineHealthState } from '../tts/engine-health.js';
import type { VoiceEngineId } from '../tts/voice-engine-registry.js';
import type { VenvBootstrapState, VenvBootstrapJobStatus } from '../tts/venv-bootstrap.js';

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

/* Each map is `satisfies Record<TheServerUnion, 1>`, which is what makes this
   test guard the case that matters. A bare array of strings would only pin
   openapi.yaml against a THIRD hardcoded literal — so editing the server union
   alone would still pass, which is exactly the #1877/#1881 forget-mode this
   issue exists to close (and which an earlier draft of this file did not
   catch).

   With `satisfies`, adding a member to the server union makes THIS FILE fail
   `npm run typecheck` with a missing key, and removing one fails with an
   excess key. The runtime assertion below then carries that same set over to
   openapi.yaml. Same idiom as src/data/help-failures.ts:49.

   Chain: server union --(satisfies, compile time)--> this map
          --(toEqual, runtime)--> openapi.yaml --(codegen)--> api-types.ts */
const BLOCKER_CAUSES = {
  'python-missing': 1, 'venv-missing': 1, 'venv-broken': 1,
  'supervisor-exhausted': 1, 'supervisor-tripped': 1, 'unreachable-transient': 1,
  'unreachable-no-supervisor': 1, 'sidecar-blocked': 1, 'no-engine-installed': 1,
  'weights-missing': 1, 'cannot-confirm-engine': 1, 'package-broken': 1,
  'ffmpeg-missing': 1, 'ffprobe-missing': 1, 'both-missing': 1,
  'ffmpeg-too-old': 1, 'ollama-unreachable': 1, 'model-not-pulled': 1,
  'no-gemini-key': 1, pass: 1,
} satisfies Record<BlockerCause, 1>;

const BLOCKER_ACTION_KINDS = {
  'venv-bootstrap': 1, 'qwen-install': 1, 'kokoro-install': 1, 'coqui-install': 1,
  'sidecar-restart': 1, 'ollama-install': 1, 'ollama-pull': 1, navigate: 1,
} satisfies Record<BlockerActionKind, 1>;

const RUNTIME_PROCESS_STATES = {
  ready: 1, starting: 1, down: 1, crashed: 1,
} satisfies Record<RuntimeProcessState, 1>;

const ENGINE_HEALTH_STATES = {
  ready: 1, 'package-missing': 1, 'weights-missing': 1, 'not-installed': 1, loaded: 1,
} satisfies Record<EngineHealthState, 1>;

const VOICE_ENGINE_IDS = {
  kokoro: 1, qwen: 1, coqui: 1,
} satisfies Record<VoiceEngineId, 1>;

const VENV_BOOTSTRAP_STATES = {
  present: 1, absent: 1,
} satisfies Record<VenvBootstrapState, 1>;

const VENV_BOOTSTRAP_JOB_STATUSES = {
  detecting: 1, bootstrapping: 1, installed: 1, error: 1,
} satisfies Record<VenvBootstrapJobStatus, 1>;

const SERVER_UNIONS: Record<
  string,
  { source: string; members: readonly string[]; read: () => string[] }
> = {
  BlockerCause: {
    source: 'server/src/routes/setup-readiness.ts',
    members: Object.keys(BLOCKER_CAUSES),
    read: () => schemaEnum('BlockerCause'),
  },
  BlockerActionKind: {
    source: 'server/src/routes/setup-readiness.ts',
    members: Object.keys(BLOCKER_ACTION_KINDS),
    read: () => schemaEnum('BlockerActionKind'),
  },
  RuntimeProcessState: {
    source: 'server/src/tts/models-status.ts',
    members: Object.keys(RUNTIME_PROCESS_STATES),
    read: () => propertyEnum('RuntimeStatus', 'process'),
  },
  EngineHealthState: {
    source: 'server/src/tts/engine-health.ts',
    members: Object.keys(ENGINE_HEALTH_STATES),
    read: () => propertyEnum('EngineStatus', 'state'),
  },
  VoiceEngineId: {
    source: 'server/src/tts/voice-engine-registry.ts',
    members: Object.keys(VOICE_ENGINE_IDS),
    read: () => propertyEnum('EngineRecommendation', 'engine'),
  },
  VenvBootstrapState: {
    source: 'server/src/tts/venv-bootstrap.ts',
    members: Object.keys(VENV_BOOTSTRAP_STATES),
    read: () => propertyEnum('VenvDetectResult', 'state'),
  },
  VenvBootstrapJobStatus: {
    source: 'server/src/tts/venv-bootstrap.ts',
    members: Object.keys(VENV_BOOTSTRAP_JOB_STATUSES),
    read: () => propertyEnum('VenvBootstrapJob', 'status'),
  },
};

describe('openapi.yaml describes the /api/setup/* surface accurately', () => {
  it.each(Object.entries(SERVER_UNIONS))(
    '%s matches its TypeScript union',
    (name, { source, members, read }) => {
      expect(
        read(),
        `openapi.yaml's ${name} disagrees with this test's exhaustive map. ` +
          `The authority is ${source}; if you just changed that union, typecheck ` +
          `will have failed here too — update openapi.yaml to match.`,
      ).toEqual(
        [...members].sort(),
      );
    },
  );

  it('every /api/setup/* route the server mounts is described', () => {
    /* NOTE the limit of this one: the expected list is a literal, NOT derived
       from the routers, so it catches a path being REMOVED from openapi.yaml
       but not a brand-new route being mounted without a description. Deriving
       it from server/src/app.ts's mounts is the honest fix; recorded as a
       known limitation in plan 270 rather than overclaimed here.
       Mounted via setupReadinessRouter, modelsStatusRouter, venvBootstrapRouter. */
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
