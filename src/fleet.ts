/**
 * Builds the fleet (every Actor known from fleet.json, from disk and from the account) and picks the
 * Actors a command acts on.
 */

import { isAbsolute, resolve } from 'node:path';
import type { ActorSummary, FleetApi } from './api.js';
import type { FleetConfig, Listing, Settings } from './config.js';
import { discoverActors, posixRelative, type LocalActor } from './discover.js';
import { globToRegExp, isGlob, type Runner, UsageError } from './util.js';

export interface Target {
    name: string;
    /** Id or `username~name` to call the API with; unset when the Actor is not on the account. */
    id?: string;
    /** Absolute folder path, when the Actor is on disk. */
    path?: string;
    version?: string;
    tags: string[];
    watch: string[];
    listing?: Listing;
    settings?: Settings;
    remote?: ActorSummary;
}

export interface Selector {
    names: string[];
    tags: string[];
    all: boolean;
    /** Git ref: keep Actors whose folder (or watched folders) changed since it. */
    changed?: string;
}

export interface BuildOptions {
    config: FleetConfig;
    /** Fetch the account's Actors (needed by every command that talks to Apify). */
    api?: FleetApi;
    local?: LocalActor[];
}

/** Merges fleet.json, disk and account into one list, sorted by name. */
export async function buildFleet({ config, api, local }: BuildOptions): Promise<Target[]> {
    const root = resolve(config.dir, config.root ?? '.');
    const onDisk = local ?? (config.discover === false ? [] : discoverActors(root));
    const byName = new Map<string, Target>();
    const get = (name: string) => {
        let t = byName.get(name);
        if (!t) {
            t = { name, tags: [], watch: [] };
            byName.set(name, t);
        }
        return t;
    };
    for (const actor of onDisk) {
        const t = get(actor.name);
        t.path = actor.path;
        t.version = actor.version;
        t.listing = actor.listing;
    }
    for (const [name, entry] of Object.entries(config.actors)) {
        const t = get(name);
        if (entry.path) {
            t.path = resolve(config.dir, entry.path);
            const disk = onDisk.find((a) => a.path === t.path);
            if (disk) {
                t.version ??= disk.version;
                t.listing ??= disk.listing;
                if (disk.name !== name) byName.delete(disk.name);
            }
        }
        if (entry.id) t.id = entry.id;
        t.tags = entry.tags ?? [];
        t.watch = (entry.watch ?? []).map((w) => resolve(config.dir, w));
        t.listing = merge(t.listing, entry.listing);
        t.settings = entry.settings;
    }
    if (api) {
        const remote = await api.listActors();
        for (const r of remote) {
            const known = [...byName.values()].find((t) => t.id === r.id || t.id === `${r.username}~${r.name}`);
            const t = known ?? get(r.name);
            t.remote = r;
            t.id = r.id;
        }
    }
    for (const t of byName.values()) {
        t.tags = [...new Set([...(config.defaults.tags ?? []), ...t.tags])];
        t.listing = merge(config.defaults.listing, t.listing);
        t.settings = merge(config.defaults.settings, t.settings);
    }
    return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

function merge<T extends object>(base: T | undefined, over: T | undefined): T | undefined {
    if (!base) return over && { ...over };
    if (!over) return { ...base };
    return { ...base, ...over };
}

/**
 * Applies a selector. With no names, tags or `--changed`, returns everything when `all` is set or
 * the command is read-only; otherwise refuses, so a typo never acts on the whole account.
 */
export async function select(
    fleet: Target[],
    selector: Selector,
    opts: { readOnly: boolean; runner?: Runner; cwd?: string },
): Promise<Target[]> {
    const narrowed = selector.names.length > 0 || selector.tags.length > 0 || selector.changed !== undefined;
    if (!narrowed && !selector.all && !opts.readOnly) {
        throw new UsageError('name the Actors to act on, or pass --tag, --changed or --all');
    }
    let picked = fleet;
    if (selector.names.length) {
        const missing: string[] = [];
        const keep = new Set<Target>();
        for (const name of selector.names) {
            const re = isGlob(name) ? globToRegExp(name) : undefined;
            const hits = fleet.filter((t) => (re ? re.test(t.name) : t.name === name || t.id === name));
            if (!hits.length) missing.push(name);
            for (const h of hits) keep.add(h);
        }
        if (missing.length) throw new UsageError(`no Actor matches: ${missing.join(', ')}`);
        picked = picked.filter((t) => keep.has(t));
    }
    if (selector.tags.length) picked = picked.filter((t) => t.tags.some((tag) => selector.tags.includes(tag)));
    if (selector.changed !== undefined) {
        if (!opts.runner || !opts.cwd) throw new UsageError('--changed needs git');
        const changed = await changedFiles(selector.changed, opts.runner, opts.cwd);
        picked = picked.filter((t) => touches(t, changed));
    }
    return picked;
}

/** Absolute paths changed since `ref`, committed or not, plus untracked files. */
export async function changedFiles(ref: string, runner: Runner, cwd: string): Promise<string[]> {
    const top = await runner('git', ['rev-parse', '--show-toplevel'], cwd);
    if (top.code !== 0) throw new UsageError(`--changed: not a git repository (${top.stderr.trim()})`);
    const root = top.stdout.trim();
    const diff = await runner('git', ['diff', '--name-only', ref, '--'], root);
    if (diff.code !== 0) throw new UsageError(`--changed: git diff ${ref} failed: ${diff.stderr.trim()}`);
    const untracked = await runner('git', ['ls-files', '--others', '--exclude-standard'], root);
    return `${diff.stdout}\n${untracked.stdout}`
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter(Boolean)
        .map((f) => resolve(root, f));
}

function touches(t: Target, files: string[]): boolean {
    const dirs = [t.path, ...t.watch].filter((d): d is string => Boolean(d));
    return files.some((f) => dirs.some((d) => within(d, f)));
}

function within(dir: string, file: string): boolean {
    const rel = posixRelative(dir, file);
    return !rel.startsWith('..') && !isAbsolute(rel);
}
