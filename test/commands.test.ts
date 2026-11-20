import assert from 'node:assert/strict';
import { test } from 'node:test';
import { build as buildCmd } from '../src/commands/build.js';
import { clean } from '../src/commands/clean.js';
import { duration, health, publicStats } from '../src/commands/health.js';
import { ls } from '../src/commands/ls.js';
import { autoPushes, push } from '../src/commands/push.js';
import { settings, settingsUpdate } from '../src/commands/settings.js';
import { listingDiff, listingWarnings, sync } from '../src/commands/sync.js';
import { DEFAULT_OPTIONS, type Context, type Options, type Row } from '../src/commands/types.js';
import type { Target } from '../src/fleet.js';
import { build, daysAgo, FakeApi, fakeRunner, NOW, run } from './fake.js';

function ctx(api: FakeApi, targets: Target[], apply = false, opts: Partial<Options> = {}, extra: Partial<Context> = {}): Context {
    return { api, targets, apply, concurrency: 2, now: NOW, opts: { ...DEFAULT_OPTIONS, ...opts }, runner: fakeRunner(), log: () => {}, ...extra };
}

const t = (name: string, id?: string, more: Partial<Target> = {}): Target => ({ name, id, tags: [], watch: [], ...more });
const byActor = (rows: Row[]): Record<string, Row> => Object.fromEntries(rows.map((r) => [r.actor, r]));

test('ls shows where each Actor lives and its latest build', async () => {
    const api = new FakeApi().add({
        id: 'a1',
        name: 'one',
        isPublic: true,
        taggedBuilds: { latest: { buildId: 'b9', buildNumber: '0.4.12', finishedAt: daysAgo(2) } },
        stats: { totalUsers30Days: 7, lastRunStartedAt: daysAgo(1) },
    });
    api.add({ id: 'a2', name: 'two', isDeprecated: true });
    api.failOn.add('getActor a3');
    api.add({ id: 'a3', name: 'three' });
    const r = await ls(ctx(api, [t('one', 'a1', { path: '/x/one' }), t('two', 'a2'), t('three', 'a3'), t('gone', 'a4'), t('local', undefined, { path: '/x/local', version: '0.1' })]));
    const rows = byActor(r.rows);
    assert.deepEqual(
        { ...rows.one },
        { actor: 'one', status: 'ok', where: 'both', tags: '', visibility: 'public', version: '0.4', build: '0.4.12', built: daysAgo(2).slice(0, 10), lastRun: daysAgo(1).slice(0, 10), users30d: 7 },
    );
    assert.equal(rows.two?.visibility, 'deprecated');
    assert.equal(rows.two?.build, '-');
    assert.equal(rows.three?.status, 'failed');
    assert.equal(rows.gone?.detail, 'not found');
    assert.deepEqual(rows.local, { actor: 'local', status: 'ok', where: 'local', tags: '', version: '0.1' });
    assert.equal(r.failed, 2);
    assert.match(r.notes[0] ?? '', /5 Actor\(s\): 1 on disk and Apify, 3 Apify only, 1 disk only/);
});

test('push: dry run, apply with pass-through args, failures and missing CLI', async () => {
    const targets = [t('a', 'id', { path: '/p/a' }), t('b', undefined, { path: '/p/b' }), t('remote', 'r')];
    const dry = await push(ctx(new FakeApi(), targets, false, { passthrough: ['--force'] }));
    assert.deepEqual(dry.rows.map((r) => [r.actor, r.status]), [['a', 'would-push'], ['b', 'would-push'], ['remote', 'skipped']]);
    assert.match(dry.rows[0]?.detail ?? '', /apify push --force \(in \/p\/a\)/);

    const calls: string[] = [];
    const runner = fakeRunner({ 'apify push --force': { code: 0 } }, calls);
    const failing = fakeRunner({ 'apify --version': { stdout: '1.0' }, 'apify push': { code: 1, stdout: 'Uploading\n', stderr: 'Error: build failed\n' } });
    const ok = await push(ctx(new FakeApi(), targets.slice(0, 1), true, { passthrough: ['--force'] }, { runner }));
    assert.deepEqual(calls, [`apify --version @ ${process.cwd()}`, 'apify push --force @ /p/a']);
    assert.equal(ok.rows[0]?.status, 'pushed');
    const bad = await push(ctx(new FakeApi(), targets.slice(0, 1), true, {}, { runner: failing }));
    assert.equal(bad.rows[0]?.status, 'failed');
    assert.equal(bad.rows[0]?.detail, 'Error: build failed');
    assert.match(bad.notes[0] ?? '', /--- a \(exit 1\) ---\nUploading\nError: build failed/);
    const noCli = await push(ctx(new FakeApi(), targets.slice(0, 1), true, {}, { runner: fakeRunner({ 'apify --version': { code: 127 } }) }));
    assert.match(noCli.rows[0]?.detail ?? '', /apify CLI not found/);
    assert.equal(noCli.failed, 1);
});

