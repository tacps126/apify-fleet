import type { AccountLimits } from '../api.js';
import { errorText, lastLine, mapLimit } from '../util.js';
import { report, type Context, type Report, type Row } from './types.js';

/** Memory one build is assumed to take on Apify, in GB. */
export const BUILD_MEMORY_GB = 4;
/** Most pushes at once with `--concurrency auto`. */
export const MAX_AUTO_PUSHES = 8;
/** Pushes at once when the account's limits cannot be read. */
export const FALLBACK_PUSHES = 4;

/**
 * Pushes to run at once: each push starts a build, which takes a job slot and memory on the account,
 * so stay within what is free now. Between 1 and MAX_AUTO_PUSHES.
 */
export function autoPushes(limits: AccountLimits | undefined): { n: number; why: string } {
    if (!limits) return { n: FALLBACK_PUSHES, why: 'account limits not readable' };
    const caps: number[] = [];
    const parts: string[] = [];
    if (limits.maxConcurrentJobs !== undefined) {
        const free = limits.maxConcurrentJobs - (limits.activeJobs ?? 0);
        caps.push(free);
        parts.push(`${free} of ${limits.maxConcurrentJobs} job slots free`);
    }
    if (limits.maxMemoryGbytes !== undefined) {
        const free = limits.maxMemoryGbytes - (limits.usedMemoryGbytes ?? 0);
        caps.push(Math.floor(free / BUILD_MEMORY_GB));
        parts.push(`${Math.round(free)} of ${limits.maxMemoryGbytes} GB memory free`);
    }
    if (!caps.length) return { n: FALLBACK_PUSHES, why: 'account limits not readable' };
    const n = Math.max(1, Math.min(MAX_AUTO_PUSHES, ...caps));
    return { n, why: parts.join(', ') };
}

/**
 * Runs `apify push` in each selected Actor folder (bounded concurrency, one failure does not stop the
 * rest). Arguments after `--` go to every `apify push`.
 */
export async function push(ctx: Context): Promise<Report> {
    const columns = ['actor', 'status', 'detail'];
    const local = ctx.targets.filter((t) => t.path);
    const skipped: Row[] = ctx.targets
        .filter((t) => !t.path)
        .map((t) => ({ actor: t.name, status: 'skipped', detail: 'no local folder (Git-sourced? use build)' }));
    const args = ['push', ...ctx.opts.passthrough];
    const notes: string[] = [];
    // Optional account facts: which Actors exist already, and how many builds fit at once.
    let existing: Set<string> | undefined;
    let limits: AccountLimits | undefined;
    const api = ctx.api as Context['api'] | undefined; // push works without an account connection
    if (api && local.length) {
        try {
            existing = new Set((await api.listActors()).map((a) => a.name));
            limits = await api.accountLimits?.();
        } catch (e) {
            notes.push(`account not read (${errorText(e)}); pushing without its limits`);
        }
    }
    let concurrency = ctx.concurrency;
    if (concurrency === 0) {
        const auto = autoPushes(limits);
        concurrency = auto.n;
        notes.push(`${auto.n} push(es) at once (${auto.why}; --concurrency <n> to change)`);
    }
    if (limits?.maxMonthlyUsd !== undefined && (limits.monthlyUsd ?? 0) >= limits.maxMonthlyUsd) {
        notes.push('the account has reached its monthly usage limit: builds may not start');
    }
    const kind = (name: string) => (existing ? (existing.has(name) ? 'update' : 'new Actor') : undefined);
    if (!ctx.apply) {
        const rows = local.map((t) => {
            const k = kind(t.name);
            return { actor: t.name, status: 'would-push', detail: `${k ? `${k}: ` : ''}apify ${args.join(' ')} (in ${t.path})` };
        });
        return report('push', ctx, columns, [...rows, ...skipped], notes);
    }
    const cli = await ctx.runner('apify', ['--version'], process.cwd());
    if (cli.code !== 0) {
        const rows = local.map((t) => ({ actor: t.name, status: 'failed', detail: 'apify CLI not found (npm i -g apify-cli, then apify login)' }));
        return report('push', ctx, columns, [...rows, ...skipped], notes);
    }
    const rows = await mapLimit(local, concurrency, async (t): Promise<Row> => {
        ctx.log(`pushing ${t.name}`);
        const started = Date.now();
        const result = await ctx.runner('apify', args, t.path as string);
        const secs = Math.round((Date.now() - started) / 1000);
        if (result.code === 0) return { actor: t.name, status: 'pushed', detail: `${kind(t.name) === 'new Actor' ? 'new Actor, ' : ''}${secs}s` };
        const tail = `${result.stdout}\n${result.stderr}`.split(/\r?\n/).filter((l) => l.trim()).slice(-15).join('\n');
        notes.push(`--- ${t.name} (exit ${result.code}) ---\n${tail}`);
        return { actor: t.name, status: 'failed', detail: lastLine(result) };
    });
    return report('push', ctx, columns, [...rows, ...skipped], notes);
}
