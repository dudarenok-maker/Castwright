// Type declarations for server-owner.mjs. Hand-written (the module ships as
// plain ESM JS so the launchers can import it without a build) so the server can
// statically import it with real types. Keep in lockstep.

export interface ServerOwnerNote {
  pid: number;
  port: number;
  https: boolean;
  startedAt: string;
}

export function serverOwnerPath(runDir: string, port: number): string;
export function writeServerOwner(opts: {
  runDir: string;
  port: number;
  https: boolean;
  pid?: number;
  now?: () => Date;
}): void;
export function readServerOwner(runDir: string, port: number): ServerOwnerNote | null;
export function releaseServerOwner(runDir: string, port: number, pid?: number): void;
export function pruneDeadServerOwners(runDir: string, alive?: (pid: number) => boolean): void;
