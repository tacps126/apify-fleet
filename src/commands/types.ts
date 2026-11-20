import type { FleetApi, StorageKind } from '../api.js';
import type { Target } from '../fleet.js';
import type { Runner } from '../util.js';

export interface Row {
    actor: string;
    status: string;
    detail?: string;
    [column: string]: unknown;
}

export interface Report {
    command: string;
    apply: boolean;
    columns: string[];
    rows: Row[];
    /** Rows whose action failed; the CLI exits 1 when any did. */
    failed: number;
    /** Health problems matched by `--fail-on`; the CLI exits 3. */
    alarm?: boolean;
    notes: string[];
}

export interface Options {
    // clean
    olderThanMs: number;
    keep: number;
    statuses?: string[];
    withStorages: boolean;
    match?: string;
    kinds: StorageKind[];
    max?: number;
    // health
    days: number;
    staleDays?: number;
    runs: number;
    maxFailRate: number;
    failOn: string[];
    // settings
    memory?: number;
    timeout?: number;
    standby?: boolean;
    // build
    wait: boolean;
    buildTag: string;
    actorVersion?: string;
    // push
    passthrough: string[];
}

export interface Context {
    api: FleetApi;
    targets: Target[];
    apply: boolean;
    concurrency: number;
    now: number;
    opts: Options;
    runner: Runner;
    log: (line: string) => void;
}

export const DEFAULT_OPTIONS: Options = {
    olderThanMs: 30 * 86_400_000,
    keep: 3,
    withStorages: false,
    kinds: ['datasets', 'key-value-stores', 'request-queues'],
    days: 7,
    runs: 100,
    maxFailRate: 0.2,
    failOn: [],
    wait: false,
    buildTag: 'latest',
    passthrough: [],
};

export function report(command: string, ctx: Pick<Context, 'apply'>, columns: string[], rows: Row[], notes: string[] = []): Report {
    return { command, apply: ctx.apply, columns, rows, failed: rows.filter((r) => r.status === 'failed').length, notes };
}

/** Row for an Actor that is not on the account (nothing to do remotely). */
export function notOnApify(t: Target): Row {
    return { actor: t.name, status: 'skipped', detail: 'not on Apify (push it first)' };
}
