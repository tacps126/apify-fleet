import { TERMINAL, type RunItem } from '../api.js';
import { day, errorText, mapLimit, time } from '../util.js';
import { notOnApify, report, type Context, type Report, type Row } from './types.js';

export const HEALTH_STATES = ['ok', 'failing', 'stale', 'idle', 'error'] as const;
const FAILED = new Set(['FAILED', 'TIMED-OUT', 'ABORTED']);

/**
 * Your own recent runs per Actor (`--days`, at most `--runs`), plus the Store's 30-day public run
 * stats when the Actor is public. States: `failing` (failure rate above `--max-fail-rate`),
 * `stale` (runs but no success in `--stale-days`), `idle` (no runs), `ok`. With `--fail-on`
 * the command exits 3 when any Actor is in one of the listed states.
 */
export async function health(ctx: Context): Promise<Report> {
    const since = ctx.now - ctx.opts.days * 86_400_000;
    const staleSince = ctx.now - (ctx.opts.staleDays ?? ctx.opts.days) * 86_400_000;
    const rows = await mapLimit(ctx.targets, ctx.concurrency, async (t): Promise<Row> => {
        if (!t.id) return notOnApify(t);
        try {
            const recent: RunItem[] = [];
            let lastSuccess: string | undefined;
            for await (const run of ctx.api.listRuns(t.id)) {
                const inWindow = time(run.startedAt) >= since && recent.length < ctx.opts.runs;
                if (inWindow) recent.push(run);
                if (run.status === 'SUCCEEDED') lastSuccess ??= run.finishedAt ?? run.startedAt;
                if (!inWindow && (lastSuccess || time(run.startedAt) < staleSince)) break;
            }
            const actor = await ctx.api.getActor(t.id);
            return { actor: t.name, ...summarize(recent, lastSuccess, staleSince, ctx.opts.maxFailRate), ...publicStats(actor?.stats?.publicActorRunStats30Days) };
        } catch (err) {
            return { actor: t.name, status: 'error', detail: errorText(err) };
        }
    });
    const out = report('health', ctx, ['actor', 'status', 'runs', 'failed', 'failRate', 'lastSuccess', 'p50', 'max', 'usd', 'public30d', 'detail'], rows);
    out.failed = 0;
    out.alarm = rows.some((r) => ctx.opts.failOn.includes(r.status));
    const counts = HEALTH_STATES.map((s) => [s, rows.filter((r) => r.status === s).length] as const).filter(([, n]) => n);
    out.notes.push(`last ${ctx.opts.days} day(s): ${counts.map(([s, n]) => `${n} ${s}`).join(', ') || 'no Actors'}`);
    return out;
}

export function summarize(runs: RunItem[], lastSuccess: string | undefined, staleSince: number, maxFailRate: number) {
    const finished = runs.filter((r) => TERMINAL.has(r.status));
    const failed = finished.filter((r) => FAILED.has(r.status)).length;
    const failRate = finished.length ? failed / finished.length : 0;
    const secs = finished
        .map((r) => (time(r.finishedAt) - time(r.startedAt)) / 1000)
        .filter((s) => s >= 0)
        .sort((a, b) => a - b);
    const usd = runs.reduce((sum, r) => sum + (r.usageTotalUsd ?? 0), 0);
    let status: string = 'ok';
    if (!runs.length) status = 'idle';
    else if (finished.length && failRate > maxFailRate) status = 'failing';
    else if (!lastSuccess || time(lastSuccess) < staleSince) status = 'stale';
    const latestFailure = finished.find((r) => FAILED.has(r.status));
    return {
        status,
        runs: runs.length,
        failed,
        failRate: `${Math.round(failRate * 100)}%`,
        lastSuccess: day(lastSuccess),
        p50: duration(secs[Math.floor((secs.length - 1) / 2)]),
        max: duration(secs.at(-1)),
        usd: usd.toFixed(3),
        detail: latestFailure ? `last failure ${latestFailure.id} ${latestFailure.status} ${day(latestFailure.startedAt)}` : '',
    };
}

export function publicStats(stats: Record<string, number> | undefined): { public30d: string } {
    if (!stats?.TOTAL) return { public30d: '-' };
    const bad = (stats.FAILED ?? 0) + (stats['TIMED-OUT'] ?? 0) + (stats.ABORTED ?? 0);
    return { public30d: `${stats.TOTAL} runs, ${Math.round((bad / stats.TOTAL) * 100)}% failed` };
}

export function duration(secs: number | undefined): string {
    if (secs === undefined) return '-';
    if (secs < 90) return `${Math.round(secs)}s`;
    if (secs < 5400) return `${Math.round(secs / 60)}m`;
    return `${(secs / 3600).toFixed(1)}h`;
}
