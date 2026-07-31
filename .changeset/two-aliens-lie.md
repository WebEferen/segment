---
'segment-state': minor
---

Move SSR serialization and port attachment to tree-shakeable entry points with
standalone `dehydrate`, `hydrate`, and `attachPort` functions.

Import SSR helpers from `segment-state/ssr` and migrate
`store.dehydrate(options)` to `dehydrate(store, options)` and
`store.hydrate(payload, options)` to `hydrate(store, payload, options)`. Import
`attachPort` from `segment-state/ports` and migrate `store.attach(port)` to
`attachPort(store, port)`.
