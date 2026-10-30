# Releasing

This guide is for maintainers. Public installation instructions are in the README.
The coordinated documentation refresh targets **0.1.1**; published versions are
immutable, so never move a released tag or replace an existing package.

## Check a candidate

Run the **Release** workflow from `main` with publishing disabled:

```sh
gh workflow run release.yml --ref main -f version=0.1.1 -F publish=false
```

The workflow runs CI and builds reviewable artifacts, retained for 14 days.
Inspect the run and download its artifacts. Checksum files accompany them.
These temporary artifacts are not registry releases.

## Publish a checked version

Confirm the release commit and tested SDK/sidecar combination, and create the
matching `v0.1.1` tag at that exact main commit. The workflow rejects a missing or
mismatched tag. Its publishing environment allows only `main`.

```sh
gh workflow run release.yml --ref main -f version=0.1.1 -F publish=true
```

An explicit publish run automatically follows successful CI with publishing.
There is no additional GitHub reviewer approval. Pull requests, ordinary pushes
and check-only runs do not publish. Inspect both registry availability and the
GitHub release afterward; do not blindly repeat a partially completed upload.

## npm

Package: [@authrail/sdk-node](https://www.npmjs.com/package/@authrail/sdk-node).
GitHub environment: **npm**. The initial interactive publication succeeded.
GitHub trusted publishing has not yet been configured, so do not assume the
OIDC upload step can authenticate.

Until it is configured, download the checked `release-package` artifact, verify
`SHA256SUMS`, and publish that exact tarball interactively:

```sh
shasum -a 256 -c SHA256SUMS
npm login
npm publish ./authrail-sdk-node-0.1.1.tgz --access public --ignore-scripts
```

On Linux, `sha256sum -c SHA256SUMS` also verifies checksums. Complete npm's 2FA
prompt yourself; no API token needs to enter GitHub or chat. Verify the public
package, then attach the checked tarball/checksums to the matching GitHub release.
Do not invoke the OIDC publishing job for a version already uploaded interactively.

For later automated uploads, configure the package's GitHub Actions trusted
publisher: owner `AuthRail`, repository `authrail-sdk-node`, workflow
`release.yml`, environment `npm`, with `npm publish` allowed. Configure it near
its first use: a new configuration expires after two days without a successful
publication. Only use the automated publish run once that trust exists.
The interactive upload does not claim GitHub OIDC provenance.

After publishing, verify `npm install @authrail/sdk-node@0.1.1` in an empty app,
including public TypeScript declarations and the connected Runtime flow.

[npm trusted publishing](https://docs.npmjs.com/trusted-publishers/)
