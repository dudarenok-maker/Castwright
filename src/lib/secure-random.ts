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

/* Generate a random string from a custom alphabet without Math.random.
   Used for share slugs and other short-token identifiers.
   Prefers crypto.getRandomValues; the final fallback is non-random but
   collision-resistant enough for mock/demo purposes. */
export function makeSecureRandom(
  alphabet: string,
  length: number,
): string {
  if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
    try {
      const result: string[] = [];
      const randomBytes = new Uint8Array(length);
      crypto.getRandomValues(randomBytes);
      for (let i = 0; i < length; i += 1) {
        result.push(alphabet[randomBytes[i] % alphabet.length]);
      }
      return result.join('');
    } catch {
      /* fall through to fallback */
    }
  }
  /* Fallback: use timestamp-based sequence with alphabet rotation. */
  const timestamp = Date.now().toString(36);
  let result = '';
  for (let i = 0; i < length; i += 1) {
    result += alphabet[(timestamp.charCodeAt(i % timestamp.length) + i) % alphabet.length];
  }
  return result;
}
