#!/usr/bin/env node
/** Command line entry: parses arguments, builds the fleet, runs one command, prints, sets the exit code. */

import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { HttpApi, STORAGE_KINDS, type FleetApi, type StorageKind } from './api.js';
import { build } from './commands/build.js';
import { clean, CLEAN_KINDS, type CleanKind } from './commands/clean.js';
import { health, HEALTH_STATES } from './commands/health.js';
import { ls } from './commands/ls.js';
import { push } from './commands/push.js';
import { settings } from './commands/settings.js';
import { sync } from './commands/sync.js';
import { DEFAULT_OPTIONS, type Context, type Options, type Report } from './commands/types.js';
import { checkMemory, checkTimeout, loadConfig } from './config.js';
import { findToken } from './discover.js';
import { buildFleet, select } from './fleet.js';
import { renderJson, renderTable } from './render.js';
import { errorText, parseDuration, runProcess, UsageError, type Runner } from './util.js';
import { VERSION } from './version.js';

export const USAGE = `apify-fleet ${VERSION}: manage many Apify Actors at once.

Usage: apify-fleet <command> [actors...] [options]

Commands
  ls                      List Actors (from disk, fleet.json and your account) with build and use
  health                  Recent runs per Actor: failure rate, last success, duration, cost
  push                    Run "apify push" in each selected Actor folder (args after -- are passed on)
  build                   Rebuild from the source already on Apify
  clean builds|runs       Delete old builds or runs (keeps tagged builds and the newest --keep)
  clean storages          Delete old named storages matching --match
  sync                    Set Store listing text and categories from fleet.json / .actor/listing.json
  settings                Set memory, timeout, build tag, Standby on/off

Pick Actors by name or glob ("*-scraper"), --tag, --changed <git-ref>, or --all.
ls and health default to every Actor. Commands that change things are a dry run until --apply.

Options
  --apply                 Make the changes (default: show what would change)
  --json                  Print the full report as JSON
  --config <file>         Config file (default: ./fleet.json if present)
  --tag <tag>             Only Actors with this tag (repeatable)
  --changed <ref>         Only Actors whose folder changed since a git ref (e.g. origin/main)
  --all                   Every Actor (needed for changing commands without other filters)
  --concurrency <n>       Actors handled at once (default 4)
  --quiet                 No progress lines on stderr

  clean:    --older-than <30d>  --keep <3>  --status FAILED,ABORTED  --with-storages
            --match <glob>  --kind datasets,key-value-stores,request-queues  --max <n>
  health:   --days <7>  --stale-days <n>  --runs <100>  --max-fail-rate <0.2>
            --fail-on failing,stale (exit 3 when any Actor is in these states)
  settings: --memory <mb>  --timeout <secs>  --standby on|off
  build:    --wait  --build-tag <latest>  --actor-version <0.1>

Token: APIFY_TOKEN, else the one saved by "apify login".
Exit codes: 0 done, 1 some actions failed, 2 bad usage, 3 health alarm.
`;

const OPTIONS = {
    apply: { type: 'boolean' },
    json: { type: 'boolean' },
    config: { type: 'string' },
    tag: { type: 'string', multiple: true },
    changed: { type: 'string' },
    all: { type: 'boolean' },
    concurrency: { type: 'string' },
    quiet: { type: 'boolean' },
    help: { type: 'boolean', short: 'h' },
    version: { type: 'boolean', short: 'V' },
    'older-than': { type: 'string' },
    keep: { type: 'string' },
    status: { type: 'string' },
    'with-storages': { type: 'boolean' },
    match: { type: 'string' },
    kind: { type: 'string' },
    max: { type: 'string' },
    days: { type: 'string' },
    'stale-days': { type: 'string' },
    runs: { type: 'string' },
    'max-fail-rate': { type: 'string' },
    'fail-on': { type: 'string' },
    memory: { type: 'string' },
    timeout: { type: 'string' },
    standby: { type: 'string' },
    wait: { type: 'boolean' },
    'build-tag': { type: 'string' },
    'actor-version': { type: 'string' },
} as const;

