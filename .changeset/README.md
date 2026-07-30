# Changesets

Every ordinary pull request must carry a changeset. For a change to the published
API or runtime behavior, run:

```sh
pnpm changeset
```

Select `segment-state`, choose the semantic version bump, and write a concise
user-facing summary. While the project is on `0.x`, use:

- `patch` for backwards-compatible fixes;
- `minor` for new API or breaking pre-1.0 changes;
- `major` when preparing the stable `1.0.0` release.

For documentation, tests, benchmarks, examples, CI, dependency maintenance, or any
other change that should not release the package, add an explicit empty changeset:

```sh
pnpm changeset --empty
```

CI enforces this policy for every pull request except the generated
`changeset-release/*` version PR, which consumes the pending changesets. After
changesets reach `main`, GitHub Actions creates or updates the
`chore: version packages` pull request. Merging that PR consumes the pending files,
updates `package.json`, and writes `CHANGELOG.md`.

See the [release guide](../docs/releasing.md) for the complete maintainer flow.
