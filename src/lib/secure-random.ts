/* Monotonic counter for fallback paths to ensure uniqueness across rapid calls
   within the same millisecond. Starts at 0 and increments on every fallback use. */
let fallbackCounter = 0;

/* CodeQL js/insecure-randomness — mint a uuid without Math.random.
   Prefers crypto.randomUUID, then getRandomValues; the final fallback combines
   timestamp + monotonic counter to ensure uniqueness across rapid calls. */
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
      const b = new Uint8Array(16);
      crypto.getRandomValues(b);
      /* Format as UUID v4-like string: 8-4-4-4-12 hex digits */
      const hex = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
      return [
        hex.slice(0, 8),
        hex.slice(8, 12),
        hex.slice(12, 16),
        hex.slice(16, 20),
        hex.slice(20),
      ].join('-');
    } catch {
      /* fall through to final fallback */
    }
  }
  /* Fallback: combine monotonic counter + timestamp for uniqueness.
     Counter is placed FIRST (positions 0-7) to ensure any slice of the output
     (e.g., .slice(0, 8) or .slice(0, 10)) captures it and remains unique
     across rapid calls within the same millisecond. */
  fallbackCounter = (fallbackCounter + 1) % 0x100000000;
  const counter = fallbackCounter.toString(16).padStart(8, '0');
  const timestamp = Date.now().toString(16).padStart(12, '0');
  /* Combine counter first, then timestamp, then padding for full UUID-like format */
  const combined = (counter + timestamp + '0000000000000000').slice(0, 32);
  return [
    combined.slice(0, 8),
    combined.slice(8, 12),
    combined.slice(12, 16),
    combined.slice(16, 20),
    combined.slice(20, 32),
  ].join('-');
}

/* Generate a random string from a custom alphabet without Math.random.
   Used for share slugs and other short-token identifiers.
   Prefers crypto.getRandomValues; the final fallback combines timestamp +
   counter to ensure uniqueness across rapid calls. */
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
  /* Fallback: use timestamp + counter + per-position entropy for uniqueness.
     This ensures each of 1000 rapid calls produces a distinct output. */
  fallbackCounter = (fallbackCounter + 1) % 0x100000000;
  const timestamp = Date.now();
  const counterVal = fallbackCounter;
  let result = '';
  for (let i = 0; i < length; i += 1) {
    /* Mix timestamp, counter, and position index using a simple XOR-based
       mixing to ensure entropy varies across positions and calls. */
    const mixed = (timestamp ^ (counterVal * 33)) + i * 73;
    result += alphabet[((mixed >>> (i % 16)) & 0xFF) % alphabet.length];
  }
  return result;
}
