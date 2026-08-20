/* Pure transform that comments out leftover-default lines in a server/.env
   file. A line is a "leftover default" when its env-var name is in the
   candidate predicate AND the line's text is an uncommented KEY=VALUE
   assignment. Lines already commented, blank, or not matching the bare
   KEY=VALUE shape pass through byte-for-byte.

   This is the "act" half of #2194 option-2: a deliberately-pinned value
   that differs from the registry default is never a candidate (the caller
   excludes it from the predicate), so this function never touches it.

   The function is intentionally filesystem-free — the caller handles
   reading, backup, and atomic write. */

/** Regex matching a bare (uncommented) env-var assignment.
    Group 1: the var name (upper-case letters, digits, underscores).
    Group 2: the rest of the line (the value, including any trailing
    whitespace or inline comment — preserved verbatim on comment-out). */
const ENV_LINE_RE = /^([A-Z0-9_]+)=(.*)$/gm;

export interface CleanEnvResult {
  /** The full file text after commenting-out. */
  text: string;
  /** Env-var NAMES actually commented out (in file order). */
  cleaned: string[];
}

/** Comment out every uncommented `KEY=VALUE` line whose KEY satisfies
    `isCandidate`. All other lines pass through unchanged.

    @param text       Full text of the .env file (may or may not end with \n).
    @param isCandidate  Predicate: true when the env-var name is a leftover-
                        default candidate at write time (re-derived from live
                        process.env + registry default — never a cached GET). */
export function cleanEnvText(
  text: string,
  isCandidate: (envVarName: string) => boolean,
): CleanEnvResult {
  const cleaned: string[] = [];
  const out = text.replace(ENV_LINE_RE, (line, varName) => {
    if (isCandidate(varName)) {
      cleaned.push(varName);
      return `# ${line}`;
    }
    return line;
  });
  return { text: out, cleaned };
}
