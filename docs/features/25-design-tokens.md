# Design tokens (CSS variables)

> Status: stable
> Key files: `src/styles.css`, `tailwind.config.ts`
> URL surface: none
> OpenAPI ops: none

## What this covers

All theme colours and core spacings live as CSS custom properties declared in `src/styles.css` (`--peach`, `--ink`, `--magenta`, `--canvas`, `--ink-soft`, etc.). `tailwind.config.ts` references those vars instead of hard-coding hex values. Component code never uses hex literals — it references Tailwind classes or `var(--name)` directly. This keeps theming consistent and makes a dark mode / re-skin a single-file change.

## Invariants to preserve

- Theme tokens are declared in `src/styles.css` (or imported there). The set is documented at the top of that file.
- `tailwind.config.ts` references `var(--<token>)` in its `theme.extend.colors`. Adding a new token requires touching both files.
- No hex literal `#RRGGBB` or `#RGB` appears in `src/components/**/*.tsx`, `src/views/**/*.tsx`, `src/modals/**/*.tsx`. Documented exceptions:
  - Gradient stop strings inside fixture data (`coverGradient: ['#a8e', '#f6c']` in `src/data/*` or `src/mocks/*`) — these are data, not styling, and are owned by the design system catalog.
  - Inline SVG `fill` attributes inside icon definitions — accepted because the icon system tints via CSS overrides at use-site.
- Renaming a token is a breaking change — update `styles.css`, `tailwind.config.ts`, and every consumer in lockstep.

## Acceptance walkthrough

1. **Grep test** —
   - `grep -rnE '#[0-9a-fA-F]{6}|#[0-9a-fA-F]{3}' src/components src/views src/modals` should return no matches inside `style={{ color: '#...' }}` or className-fragments. Matches inside fixture-data files (`src/data/`, `src/mocks/`) are allowed.
   - On Windows PowerShell: `Select-String -Path src\components\*.tsx, src\views\*.tsx, src\modals\*.tsx -Pattern '#[0-9a-fA-F]{3,6}'` returns zero hits.
2. **Add a new accent colour** — declare `--accent-lime: #c5e88a;` in `src/styles.css`, add `lime: 'var(--accent-lime)'` in `tailwind.config.ts`, then `<div className="bg-lime">` should render the new colour.
3. **Theme override smoke test** — temporarily redefine `--peach` to a vivid colour in `src/styles.css`; every component that uses the peach background visibly changes. Revert.
4. **Generated content audit** — fixture files (`src/data/colors.ts`, `src/mocks/*`) may contain hex literals; verify they're labelled as data, not styling.

## Out of scope

- Dark mode implementation (the system supports it but v1 is light-only).
- Token semantics (semantic naming vs role-based) — current set is mixed and documented in `styles.css`.
- Cross-platform native theming.
