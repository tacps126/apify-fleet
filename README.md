# apify-fleet

Manage many [Apify](https://apify.com) Actors at once from the command line: push the ones that
changed, rebuild, clean up old builds, runs and storages, keep Store listings and run settings in
files, and check the health of the whole fleet.

The official [Apify CLI](https://docs.apify.com/cli) works on one Actor at a time. Once you have ten or
a hundred, the chores repeat: the same push in every folder, builds piling up, a category to change on
every listing, memory to raise everywhere, "which ones failed this week?". `apify-fleet` does those
across the fleet, with a dry run first.

- **Works with what you have.** No config needed: Actors are found on disk (`.actor/actor.json`) and
  on your account through the API. Add `fleet.json` only for tags, listing text or settings.
- **Safe by default.** Every command that changes something shows the change and stops. Add
  `--apply` to do it. Commands that change things refuse to run on the whole account unless you say
  `--all`.
- **Built for scripts and CI.** `--json` output, exit codes for failures and health alarms,
  `--changed origin/main` to act only on Actors whose code changed.
- **Small.** No runtime dependencies; Node.js 22 or newer.

## Install

```bash
npm install -g apify-fleet
```

or run it without installing: `npx apify-fleet ls`.

It uses your Apify API token from `APIFY_TOKEN`, or the one saved by `apify login`. Newer Apify CLI
versions keep the login in the system keychain; then `apify-fleet` sends its requests through
`apify api`, so your login works without the token ever being read (slower: one process per request,
so set `APIFY_TOKEN` for large fleets or CI). `push` calls the Apify CLI (`npm install -g apify-cli`)
in each folder.

## Commands

| Command | What it does | Changes things |
|---|---|---|
| `ls` | Every Actor: on disk, on Apify or both; visibility, latest build, last run, users in 30 days | no |
| `health` | Your recent runs per Actor: failure rate, last success, typical and longest run, cost; plus the Store's 30-day public failure rate | no |
| `push` | `apify push` in each selected folder, several at once; arguments after `--` are passed on | yes |
| `build` | Rebuild from the source already on Apify (for example to pick up a new base image) | yes |
| `clean builds` | Delete old builds; keeps every tagged build and the newest `--keep` | yes |
| `clean runs` | Delete old finished runs, optionally only some statuses and with their default storages | yes |
| `clean storages` | Delete old named datasets, key-value stores and request queues matching `--match` | yes |
| `sync` | Set Store listing text and categories from files | yes |
| `settings` | Set default memory, timeout, build tag, restart on error, Standby on/off | yes |

### Pick the Actors

```bash
apify-fleet health                         # read-only commands default to every Actor
apify-fleet push my-actor other-actor      # by name (or id)
apify-fleet build "*-scraper"              # by glob
apify-fleet sync --tag ecommerce           # by tag from fleet.json
apify-fleet push --changed origin/main     # only Actors whose folder changed since a git ref
apify-fleet settings --all --memory 1024   # everything (needed for changing commands)
```

### Examples

```bash
# What would be deleted? Builds older than 30 days, keeping the newest 3 and all tagged ones.
apify-fleet clean builds --all

# Do it, and failed or aborted runs older than two weeks too.
apify-fleet clean builds --all --apply
apify-fleet clean runs --all --older-than 14d --status FAILED,ABORTED --apply

# Leftover named storages from experiments.
apify-fleet clean storages --match "tmp-*" --older-than 7d --apply

# Push everything that changed on this branch, two at a time, forcing a build.
apify-fleet push --changed origin/main --concurrency 2 --apply -- --force

# Nightly check in CI: exit code 3 when any Actor is failing or has not succeeded for 2 days.
apify-fleet health --days 1 --stale-days 2 --fail-on failing,stale

# Raise memory on all Actors tagged "browser" and turn Standby off.
apify-fleet settings --tag browser --memory 4096 --standby off --apply
```

Output is a table; `--json` prints the full report (every row, plus what changed) for scripts.

### How much runs at once

Every command works on several Actors in parallel. API commands (`ls`, `health`, `build`, `clean`,
`sync`, `settings`) handle 8 at a time; API rate limits are retried with backoff.

`push` starts a build on Apify for each Actor, and builds share your account's job slots and memory.
By default (`--concurrency auto`) it reads your plan's limits and current use and runs as many pushes
as fit: the free job slots, and the free memory divided by 4 GB per build, between 1 and 8. The dry
run prints the number and why, marks each Actor `update` or `new Actor`, and warns when the account
has reached its monthly usage limit. Without an account connection `push` still works, 4 at a time.
Pushes to an Actor your token cannot change fail on their own row; the rest carry on.

## Repository layouts

Any folder with `.actor/actor.json` is an Actor; its name comes from that file. No folder naming,
monorepo tooling or shared code is assumed.

| Your setup | What to do |
|---|---|
| One Actor, one repository | Run `apify-fleet` in the repository; the Actor is the root folder itself. |
| Many Actors under one folder, any depth (up to 6 levels) | Run it at the top. `node_modules`, `dist`, `build`, `target`, `storage`, virtualenvs and hidden folders are skipped. |
| One repository per Actor, side by side | Run it in the parent folder, or list each folder in `fleet.json` (`"path": "../shop-products"`) with `"discover": false`. |
| Actors built on Apify from a Git repository, with no folder here | `ls`, `health`, `build`, `clean`, `sync` and `settings` work through the API; `push` skips them (`build` rebuilds from the repository). |
| Only some folders are yours (templates, old copies) | Narrow with `--root <dir>` or `fleet.json` `root`, or list the Actors with `"discover": false`. |
| The same Actor name in two folders | `apify-fleet` stops and names both folders. Set `actors.<name>.path` to the one to use; to push the other copy to a second Actor, add it under another name with its own `path`. |

Actors on your account but not on disk, and folders not yet on your account, both appear in `ls`.

## fleet.json (optional)

Put it at the root of your Actors repository, or point to it with `--config`.

```json
{
  "$schema": "./node_modules/apify-fleet/fleet.schema.json",
  "root": ".",
  "defaults": {
    "settings": { "memoryMbytes": 1024 }
  },
  "actors": {
    "shop-products": {
      "path": "actors/shop-products",
      "tags": ["ecommerce"],
      "watch": ["packages/shared"],
      "listing": {
        "title": "Shop Products",
        "seoTitle": "Shop Products Scraper",
        "seoDescription": "Extract product names, prices and stock from online shops.",
        "categories": ["ECOMMERCE", "AUTOMATION"]
      },
      "settings": { "memoryMbytes": 4096, "timeoutSecs": 3600, "standby": false }
    }
  }
}
```

| Key | Meaning |
|---|---|
| `root` | Where to look for Actor folders (default: the config's folder; `--root` overrides) |
| `discover` | `false` to use only the Actors listed here |
| `defaults` | `tags`, `listing` and `settings` every Actor starts from |
| `actors.<name>.path` | Folder with `.actor/actor.json`, relative to `fleet.json`: one outside `root` (another repository), or the one to use when two folders share a name |
| `actors.<name>.id` | Actor id or `username~name`, if the name alone is not enough |
| `actors.<name>.tags` | For `--tag` |
| `actors.<name>.watch` | Extra folders (shared code) that count as changes for `--changed` |
| `actors.<name>.listing` | `title`, `description`, `seoTitle`, `seoDescription`, `categories` for `sync` |
| `actors.<name>.settings` | `memoryMbytes`, `timeoutSecs`, `build`, `restartOnError`, `standby` for `settings` |

Listing text can also live next to the code in `<actor>/.actor/listing.json` (same keys as
`listing`); values in `fleet.json` win. `sync` warns when an SEO title is over 60 characters or an SEO
description over 200, where search results cut them. Unknown keys are an error, so typos do not pass
silently.

## Options

| Option | Commands | Default |
|---|---|---|
| `--apply` | changing commands | dry run |
| `--json` | all | table |
| `--concurrency <n\|auto>` | all | 8; `push`: auto |
| `--root <dir>` | all | `fleet.json` `root`, else the current folder |
| `--config <file>` | all | `./fleet.json` if present |
| `--older-than <30d>` | clean | 30 days (`d`, `h`, `m`, `s`) |
| `--keep <n>` | clean builds, clean runs | 3 newest |
| `--status <list>` | clean runs | all finished statuses |
| `--with-storages` | clean runs | off |
| `--match <glob>`, `--kind <list>` | clean storages | required, all kinds |
| `--max <n>` | clean | no cap (deletions per Actor or per kind) |
| `--days <n>`, `--runs <n>` | health | 7 days, 100 runs |
| `--stale-days <n>` | health | same as `--days` |
| `--max-fail-rate <0..1>` | health | 0.2 |
| `--fail-on <states>` | health | none (`failing`, `stale`, `idle`, `error`, `ok`) |
| `--memory`, `--timeout`, `--standby on/off` | settings | from fleet.json |
| `--wait`, `--build-tag`, `--actor-version` | build | no wait, `latest`, local or highest version |

Exit codes: `0` done, `1` some actions failed, `2` bad usage, `3` health alarm (`--fail-on`).

## Safety notes

- `clean builds` never deletes a build that a tag (such as `latest`) points to, or one still running.
- `clean runs` deletes only finished runs. Deleting a run cannot be undone; `--with-storages` also
  deletes the run's default dataset, key-value store and request queue.
- `clean storages` only looks at named storages, only those matching `--match`, and only those not
  modified or read within `--older-than`.
- `settings` and `sync` send only the fields that differ, and keep the rest of the Actor as it is.
- The token is sent only to the Apify API and never printed. Without `APIFY_TOKEN`, a keychain login
  is used through the Apify CLI and never read by `apify-fleet`.

## Use from code

```js
import { HttpApi, buildFleet, loadConfig, select, health, DEFAULT_OPTIONS } from 'apify-fleet';

const api = new HttpApi({ token: process.env.APIFY_TOKEN });
const fleet = await buildFleet({ config: loadConfig(process.cwd()), api });
const targets = await select(fleet, { names: [], tags: ['ecommerce'], all: false }, { readOnly: true });
const report = await health({ api, targets, apply: false, concurrency: 4, now: Date.now(), opts: DEFAULT_OPTIONS, runner: async () => ({ code: 0, stdout: '', stderr: '' }), log: console.error });
console.log(report.rows);
```

Every command takes a `FleetApi`, so you can pass your own implementation (a proxy, a cache, a fake in
tests).

## More

- [examples/](examples): a sample `fleet.json`, a listing file, GitHub Actions for nightly health,
  weekly cleanup and pushing changed Actors.
- [CONTRIBUTING.md](CONTRIBUTING.md), [SECURITY.md](SECURITY.md), [CHANGELOG.md](CHANGELOG.md).

Not affiliated with Apify. MIT licensed.