const COMMANDS = ['ls', 'health', 'push', 'build', 'clean', 'sync', 'settings'];
const READ_ONLY = new Set(['ls', 'health']);

export interface Deps {
    env?: NodeJS.ProcessEnv;
    cwd?: string;
    home?: string;
    stdout?: (text: string) => void;
    stderr?: (text: string) => void;
    /** Overrides the HTTP client (tests, custom transports). */
    api?: FleetApi;
    /** fetch for the built-in HTTP client. */
    fetch?: typeof fetch;
    runner?: Runner;
    now?: number;
}

export async function main(argv: string[], deps: Deps = {}): Promise<number> {
    const out = deps.stdout ?? ((t: string) => void process.stdout.write(t));
    const err = deps.stderr ?? ((t: string) => void process.stderr.write(t));
    try {
        const { values, tokens } = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true, strict: true, tokens: true });
        const dashdash = tokens.find((t) => t.kind === 'option-terminator')?.index;
        const before = tokens.flatMap((t) => (t.kind === 'positional' && (dashdash === undefined || t.index < dashdash) ? [t.value] : []));
        const passthrough = dashdash === undefined ? [] : argv.slice(dashdash + 1);
        if (values.version) {
            out(`${VERSION}\n`);
            return 0;
        }
        const [command, ...rest] = before;
        if (values.help || !command || command === 'help') {
            out(USAGE);
            return 0;
        }
        if (!COMMANDS.includes(command)) throw new UsageError(`unknown command "${command}" (try --help)`);
        let names = rest;
        let cleanKind: CleanKind | undefined;
        if (command === 'clean') {
            cleanKind = rest[0] as CleanKind;
            if (!CLEAN_KINDS.includes(cleanKind)) throw new UsageError(`clean what? one of: ${CLEAN_KINDS.join(', ')}`);
            names = rest.slice(1);
        }
        if (passthrough.length && command !== 'push') throw new UsageError('arguments after -- are only for push');

        const opts = options(values, passthrough);
        const concurrency = int(values.concurrency, 'concurrency', 4, 1);
        const cwd = deps.cwd ?? process.cwd();
        const config = loadConfig(cwd, values.config);
        const runner = deps.runner ?? runProcess;
        const needsApi = command !== 'push';
        let api = deps.api;
        if (!api && needsApi) {
            const env = deps.env ?? process.env;
            const token = findToken(env, deps.home);
            if (!token) throw new UsageError('no Apify token: set APIFY_TOKEN or run "apify login"');
            api = new HttpApi({ token, baseUrl: env.APIFY_API_BASE_URL, fetch: deps.fetch });
        }
        const log = values.quiet || values.json ? () => {} : (line: string) => err(`${line}\n`);
        const fleet = cleanKind === 'storages' ? [] : await buildFleet({ config, api: needsApi ? api : undefined });
        const targets =
            cleanKind === 'storages'
                ? []
                : await select(
                      fleet,
                      { names, tags: (values.tag ?? []).flatMap((t) => t.split(',')).filter(Boolean), all: Boolean(values.all), changed: values.changed },
                      { readOnly: READ_ONLY.has(command), runner, cwd },
                  );
        const ctx: Context = {
            api: api as FleetApi,
            targets,
            apply: Boolean(values.apply),
            concurrency,
            now: deps.now ?? Date.now(),
            opts,
            runner,
            log,
        };
        const result = await run(command, ctx, cleanKind);
        out(values.json ? renderJson(result) : renderTable(result));
        if (result.failed) return 1;
        return result.alarm ? 3 : 0;
    } catch (e) {
        const usage = e instanceof UsageError || (e as { code?: string }).code?.startsWith('ERR_PARSE_ARGS');
        err(`apify-fleet: ${errorText(e)}\n`);
        return usage ? 2 : 1;
    }
}

