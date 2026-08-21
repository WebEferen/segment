---
'segment-state': minor
---

Add a React binding at the new `segment-state/react` entry point: the same `useValue`, `useStatus`, and `useDraft` contract as the Octane binding, built on `useSyncExternalStore` and React 19's `use()`. The entry re-exports the whole application API, so a React application imports from one place and never loads Octane. The `octane` and `react` peer dependencies are both optional; an application installs only the renderer it uses.
