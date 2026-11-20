import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import { parseConfig } from '../src/config.js';
import { buildFleet, changedFiles, select, type Target } from '../src/fleet.js';
import { FakeApi, fakeRunner } from './fake.js';
import { actorJson, tree } from './helpers.js';

test('merges disk, fleet.json and the account; defaults apply to all', async () => {
    const root = tree({
        'actors/one/.actor/actor.json': actorJson('one', '0.3'),
        'actors/one/.actor/listing.json': { title: 'From file', seoTitle: 'File SEO' },
        'actors/renamed/.actor/actor.json': actorJson('old-name'),
        'actors/local-only/.actor/actor.json': actorJson('local-only'),
    });
    const config = parseConfig(
        {
            defaults: { tags: ['fleet'], settings: { memoryMbytes: 512 } },
            actors: {
                one: { tags: ['jobs'], listing: { title: 'From config' } },
                'new-name': { path: 'actors/renamed', id: 'me~new-name' },
                'config-only': { tags: ['x'] },
            },
        },
        root,
    );
    const api = new FakeApi().add({ id: 'id1', name: 'one' }).add({ id: 'id2', name: 'new-name' }).add({ id: 'id3', name: 'remote-only' });
    const fleet = await buildFleet({ config, api });
    const by = Object.fromEntries(fleet.map((t) => [t.name, t]));
    assert.deepEqual(Object.keys(by), ['config-only', 'local-only', 'new-name', 'one', 'remote-only']);
    assert.equal(by.one?.id, 'id1');
    assert.equal(by.one?.version, '0.3');
    assert.deepEqual(by.one?.tags, ['fleet', 'jobs']);
    assert.deepEqual(by.one?.listing, { title: 'From config', seoTitle: 'File SEO' });
    assert.deepEqual(by.one?.settings, { memoryMbytes: 512 });
    assert.equal(by['new-name']?.path, join(root, 'actors/renamed'));
    assert.equal(by['new-name']?.id, 'id2');
    assert.equal(by['remote-only']?.path, undefined);
    assert.deepEqual(by['remote-only']?.tags, ['fleet']);
    assert.equal(by['config-only']?.id, undefined);
    assert.equal(by['local-only']?.id, undefined);
});

test('discover: false and root narrow what is read from disk; no api means no remote', async () => {
    const root = tree({ 'a/.actor/actor.json': actorJson('a'), 'sub/b/.actor/actor.json': actorJson('b') });
    assert.deepEqual((await buildFleet({ config: parseConfig({ discover: false }, root) })).map((t) => t.name), []);
    assert.deepEqual((await buildFleet({ config: parseConfig({ root: 'sub' }, root) })).map((t) => t.name), ['b']);
});

const fleet: Target[] = ['alpha-scraper', 'beta-scraper', 'gamma'].map((name, i) => ({ name, id: `id${i}`, tags: i ? ['b'] : ['a'], watch: [], path: `/repo/actors/${name}` }));

test('select by name, id, glob and tag; refuses an unscoped change', async () => {
    const pick = (names: string[], tags: string[] = [], all = false, readOnly = false) => select(fleet, { names, tags, all }, { readOnly }).then((r) => r.map((t) => t.name));
    assert.deepEqual(await pick(['gamma', 'id0']), ['alpha-scraper', 'gamma']);
    assert.deepEqual(await pick(['*-scraper']), ['alpha-scraper', 'beta-scraper']);
    assert.deepEqual(await pick([], ['b']), ['beta-scraper', 'gamma']);
    assert.deepEqual(await pick(['*-scraper'], ['b']), ['beta-scraper']);
    assert.deepEqual(await pick([], [], true), ['alpha-scraper', 'beta-scraper', 'gamma']);
    assert.deepEqual(await pick([], [], false, true), ['alpha-scraper', 'beta-scraper', 'gamma']);
    await assert.rejects(pick([]), /--all/);
    await assert.rejects(pick(['nope', 'x*']), /no Actor matches: nope, x\*/);
});

test('--changed keeps Actors whose folder or watched folder changed', async () => {
    const calls: string[] = [];
    const runner = fakeRunner(
        {
            'git rev-parse --show-toplevel': { stdout: '/repo\n' },
            'git diff --name-only origin/main --': { stdout: 'actors/beta-scraper/src/main.ts\nREADME.md\n' },
            'git ls-files --others --exclude-standard': { stdout: 'shared/new.ts\n' },
        },
        calls,
    );
    const withWatch = fleet.map((t) => (t.name === 'gamma' ? { ...t, watch: ['/repo/shared'] } : t));
    const picked = await select(withWatch, { names: [], tags: [], all: false, changed: 'origin/main' }, { readOnly: false, runner, cwd: '/repo/actors' });
    assert.deepEqual(picked.map((t) => t.name), ['beta-scraper', 'gamma']);
    assert.equal(calls[1], 'git diff --name-only origin/main -- @ /repo');
    await assert.rejects(select(fleet, { names: [], tags: [], all: false, changed: 'x' }, { readOnly: false }), /needs git/);
});

test('--changed reports git problems', async () => {
    await assert.rejects(changedFiles('main', fakeRunner({ 'git rev-parse --show-toplevel': { code: 128, stderr: 'fatal: not a git repository' } }), '/'), /not a git repository/);
    const runner = fakeRunner({ 'git rev-parse --show-toplevel': { stdout: '/r' }, 'git diff*': { code: 128, stderr: 'bad revision' } });
    await assert.rejects(changedFiles('nope', runner, '/r'), /git diff nope failed: bad revision/);
});
