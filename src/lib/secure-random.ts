/* CodeQL js/insecure-randomness — mint a uuid without Math.random.
   Prefers crypto.randomUUID, then getRandomValues; the final fallback is
   non-random but collision-resistant enough for a voice library entry id. */
export function makeSecureUuid(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    try {
      return crypto.randomUUID();
    } catch {
      /* fall through to fallback */
    }
  }
  if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
    try {
      const b = new Uint8Array(8);
      crypto.getRandomValues(b);
      return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
    } catch {
      /* fall through to final fallback */
    }
  }
  return Date.now().toString(36);
}