test('push --concurrency auto follows the account: free job slots and memory', async () => {
    assert.deepEqual(autoPushes(undefined), { n: 4, why: 'account limits not readable' });
    assert.deepEqual(autoPushes({}), { n: 4, why: 'account limits not readable' });
    assert.deepEqual(autoPushes({ maxConcurrentJobs: 32, activeJobs: 2, maxMemoryGbytes: 64, usedMemoryGbytes: 0 }), {
        n: 8,
        why: '30 of 32 job slots free, 64 of 64 GB memory free',
    });
    assert.equal(autoPushes({ maxConcurrentJobs: 25, maxMemoryGbytes: 8, usedMemoryGbytes: 0 }).n, 2);
    assert.equal(autoPushes({ maxConcurrentJobs: 5, activeJobs: 5 }).n, 1);

    const api = new FakeApi().add({ id: 'a', name: 'a' });
    api.limits = { maxConcurrentJobs: 32, activeJobs: 0, maxMemoryGbytes: 8, usedMemoryGbytes: 0, maxMonthlyUsd: 5, monthlyUsd: 5 };
    const targets = [t('a', 'a', { path: '/p/a' }), t('b', undefined, { path: '/p/b' })];
    const dry = await push(ctx(api, targets, false, {}, { concurrency: 0 }));
    assert.deepEqual(dry.rows.map((r) => r.detail?.split(':')[0]), ['update', 'new Actor']);
    assert.match(dry.notes.join('\n'), /2 push\(es\) at once \(32 of 32 job slots free, 8 of 8 GB memory free/);
    assert.match(dry.notes.join('\n'), /monthly usage limit/);
    const done = await push(ctx(api, targets, true, {}, { concurrency: 0, runner: fakeRunner({ 'apify --version': { stdout: '1' }, 'apify push': { code: 0 } }) }));
    assert.match(done.rows[1]?.detail ?? '', /^new Actor, \d+s$/);

    api.failOn.add('listActors');
    const offline = await push(ctx(api, targets, false, {}, { concurrency: 0 }));
    assert.match(offline.notes.join('\n'), /account not read .*4 push\(es\) at once \(account limits not readable/s);
    const noApi = await push(ctx(api, targets, false, {}, { api: undefined as unknown as FakeApi }));
    assert.equal(noApi.rows[0]?.detail, 'apify push (in /p/a)');
});

test('build picks the version, waits when asked, reports failures', async () => {
    const api = new FakeApi().add({ id: 'a', name: 'a', versions: [{ versionNumber: '0.9' }, { versionNumber: '0.10' }] }).add({ id: 'n', name: 'n', versions: [] });
    const dry = await buildCmd(ctx(api, [t('a', 'a'), t('local', undefined), t('n', 'n'), t('v', 'v', { version: '1.0' })]));
    assert.deepEqual(dry.rows.map((r) => [r.status, r.detail]), [
        ['would-build', 'version 0.10, tag latest'],
        ['skipped', 'not on Apify (push it first)'],
        ['failed', 'no version found'],
        ['would-build', 'version 1.0, tag latest'],
    ]);
    const started = await buildCmd(ctx(api, [t('a', 'a')], true, { actorVersion: '0.2', buildTag: 'beta' }));
    assert.deepEqual([started.rows[0]?.status, started.rows[0]?.detail], ['started', 'build 0.2.9 READY']);
    assert.ok(api.calls.includes('startBuild a 0.2 beta'));
    const waited = await buildCmd(ctx(api, [t('a', 'a')], true, { wait: true }));
    assert.deepEqual([waited.rows[0]?.status, waited.rows[0]?.detail], ['built', 'build 0.1.9 SUCCEEDED']);
    assert.equal(api.calls.filter((c) => c.startsWith('getBuild')).length, 2);
    api.buildSteps = ['FAILED'];
    assert.equal((await buildCmd(ctx(api, [t('a', 'a')], true, { wait: true }))).rows[0]?.status, 'failed');
    api.failOn.add('startBuild');
    assert.match((await buildCmd(ctx(api, [t('a', 'a')], true))).rows[0]?.detail ?? '', /boom/);
});

test('clean builds keeps tagged, newest and recent builds; skips unfinished', async () => {
    const builds = [build('1', 1), build('2', 40), build('3', 50), build('4', 60), build('5', 70), build('6', 80), build('7', 90, 'RUNNING'), build('8', 100, 'FAILED')];
    const api = new FakeApi().add({ id: 'a', name: 'a', taggedBuilds: { latest: { buildId: '2' }, beta: { buildId: '6' }, old: null } }, builds);
    const dry = await clean(ctx(api, [t('a', 'a'), t('x', undefined)]), 'builds');
    assert.deepEqual({ ...dry.rows[0] }, {
        actor: 'a',
        status: 'would-delete',
        deleted: 3,
        kept: 5,
        total: 8,
        detail: 'keeps 2 tagged, newest 3, and builds after 2026-05-31',
    });
    assert.equal(dry.rows[1]?.status, 'skipped');
    assert.deepEqual(dry.notes, ['would delete 3 builds']);
    assert.equal(api.calls.filter((c) => c.startsWith('deleteBuild')).length, 0);

    const done = await clean(ctx(api, [t('a', 'a')], true, { max: 2 }), 'builds');
    assert.equal(done.rows[0]?.status, 'deleted');
    assert.deepEqual(api.calls.filter((c) => c.startsWith('deleteBuild')).sort(), ['deleteBuild 4', 'deleteBuild 5']);
    const again = await clean(ctx(api, [t('a', 'a')], true, { keep: 0, olderThanMs: 0 }), 'builds');
    assert.equal(again.rows[0]?.deleted, 3);
    assert.deepEqual([...(api.builds.get('a') ?? [])].map((b) => b.id).sort(), ['2', '6', '7']);
    const none = await clean(ctx(api, [t('a', 'a')], true), 'builds');
    assert.equal(none.rows[0]?.status, 'unchanged');
});

test('clean runs: status filter, storages, partial failure', async () => {
    const runs = [run('r1', 1), run('r2', 40, 'FAILED'), run('r3', 41), run('r4', 42, 'ABORTED'), run('r5', 43, 'RUNNING')];
    const api = new FakeApi().add({ id: 'a', name: 'a' }, [], runs);
    const dry = await clean(ctx(api, [t('a', 'a')], false, { keep: 0, statuses: ['FAILED', 'ABORTED'] }), 'runs');
    assert.equal(dry.rows[0]?.deleted, 2);
    assert.match(dry.rows[0]?.detail ?? '', /only FAILED,ABORTED/);
    await clean(ctx(api, [t('a', 'a')], true, { keep: 0, statuses: ['FAILED'], withStorages: true }), 'runs');
    assert.deepEqual(api.calls.filter((c) => c.startsWith('delete')), ['deleteStorage datasets ds-r2', 'deleteStorage key-value-stores kv-r2', 'deleteStorage request-queues rq-r2', 'deleteRun r2']);
    api.failOn.add('deleteRun r3');
    const partial = await clean(ctx(api, [t('a', 'a')], true, { keep: 0 }), 'runs');
    assert.deepEqual([partial.rows[0]?.status, partial.rows[0]?.deleted], ['failed', 1]);
    assert.match(partial.rows[0]?.detail ?? '', /1 failed: boom: deleteRun r3/);
    assert.equal(partial.failed, 1);
    api.failOn.add('listRuns');
    assert.equal((await clean(ctx(api, [t('a', 'a')], true), 'runs')).rows[0]?.status, 'failed');
});

test('clean storages needs --match and keeps recently used ones', async () => {
    const api = new FakeApi();
    api.storages.datasets = [
        { id: 'd1', name: 'tmp-old', modifiedAt: daysAgo(90) },
        { id: 'd2', name: 'tmp-touched', modifiedAt: daysAgo(90), accessedAt: daysAgo(1) },
        { id: 'd3', name: 'keep-me', modifiedAt: daysAgo(90) },
        { id: 'd4', modifiedAt: daysAgo(90) },
    ];
    api.storages['key-value-stores'] = [{ id: 'k1', name: 'TMP-x', createdAt: daysAgo(400) }, { id: 'k2', name: 'tmp-y', createdAt: daysAgo(400) }];
    await assert.rejects(clean(ctx(api, []), 'storages'), /needs --match/);
    const dry = await clean(ctx(api, [], false, { match: 'tmp-*', kinds: ['datasets', 'key-value-stores'], max: 5 }), 'storages');
    assert.deepEqual(dry.rows.map((r) => `${r.kind}:${r.actor}:${r.status}`), ['datasets:tmp-old:would-delete', 'key-value-stores:TMP-x:would-delete', 'key-value-stores:tmp-y:would-delete']);
    api.failOn.add('deleteStorage key-value-stores k2');
    api.failOn.add('listStorages request-queues');
    const done = await clean(ctx(api, [], true, { match: 'tmp-*' }), 'storages');
    assert.deepEqual(done.rows.map((r) => `${r.actor}:${r.status}`), ['tmp-old:deleted', 'TMP-x:deleted', 'tmp-y:failed', '(request-queues):failed']);
    assert.deepEqual(done.notes, ['deleted 2 storage(s) matching "tmp-*"']);
    assert.deepEqual(api.storages.datasets.map((s) => s.id), ['d2', 'd3', 'd4']);
});

test('sync sends only changed listing fields and warns on long SEO text', async () => {
    const api = new FakeApi().add({ id: 'a', name: 'a', title: 'Same', description: 'Old', categories: ['B', 'A'] });
    api.add({ id: 'b', name: 'b', title: 'T' });
    const targets = [
        t('a', 'a', { listing: { title: 'Same', description: 'New', categories: ['A', 'B'], seoDescription: 'x'.repeat(201) } }),
        t('b', 'b', { listing: { title: 'T', categories: ['C'] } }),
        t('none', 'n'),
        t('local', undefined, { listing: { title: 'x' } }),
        t('gone', 'g', { listing: { title: 'x' } }),
    ];
    const dry = await sync(ctx(api, targets));
    const rows = byActor(dry.rows);
    assert.equal(rows.a?.status, 'would-change');
    assert.deepEqual(rows.a?.changes, { description: 'New', seoDescription: 'x'.repeat(201) });
    assert.match(rows.a?.detail ?? '', /seoDescription is 201 chars \(cut at 200\)/);
    assert.deepEqual(rows.b?.changes, { categories: ['C'] });
    assert.equal(rows.none?.status, 'skipped');
    assert.equal(rows.local?.status, 'skipped');
    assert.equal(rows.gone?.status, 'failed');
    await sync(ctx(api, targets.slice(0, 2), true));
    assert.equal(api.actors.get('a')?.description, 'New');
    assert.deepEqual(api.actors.get('b')?.categories, ['C']);
    const after = await sync(ctx(api, targets.slice(0, 2), true));
    assert.deepEqual(after.rows.map((r) => r.status), ['unchanged', 'unchanged']);
    api.failOn.add('updateActor');
    api.actors.set('b', { id: 'b', name: 'b' });
    assert.equal((await sync(ctx(api, targets.slice(1, 2), true))).rows[0]?.status, 'failed');
});

test('listingDiff and warnings', () => {
    assert.deepEqual(listingDiff({ id: 'a', name: 'a' }, { title: '', seoTitle: 'S' }), { seoTitle: 'S' });
    assert.deepEqual(listingDiff({ id: 'a', name: 'a' }, { categories: [] }), {});
    assert.deepEqual(listingWarnings({ seoTitle: 'x'.repeat(61), title: 'x'.repeat(500) }), ['seoTitle is 61 chars (cut at 60)']);
});

test('settings: config plus flags, whole objects sent, Standby toggled', async () => {
    const api = new FakeApi().add({ id: 'a', name: 'a', defaultRunOptions: { build: 'latest', memoryMbytes: 1024, timeoutSecs: 3600 }, actorStandby: { isEnabled: true, idleTimeoutSecs: 300 } });
    api.add({ id: 'b', name: 'b', defaultRunOptions: { memoryMbytes: 512 } });
    const targets = [t('a', 'a', { settings: { memoryMbytes: 2048, timeoutSecs: 3600 } }), t('b', 'b'), t('c', undefined, { settings: { memoryMbytes: 256 } }), t('gone', 'g', { settings: { build: 'beta' } })];
    const dry = await settings(ctx(api, targets));
    assert.deepEqual(dry.rows.map((r) => [r.actor, r.status]), [['a', 'would-change'], ['b', 'skipped'], ['c', 'skipped'], ['gone', 'failed']]);
    assert.equal(dry.rows[0]?.detail, 'memoryMbytes: 1024 -> 2048');
    await settings(ctx(api, targets.slice(0, 2), true, { standby: false, timeout: 600 }));
    assert.deepEqual(api.actors.get('a')?.defaultRunOptions, { build: 'latest', memoryMbytes: 2048, timeoutSecs: 600 });
    assert.deepEqual(api.actors.get('a')?.actorStandby, { isEnabled: false, idleTimeoutSecs: 300 });
    assert.deepEqual(api.actors.get('b')?.defaultRunOptions, { memoryMbytes: 512, timeoutSecs: 600 });
    const again = await settings(ctx(api, targets.slice(0, 1), true, { standby: false, timeout: 600 }));
    assert.equal(again.rows[0]?.status, 'unchanged');
    api.failOn.add('updateActor');
    assert.equal((await settings(ctx(api, targets.slice(0, 1), true, { memory: 128 }))).rows[0]?.status, 'failed');
});

test('settingsUpdate only touches what differs', () => {
    assert.deepEqual(settingsUpdate({ id: 'a', name: 'a' }, { standby: true, restartOnError: true }), {
        body: { defaultRunOptions: { restartOnError: true }, actorStandby: { isEnabled: true } },
        changed: ['restartOnError: - -> true', 'standby: off -> on'],
    });
    assert.deepEqual(settingsUpdate({ id: 'a', name: 'a', actorStandby: null }, { standby: false }), { body: {}, changed: [] });
});

test('health: states, stats, alarm', async () => {
    const api = new FakeApi()
        .add({ id: 'ok', name: 'ok', stats: { publicActorRunStats30Days: { TOTAL: 200, SUCCEEDED: 190, FAILED: 6, 'TIMED-OUT': 2, ABORTED: 2 } } }, [], [run('o1', 1, 'SUCCEEDED', 30, 0.5), run('o2', 2, 'SUCCEEDED', 120), run('o3', 3, 'FAILED', 7200), run('o4', 4), run('o5', 5), run('o6', 6)])
        .add({ id: 'bad', name: 'bad' }, [], [run('b1', 1, 'FAILED'), run('b2', 2, 'TIMED-OUT'), run('b3', 3)])
        .add({ id: 'stale', name: 'stale' }, [], [run('s0', 0, 'RUNNING'), run('s1', 20)])
        .add({ id: 'idle', name: 'idle' }, [], [run('i1', 30)]);
    api.failOn.add('listRuns err');
    api.add({ id: 'err', name: 'err' });
    const r = await health(ctx(api, [t('ok', 'ok'), t('bad', 'bad'), t('stale', 'stale'), t('idle', 'idle'), t('err', 'err'), t('local', undefined)], false, { failOn: ['failing'] }));
    const rows = byActor(r.rows);
    assert.deepEqual({ ...rows.ok }, {
        actor: 'ok',
        status: 'ok',
        runs: 6,
        failed: 1,
        failRate: '17%',
        lastSuccess: daysAgo(1).slice(0, 10),
        p50: '60s',
        max: '2.0h',
        usd: '0.550',
        detail: 'last failure o3 FAILED ' + daysAgo(3).slice(0, 10),
        public30d: '200 runs, 5% failed',
    });
    assert.equal(rows.bad?.status, 'failing');
    assert.equal(rows.stale?.status, 'stale');
    assert.equal(rows.stale?.lastSuccess, daysAgo(20).slice(0, 10));
    assert.equal(rows.idle?.status, 'idle');
    assert.equal(rows.err?.status, 'error');
    assert.equal(rows.local?.status, 'skipped');
    assert.equal(r.alarm, true);
    assert.equal(r.failed, 0);
    assert.match(r.notes[0] ?? '', /last 7 day\(s\): 1 ok, 1 failing, 1 stale, 1 idle, 1 error/);
    const calm = await health(ctx(api, [t('ok', 'ok')], false, { runs: 2, staleDays: 1 }));
    assert.equal(calm.rows[0]?.runs, 2);
    assert.equal(calm.alarm, false);
    const empty = await health(ctx(api, []));
    assert.match(empty.notes[0] ?? '', /no Actors/);
});

test('health helpers', () => {
    assert.deepEqual(publicStats(undefined), { public30d: '-' });
    assert.deepEqual(publicStats({ TOTAL: 0 }), { public30d: '-' });
    assert.deepEqual(publicStats({ TOTAL: 10 }), { public30d: '10 runs, 0% failed' });
    assert.equal(duration(undefined), '-');
    assert.equal(duration(89), '89s');
    assert.equal(duration(600), '10m');
    assert.equal(duration(5400), '1.5h');
});