function run(command: string, ctx: Context, cleanKind?: CleanKind): Promise<Report> {
    switch (command) {
        case 'ls':
            return ls(ctx);
        case 'health':
            return health(ctx);
        case 'push':
            return push(ctx);
        case 'build':
            return build(ctx);
        case 'clean':
            return clean(ctx, cleanKind as CleanKind);
        case 'sync':
            return sync(ctx);
        default:
            return settings(ctx);
    }
}

type Values = ReturnType<typeof parseArgs<{ options: typeof OPTIONS }>>['values'];

export function options(v: Values, passthrough: string[] = []): Options {
    const opts: Options = { ...DEFAULT_OPTIONS, passthrough };
    if (v['older-than'] !== undefined) opts.olderThanMs = parseDuration(v['older-than']);
    if (v.keep !== undefined) opts.keep = int(v.keep, 'keep', 3, 0);
    if (v.status) opts.statuses = list(v.status).map((s) => s.toUpperCase());
    opts.withStorages = Boolean(v['with-storages']);
    if (v.match !== undefined) opts.match = v.match;
    if (v.kind) {
        const kinds = list(v.kind);
        const bad = kinds.filter((k) => !STORAGE_KINDS.includes(k as StorageKind));
        if (bad.length) throw new UsageError(`--kind: unknown ${bad.join(', ')} (use ${STORAGE_KINDS.join(', ')})`);
        opts.kinds = kinds as StorageKind[];
    }
    if (v.max !== undefined) opts.max = int(v.max, 'max', 0, 0);
    if (v.days !== undefined) opts.days = num(v.days, 'days');
    if (v['stale-days'] !== undefined) opts.staleDays = num(v['stale-days'], 'stale-days');
    if (v.runs !== undefined) opts.runs = int(v.runs, 'runs', 100, 1);
    if (v['max-fail-rate'] !== undefined) {
        opts.maxFailRate = num(v['max-fail-rate'], 'max-fail-rate');
        if (opts.maxFailRate > 1) throw new UsageError('--max-fail-rate is a fraction from 0 to 1');
    }
    if (v['fail-on']) {
        opts.failOn = list(v['fail-on']);
        const bad = opts.failOn.filter((s) => !(HEALTH_STATES as readonly string[]).includes(s));
        if (bad.length) throw new UsageError(`--fail-on: unknown ${bad.join(', ')} (use ${HEALTH_STATES.join(', ')})`);
    }
    if (v.memory !== undefined) opts.memory = checkMemory(int(v.memory, 'memory', 0, 0), '--memory');
    if (v.timeout !== undefined) opts.timeout = checkTimeout(int(v.timeout, 'timeout', 0, 0), '--timeout');
    if (v.standby !== undefined) {
        if (!['on', 'off'].includes(v.standby)) throw new UsageError('--standby is on or off');
        opts.standby = v.standby === 'on';
    }
    opts.wait = Boolean(v.wait);
    if (v['build-tag'] !== undefined) opts.buildTag = v['build-tag'];
    if (v['actor-version'] !== undefined) {
        if (!/^\d+\.\d+$/.test(v['actor-version'])) throw new UsageError('--actor-version looks like 0.1');
        opts.actorVersion = v['actor-version'];
    }
    return opts;
}

function list(text: string): string[] {
    return text.split(',').map((s) => s.trim()).filter(Boolean);
}

function int(text: string | undefined, name: string, fallback: number, min: number): number {
    if (text === undefined) return fallback;
    const n = Number(text);
    if (!Number.isInteger(n) || n < min) throw new UsageError(`--${name}: expected a whole number >= ${min}, got "${text}"`);
    return n;
}

function num(text: string, name: string): number {
    const n = Number(text);
    if (!Number.isFinite(n) || n < 0) throw new UsageError(`--${name}: expected a number >= 0, got "${text}"`);
    return n;
}

/* node:coverage disable */
function isEntry(): boolean {
    try {
        return Boolean(process.argv[1]) && realpathSync(process.argv[1] as string) === realpathSync(fileURLToPath(import.meta.url));
    } catch {
        return false;
    }
}

if (isEntry()) {
    main(process.argv.slice(2)).then((code) => {
        process.exitCode = code;
    });
}
/* node:coverage enable */
