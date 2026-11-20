import { TERMINAL } from '../api.js';
import { compareVersions, errorText, mapLimit } from '../util.js';
import { notOnApify, report, type Context, type Report, type Row } from './types.js';

const MAX_WAIT_MS = 60 * 60 * 1000;

/**
 * Starts a build from the source already on Apify (no upload), for example to pick up a new base
 * image. Version: `--actor-version`, else the local `actor.json`, else the highest on Apify.
 */
export async function build(ctx: Context): Promise<Report> {
    const rows = await mapLimit(ctx.targets, ctx.concurrency, async (t): Promise<Row> => {
        if (!t.id) return notOnApify(t);
        try {
            let version = ctx.opts.actorVersion ?? t.version;
            if (!version) {
                const actor = await ctx.api.getActor(t.id);
                version = (actor?.versions ?? []).map((v) => v.versionNumber).sort(compareVersions).at(-1);
            }
            if (!version) return { actor: t.name, status: 'failed', detail: 'no version found' };
            if (!ctx.apply) return { actor: t.name, status: 'would-build', detail: `version ${version}, tag ${ctx.opts.buildTag}` };
            let b = await ctx.api.startBuild(t.id, version, ctx.opts.buildTag);
            ctx.log(`build ${b.buildNumber ?? b.id} started for ${t.name}`);
            if (ctx.opts.wait) {
                const deadline = Date.now() + MAX_WAIT_MS;
                while (!TERMINAL.has(b.status) && Date.now() < deadline) {
                    b = (await ctx.api.getBuild(b.id, 60)) ?? b;
                }
            }
            const status = !ctx.opts.wait ? 'started' : b.status === 'SUCCEEDED' ? 'built' : TERMINAL.has(b.status) ? 'failed' : 'running';
            return { actor: t.name, status, detail: `build ${b.buildNumber ?? b.id} ${b.status}` };
        } catch (err) {
            return { actor: t.name, status: 'failed', detail: errorText(err) };
        }
    });
    return report('build', ctx, ['actor', 'status', 'detail'], rows);
}
