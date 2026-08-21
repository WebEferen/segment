// segment-state/react is the React-facing application API: the same surface the
// package root gives an Octane application, with the React binding in place of
// the Octane one. Importing it never loads Octane, so a React application needs
// only the `react` peer.
export * from '../core/index.js';
export { useDraft, useStatus, useValue } from './hooks.js';
export { attachPort } from '../ports/index.js';
export { dehydrate, hydrate } from '../ssr/index.js';
