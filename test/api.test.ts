import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ApiError, backoff, collect, HttpApi, retryAfter } from '../src/api.js';

interface Call {
    url: URL;
    method: string;
    headers: Record<string, string>;
    body?: string;
}

function fakeFetch(responses: (Response | Error | ((c: Call) => Response))[], calls: Call[] = []): typeof fetch {
    return (async (input: URL, init: RequestInit) => {
        const call = { url: new URL(String(input)), method: init.method ?? 'GET', headers: init.headers as Record<string, string>, body: init.body as string | undefined };
        calls.push(call);
        const next = responses.shift();
        if (!next) throw new Error('no more responses');
        if (next instanceof Error) throw next;
        return typeof next === 'function' ? next(call) : next;
    }) as typeof fetch;
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

function api(responses: Parameters<typeof fakeFetch>[0], calls: Call[] = [], sleeps: number[] = [], extra = {}) {
    return new HttpApi({ token: 't0k', fetch: fakeFetch(responses, calls), sleep: async (ms) => void sleeps.push(ms), ...extra });
}

test('sends the token as a bearer header and unwraps data', async () => {
    const calls: Call[] = [];
    const a = api([json({ data: { id: 'a1', name: 'x' } })], calls);
    assert.deepEqual(await a.getActor('me~x'), { id: 'a1', name: 'x' });
    assert.equal(calls[0]?.headers.authorization, 'Bearer t0k');
    assert.match(calls[0]?.headers['user-agent'] ?? '', /^apify-fleet\//);
    assert.equal(calls[0]?.url.pathname, '/v2/acts/me~x');
});

test('retries 429 honouring Retry-After, then 5xx and network errors with backoff', async () => {
    const sleeps: number[] = [];
    const a = api([json({}, 429, { 'retry-after': '2' }), json({}, 503), new TypeError('fetch failed'), json({ data: { id: 'a' } })], [], sleeps);
    assert.deepEqual(await a.getActor('a'), { id: 'a' });
    assert.deepEqual(sleeps, [2000, 1000, 2000]);
});

test('gives up after the last retry', async () => {
    const a = api([json({}, 500), json({ error: { type: 'internal', message: 'down' } }, 500)], [], [], { retries: 1 });
    await assert.rejects(a.getActor('a'), (e: unknown) => e instanceof ApiError && e.status === 500 && /internal: down/.test(e.message));
    const b = api([new Error('reset'), new Error('reset')], [], [], { retries: 1 });
    await assert.rejects(b.getActor('a'), /reset/);
});

test('404 reads as missing; delete of a missing item succeeds; other errors throw', async () => {
    const a = api([json({ error: { type: 'record-not-found', message: 'nope' } }, 404), new Response('', { status: 404 }), new Response(null, { status: 204 }), new Response('bad', { status: 403 })]);
    assert.equal(await a.getActor('gone'), undefined);
    await a.deleteRun('gone');
    await a.deleteBuild('b1');
    await assert.rejects(a.deleteStorage('datasets', 'd1'), (e: unknown) => e instanceof ApiError && e.status === 403 && e.type === 'http-error' && /bad/.test(e.message));
});

test('non-404 errors on reads throw', async () => {
    const a = api([json({ error: { type: 'forbidden', message: 'no' } }, 403)]);
    await assert.rejects(a.getBuild('b', 0), /403 forbidden/);
});

test('pages through lists until a short page or the total', async () => {
    const calls: Call[] = [];
    const a = api(
        [json({ data: { items: [{ id: '1' }, { id: '2' }], total: 3 } }), json({ data: { items: [{ id: '3' }], total: 3 } }), json({ data: { items: [{ id: 'r1' }, { id: 'r2' }], total: 2 } })],
        calls,
        [],
        { pageSize: 2 },
    );
    assert.deepEqual((await a.listActors()).map((x) => x.id), ['1', '2', '3']);
    assert.equal(calls[0]?.url.searchParams.get('my'), 'true');
    assert.equal(calls[1]?.url.searchParams.get('offset'), '2');
    assert.deepEqual((await collect(a.listRuns('a'))).map((x) => x.id), ['r1', 'r2']);
    assert.equal(calls[2]?.url.searchParams.get('desc'), 'true');
});

test('every endpoint uses the documented path and method', async () => {
    const calls: Call[] = [];
    const empty = () => json({ data: { items: [] } });
    const a = api([empty(), empty(), json({ data: { id: 'a' } }), json({ data: { id: 'b', status: 'READY' } }), json({ data: { id: 'b' } }), json({ data: { id: 'b' } }), new Response(null, { status: 204 })], calls);
    await collect(a.listBuilds('a'));
    await collect(a.listStorages('key-value-stores'));
    await a.updateActor('a', { title: 'T' });
    await a.startBuild('a', '0.2', 'latest');
    await a.getBuild('b', 90);
    await a.getBuild('b', 0);
    await a.deleteStorage('request-queues', 'q');
    const seen = calls.map((c) => `${c.method} ${c.url.pathname}${c.url.search}`);
    assert.deepEqual(seen, [
        'GET /v2/acts/a/builds?desc=true&offset=0&limit=1000',
        'GET /v2/key-value-stores?unnamed=false&offset=0&limit=1000',
        'PUT /v2/acts/a',
        'POST /v2/acts/a/builds?version=0.2&tag=latest',
        'GET /v2/actor-builds/b?waitForFinish=60',
        'GET /v2/actor-builds/b',
        'DELETE /v2/request-queues/q',
    ]);
    assert.equal(calls[2]?.body, '{"title":"T"}');
    assert.equal(calls[2]?.headers['content-type'], 'application/json');
});

test('account limits: GET /users/me/limits, numbers only', async () => {
    const calls: Call[] = [];
    const a = api([json({ data: { limits: { maxConcurrentActorJobs: 32, maxActorMemoryGbytes: 64, maxMonthlyUsageUsd: 'x' }, current: { activeActorJobCount: 1, actorMemoryGbytes: 4, monthlyUsageUsd: 2 } } }), json({}, 404)], calls);
    assert.deepEqual(await a.accountLimits(), { maxConcurrentJobs: 32, activeJobs: 1, maxMemoryGbytes: 64, usedMemoryGbytes: 4, maxMonthlyUsd: undefined, monthlyUsd: 2 });
    assert.equal(calls[0]?.url.pathname, '/v2/users/me/limits');
    assert.equal(await a.accountLimits(), undefined);
});

test('custom base URL, and a non-JSON body passes through', async () => {
    const calls: Call[] = [];
    const a = new HttpApi({ token: 't', baseUrl: 'http://localhost:9/', fetch: fakeFetch([new Response('plain')], calls) });
    assert.equal(await a.request('GET', '/x'), undefined);
    assert.equal(calls[0]?.url.href, 'http://localhost:9/v2/x');
});

test('backoff and Retry-After parsing', () => {
    assert.equal(backoff(0), 500);
    assert.equal(backoff(20), 30_000);
    assert.equal(retryAfter(null), undefined);
    assert.equal(retryAfter('3'), 3000);
    assert.equal(retryAfter('999'), 60_000);
    assert.equal(retryAfter('soon'), undefined);
    const inFuture = retryAfter(new Date(Date.now() + 5000).toUTCString()) ?? -1;
    assert.ok(inFuture > 0 && inFuture <= 5000);
});

test('collect stops early', async () => {
    async function* gen() {
        yield* [1, 2, 3, 4];
    }
    assert.deepEqual(await collect(gen(), (n) => n === 3), [1, 2]);
});
