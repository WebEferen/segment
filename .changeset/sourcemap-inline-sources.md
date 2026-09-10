---
'segment-state': patch
---

Embed the original TypeScript in the published `dist/*.js.map` files. The package does not ship `src/`, so consumer bundlers warned that every sourcemap pointed to missing source files.
