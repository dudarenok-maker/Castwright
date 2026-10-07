/* #3084 P22, A9 — leaf gate: the known analyzer secrets, readable from any route,
   analyzer or transport module without importing workspace/user-settings.ts (which
   would add an import edge that can close a cycle). user-settings.ts registers the
   provider at module load; server/src/index.ts imports user-settings.ts before any
   route or transport runs. Unregistered → [] (nothing known to redact): a module
   graph that never loaded user-settings.ts has no saved secret to leak. The names
   are the master contract's. */
export interface KnownSecretsProvider {
  /** synchronous view of the cached settings */
  known: () => string[];
  /** the same list after settings have been read at least once */
  load: () => Promise<string[]>;
}

let provider: KnownSecretsProvider | null = null;

export function registerKnownSecretsProvider(next: KnownSecretsProvider): void {
  provider = next;
}

export function knownAnalyzerSecrets(): string[] {
  return provider ? provider.known() : [];
}

export async function loadKnownAnalyzerSecrets(): Promise<string[]> {
  return provider ? provider.load() : [];
}
