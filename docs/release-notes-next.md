# Castwright vNext

Draft release notes for the next version. Feed to `bump-version.mjs` as
`--notes-file docs/release-notes-next.md` when cutting the release. Remove
this file and this header after the tag is created.

---

## Features

- **Advanced Settings (fs-42).** A new `#/advanced` view (reached from Admin and Account) exposes model, generation, and QA knobs via a collapsible accordion. Each knob shows its current value with an edit field, a "live" or "restart" apply-mode badge, and a Revert button that restores the shipped default. Env-sourced values are shown read-only ("locked by .env") so overrides can't silently stomp them. Analyzer prompts are editable and forkable to local files. A persistent amber banner appears when a sidecar-restart-required knob is changed, with a one-click "Restart sidecar" button. All changes persist across server restarts in `config.json`.
