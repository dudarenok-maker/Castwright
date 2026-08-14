# Agent context

This repository's full project context for AI coding agents lives in
`CLAUDE.md` at the repo root, with the branching / commit / PR / issue /
release-notes specs alongside it in `CONTRIBUTING.md`. Those two are the single
source of truth -- do not duplicate their rules here.

- **Claude Code:** `CLAUDE.md` is native; read `CONTRIBUTING.md` before opening
  a branch or a PR.
- **Cline:** reads `CLAUDE.md` and `CONTRIBUTING.md`, plus every
  `.clinerules/*.md`. Cline-specific operational prefs live in
  `.clinerules/cline.md`.
- **Other tools:** read both files directly for the same canonical context. A
  tool that reads *this* file but not `CLAUDE.md` should import it explicitly
  (`@CLAUDE.md`, or whatever your include syntax is). Do not add that import
  here unconditionally: any tool that already loads `CLAUDE.md` natively would
  then pull the same ~90 KB into context twice.
