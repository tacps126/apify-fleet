import { day, errorText, mapLimit } from '../util.js';
import { report, type Context, type Report, type Row } from './types.js';

/** Every Actor with where it lives, its latest build and recent use. Read-only. */
export async function ls(ctx: Context): Promise<Report> {
    const rows = await mapLimit(ctx.targets, ctx.concurrency, async (t): Promise<Row> => {
        const where = t.path && t.id ? 'both' : t.id ? 'apify' : 'local';
        const base: Row = { actor: t.name, status: 'ok', where, tags: t.tags.join(',') };
        if (!t.id) return { ...base, version: t.version ?? '-' };
        try {
            const a = await ctx.api.getActor(t.id);
            if (!a) return { ...base, status: 'failed', detail: 'not found' };
            const latest = a.taggedBuilds?.latest;
            return {
                ...base,
                visibility: a.isDeprecated ? 'deprecated' : a.isPublic ? 'public' : 'private',
                version: t.version ?? latest?.buildNumber?.split('.').slice(0, 2).join('.') ?? '-',
                build: latest?.buildNumber ?? '-',
                built: day(latest?.finishedAt),
                lastRun: day(a.stats?.lastRunStartedAt),
                users30d: a.stats?.totalUsers30Days ?? 0,
            };
        } catch (err) {
            return { ...base, status: 'failed', detail: errorText(err) };
        }
    });
    const notes = [`${rows.length} Actor(s): ${count(rows, 'both')} on disk and Apify, ${count(rows, 'apify')} Apify only, ${count(rows, 'local')} disk only`];
    return report('ls', ctx, ['actor', 'where', 'visibility', 'version', 'build', 'built', 'lastRun', 'users30d', 'tags', 'detail'], rows, notes);
}

function count(rows: Row[], where: string) {
    return rows.filter((r) => r.where === where).length;
}
