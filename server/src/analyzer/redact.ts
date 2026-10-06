/* Redact known credentials from upstream error text before it is logged or
   shown (#3084 Global Constraints "Secrets"). Pure: callers pass the secrets.
   Values shorter than 8 characters are ignored — they would blank ordinary
   words. Wave 5's payload redaction applies the same length rule. */
export const REDACTED = '[redacted]';

export function redactKnownSecrets(
  text: string,
  secrets: ReadonlyArray<string | null | undefined>,
): string {
  const raw = secrets.filter((s): s is string => typeof s === 'string' && s.length >= 8);
  /* A key holding `"` or `\` also appears in its JSON-escaped spelling once an error body
     is stringified, so that spelling is redacted too (it differs only for those keys). */
  const usable = [...new Set([...raw, ...raw.map((s) => JSON.stringify(s).slice(1, -1))])].sort(
    (a, b) => b.length - a.length,
  );
  let out = text;
  for (const secret of usable) out = out.split(secret).join(REDACTED);
  return out;
}
