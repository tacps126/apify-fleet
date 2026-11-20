# Examples

| Path | What it shows |
|---|---|
| [monorepo](monorepo) | A repository with two Actors, a shared package and a `fleet.json` with tags, listing text and settings. One Actor keeps its listing text in `.actor/listing.json` |
| [github-actions/fleet-health.yml](github-actions/fleet-health.yml) | Nightly health check that fails when an Actor is failing or stale |
| [github-actions/fleet-cleanup.yml](github-actions/fleet-cleanup.yml) | Weekly cleanup of old builds, runs and temporary storages |
| [github-actions/push-changed.yml](github-actions/push-changed.yml) | Push, sync and set settings only for Actors changed by a merge |

Try the monorepo example without touching anything (dry runs need only a token, for reading):

```bash
cd examples/monorepo
npx apify-fleet ls
npx apify-fleet push --all             # shows what would be pushed
npx apify-fleet settings --tag browser # shows what would change on Apify
```

Actors in the example that are not on your account show as "not on Apify".
