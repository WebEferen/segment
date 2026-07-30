# Changesets

Every pull request that changes the published API or runtime behavior should carry
a changeset. Run:

```sh
pnpm changeset
```

Select `segment-state`, choose the semantic version bump, and write a concise
user-facing summary. While the project is on `0.x`, use:

- `patch` for backwards-compatible fixes;
- `minor` for new API or breaking pre-1.0 changes;
- `major` when preparing the stable `1.0.0` release.

Documentation, tests, benchmarks, examples, and CI-only changes do not need a
changeset. After changesets reach `main`, GitHub Actions creates or updates the
`chore: version packages` pull request. Merging that PR consumes the pending
changesets, updates `package.json`, and writes `CHANGELOG.md`.

See the [release guide](../docs/releasing.md) for the complete maintainer flow.
