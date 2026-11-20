import type { Report } from './commands/types.js';

/** Plain-text table: only columns with at least one value, widths fitted, long cells cut. */
export function renderTable(r: Report, maxCell = 80): string {
    const cell = (v: unknown) => {
        const s = v === undefined || v === null ? '' : String(v);
        return s.length > maxCell ? `${s.slice(0, maxCell - 3)}...` : s;
    };
    const columns = r.columns.filter((c) => r.rows.some((row) => cell(row[c]) !== ''));
    const lines: string[] = [];
    if (r.rows.length) {
        const widths = columns.map((c) => Math.max(c.length, ...r.rows.map((row) => cell(row[c]).length)));
        const line = (values: string[]) => values.map((v, i) => v.padEnd(widths[i] as number)).join('  ').trimEnd();
        lines.push(line(columns), line(widths.map((w) => '-'.repeat(w))));
        for (const row of r.rows) lines.push(line(columns.map((c) => cell(row[c]))));
    } else {
        lines.push('No Actors selected.');
    }
    lines.push('', ...r.notes);
    if (!r.apply && r.rows.some((row) => row.status.startsWith('would-'))) {
        lines.push('Dry run: nothing was changed. Run again with --apply to do it.');
    }
    return `${lines.join('\n').trimEnd()}\n`;
}

export function renderJson(r: Report): string {
    return `${JSON.stringify(r, null, 2)}\n`;
}
