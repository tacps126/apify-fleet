import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import { discoverActors, findToken, readActor } from '../src/discover.js';
import { actorJson, tree } from './helpers.js';

test('finds Actor folders, skips build and dependency folders, stops inside an Actor', () => {
    const root = tree({
        'actors/b/.actor/actor.json': actorJson('b-actor', '1.2'),
        'actors/b/.actor/listing.json': { title: 'B' },
        'actors/b/inner/.actor/actor.json': actorJson('inner'),
        'a/.actor/actor.json': actorJson('a-actor'),
        'node_modules/x/.actor/actor.json': actorJson('dep'),
        '.hidden/.actor/actor.json': actorJson('hidden'),
        'broken/.actor/actor.json': '{ nope',
        'noname/.actor/actor.json': { version: '0.1' },
        'deep/1/2/3/.actor/actor.json': actorJson('deep'),
        'README.md': 'x',
    });
    const found = discoverActors(root);
    assert.deepEqual(found.map((a) => a.name), ['a-actor', 'b-actor', 'deep']);
    assert.equal(found[1]?.version, '1.2');
    assert.deepEqual(found[1]?.listing, { title: 'B' });
    assert.deepEqual(discoverActors(root, 2).map((a) => a.name), ['a-actor', 'b-actor']);
    assert.equal(readActor(join(root, 'nothing-here')), undefined);
    assert.deepEqual(discoverActors(join(root, 'missing')), []);
});

test('a single Actor at the root', () => {
    const root = tree({ '.actor/actor.json': { name: 'solo' } });
    assert.deepEqual(discoverActors(root), [{ name: 'solo', path: root }]);
});

test('token from env, else from the apify login file', () => {
    assert.equal(findToken({ APIFY_TOKEN: 'env' }, '/nowhere'), 'env');
    assert.equal(findToken({}, '/nowhere'), undefined);
    assert.equal(findToken({}, tree({ '.apify/auth.json': { token: 'saved', username: 'u' } })), 'saved');
    assert.equal(findToken({}, tree({ '.apify/auth.json': { token: '' } })), undefined);
    assert.equal(findToken({}, tree({ '.apify/auth.json': 'nope' })), undefined);
});
