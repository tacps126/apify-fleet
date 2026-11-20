/** Finds Actor folders (those with `.actor/actor.json`) on disk, and the API token. */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, relative, sep } from 'node:path';
import { listing, type Listing } from './config.js';

export interface LocalActor {
    name: string;
    /** Absolute folder path. */
    path: string;
    version?: string;
    /** From `.actor/listing.json`, when the folder has one. */
    listing?: Listing;
}

const SKIP = new Set(['node_modules', '.git', 'dist', 'build', 'target', 'storage', '.venv', 'venv', '__pycache__', 'coverage']);

/** Walks `root` up to `maxDepth` folders deep; does not look inside an Actor folder once found. */
export function discoverActors(root: string, maxDepth = 6): LocalActor[] {
    const found: LocalActor[] = [];
    const walk = (dir: string, depth: number) => {
        const actor = readActor(dir);
        if (actor) {
            found.push(actor);
            return;
        }
        if (depth >= maxDepth) return;
        let entries;
        try {
            entries = readdirSync(dir, { withFileTypes: true });
        } catch {
            return;
        }
        for (const e of entries) {
            if (e.isDirectory() && !SKIP.has(e.name) && !e.name.startsWith('.')) walk(join(dir, e.name), depth + 1);
        }
    };
    walk(root, 0);
    return found.sort((a, b) => a.name.localeCompare(b.name));
}

/** Reads `<dir>/.actor/actor.json`; undefined when the folder is not an Actor. */
export function readActor(dir: string): LocalActor | undefined {
    const file = join(dir, '.actor', 'actor.json');
    if (!existsSync(file)) return undefined;
    let meta: { name?: unknown; version?: unknown };
    try {
        meta = JSON.parse(readFileSync(file, 'utf8')) as typeof meta;
    } catch {
        return undefined;
    }
    if (typeof meta.name !== 'string' || !meta.name) return undefined;
    const actor: LocalActor = { name: meta.name, path: dir };
    if (typeof meta.version === 'string') actor.version = meta.version;
    const listingFile = join(dir, '.actor', 'listing.json');
    if (existsSync(listingFile)) {
        actor.listing = listing(JSON.parse(readFileSync(listingFile, 'utf8')), listingFile);
    }
    return actor;
}

/** `APIFY_TOKEN`, else the token `apify login` saved; undefined when neither exists. */
export function findToken(env: NodeJS.ProcessEnv = process.env, home = homedir()): string | undefined {
    if (env.APIFY_TOKEN) return env.APIFY_TOKEN;
    const file = join(home, '.apify', 'auth.json');
    if (!existsSync(file)) return undefined;
    try {
        const auth = JSON.parse(readFileSync(file, 'utf8')) as { token?: unknown };
        return typeof auth.token === 'string' && auth.token ? auth.token : undefined;
    } catch {
        return undefined;
    }
}

/** POSIX-style relative path, for matching git output. */
export function posixRelative(from: string, to: string): string {
    return relative(from, to).split(sep).join('/');
}
