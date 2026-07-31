# Releasing Segment

Segment uses Changesets for version decisions and changelog entries, then publishes
the exact version PR merge commit through npm trusted publishing. After npm accepts
the package, that commit receives its immutable release tag and GitHub Release. No
long-lived `NPM_TOKEN` is stored in GitHub.

## Release model

| Stage                     | Source of truth                   | Automation                |
| ------------------------- | --------------------------------- | ------------------------- |
| Describe a package change | `.changeset/*.md`                 | `pnpm changeset`          |
| Prepare a version         | `package.json` and `CHANGELOG.md` | Version packages workflow |
| Publish an artifact       | Version PR merge commit           | Publish release workflow  |

The version PR keeps the version diff reviewable. Merging it is the final release
approval: the exact merge commit is published to npm, tagged, and attached to a
GitHub Release.

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
GitHub Actions to create pull requests. The version workflow grants write access
only for its version PR. The publish workflow separately grants `id-token: write`
for npm OIDC and `contents: write` for the release tag and GitHub Release.

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

Review and merge that PR when its CI checks pass. Merging it is the release approval
and automatically starts `.github/workflows/publish.yml` because `package.json`
changed on `main`.

## Automatic publish after merge

The publish workflow checks out the exact merge commit and:

- ignores `package.json` edits that did not change its version;
- runs the complete `prepublishOnly` validation and packed-artifact smoke test;
- publishes the stable version with `npm publish --tag latest` through OIDC;
- verifies that npm's `latest` dist-tag points at the released version;
- creates an annotated `v<version>` tag for the merge commit;
- creates or repairs the matching GitHub Release from that version's changelog.

Tag and GitHub Release creation happen only after npm accepts the package. A failed
publish therefore cannot advertise an unavailable release.

## Run or retry manually

Open **Actions → Publish release → Run workflow**. Leave `ref` set to `main` for
the current version or select an existing release tag when repairing an older
release. Keep **Validate without publishing** enabled for a safe dry run. Disable it
only to retry the actual release.

Retries are idempotent. If npm already contains the version, the workflow skips
`npm publish` and continues by verifying or recreating its missing tag and GitHub
Release. It refuses to reuse a tag that points at a different commit.

## What the workflow verifies

`.github/workflows/publish.yml` publishes only when the version changed on `main` or
when a maintainer explicitly disables dry-run during a manual dispatch. npm invokes
`prepublishOnly`, which runs the full suite and installs the packed tarball into a
clean offline consumer. Manual dry runs execute the same lifecycle with
`npm publish --dry-run` but never create tags or releases.

## Inspect the package locally

`pnpm pack:check` is the authoritative smoke test. For a manual view of the tarball
manifest, run:

```sh
npm pack --dry-run
```

The published package contains `dist`, `README.md`, `CHANGELOG.md`, and `LICENSE`,
with exports for `segment-state`, `segment-state/core`, `segment-state/ports`, and
`segment-state/ssr`.
