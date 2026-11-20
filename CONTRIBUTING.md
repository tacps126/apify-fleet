# Contributing

Thanks for helping. Bug reports, new commands, options and doc fixes are all welcome.

## Ground rules

- Every command that changes something on Apify is a dry run unless `--apply` is passed, and refuses
  to act on the whole account without `--all`. New commands follow the same rule.
- Commands talk to the `FleetApi` interface (`src/api.ts`), never to `fetch` directly, so tests run
  against the in-memory fake in `test/fake.ts` with no network.
- Every change comes with tests. Coverage gates: 95% lines and functions, 85% branches.
- No runtime dependencies. Node.js built-ins only.
- Never print, log or store the API token.

## Setup

```bash
npm ci
npm run check   # eslint, tsc, tests with coverage gates
npm run build   # dist/ for trying the binary: node dist/cli.js --help
```

Tests are TypeScript compiled to `.build/` and run with the built-in `node --test`.

## Pull requests

1. Open an issue first for anything bigger than a fix, so we agree on the approach.
2. Keep the change focused; one topic per pull request.
3. Update `README.md` for new commands or options, and `CHANGELOG.md` under "Unreleased".
4. CI must be green (lint, types, tests on every supported Node version).

## Releases

Maintainers bump the version in `package.json`, `package-lock.json` (`npm version --no-git-tag-version`)
and `src/version.ts` together, and move "Unreleased" in the changelog under the new version. Merging
that to main creates the tag and GitHub Release. See [docs/MAINTAINING.md](docs/MAINTAINING.md).

## Conduct

Be kind and assume good intent. See [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).
