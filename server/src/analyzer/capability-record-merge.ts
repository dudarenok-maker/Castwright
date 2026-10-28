/* #3084 wave 5 (N14, A2) — pure Test-record helpers. Structural types: this module imports nothing. */

interface CapabilityRecordShape {
  serverUrl: string;
  testedAt: string;
  structuredOutput: object;
  reasoning: object;
  /** 3c (A3) — Ollama only: the model build's /api/tags digest when the Test ran. Mirrored here
      structurally, not imported, since this leaf imports nothing. */
  digest?: string;
  /** A2 — each verdict's own Test date, keyed like the verdicts. */
  verdictTestedAt?: { reasoning?: Record<string, string>; structuredOutput?: Record<string, Record<string, string>> };
}

/** Moved from capabilities.ts (W3c), body unchanged: a record belongs to the server it was taken on. */
export function sameServer(a: string, b: string): boolean {
  return a.replace(/\/+$/, '') === b.replace(/\/+$/, '');
}

/** A2 — the dates a record's verdicts carry: its own `verdictTestedAt`, with every verdict it does not
    name (a record written before that field existed) taking the record's own `testedAt`. */
function verdictDates(record: CapabilityRecordShape): {
  reasoning: Record<string, string>;
  structuredOutput: Record<string, Record<string, string>>;
} {
  const reasoning: Record<string, string> = {};
  for (const level of Object.keys(record.reasoning)) {
    reasoning[level] = record.verdictTestedAt?.reasoning?.[level] ?? record.testedAt;
  }
  const structuredOutput: Record<string, Record<string, string>> = {};
  for (const [mode, byLevel] of Object.entries(record.structuredOutput as Record<string, Record<string, string> | undefined>)) {
    structuredOutput[mode] = {};
    for (const level of Object.keys(byLevel ?? {})) {
      structuredOutput[mode][level] = record.verdictTestedAt?.structuredOutput?.[mode]?.[level] ?? record.testedAt;
    }
  }
  return { reasoning, structuredOutput };
}

/** N14 — a Test merges the verdicts it probed into the model's record for the same server URL: only the
    probed `reasoning` levels and `structuredOutput[mode][level]` cells are replaced, `testedAt` is the
    latest, and every kept verdict keeps its own date (A2). A record for another server, or one whose
    `digest` (3c) differs from this Test's (A2 — a re-pulled Ollama build; a digest present on one side
    only proves nothing), or none at all, is replaced by `next` as is. */
export function mergeCapabilityRecords<R extends CapabilityRecordShape>(previous: R | undefined, next: R): R {
  if (!previous || !sameServer(previous.serverUrl, next.serverUrl) || previous.digest !== next.digest) return next;
  const before = previous.structuredOutput as Record<string, Record<string, string> | undefined>;
  const structuredOutput: Record<string, Record<string, string>> = { ...(before as Record<string, Record<string, string>>) };
  for (const [mode, byLevel] of Object.entries(next.structuredOutput as Record<string, Record<string, string>>)) {
    structuredOutput[mode] = { ...(before[mode] ?? {}), ...byLevel };
  }
  const dates = { previous: verdictDates(previous), next: verdictDates(next) };
  const modeDates: Record<string, Record<string, string>> = { ...dates.previous.structuredOutput };
  for (const [mode, byLevel] of Object.entries(dates.next.structuredOutput)) {
    modeDates[mode] = { ...(dates.previous.structuredOutput[mode] ?? {}), ...byLevel };
  }
  return {
    ...next,
    testedAt: Date.parse(previous.testedAt) > Date.parse(next.testedAt) ? previous.testedAt : next.testedAt,
    structuredOutput,
    reasoning: { ...previous.reasoning, ...next.reasoning },
    verdictTestedAt: { reasoning: { ...dates.previous.reasoning, ...dates.next.reasoning }, structuredOutput: modeDates },
  } as R;
}
