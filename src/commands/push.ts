import { lastLine, mapLimit } from '../util.js';
import { report, type Context, type Report, type Row } from './types.js';

/**
 * Runs `apify push` in each selected Actor folder (bounded concurrency, one failure does not stop the
 * rest). Arguments after `--` go to every `apify push`.
 */
export async function push(ctx: Context): Promise<Report> {
    const columns = ['actor', 'status', 'detail'];
    const local = ctx.targets.filter((t) => t.path);
    const skipped: Row[] = ctx.targets.filter((t) => !t.path).map((t) => ({ actor: t.name, status: 'skipped', detail: 'no local folder' }));
    const args = ['push', ...ctx.opts.passthrough];
    if (!ctx.apply) {
        const rows = local.map((t) => ({ actor: t.name, status: 'would-push', detail: `apify ${args.join(' ')} (in ${t.path})` }));
        return report('push', ctx, columns, [...rows, ...skipped]);
    }
    const cli = await ctx.runner('apify', ['--version'], process.cwd());
    if (cli.code !== 0) {
        const rows = local.map((t) => ({ actor: t.name, status: 'failed', detail: 'apify CLI not found (npm i -g apify-cli, then apify login)' }));
        return report('push', ctx, columns, [...rows, ...skipped]);
    }
    const notes: string[] = [];
    const rows = await mapLimit(local, ctx.concurrency, async (t): Promise<Row> => {
        ctx.log(`pushing ${t.name}`);
        const started = Date.now();
        const result = await ctx.runner('apify', args, t.path as string);
        const secs = Math.round((Date.now() - started) / 1000);
        if (result.code === 0) return { actor: t.name, status: 'pushed', detail: `${secs}s` };
        const tail = `${result.stdout}\n${result.stderr}`.split(/\r?\n/).filter((l) => l.trim()).slice(-15).join('\n');
        notes.push(`--- ${t.name} (exit ${result.code}) ---\n${tail}`);
        return { actor: t.name, status: 'failed', detail: lastLine(result) };
    });
    return report('push', ctx, columns, [...rows, ...skipped], notes);
}
