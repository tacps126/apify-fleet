import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { checkMemory, loadConfig, parseConfig } from '../src/config.js';

test('parses a full config', () => {
    const c = parseConfig(
        {
            $schema: './fleet.schema.json',
            root: 'actors',
            discover: false,
            defaults: { tags: ['all'], listing: { categories: ['AUTOMATION'] }, settings: { memoryMbytes: 1024 } },
            actors: {
                one: { path: 'actors/one', id: 'me~one', tags: ['a'], watch: ['shared'], listing: { title: 'One', seoTitle: 'S' }, settings: { timeoutSecs: 60, standby: false, build: 'beta', restartOnError: true } },
                two: {},
            },
        },
        '/x',
    );
    assert.equal(c.dir, '/x');
    assert.equal(c.root, 'actors');
    assert.equal(c.discover, false);
    assert.deepEqual(c.defaults.settings, { memoryMbytes: 1024 });
    assert.deepEqual(c.actors.one?.settings, { timeoutSecs: 60, standby: false, build: 'beta', restartOnError: true });
    assert.deepEqual(c.actors.one?.listing, { title: 'One', seoTitle: 'S' });
    assert.deepEqual(c.actors.two, { path: undefined, id: undefined, tags: undefined, watch: undefined, listing: undefined, settings: undefined });
});

test('rejects typos and wrong types with the path to the problem', () => {
    const bad: [unknown, RegExp][] = [
        [[], /expected an object/],
        [{ actor: {} }, /unknown key "actor"/],
        [{ actors: { a: { tag: [] } } }, /actors\.a: unknown key "tag"/],
        [{ actors: { a: { tags: 'x' } } }, /actors\.a\.tags: expected a list of strings/],
        [{ actors: { a: { path: 1 } } }, /actors\.a\.path: expected a string/],
        [{ actors: { a: { listing: { categories: ['automation'] } } } }, /not a category id/],
        [{ actors: { a: { listing: { summary: 'x' } } } }, /unknown key "summary"/],
        [{ actors: { a: { settings: { memoryMbytes: 1000 } } } }, /power of two/],
        [{ actors: { a: { settings: { timeoutSecs: -1 } } } }, /whole seconds/],
        [{ defaults: { settings: { standby: 'yes' } } }, /expected a boolean/],
        [{ defaults: { other: 1 } }, /unknown key "other"/],
    ];
    for (const [raw, re] of bad) assert.throws(() => parseConfig(raw, '/x'), re);
});

test('memory limits', () => {
    assert.equal(checkMemory(128, 'm'), 128);
    assert.equal(checkMemory(32768, 'm'), 32768);
    for (const mb of [64, 65536, 300, 1.5]) assert.throws(() => checkMemory(mb, 'm'));
});

test('loadConfig: missing default file is empty, explicit missing file and bad JSON fail', () => {
    const dir = mkdtempSync(join(tmpdir(), 'fleet-config-'));
    assert.deepEqual(loadConfig(dir), { dir, defaults: {}, actors: {} });
    assert.throws(() => loadConfig(dir, 'other.json'), /not found/);
    writeFileSync(join(dir, 'fleet.json'), '{ nope');
    assert.throws(() => loadConfig(dir), /not valid JSON/);
    writeFileSync(join(dir, 'fleet.json'), '{"actors": {"a": {"tags": ["x"]}}}');
    assert.deepEqual(loadConfig(dir).actors.a?.tags, ['x']);
});

test('the example config and the JSON schema agree with the parser', async () => {
    const { buildFleet } = await import('../src/fleet.js');
    const root = fileURLToPath(new URL('../../', import.meta.url));
    const dir = join(root, 'examples/monorepo');
    const fleet = await buildFleet({ config: loadConfig(dir) });
    assert.deepEqual(fleet.map((t) => [t.name, t.version, t.tags]), [
        ['news-feed', '1.2', ['news']],
        ['shop-products', '0.1', ['ecommerce', 'browser']],
    ]);
    assert.equal(fleet[1]?.listing?.title, 'Shop Products');
    assert.deepEqual(fleet[1]?.settings, { memoryMbytes: 4096, timeoutSecs: 3600 });
    const schema = JSON.parse(readFileSync(join(root, 'fleet.schema.json'), 'utf8')) as {
        properties: Record<string, unknown>;
        $defs: { listing: { properties: object }; settings: { properties: { memoryMbytes: { enum: number[] } } } };
    };
    assert.deepEqual(Object.keys(schema.properties).sort(), ['$schema', 'actors', 'defaults', 'discover', 'root']);
    assert.deepEqual(Object.keys(schema.$defs.listing.properties).sort(), ['categories', 'description', 'seoDescription', 'seoTitle', 'title']);
    for (const mb of schema.$defs.settings.properties.memoryMbytes.enum) assert.equal(checkMemory(mb, 'm'), mb);
});
