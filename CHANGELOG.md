# segment-state

## 0.1.0

### Minor Changes

- eb3b55a: Export Octane hooks from segment-state, make Octane required, retain the renderer-free segment-state/core entry point, and remove segment-state/octane.
- 82fd047: Move SSR serialization and port attachment to tree-shakeable entry points with
  standalone `dehydrate`, `hydrate`, and `attachPort` functions.

  Import SSR helpers from `segment-state/ssr` and migrate
  `store.dehydrate(options)` to `dehydrate(store, options)` and
  `store.hydrate(payload, options)` to `hydrate(store, payload, options)`. Import
  `attachPort` from `segment-state/ports` and migrate `store.attach(port)` to
  `attachPort(store, port)`.

## 0.0.2

### Patch Changes

- ceb8960: Document the complete server-to-client hydration flow and strengthen release
  automation with packed-artifact validation, mandatory pull-request changesets, and
  trusted npm publishing.

## 0.0.1

### Patch Changes

- Initial experimental release of the framework-agnostic core and optional Octane
  adapter.
