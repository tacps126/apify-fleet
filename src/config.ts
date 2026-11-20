/**
 * Optional `fleet.json`: tags, Store listing text and run settings per Actor. Without it the fleet is
 * whatever is found on disk plus whatever the account has on Apify.
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { UsageError } from './util.js';

export interface Listing {
    title?: string;
    description?: string;
    seoTitle?: string;
    seoDescription?: string;
    categories?: string[];
}

export interface Settings {
    memoryMbytes?: number;
    timeoutSecs?: number;
    build?: string;
    restartOnError?: boolean;
    standby?: boolean;
}

export interface ActorEntry {
    /** Folder holding `.actor/actor.json`, relative to the config file. */
    path?: string;
    /** Actor id or `username~name`, when the name alone is ambiguous. */
    id?: string;
    tags?: string[];
    /** Extra folders (shared code) whose changes count as changes to this Actor for `--changed`. */
    watch?: string[];
    listing?: Listing;
    settings?: Settings;
}

export interface FleetConfig {
    /** Folder the config was read from; paths resolve against it. */
    dir: string;
    /** Where to look for Actor folders (default: the config's folder). */
    root?: string;
    /** Look for Actor folders under `root` (default true). */
    discover?: boolean;
    defaults: { tags?: string[]; listing?: Listing; settings?: Settings };
    actors: Record<string, ActorEntry>;
}

const LISTING_KEYS = ['title', 'description', 'seoTitle', 'seoDescription', 'categories'];
const SETTINGS_KEYS = ['memoryMbytes', 'timeoutSecs', 'build', 'restartOnError', 'standby'];
const ENTRY_KEYS = ['path', 'id', 'tags', 'watch', 'listing', 'settings'];
const TOP_KEYS = ['$schema', 'root', 'discover', 'defaults', 'actors'];

export const CONFIG_FILE = 'fleet.json';

/** Reads `file`, or `fleet.json` in `cwd` if present; returns an empty config otherwise. */
export function loadConfig(cwd: string, file?: string): FleetConfig {
    const path = file ? resolve(cwd, file) : resolve(cwd, CONFIG_FILE);
    if (!existsSync(path)) {
        if (file) throw new UsageError(`config file not found: ${path}`);
        return { dir: cwd, defaults: {}, actors: {} };
    }
    let raw: unknown;
    try {
        raw = JSON.parse(readFileSync(path, 'utf8'));
    } catch (err) {
        throw new UsageError(`${path}: not valid JSON (${(err as Error).message})`);
    }
    return parseConfig(raw, dirname(path), path);
}

export function parseConfig(raw: unknown, dir: string, where = CONFIG_FILE): FleetConfig {
    const top = object(raw, where);
    keys(top, TOP_KEYS, where);
    const defaults = object(top.defaults ?? {}, `${where}: defaults`);
    keys(defaults, ['tags', 'listing', 'settings'], `${where}: defaults`);
    const actors: Record<string, ActorEntry> = {};
    for (const [name, value] of Object.entries(object(top.actors ?? {}, `${where}: actors`))) {
        actors[name] = entry(value, `${where}: actors.${name}`);
    }
    return {
        dir,
        root: optional(top.root, 'string', `${where}: root`),
        discover: optional(top.discover, 'boolean', `${where}: discover`),
        defaults: {
            tags: strings(defaults.tags, `${where}: defaults.tags`),
            listing: listing(defaults.listing, `${where}: defaults.listing`),
            settings: settings(defaults.settings, `${where}: defaults.settings`),
        },
        actors,
    };
}

function entry(value: unknown, where: string): ActorEntry {
    const o = object(value ?? {}, where);
    keys(o, ENTRY_KEYS, where);
    return {
        path: optional(o.path, 'string', `${where}.path`),
        id: optional(o.id, 'string', `${where}.id`),
        tags: strings(o.tags, `${where}.tags`),
        watch: strings(o.watch, `${where}.watch`),
        listing: listing(o.listing, `${where}.listing`),
        settings: settings(o.settings, `${where}.settings`),
    };
}

export function listing(value: unknown, where: string): Listing | undefined {
    if (value === undefined) return undefined;
    const o = object(value, where);
    keys(o, LISTING_KEYS, where);
    const out: Listing = {};
    for (const key of ['title', 'description', 'seoTitle', 'seoDescription'] as const) {
        const v = optional(o[key], 'string', `${where}.${key}`);
        if (v !== undefined) out[key] = v;
    }
    const categories = strings(o.categories, `${where}.categories`);
    if (categories) {
        for (const c of categories) {
            if (!/^[A-Z][A-Z0-9_]*$/.test(c)) throw new UsageError(`${where}.categories: "${c}" is not a category id like AUTOMATION`);
        }
        out.categories = categories;
    }
    return out;
}

export function settings(value: unknown, where: string): Settings | undefined {
    if (value === undefined) return undefined;
    const o = object(value, where);
    keys(o, SETTINGS_KEYS, where);
    const out: Settings = {};
    const memory = optional(o.memoryMbytes, 'number', `${where}.memoryMbytes`);
    if (memory !== undefined) out.memoryMbytes = checkMemory(memory, `${where}.memoryMbytes`);
    const timeout = optional(o.timeoutSecs, 'number', `${where}.timeoutSecs`);
    if (timeout !== undefined) out.timeoutSecs = checkTimeout(timeout, `${where}.timeoutSecs`);
    const build = optional(o.build, 'string', `${where}.build`);
    if (build !== undefined) out.build = build;
    const restart = optional(o.restartOnError, 'boolean', `${where}.restartOnError`);
    if (restart !== undefined) out.restartOnError = restart;
    const standby = optional(o.standby, 'boolean', `${where}.standby`);
    if (standby !== undefined) out.standby = standby;
    return out;
}

/** Apify accepts powers of two from 128 MB to 32 GB. */
export function checkMemory(mb: number, where: string): number {
    if (!Number.isInteger(mb) || mb < 128 || mb > 32768 || (mb & (mb - 1)) !== 0) {
        throw new UsageError(`${where}: memory must be a power of two from 128 to 32768 MB, got ${mb}`);
    }
    return mb;
}

export function checkTimeout(secs: number, where: string): number {
    if (!Number.isInteger(secs) || secs < 0) throw new UsageError(`${where}: timeout must be whole seconds >= 0, got ${secs}`);
    return secs;
}

function object(value: unknown, where: string): Record<string, unknown> {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new UsageError(`${where}: expected an object`);
    return value as Record<string, unknown>;
}

function keys(o: Record<string, unknown>, allowed: string[], where: string) {
    for (const key of Object.keys(o)) {
        if (!allowed.includes(key)) throw new UsageError(`${where}: unknown key "${key}" (allowed: ${allowed.join(', ')})`);
    }
}

function optional<T extends 'string' | 'number' | 'boolean'>(
    value: unknown,
    type: T,
    where: string,
): (T extends 'string' ? string : T extends 'number' ? number : boolean) | undefined {
    if (value === undefined) return undefined;
    if (typeof value !== type) throw new UsageError(`${where}: expected a ${type}`);
    return value as never;
}

function strings(value: unknown, where: string): string[] | undefined {
    if (value === undefined) return undefined;
    if (!Array.isArray(value) || value.some((v) => typeof v !== 'string')) throw new UsageError(`${where}: expected a list of strings`);
    return value as string[];
}
