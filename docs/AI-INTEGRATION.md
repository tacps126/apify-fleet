# Setting up apify-fleet with an AI assistant

This page is written for AI coding assistants (Claude, ChatGPT, Copilot, Cursor and others) and for
people who use them. It holds what an assistant needs to set up and run `apify-fleet` safely in one
file. Point your assistant at it, or paste one of the prompts at the end.

## What the assistant must know first

- `apify-fleet <command> [actors...] [options]`. Read-only: `ls`, `health`. Changing: `push`,
  `build`, `clean builds|runs|storages`, `sync`, `settings`.
- **Changing commands only show what they would do until `--apply` is added.** Always run the dry run
  first, show the output to the person, and add `--apply` only after they agree. Deleting runs and
  storages cannot be undone.
- Changing commands refuse to act on every Actor unless given names, `--tag`, `--changed <ref>` or
  `--all`.
- Exit codes: `0` done, `1` some Actors failed (others still ran), `2` bad usage, `3` health alarm
  (with `--fail-on`).
- `--json` prints the whole report (`rows`, `notes`, `failed`, `alarm`) for scripts and for reading
  results back.
- Auth: `APIFY_TOKEN`, else the token saved by `apify login`, else requests go through the Apify CLI's
  own login. Never print the token or put it in files; in CI use a secret.

## Step 1: find out about the project

| Question | How to check | Why it matters |
|---|---|---|
| Where are the Actors? | Folders with `.actor/actor.json` | Run from the folder above them, or use `--root` |
| One Actor per repository? | Several sibling repositories | `fleet.json` with `"path": "../repo"` per Actor and `"discover": false` |
| Built from Git on Apify, no local folder? | `ls` shows them as "apify" only | `push` skips them; use `build` |
| Old copies or templates in the tree? | Two folders with one Actor name stop the tool | Set `actors.<name>.path`, or narrow `--root` |
| Groups that change together? | Shared code folders | `tags` and `watch` in `fleet.json` |
| CI? | `.github/workflows/` | The examples below |

Start with a read-only look. It changes nothing:

```bash
npx apify-fleet ls
npx apify-fleet health --days 7
```

## Step 2: fleet.json (only if needed)

Without it everything is found on disk and on the account. Add it for tags, listing text, run
settings, or Actors in other folders:

```json
{
  "$schema": "./node_modules/apify-fleet/fleet.schema.json",
  "defaults": { "settings": { "memoryMbytes": 1024 } },
  "actors": {
    "shop-products": {
      "path": "actors/shop-products",
      "tags": ["ecommerce"],
      "watch": ["packages/shared"],
      "listing": { "seoTitle": "Shop Products Scraper", "categories": ["ECOMMERCE"] },
      "settings": { "memoryMbytes": 4096, "timeoutSecs": 3600 }
    }
  }
}
```

Unknown keys are an error. All keys: README section "fleet.json".

## Step 3: common tasks

| The person wants | Dry run first | Then |
|---|---|---|
| See everything | `apify-fleet ls` | |
| Which Actors fail? | `apify-fleet health --days 7` | |
| Push what changed on this branch | `apify-fleet push --changed origin/main` | add `--apply` |
| Push all, fewer at once | `apify-fleet push --all --concurrency 2` | add `--apply` |
| Rebuild everything (new base image) | `apify-fleet build --all` | add `--apply --wait` |
| Delete old builds | `apify-fleet clean builds --all --older-than 30d --keep 3` | add `--apply` |
| Delete failed runs | `apify-fleet clean runs --all --status FAILED,ABORTED --older-than 14d` | add `--apply` |
| Delete leftover test storages | `apify-fleet clean storages --match "tmp-*" --older-than 7d` | add `--apply` |
| Same memory everywhere | `apify-fleet settings --all --memory 1024` | add `--apply` |
| Listing text from files | `apify-fleet sync --tag ecommerce` | add `--apply` |

`push` runs as many pushes at once as the account's free job slots and memory allow, up to 8; the dry
run says how many and why, and marks each Actor `update` or `new Actor`. Arguments after `--` go to
every `apify push` (for example `-- --force`).

## Step 4: CI

Nightly health check that fails the job when an Actor is failing or has not succeeded for 2 days:

```yaml
- run: npx apify-fleet health --days 1 --stale-days 2 --fail-on failing,stale
  env:
    APIFY_TOKEN: ${{ secrets.APIFY_TOKEN }}
```

Push the Actors that changed on main (needs the Apify CLI and full git history):

```yaml
- uses: actions/checkout@v5
  with: { fetch-depth: 0 }
- run: npm install -g apify-cli
- run: npx apify-fleet push --changed "${{ github.event.before }}" --apply
  env:
    APIFY_TOKEN: ${{ secrets.APIFY_TOKEN }}
```

Full workflows: [examples/github-actions](../examples/github-actions).

## Checklist

- [ ] Every changing command was shown as a dry run and the person agreed before `--apply`.
- [ ] Selections are explicit (names, `--tag`, `--changed`); `--all` only when the person asked.
- [ ] The token comes from the environment or a CI secret, never from a file in the repository.
- [ ] Results were read from `--json` output, not guessed: check `failed` and each row's `status`.
- [ ] Failures (exit 1) were reported per Actor with the `notes` text, not retried blindly.

## Prompts to paste

Set it up:

```text
Set up apify-fleet for this repository. Read
https://github.com/tacps126/apify-fleet/blob/main/docs/AI-INTEGRATION.md first and follow it.
Run only read-only commands (ls, health) and dry runs, show me the output, and ask before any --apply.
Add a fleet.json only if my layout needs one, and explain each key.
```

Add CI:

```text
Using https://github.com/tacps126/apify-fleet/blob/main/docs/AI-INTEGRATION.md, add GitHub Actions
that run apify-fleet health every night (fail on failing or stale Actors) and push the Actors that
changed on main. Use the APIFY_TOKEN repository secret.
```
