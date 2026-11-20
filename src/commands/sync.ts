import type { ActorDetails } from '../api.js';
import type { Listing } from '../config.js';
import { errorText, mapLimit } from '../util.js';
import { notOnApify, report, type Context, type Report, type Row } from './types.js';

/** Lengths past which Store and search results cut the text. Over them is a warning, not an error. */
export const LIMITS: Partial<Record<keyof Listing, number>> = { seoTitle: 60, seoDescription: 200 };

/**
 * Sets Store listing text (title, description, SEO title and description, categories) from
 * fleet.json or each Actor's `.actor/listing.json`. Shows the difference first; sends only changed
 * fields.
 */
export async function sync(ctx: Context): Promise<Report> {
    const rows = await mapLimit(ctx.targets, ctx.concurrency, async (t): Promise<Row> => {
        if (!t.listing || !Object.keys(t.listing).length) return { actor: t.name, status: 'skipped', detail: 'no listing set' };
        if (!t.id) return notOnApify(t);
        try {
            const current = await ctx.api.getActor(t.id);
            if (!current) return { actor: t.name, status: 'failed', detail: 'not found' };
            const changes = listingDiff(current, t.listing);
            const warnings = listingWarnings(t.listing);
            const fields = Object.keys(changes);
            const detail = [fields.length ? `fields: ${fields.join(', ')}` : '', ...warnings].filter(Boolean).join('; ');
            if (!fields.length) return { actor: t.name, status: 'unchanged', detail, changes };
            if (!ctx.apply) return { actor: t.name, status: 'would-change', detail, changes };
            await ctx.api.updateActor(t.id, changes);
            return { actor: t.name, status: 'changed', detail, changes };
        } catch (err) {
            return { actor: t.name, status: 'failed', detail: errorText(err) };
        }
    });
    return report('sync', ctx, ['actor', 'status', 'detail'], rows);
}

/** Fields of `want` that differ from the Actor; categories compare as sets. */
export function listingDiff(current: ActorDetails, want: Listing): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const key of ['title', 'description', 'seoTitle', 'seoDescription'] as const) {
        const value = want[key];
        if (value !== undefined && value !== (current[key] ?? '')) out[key] = value;
    }
    if (want.categories) {
        const have = [...(current.categories ?? [])].sort().join(',');
        if ([...want.categories].sort().join(',') !== have) out.categories = want.categories;
    }
    return out;
}

export function listingWarnings(want: Listing): string[] {
    const out: string[] = [];
    for (const [key, max] of Object.entries(LIMITS) as [keyof Listing, number][]) {
        const value = want[key];
        if (typeof value === 'string' && value.length > max) out.push(`${key} is ${value.length} chars (cut at ${max})`);
    }
    return out;
}
