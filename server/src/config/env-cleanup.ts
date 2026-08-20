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
    Matches:
    - Optional leading whitespace (indented lines)
    - Optional `export ` prefix (shell-compatible syntax)
    - Key name (upper-case letters, digits, underscores)
    - `=` and the value

    Group 1: leading whitespace (spaces/tabs).
    Group 2: optional export prefix with trailing space (or empty string).
    Group 3: the var name (upper-case letters, digits, underscores).
    Group 4: the rest of the line (the value, including any trailing
    whitespace or inline comment — preserved verbatim on comment-out). */
export const ENV_LINE_RE = /^(\s*)((?:export\s+)?)([A-Z0-9_]+)=(.*)$/gm;

export interface CleanEnvResult {
  /** The full file text after commenting-out. */
  text: string;
  /** Env-var NAMES actually commented out (in file order). */
  cleaned: string[];
}

/** Parse an env file's uncommented KEY=VALUE lines into a map of name -> value.
    Commented-out lines, blanks, and section headers are ignored.
    Returns a Map where each key appears at most once (file order preserved —
    later occurrences overwrite earlier ones, matching .env semantics). */
export function parseEnvFileLines(fileContent: string): Map<string, string> {
  const map = new Map<string, string>();
  const regex = new RegExp(ENV_LINE_RE.source, ENV_LINE_RE.flags);
  let match;
  while ((match = regex.exec(fileContent)) !== null) {
    // Group 1: indent, Group 2: export prefix, Group 3: var name, Group 4: value
    map.set(match[3], match[4]);
  }
  return map;
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
  const out = text.replace(ENV_LINE_RE, (line, indent, exportPrefix, varName, value) => {
    if (isCandidate(varName)) {
      cleaned.push(varName);
      // Preserve indentation, add comment marker, preserve export keyword
      return `${indent}# ${exportPrefix}${varName}=${value}`;
    }
    return line;
  });
  return { text: out, cleaned };
}
