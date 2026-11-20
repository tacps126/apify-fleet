# AGENTS.md

Guide for AI coding agents working on this repository. For using apify-fleet in another project,
see [docs/AI-INTEGRATION.md](docs/AI-INTEGRATION.md) instead.

## Layout

| Path | What |
|---|---|
| `src/cli.ts` | Argument parsing, usage text, token / CLI-login choice, exit codes |
| `src/fleet.ts` | Merges disk, `fleet.json` and the account into targets; selection (names, globs, tags, `--changed`) |
| `src/discover.ts` | Finds `.actor/actor.json` folders; token lookup |
| `src/config.ts` | `fleet.json` parsing and validation (unknown keys are errors) |
| `src/api.ts` | `FleetApi` interface and the fetch-based `HttpApi` (retries, paging) |
| `src/cli-transport.ts` | Sends API calls through `apify api` when there is no token |
| `src/commands/*.ts` | One file per command; each returns a `Report` |
| `test/fake.ts` | In-memory `FakeApi` and `fakeRunner`; tests never touch the network |
| `fleet.schema.json` | JSON schema for `fleet.json`; keep in sync with `config.ts` |

## Commands

```bash
npm ci
npm run check     # eslint, tsc, tests with coverage gates (lines 95%, branches 85%)
npm run build     # dist/ for a local try: node dist/cli.js ls
```

Run `npm run check` before you say a change is done.

## Rules

- Changing commands are dry runs unless `--apply`; they refuse to act on everything without `--all`.
  Keep both properties for any new command.
- One Actor failing never stops the others: report it on its row and carry on.
- Never print or log a token. Never read the Apify CLI's keychain or config files beyond `auth.json`.
- No runtime dependencies.
- New options go into `USAGE` in `src/cli.ts`, the README options table and the changelog.
- New `fleet.json` keys go into `config.ts`, `fleet.schema.json` and the README key table.
- Plain ASCII in docs and output (no curly quotes, em dashes or ellipsis characters).
- Update `CHANGELOG.md` under "Unreleased".
