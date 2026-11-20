import { collect, STORAGE_KINDS, TERMINAL, type BuildItem, type RunItem, type StorageItem, type StorageKind } from '../api.js';
import { errorText, globToRegExp, mapLimit, time, UsageError } from '../util.js';
import { notOnApify, report, type Context, type Report, type Row } from './types.js';

export type CleanKind = 'builds' | 'runs' | 'storages';
export const CLEAN_KINDS: readonly CleanKind[] = ['builds', 'runs', 'storages'];

/**
 * Deletes old builds, old runs, or old named storages. Never touches a build a tag points to, a
 * run or build still going, or the newest `--keep` of each Actor.
 */
export async function clean(ctx: Context, kind: CleanKind): Promise<Report> {
    if (kind === 'storages') return cleanStorages(ctx);
    const cutoff = ctx.now - ctx.opts.olderThanMs;
    const rows = await mapLimit(ctx.targets, ctx.concurrency, async (t): Promise<Row> => {
        if (!t.id) return notOnApify(t);
        try {
            const plan = kind === 'builds' ? await planBuilds(ctx, t.id, cutoff) : await planRuns(ctx, t.id, cutoff);
            const base = { actor: t.name, kept: plan.total - plan.doomed.length, total: plan.total };
            if (!plan.doomed.length) return { ...base, status: 'unchanged', deleted: 0, detail: plan.why };
            if (!ctx.apply) return { ...base, status: 'would-delete', deleted: plan.doomed.length, detail: plan.why };
            const errors = await deleteAll(ctx, plan.doomed);
            const deleted = plan.doomed.length - errors.length;
            return errors.length
                ? { ...base, status: 'failed', deleted, detail: `${errors.length} failed: ${errors[0]}` }
                : { ...base, status: 'deleted', deleted, detail: plan.why };
        } catch (err) {
            return { actor: t.name, status: 'failed', detail: errorText(err) };
        }
    });
    const total = rows.reduce((n, r) => n + (typeof r.deleted === 'number' ? r.deleted : 0), 0);
    const verb = ctx.apply ? 'deleted' : 'would delete';
    return report(`clean ${kind}`, ctx, ['actor', 'status', 'deleted', 'kept', 'total', 'detail'], rows, [`${verb} ${total} ${kind}`]);
}

interface Plan {
    total: number;
    doomed: (() => Promise<void>)[];
    why: string;
}

async function planBuilds(ctx: Context, actorId: string, cutoff: number): Promise<Plan> {
    const actor = await ctx.api.getActor(actorId);
    const tagged = new Set(Object.values(actor?.taggedBuilds ?? {}).map((b) => b?.buildId).filter(Boolean));
    const builds = await collect(ctx.api.listBuilds(actorId));
    const picked = pick(builds, ctx, cutoff, (b) => !tagged.has(b.id));
    return {
        total: builds.length,
        doomed: picked.map((b) => () => ctx.api.deleteBuild(b.id)),
        why: `keeps ${tagged.size} tagged, newest ${ctx.opts.keep}, and builds after ${new Date(cutoff).toISOString().slice(0, 10)}`,
    };
}

async function planRuns(ctx: Context, actorId: string, cutoff: number): Promise<Plan> {
    const runs = await collect(ctx.api.listRuns(actorId));
    const statuses = ctx.opts.statuses;
    const picked = pick(runs, ctx, cutoff, (r) => !statuses || statuses.includes(r.status));
    return {
        total: runs.length,
        doomed: picked.map((r) => () => deleteRun(ctx, r)),
        why: `keeps newest ${ctx.opts.keep} and runs after ${new Date(cutoff).toISOString().slice(0, 10)}${statuses ? `; only ${statuses.join(',')}` : ''}${ctx.opts.withStorages ? '; with default storages' : ''}`,
    };
}

/** Finished items past the newest `keep`, older than the cutoff, passing `extra`, capped by `--max`. */
function pick<T extends BuildItem | RunItem>(items: T[], ctx: Context, cutoff: number, extra: (item: T) => boolean): T[] {
    const done = items.filter((i) => TERMINAL.has(i.status)).sort((a, b) => time(b.startedAt) - time(a.startedAt));
    const old = done.slice(ctx.opts.keep).filter((i) => time(i.finishedAt ?? i.startedAt) < cutoff && extra(i));
    return ctx.opts.max === undefined ? old : old.slice(0, ctx.opts.max);
}

async function deleteRun(ctx: Context, run: RunItem) {
    if (ctx.opts.withStorages) {
        const own: [StorageKind, string | undefined][] = [
            ['datasets', run.defaultDatasetId],
            ['key-value-stores', run.defaultKeyValueStoreId],
            ['request-queues', run.defaultRequestQueueId],
        ];
        for (const [kind, id] of own) if (id) await ctx.api.deleteStorage(kind, id);
    }
    await ctx.api.deleteRun(run.id);
}

async function deleteAll(ctx: Context, jobs: (() => Promise<void>)[]): Promise<string[]> {
    const errors: string[] = [];
    await mapLimit(jobs, Math.max(1, ctx.concurrency), async (job) => {
        try {
            await job();
        } catch (err) {
            errors.push(errorText(err));
        }
    });
    return errors;
}

async function cleanStorages(ctx: Context): Promise<Report> {
    if (!ctx.opts.match) throw new UsageError('clean storages needs --match <glob> (named storages to consider, e.g. "tmp-*")');
    const re = globToRegExp(ctx.opts.match);
    const cutoff = ctx.now - ctx.opts.olderThanMs;
    const kinds = ctx.opts.kinds.filter((k) => STORAGE_KINDS.includes(k));
    const rows: Row[] = [];
    for (const kind of kinds) {
        let items: StorageItem[];
        try {
            items = await collect(ctx.api.listStorages(kind));
        } catch (err) {
            rows.push({ actor: `(${kind})`, kind, status: 'failed', detail: errorText(err) });
            continue;
        }
        const used = (s: StorageItem) => Math.max(time(s.modifiedAt), time(s.accessedAt), time(s.createdAt));
        let old = items.filter((s) => s.name && re.test(s.name) && used(s) < cutoff);
        if (ctx.opts.max !== undefined) old = old.slice(0, ctx.opts.max);
        const done = await mapLimit(old, ctx.concurrency, async (s): Promise<Row> => {
            const base = { actor: s.name as string, kind, detail: `last used ${new Date(used(s)).toISOString().slice(0, 10)}` };
            if (!ctx.apply) return { ...base, status: 'would-delete' };
            try {
                await ctx.api.deleteStorage(kind, s.id);
                return { ...base, status: 'deleted' };
            } catch (err) {
                return { ...base, status: 'failed', detail: errorText(err) };
            }
        });
        rows.push(...done);
    }
    const n = rows.filter((r) => r.status !== 'failed').length;
    return report('clean storages', ctx, ['actor', 'kind', 'status', 'detail'], rows, [`${ctx.apply ? 'deleted' : 'would delete'} ${n} storage(s) matching "${ctx.opts.match}"`]);
}
