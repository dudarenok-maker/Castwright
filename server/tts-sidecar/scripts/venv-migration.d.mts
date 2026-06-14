// Type declarations for venv-migration.mjs — the pure venv decision core.
// Hand-written (the module ships as plain ESM JS) so the server runtime can
// statically `import` classifyVenvState/readStamp/resolveRequired from apply.ts
// with real types instead of the `@ts-expect-error`-suppressed `any` the test
// files use. Keep in lockstep with the JSDoc'd exports in venv-migration.mjs.

/** A venv stamp / a release's required descriptor. */
export interface VenvStamp {
  pythonTag: string;
  profile: string;
  reqHash: string;
  builtVersion?: string;
}

export type VenvAction = 'rebuild' | 'pip-in-place' | 'noop';
export type VenvState = 'fresh-bootstrap' | 'needs-reinstall' | 'pip-in-place' | 'noop';

export function computeReqHash(fileContents: string[]): string;

export function decideVenvAction(args: {
  stamp: VenvStamp | null;
  required: VenvStamp;
}): VenvAction;

export function stampPath(venvDir: string): string;

export function readStamp(venvDir: string): VenvStamp | null;

export function writeStamp(venvDir: string, stamp: VenvStamp): void;

export function classifyVenvState(args: {
  venvExists: boolean;
  stamp: VenvStamp | null;
  required: VenvStamp;
}): { action: VenvState };

export function resolveRequired(sidecarDir: string): {
  pythonTag: string;
  profile: 'nvidia';
  reqHash: string;
};
