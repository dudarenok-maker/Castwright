// Scan PowerShell source for non-ASCII characters OUTSIDE comments (#3055
// pass-2 blocking finding).
//
// Why this exists: a `.ps1`/`.psm1` saved as UTF-8 with NO BOM is decoded by
// Windows PowerShell 5.1 as the ANSI code page (CP1252 on this box), not as
// UTF-8. An em dash (U+2014, bytes `E2 80 94`) therefore reads back as three
// CP1252 characters and the THIRD of them is `"` — which terminates an
// enclosing double-quoted string literal mid-line and turns the rest of the
// line into a parse error. Measured on 5.1.26100.9223:
//
//   throw "... could not inspect '$Dir' <em dash> the scan is INCOMPLETE ..."
//   -> ParserError: Unexpected token 'the' in expression or statement
//   -> Import-Module fails -> the exported function is undefined
//
// The whole module then fails to load, on an engine `pickPowerShell()`
// (scripts/wt-gc.mjs) explicitly falls back to and that a Windows box has
// unless someone installed PowerShell 7. PR #3055 shipped exactly that
// defect green: both `pickPowerShell()` and scripts/run-powershell.mjs prefer
// `pwsh`, so no harness in the repo ever loaded the file under 5.1.
//
// Inside a COMMENT the same mojibake is harmless — `#` runs to end of line
// and `<# #>` is delimited by ASCII — which is why every other PowerShell
// file under scripts/lib/ can and does carry non-ASCII prose in its header.
// So the rule this scanner enforces is: never a non-ASCII character in a
// PowerShell string literal (or anywhere else in code); comments only, and
// prefer ASCII even there.
//
// The scan is a lexer, not a regex, because the naive "strip from `#` to end
// of line" shortcut is exactly wrong here: `#` inside a string literal is not
// a comment, so that shortcut would strip — and therefore MISS — a non-ASCII
// character sitting in a string that happens to contain a `#`.

/**
 * Every non-ASCII character in `text` that is NOT inside a comment.
 *
 * Tracks the five PowerShell lexical states a `#` or a quote can be sitting
 * in: code, single-quoted string, double-quoted string, and the two
 * here-string forms. Escapes handled: `''`/`""` doubling and the backtick
 * escape inside a double-quoted string.
 *
 * @param {string} text PowerShell source
 * @returns {{line: number, column: number, char: string, codePoint: string, context: string, lineText: string}[]}
 */
export function scanPowerShellNonAscii(text) {
  const findings = [];
  const lines = text.split(/\r?\n/);
  // 'code' | 'single' | 'double' | 'hereSingle' | 'hereDouble' | 'block'
  let state = 'code';

  for (let li = 0; li < lines.length; li += 1) {
    const line = lines[li];
    let i = 0;
    let lineComment = false;

    // A here-string terminator is only a terminator at the START of a line
    // (leading whitespace allowed by PS 5.1 is NOT — the sequence must be in
    // column 0 — but accepting either way here is the conservative reading:
    // ending the string early can only ever make us scan MORE as code).
    if (state === 'hereSingle' || state === 'hereDouble') {
      const term = state === 'hereSingle' ? "'@" : '"@';
      if (line.startsWith(term)) {
        state = 'code';
        i = term.length;
      } else {
        // Body of a here-string: still a string literal, so scan it.
        recordNonAscii(findings, line, li, 0, line.length, 'here-string');
        continue;
      }
    }

    while (i < line.length) {
      const ch = line[i];

      if (state === 'block') {
        if (ch === '#' && line[i + 1] === '>') {
          state = 'code';
          i += 2;
          continue;
        }
        i += 1;
        continue;
      }

      if (state === 'single') {
        if (ch === "'") {
          if (line[i + 1] === "'") { i += 2; continue; } // '' escape
          state = 'code';
          i += 1;
          continue;
        }
        if (isNonAscii(ch)) findings.push(finding(line, li, i, 'single-quoted string'));
        i += 1;
        continue;
      }

      if (state === 'double') {
        if (ch === '`') { i += 2; continue; } // backtick escape
        if (ch === '"') {
          if (line[i + 1] === '"') { i += 2; continue; } // "" escape
          state = 'code';
          i += 1;
          continue;
        }
        if (isNonAscii(ch)) findings.push(finding(line, li, i, 'double-quoted string'));
        i += 1;
        continue;
      }

      // state === 'code'
      if (ch === '<' && line[i + 1] === '#') { state = 'block'; i += 2; continue; }
      if (ch === '#') { lineComment = true; break; }
      if (ch === '@' && (line[i + 1] === "'" || line[i + 1] === '"')) {
        // `@'` / `@"` opens a here-string only when nothing but whitespace
        // follows on the line; otherwise it is a splat/array-ish `@` next to
        // an ordinary quote, which we treat as an ordinary string open.
        const rest = line.slice(i + 2).trim();
        if (rest === '') {
          state = line[i + 1] === "'" ? 'hereSingle' : 'hereDouble';
          i = line.length;
          continue;
        }
        i += 1;
        continue;
      }
      if (ch === "'") { state = 'single'; i += 1; continue; }
      if (ch === '"') { state = 'double'; i += 1; continue; }
      if (isNonAscii(ch)) findings.push(finding(line, li, i, 'code'));
      i += 1;
    }

    // A single- or double-quoted string does not span lines in PowerShell in
    // any shape this repo writes; reset so one unbalanced quote cannot make
    // the whole rest of the file read as a string (and so silently stop
    // reporting). Here-strings and block comments DO span lines.
    if (state === 'single' || state === 'double') state = 'code';
    void lineComment;
  }

  return findings;
}

function isNonAscii(ch) {
  return ch.codePointAt(0) > 127;
}

function finding(line, li, i, context) {
  const ch = line[i];
  return {
    line: li + 1,
    column: i + 1,
    char: ch,
    codePoint: `U+${ch.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')}`,
    context,
    lineText: line.trim(),
  };
}

function recordNonAscii(findings, line, li, from, to, context) {
  for (let i = from; i < to; i += 1) {
    if (isNonAscii(line[i])) findings.push(finding(line, li, i, context));
  }
}

/** One human-readable line per finding, for a test failure message. */
export function formatNonAsciiFindings(file, findings) {
  return findings
    .map((f) => `${file}:${f.line}:${f.column} ${f.codePoint} (${f.char}) in ${f.context} -- ${f.lineText}`)
    .join('\n');
}
