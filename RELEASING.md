# Releasing

This guide is for maintainers. Public setup remains in the README. The initial
release version is **0.1.0**. Preparing a release does not publish it.

## Check a candidate

After the release preparation has merged, run the **Release** workflow from
`main`, with version `0.1.0` and **publish unchecked**:

```sh
gh workflow run release.yml --ref main -f version=0.1.0 -F publish=false
```

The workflow runs CI, builds the distributions and retains reviewable artifacts
for 14 days. Open its run in Actions, check every job, and download the artifacts.
These artifacts are temporary review downloads, not public releases.

## Before publishing

Complete the connected release checks, confirm the exact main commit and tested
sidecar/SDK combination, and obtain the owner's release approval. Create only
that approved `v0.1.0` tag; never move a published tag. The publish workflow
requires the tag to point to the exact main commit being run. An intervening
main commit requires reviewing the release identity again.

Configure the GitHub environment below with the owner as a required reviewer
and deployment branches restricted to `main`. Publishing is a separate manual
Release workflow run with **publish checked**. A pull request, ordinary push
or check-only run cannot publish.

## npm setup

Use GitHub environment **npm**. The package is `@authrail/sdk-node` in the
`authrail` npm organisation. Registry trust is configured through the package's
settings, so the first release has an interactive bootstrap step:

1. Download `release-package` from the approved check-only run.
2. Verify `SHA256SUMS` with `shasum -a 256 -c SHA256SUMS` on macOS or
   `sha256sum -c SHA256SUMS` on Linux.
3. After release approval and tagging, sign in using `npm login` and publish
   that exact tarball with `npm publish ./authrail-sdk-node-0.1.0.tgz --access public --ignore-scripts`.
   Complete npm's 2FA prompt yourself. No token needs to enter GitHub or chat.
4. Verify the public installation and create the GitHub release for the approved
   tag, attaching the checked tarball and checksum file. Do not rerun publication
   for an already published version.

For subsequent releases, configure a GitHub Actions trusted publisher in the
package settings: owner `AuthRail`, repository `authrail-sdk-node`, workflow
`release.yml`, environment `npm`, allowing `npm publish`. The workflow uses OIDC
and publishes the checked tarball without running lifecycle scripts. Configure
trust close to its first use: npm expires a new configuration if no successful
publication occurs within two days. The initial interactive upload does not
claim GitHub OIDC provenance; trusted public GitHub uploads generate it.

After publishing, install the exact version into an empty application, check its
public types and Runtime integration, and update the public install guide.

[npm trusted publishing](https://docs.npmjs.com/trusted-publishers/)
