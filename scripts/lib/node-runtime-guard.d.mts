// Type declarations for node-runtime-guard.mjs. Hand-written (the module ships
// as plain ESM JS so the launchers can import it without a build) so the
// server can statically import it with real types. Keep in lockstep.

export interface NodeCrashRange {
  from: string;
  toExclusive: string;
}

type Env = Readonly<Record<string, string | undefined>>;

export function parseNodeVersion(v: string): [number, number, number] | null;
export function findCrashRange(
  version: string,
  platform: string,
  ranges: readonly NodeCrashRange[],
): NodeCrashRange | null;
export function isCondaEnvNode(env: Env, execPath: string): boolean;
export function nodeRuntimeRefusal(
  version: string,
  platform: string,
  ranges: readonly NodeCrashRange[],
  minimum: string,
  env?: Env,
  execPath?: string,
): string | null;
export function loadCrashRanges(): NodeCrashRange[];
export function loadNodeMinimum(): string;
export function enforceNodeRuntime(deps?: {
  version?: string;
  platform?: string;
  env?: Env;
  execPath?: string;
  logDir?: string;
  stderr?: (text: string) => void;
  exit?: (code: number) => void;
  warn?: (text: string) => void;
}): void;
