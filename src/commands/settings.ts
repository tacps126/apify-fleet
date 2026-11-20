import type { ActorDetails } from '../api.js';
import type { Settings } from '../config.js';
import { errorText, mapLimit } from '../util.js';
import { notOnApify, report, type Context, type Report, type Row } from './types.js';

/**
 * Sets default run options (memory, timeout, build tag, restart on error) and Standby on/off, from
 * fleet.json with flags (`--memory`, `--timeout`, `--standby`) on top. Shows the difference first.
 */
export async function settings(ctx: Context): Promise<Report> {
    const flags: Settings = {};
    if (ctx.opts.memory !== undefined) flags.memoryMbytes = ctx.opts.memory;
    if (ctx.opts.timeout !== undefined) flags.timeoutSecs = ctx.opts.timeout;
    if (ctx.opts.standby !== undefined) flags.standby = ctx.opts.standby;
    const rows = await mapLimit(ctx.targets, ctx.concurrency, async (t): Promise<Row> => {
        const want = { ...t.settings, ...flags };
        if (!Object.keys(want).length) return { actor: t.name, status: 'skipped', detail: 'no settings set' };
        if (!t.id) return notOnApify(t);
        try {
            const current = await ctx.api.getActor(t.id);
            if (!current) return { actor: t.name, status: 'failed', detail: 'not found' };
            const { body, changed } = settingsUpdate(current, want);
            if (!changed.length) return { actor: t.name, status: 'unchanged', detail: '' };
            const detail = changed.join('; ');
            if (!ctx.apply) return { actor: t.name, status: 'would-change', detail };
            await ctx.api.updateActor(t.id, body);
            return { actor: t.name, status: 'changed', detail };
        } catch (err) {
            return { actor: t.name, status: 'failed', detail: errorText(err) };
        }
    });
    return report('settings', ctx, ['actor', 'status', 'detail'], rows);
}

/** The update body (whole objects, current values kept) and a `field: old -> new` line per change. */
export function settingsUpdate(current: ActorDetails, want: Settings): { body: Record<string, unknown>; changed: string[] } {
    const run = { ...(current.defaultRunOptions ?? {}) };
    const changed: string[] = [];
    for (const key of ['memoryMbytes', 'timeoutSecs', 'build', 'restartOnError'] as const) {
        if (want[key] !== undefined && want[key] !== run[key]) {
            changed.push(`${key}: ${String(run[key] ?? '-')} -> ${String(want[key])}`);
            (run as Record<string, unknown>)[key] = want[key];
        }
    }
    const body: Record<string, unknown> = {};
    if (changed.length) body.defaultRunOptions = run;
    const standbyNow = Boolean(current.actorStandby?.isEnabled);
    if (want.standby !== undefined && want.standby !== standbyNow) {
        changed.push(`standby: ${standbyNow ? 'on' : 'off'} -> ${want.standby ? 'on' : 'off'}`);
        body.actorStandby = { ...(current.actorStandby ?? {}), isEnabled: want.standby };
    }
    return { body, changed };
}
