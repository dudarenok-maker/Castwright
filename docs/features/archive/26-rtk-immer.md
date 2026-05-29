---
status: stable
shipped: 2026-05-13
owner: null
---

# RTK Immer drafts

> Status: stable
> Key files: `src/store/*-slice.ts`, `src/store/index.ts`
> URL surface: none
> OpenAPI ops: none

## What this covers

All Redux Toolkit slice reducers in this repo mutate the state draft directly (Immer-style) — they never return a new spread object. This keeps reducers concise, sidesteps a class of accidental immutability bugs, and matches the RTK idiom. Selectors and dispatch use the typed `useAppDispatch` / `useAppSelector` hooks exported from `src/store/index.ts`.

## Invariants to preserve

- Every reducer in `src/store/ui-slice.ts`, `cast-slice.ts`, `chapters-slice.ts`, `revisions-slice.ts`, `manuscript-slice.ts`, `library-slice.ts`, `voices-slice.ts` mutates the draft directly. Patterns like `s.foo = ...`, `s.list.push(...)`, `delete s.map[id]` are correct; `return { ...s, foo: ... }` is forbidden.
- Typed hooks `useAppDispatch` and `useAppSelector` from `src/store/index.ts` are the only Redux hooks used in components. Raw `useDispatch` / `useSelector` are not used.
- Selectors are namespaced under each slice's `*Selectors` export (e.g. `uiSelectors.stageKind` in `src/store/ui-slice.ts:126-132`).
- `configureStore` wires the router via `RouterStore` adapter (`src/lib/router.ts:77-110`); the router never imports actions directly.

## Acceptance walkthrough

These are static checks; run them locally before any slice refactor.

1. **Spread-return grep** — `grep -rn 'return\s*{\s*\.\.\.s' src/store/` should return zero matches. Same for `\.\.\.(state)?\s*}`.
2. **Mutation patterns** — open each slice and confirm every reducer body either assigns to a property of `s` or calls a mutating method (`push`, `splice`, `delete`). Zero `Object.assign` returning the result.
3. **Raw hook grep** — `grep -rn "from 'react-redux'" src/` should show only `src/store/index.ts` importing the raw hooks (to re-export typed versions). Components import `useAppDispatch`/`useAppSelector` from `src/store/index.ts`.
4. **Selector usage** — every component reading slice state uses a selector function, either inline (`useAppSelector(s => s.cast.characters)`) or via the slice's `*Selectors` namespace.
5. **Type test** — dispatching an action with the wrong payload type errors at compile time; selectors infer the right return type from `RootState`.
6. **Reducer refactor test** — pick one reducer (e.g. `setSelectedModel`) and try rewriting it as `return { ...s, selectedModel: a.payload }`. Behaviour should be functionally identical; revert to the mutation form to keep the convention.

## Out of scope

- Custom Immer patches / inverse patches (we don't use them).
- Redux Toolkit Query (not used in v1; manual fetch wrappers per `23-mock-toggle.md`).
- Slice splitting policy — current split is by domain, not by feature.
