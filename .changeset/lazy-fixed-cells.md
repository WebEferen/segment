---
'segment-state': patch
---

Keep plain fixed cells out of the trie until they are observed. A derivation re-runs only when one of its dependency stamps moved; a commit still walks every observed derivation to do that check.
