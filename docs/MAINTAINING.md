# Maintaining

## One-time repository setup

Run once after creating the repository on GitHub (needs the GitHub CLI, `gh auth login`):

```bash
# Protect main: pull requests only, squash merges, CI green, one code-owner review,
# no force pushes or deletion. Admins may merge their own pull requests (bypass
# "pull_request" mode), but nobody pushes straight to main.
gh api -X POST repos/tacps126/apify-fleet/rulesets --input .github/rulesets/main.json

# Squash merges only, branches deleted after merge.
gh repo edit tacps126/apify-fleet --enable-squash-merge --enable-merge-commit=false \
  --enable-rebase-merge=false --delete-branch-on-merge

# Private vulnerability reporting (used by SECURITY.md).
gh api -X PUT repos/tacps126/apify-fleet/private-vulnerability-reporting
```

To change the protection later, edit `.github/rulesets/main.json` and update the ruleset:
`gh api repos/tacps126/apify-fleet/rulesets` lists it with its id, then
`gh api -X PUT repos/tacps126/apify-fleet/rulesets/<id> --input .github/rulesets/main.json`.

## Releasing

1. Open a pull request that bumps the version (`npm version X.Y.Z --no-git-tag-version`, then the
   same in `src/version.ts`) and moves the "Unreleased" notes in `CHANGELOG.md` under `## X.Y.Z`.
   CI fails if the versions differ or the section is missing.
2. Merge it. The Release workflow sees a version with no tag, packs the package, tags `vX.Y.Z` and
   creates a GitHub Release with the changelog section and the tarball attached.
3. Versions with a suffix (`0.2.0-rc.1`) become pre-releases and publish under the `next` tag.

## Publishing to npm (off until enabled)

The Publish workflow publishes a GitHub Release to npm with npm trusted publishing: the job proves it
is this repository's `publish.yml` through GitHub's OIDC token and npm gives it a one-time publish
credential. No npm token is stored anywhere, and every version gets provenance. It runs only when the
repository variable `PUBLISH_ENABLED` is `true`, and skips versions already on npm.

1. **First version by hand** (npm can only trust a workflow for a package that already exists).
   From a clean checkout of the release tag, signed in with `npm login` (two-factor code when asked):

   ```bash
   git switch --detach v0.1.0
   npm ci && npm publish --access public
   git switch -
   ```

2. **Trust the workflow** on npmjs.com: the package, Settings, Trusted publishing, GitHub Actions:
   organization or user `tacps126`, repository `apify-fleet`, workflow file `publish.yml`, environment
   `npm`. Allowed actions: `npm stage publish` is always on. Leave "Allow npm publish" unticked
   (recommended): each release is then staged and goes live only when you approve it on npmjs.com
   (the package, Staged packages) with your two-factor code. To publish with no approval instead,
   tick "Allow npm publish" and set the repository variable `NPM_PUBLISH_MODE` = `publish`. "Allow
   npm dist-tag" is not needed. Set up connection, then under Publishing access choose "Require
   two-factor authentication and disallow tokens". The trusted publisher must
   publish once within 2 days of being added, or it expires: do step 4 soon after.
3. **GitHub:** Settings, Environments: create `npm` (optionally add yourself as a required reviewer,
   so every publish waits for your click). Settings, Secrets and variables, Actions, Variables: add
   `PUBLISH_ENABLED` = `true`. No secrets are needed.
4. **Check it:** bump the version in a pull request and merge it (Releasing, above). The Release
   workflow tags it and starts Publish. A release made before publishing was on can be published
   from Actions, Publish, Run workflow, tag `vX.Y.Z`.

## Housekeeping

- Dependabot opens grouped pull requests (actions weekly, npm monthly).
- `npm audit` should stay clean; the package has no runtime dependencies, so only dev tools appear.
