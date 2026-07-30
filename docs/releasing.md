# Releasing Segment

Segment uses Changesets for version decisions and changelog entries, then publishes
from an immutable Git tag through npm trusted publishing. No long-lived `NPM_TOKEN`
is stored in GitHub.

## Release model

| Stage                     | Source of truth                   | Automation                |
| ------------------------- | --------------------------------- | ------------------------- |
| Describe a package change | `.changeset/*.md`                 | `pnpm changeset`          |
| Prepare a version         | `package.json` and `CHANGELOG.md` | Version packages workflow |
| Publish an artifact       | Git tag `v<version>`              | Publish to npm workflow   |

Keeping versioning and publishing separate makes the version diff reviewable and
ensures npm always receives code that can be traced to an immutable tag.

## One-time npm configuration

Configure a trusted publisher for the package on npm with these values:

| Field                | Value         |
| -------------------- | ------------- |
| Organization or user | `WebEferen`   |
| Repository           | `segment`     |
| Workflow             | `publish.yml` |
| Environment          | leave empty   |

An authenticated maintainer using npm `11.10.0+` can create the same connection
from the repository root:

```sh
npm trust github segment-state \
  --file publish.yml \
  --repo WebEferen/segment \
  --allow-publish
```

npm requires account-level 2FA and opens a browser confirmation before creating or
listing trusted publishers. The package already exists, so no bootstrap publish is
required.

The workflow requests an OpenID Connect identity with `id-token: write`. npm checks
that identity against the trusted-publisher record before accepting the package.

In GitHub, **Settings → Actions → General → Workflow permissions** must allow
GitHub Actions to create pull requests. The Version packages workflow still grants
only `contents: write` and `pull-requests: write` to its single job.

## Describe a package change

Every ordinary pull request must declare its release intent. For a change to the
published API or runtime behavior, run:

```sh
pnpm changeset
```

Select `segment-state`, choose the bump, and write a user-facing summary. Use
`patch` for backwards-compatible fixes and `minor` for new API or breaking changes
while Segment is pre-1.0.

For documentation, examples, tests, benchmarks, CI, dependency maintenance, and
other work that should not release the package, add an explicit empty changeset:

```sh
pnpm changeset --empty
```

Use `pnpm changeset:status` to inspect the pending release locally.

CI validates this on every pull request. The generated `changeset-release/*` version
PR is the only exception because applying a version consumes and removes its pending
changesets.

## Prepare the version

When a changeset lands on `main`, `.github/workflows/version.yml` creates or updates
the `chore: version packages` pull request. That PR:

- consumes all pending changesets;
- applies the combined semantic version bump to `package.json`;
- updates `CHANGELOG.md`;
- keeps the version shown in the documentation in sync automatically.

Review and merge that PR when its CI checks pass. It changes versions only; it does
not publish anything.

## Publish from a release

1. Confirm the version PR has been merged into `main` and CI is green.
2. Run the complete local validation if you are preparing the release locally:

   ```sh
   pnpm check
   pnpm pack:check
   ```

3. Create and publish a GitHub Release tagged exactly `v<package-version>`, for
   example `v0.1.0` for package version `0.1.0`.

Publishing the GitHub Release automatically starts `.github/workflows/publish.yml`.
The workflow checks out that tag, verifies it against `package.json`, installs the
locked dependency graph, runs all package checks, and publishes through npm OIDC.

## Run or retry manually

Open **Actions → Publish to npm → Run workflow** and provide an existing Git tag.
The tag must match the package version at that tag. Keep **Validate without
publishing** enabled for a safe dry run; disable it only when you intend to publish
or retry a failed release.

The manual workflow deliberately refuses branch names and missing tags. It never
creates a release or changes a version.

## What the workflow verifies

`.github/workflows/publish.yml` verifies that the selected ref is a Git tag and that
it matches `package.json`, then runs `npm publish --access public`. npm invokes
`prepublishOnly`, which runs the full suite and installs the packed tarball into a
clean offline consumer before publication. Manual dry runs execute the same
lifecycle with `npm publish --dry-run`.

If the tag and package version differ, the job stops before contacting npm. If any
validation fails, no package is published.

## Inspect the package locally

`pnpm pack:check` is the authoritative smoke test. For a manual view of the tarball
manifest, run:

```sh
npm pack --dry-run
```

The published package contains `dist`, `README.md`, `CHANGELOG.md`, and `LICENSE`,
with exports for `segment-state`, `segment-state/core`, and `segment-state/octane`.
