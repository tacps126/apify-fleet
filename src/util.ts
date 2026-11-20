/** Small helpers shared by the commands. */

import { spawn } from 'node:child_process';

/** Runs `fn` over `items` with at most `limit` in flight; results keep input order. */
export async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
    const results = new Array<R>(items.length);
    let next = 0;
    const worker = async () => {
        while (next < items.length) {
            const index = next++;
            results[index] = await fn(items[index] as T, index);
        }
    };
    await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
    return results;
}

/** `30d`, `12h`, `90m`, `45s`, or a bare number of days, to milliseconds. */
export function parseDuration(text: string): number {
    const m = /^(\d+(?:\.\d+)?)([dhms]?)$/.exec(text.trim());
    if (!m) throw new UsageError(`not a duration: "${text}" (use 30d, 12h, 90m or a number of days)`);
    const unit = { d: 86_400_000, h: 3_600_000, m: 60_000, s: 1000, '': 86_400_000 }[m[2] as 'd' | 'h' | 'm' | 's' | ''];
    return Number(m[1]) * unit;
}

/** Glob with `*` and `?` to an anchored regular expression. */
export function globToRegExp(glob: string): RegExp {
    const body = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
    return new RegExp(`^${body}$`, 'i');
}

export function isGlob(text: string): boolean {
    return /[*?]/.test(text);
}

export function time(iso: string | undefined): number {
    const t = iso ? Date.parse(iso) : Number.NaN;
    return Number.isNaN(t) ? 0 : t;
}

export function day(iso: string | undefined): string {
    return iso ? iso.slice(0, 10) : '-';
}

export function errorText(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
}

export class UsageError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'UsageError';
    }
}

export interface ExecResult {
    code: number;
    stdout: string;
    stderr: string;
}

/** Runs a program without a shell (except on Windows, where `.cmd` shims need one). */
export type Runner = (cmd: string, args: string[], cwd: string) => Promise<ExecResult>;

export const runProcess: Runner = (cmd, args, cwd) =>
    new Promise((resolve) => {
        const child = spawn(cmd, args, { cwd, shell: process.platform === 'win32', env: process.env });
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (d: Buffer) => (stdout += d.toString()));
        child.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
        child.on('error', (err) => resolve({ code: 127, stdout, stderr: stderr + err.message }));
        child.on('close', (code) => resolve({ code: code ?? 1, stdout, stderr }));
    });

/** Last non-empty line of a process's output, for a one-line failure reason. */
export function lastLine(result: ExecResult): string {
    const lines = `${result.stdout}\n${result.stderr}`.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    return (lines.at(-1) ?? `exit code ${result.code}`).slice(0, 200);
}

/** Compares semantic-ish versions like `0.2` and `1.10`. */
export function compareVersions(a: string, b: string): number {
    const pa = a.split('.').map(Number);
    const pb = b.split('.').map(Number);
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
        const d = (pa[i] ?? 0) - (pb[i] ?? 0);
        if (d) return d;
    }
    return 0;
}
