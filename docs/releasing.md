# Releasing Segment

This page is for maintainers publishing `segment-state` to npm. Releases are built
from an immutable GitHub tag and use npm trusted publishing through GitHub Actions;
the repository does not require a long-lived `NPM_TOKEN` secret.

## One-time npm configuration

Configure a trusted publisher for the package on npm with these values:

| Field                | Value         |
| -------------------- | ------------- |
| Organization or user | `WebEferen`   |
| Repository           | `segment`     |
| Workflow             | `publish.yml` |
| Environment          | leave empty   |

The workflow requests an OpenID Connect identity with `id-token: write`. npm checks
that identity against the trusted-publisher record before accepting the package.

## Prepare a release

1. Update `version` in `package.json` and the version displayed in the docs navbar.
2. Install the locked dependency graph with `pnpm install --frozen-lockfile`.
3. Run the complete local validation:

   ```sh
   pnpm check
   pnpm pack:check
   ```

4. Merge the version change into `main`.
5. Create and publish a GitHub Release tagged exactly `v<package-version>`, for
   example `v0.1.0` for package version `0.1.0`.

## What the workflow verifies

`.github/workflows/publish.yml` checks out the release tag, verifies that the tag
matches `package.json`, installs from the lockfile, and runs `npm publish --access
public`. npm invokes `prepublishOnly`, which runs the full suite and installs the
packed tarball into a clean offline consumer before publication.

If the tag and package version differ, the job stops before contacting npm. If any
validation fails, no package is published.

## Inspect the package locally

`pnpm pack:check` is the authoritative smoke test. For a manual view of the tarball
manifest, run:

```sh
npm pack --dry-run
```

The published package contains `dist`, `README.md`, and `LICENSE`, with exports for
`segment-state`, `segment-state/core`, and `segment-state/octane`.
