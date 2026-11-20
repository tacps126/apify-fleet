import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { main, options, type Deps } from '../src/cli.js';
import { VERSION } from '../src/version.js';
import { FakeApi, fakeRunner, NOW, run } from './fake.js';
import { actorJson, tree } from './helpers.js';

async function cli(args: string[], deps: Deps = {}) {
    let stdout = '';
    let stderr = '';
    const code = await main(args, { now: NOW, home: '/nowhere', env: {}, stdout: (s) => void (stdout += s), stderr: (s) => void (stderr += s), ...deps });
    return { code, stdout, stderr };
}

const fleetDir = () =>
    tree({
        'fleet.json': { actors: { one: { tags: ['main'], settings: { memoryMbytes: 2048 } } } },
        'one/.actor/actor.json': actorJson('one'),
        'two/.actor/actor.json': actorJson('two'),
    });

const api = () =>
    new FakeApi()
        .add({ id: 'id1', name: 'one', defaultRunOptions: { memoryMbytes: 1024 } }, [], [run('r1', 1)])
        .add({ id: 'id2', name: 'two' }, [], [run('r2', 1, 'FAILED')]);

test('version matches package.json', async () => {
    const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { version: string };
    assert.equal(VERSION, pkg.version);
    assert.deepEqual(await cli(['--version']), { code: 0, stdout: `${VERSION}\n`, stderr: '' });
});

test('help with no command, help, or --help', async () => {
    for (const args of [[], ['help'], ['ls', '--help']]) {
        const r = await cli(args);
        assert.equal(r.code, 0);
        assert.match(r.stdout, /^apify-fleet .*Usage:/s);
    }
});

test('usage errors exit 2', async () => {
    const cases: [string[], RegExp][] = [
        [['nope'], /unknown command "nope"/],
        [['clean'], /clean what\?/],
        [['ls', '--bogus'], /Unknown option '--bogus'/],
        [['ls', '--', 'x'], /only for push/],
        [['ls', '--keep=-1'], /--keep: expected a whole number >= 0/],
        [['ls', '--days', 'x'], /--days: expected a number/],
        [['ls', '--max-fail-rate', '2'], /fraction/],
        [['ls', '--fail-on', 'bad'], /--fail-on: unknown bad/],
        [['ls', '--kind', 'tables'], /--kind: unknown tables/],
        [['ls', '--memory', '1000'], /power of two/],
        [['ls', '--standby', 'maybe'], /on or off/],
        [['ls', '--actor-version', '1'], /looks like 0.1/],
        [['ls', '--older-than', 'soon'], /not a duration/],
        [['ls', '--concurrency', '0'], /--concurrency/],
    ];
    for (const [args, re] of cases) {
        const r = await cli(args);
        assert.equal(r.code, 2, args.join(' '));
        assert.match(r.stderr, re, args.join(' '));
    }
});

test('ls over disk plus account, table and JSON', async () => {
    const cwd = fleetDir();
    const table = await cli(['ls'], { cwd, api: api() });
    assert.equal(table.code, 0);
    assert.match(table.stdout, /^actor\s+where\s+visibility/);
    assert.match(table.stdout, /one\s+both\s+private/);
    const json = await cli(['ls', '--tag', 'main', '--json'], { cwd, api: api() });
    const report = JSON.parse(json.stdout) as { command: string; rows: { actor: string }[] };
    assert.equal(report.command, 'ls');
    assert.deepEqual(report.rows.map((r) => r.actor), ['one']);
});

test('changing commands need a selection, dry-run by default, apply on request', async () => {
    const cwd = fleetDir();
    const fake = api();
    const refused = await cli(['settings'], { cwd, api: fake });
    assert.equal(refused.code, 2);
    const dry = await cli(['settings', 'one'], { cwd, api: fake });
    assert.equal(dry.code, 0);
    assert.match(dry.stdout, /would-change\s+memoryMbytes: 1024 -> 2048/);
    assert.match(dry.stdout, /Dry run: nothing was changed/);
    assert.equal(fake.calls.some((c) => c.startsWith('updateActor')), false);
    const applied = await cli(['settings', '--all', '--apply', '--quiet'], { cwd, api: fake });
    assert.equal(applied.code, 0);
    assert.equal(fake.actors.get('id1')?.defaultRunOptions?.memoryMbytes, 2048);
});

test('exit 1 when an action fails, 3 on a health alarm', async () => {
    const cwd = fleetDir();
    const fake = api();
    fake.failOn.add('updateActor');
    assert.equal((await cli(['settings', 'one', '--apply'], { cwd, api: fake })).code, 1);
    assert.equal((await cli(['health', '--fail-on', 'failing'], { cwd, api: api() })).code, 3);
    assert.equal((await cli(['health'], { cwd, api: api() })).code, 0);
});

