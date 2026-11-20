/**
 * A `fetch` that sends each request through `apify api`, so the Apify CLI's own login is used.
 * Newer CLI versions keep their token in the system keychain (OAuth), where nothing else should
 * read it; this way apify-fleet never sees the token at all. Slower than direct HTTP (one process per
 * request), so `APIFY_TOKEN` stays the first choice.
 */

import type { Runner } from './util.js';

export function cliFetch(runner: Runner, bin = 'apify', cwd = process.cwd()): typeof fetch {
    return (async (input: string | URL | Request, init: RequestInit = {}) => {
        const url = new URL(String(input instanceof Request ? input.url : input));
        const method = (init.method ?? 'GET').toUpperCase();
        const args = ['api', '-X', method, url.pathname];
        const params = Object.fromEntries(url.searchParams);
        if (Object.keys(params).length) args.push('-p', JSON.stringify(params));
        if (typeof init.body === 'string') args.push('-d', init.body);
        const result = await runner(bin, args, cwd);
        if (result.code === 0) {
            return new Response(result.stdout.trim() ? result.stdout : null, { status: result.stdout.trim() ? 200 : 204 });
        }
        const http = Number(/Error: (\d{3})\b/.exec(result.stderr)?.[1] ?? 0);
        if (http >= 400) return new Response(result.stdout.trim() || null, { status: http });
        // Not an HTTP answer. Login problems are final; anything else (a token refresh racing another
        // process, a crash) is answered as 503 so the client retries with backoff.
        const lines = result.stderr.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !/old version|npm install/i.test(l));
        const message = lines.slice(0, 3).join(' | ') || `apify exited with ${result.code}`;
        const status = /log ?in|not authenticated|unauthori[sz]ed/i.test(message) ? 401 : 503;
        return new Response(JSON.stringify({ error: { type: 'apify-cli', message } }), { status });
    }) as typeof fetch;
}
