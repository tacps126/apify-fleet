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

The Publish workflow runs when a GitHub Release is published, but only when the repository variable
`PUBLISH_ENABLED` is `true`. To turn it on:

1. Create an automation (or granular, publish-only) token on npmjs.com and add it as the repository
   secret `NPM_TOKEN`.
2. Settings, Environments: create `npm`. Optionally add yourself as a required reviewer, so every
   publish waits for your click.
3. Settings, Secrets and variables, Actions, Variables: add `PUBLISH_ENABLED` = `true`.

To publish a release made before publishing was on: Actions, Publish, Run workflow, tag `vX.Y.Z`.
Packages are published with provenance.

## Housekeeping

- Dependabot opens grouped pull requests (actions weekly, npm monthly).
- `npm audit` should stay clean; the package has no runtime dependencies, so only dev tools appear.
