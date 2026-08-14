# Agent context

This repository's full project context for AI coding agents lives in
`CLAUDE.md` at the repo root. Claude Code and Cline both load it at the start
of each session, so it is the single source of truth -- do not duplicate its
rules here.

@CLAUDE.md

- **Claude Code:** `CLAUDE.md` is native.
- **Cline:** reads `CLAUDE.md` + every `.clinerules/*.md`. Cline-specific
  operational prefs live in `.clinerules/cline.md`.
- **Other tools:** read `CLAUDE.md` directly (or import it here) for the same
  canonical context.
