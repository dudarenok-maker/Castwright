# Agent context

This repository's canonical context for AI coding agents is `CLAUDE.md` at the
repo root, with the branching / commit / PR / issue / release-notes specs
alongside it in `CONTRIBUTING.md`. Those two are the single source of truth --
do not duplicate their rules here.

**Most tools do not load them automatically. Read both before your first edit.**

- **Claude Code:** `CLAUDE.md` is native. Read `CONTRIBUTING.md` before opening
  a branch or a PR.
- **Cline:** loads this file and every `.clinerules/*.md`, and **neither
  `CLAUDE.md` nor `CONTRIBUTING.md`** -- verified 2026-08-14 against the
  installed `@cline/core` rule loader (which knows `AGENTS.md` and
  `.clinerules` and contains no `CLAUDE.md` literal) and a live `cline -p`
  probe. So reading them is an explicit first step, not something already done
  for you. Cline-specific operational prefs are in `.clinerules/cline.md`,
  which is a summary and not a substitute.
- **Other tools:** read both files directly. If your tool supports file
  includes and you want them loaded unconditionally, add the import in your own
  tool-specific config rather than here -- an unconditional `@CLAUDE.md` in
  this file would pull the same ~90 KB in twice for any tool that already loads
  `CLAUDE.md` natively.
