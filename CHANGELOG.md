# Changelog

All notable changes. Versions follow [Semantic Versioning](https://semver.org/).

## Unreleased

## 0.1.0

First release.

- Fleet from disk (`.actor/actor.json`), optional `fleet.json` and the account's Actors through the API.
- Any layout: one Actor per repository, many under one folder, folders in other repositories via
  `fleet.json` paths, `--root`; two folders with one Actor name stop with both paths named.
- Select Actors by name, id, glob, tag, `--changed <git-ref>` (with watched shared folders) or `--all`.
- `ls`: where each Actor lives, visibility, latest build, last run, users in 30 days.
- `health`: failure rate, last success, typical and longest run, cost, public 30-day failure rate;
  `--fail-on` exit code for CI.
- `push`: `apify push` in each folder with pass-through arguments; as many at once as the account's free
  job slots and memory allow (`--concurrency auto`, the default); dry run marks `update` or `new Actor`.
- Other commands handle 8 Actors at once by default (`--concurrency <n>`).
- `build`: rebuild from the source on Apify, optionally waiting for the result.
- `clean builds`, `clean runs`, `clean storages`: age, keep-newest, status and name filters; tagged and
  unfinished items are never touched.
- `sync`: Store listing text and categories from `fleet.json` or `.actor/listing.json`, changed
  fields only, with length warnings.
- `settings`: memory, timeout, build tag, restart on error and Standby, changed fields only.
- Dry run by default, `--apply` to change; `--json` reports; exit codes 0, 1, 2, 3.
- Token from `APIFY_TOKEN` or `apify login`; with a keychain (OAuth) login of a newer Apify CLI,
  requests go through `apify api` instead, retrying when concurrent CLI calls race.
- JSON schema for `fleet.json`; no runtime dependencies.