test('push needs no token and passes args after --; clean storages skips the fleet', async () => {
    const cwd = fleetDir();
    const calls: string[] = [];
    const r = await cli(['push', 'one', '--apply', '--', '--force', '-b', 'beta'], { cwd, runner: fakeRunner({}, calls) });
    assert.equal(r.code, 0);
    assert.match(r.stderr, /pushing one/);
    assert.ok(calls.some((c) => c.startsWith('apify push --force -b beta @ ') && c.endsWith('/one')));
    const fake = new FakeApi();
    const s = await cli(['clean', 'storages', '--match', 'tmp-*'], { cwd, api: fake });
    assert.equal(s.code, 0);
    assert.equal(fake.calls.includes('listActors'), false);
    assert.match(s.stdout, /No Actors selected/);
});

test('--root picks where Actor folders are found; duplicate names exit 2', async () => {
    const cwd = fleetDir();
    const r = await cli(['push', '--all', '--root', 'two'], { cwd, runner: fakeRunner({}) });
    assert.equal(r.code, 0);
    assert.match(r.stdout, /two/);
    assert.doesNotMatch(r.stdout, /would-push.*\/one\b/);
    const dup = tree({ 'a/.actor/actor.json': actorJson('same'), 'b/.actor/actor.json': actorJson('same') });
    const d = await cli(['push', '--all'], { cwd: dup, runner: fakeRunner({}) });
    assert.equal(d.code, 2);
    assert.match(d.stderr, /2 folders define Actor "same" \(a, b\)/);
});

test('token from env or the login file builds the HTTP client', async () => {
    const seen: string[] = [];
    const fetch = (async (url: URL, init: RequestInit) => {
        seen.push(`${String(url)} ${(init.headers as Record<string, string>).authorization}`);
        return new Response(JSON.stringify({ data: { items: [], total: 0 } }));
    }) as typeof globalThis.fetch;
    const r = await cli(['ls', '--json'], { cwd: fleetDir(), env: { APIFY_TOKEN: 'x', APIFY_API_BASE_URL: 'http://127.0.0.1:9' }, fetch });
    assert.equal(r.code, 0);
    assert.deepEqual(seen, ['http://127.0.0.1:9/v2/acts?my=true&offset=0&limit=1000 Bearer x']);
    const home = tree({ '.apify/auth.json': { token: 'saved' } });
    await cli(['ls'], { cwd: fleetDir(), home, fetch });
    assert.match(seen[1] ?? '', /^https:\/\/api\.apify\.com\/v2\/acts.* Bearer saved$/);
});

test('no token: uses the Apify CLI login when the CLI exists, else explains', async () => {
    const calls: string[] = [];
    const runner = fakeRunner({ 'apify --version': { stdout: '1.12' }, 'apify api*': { stdout: '{"data":{"items":[],"total":0}}' } }, calls);
    const r = await cli(['ls'], { cwd: fleetDir(), runner });
    assert.equal(r.code, 0);
    assert.match(r.stderr, /using the Apify CLI login/);
    assert.ok(calls.some((c) => c.startsWith('apify api -X GET /v2/acts')));
    const quiet = await cli(['ls', '--json'], { cwd: fleetDir(), runner });
    assert.equal(quiet.stderr, '');
    const none = await cli(['ls'], { cwd: fleetDir(), runner: fakeRunner({ 'apify --version': { code: 127 } }) });
    assert.equal(none.code, 2);
    assert.match(none.stderr, /no Apify token/);
});

test('options parsing', () => {
    const o = options({ 'older-than': '12h', keep: '0', status: 'failed, aborted', 'with-storages': true, kind: 'datasets', max: '10', days: '3', 'stale-days': '14', runs: '5', 'max-fail-rate': '0.5', 'fail-on': 'failing,stale', memory: '4096', timeout: '0', standby: 'off', wait: true, 'build-tag': 'beta', 'actor-version': '1.2', match: 'x' });
    assert.deepEqual(o, {
        olderThanMs: 43_200_000,
        keep: 0,
        statuses: ['FAILED', 'ABORTED'],
        withStorages: true,
        match: 'x',
        kinds: ['datasets'],
        max: 10,
        days: 3,
        staleDays: 14,
        runs: 5,
        maxFailRate: 0.5,
        failOn: ['failing', 'stale'],
        memory: 4096,
        timeout: 0,
        standby: false,
        wait: true,
        buildTag: 'beta',
        actorVersion: '1.2',
        passthrough: [],
    });
});
