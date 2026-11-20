import assert from 'node:assert/strict';
import { test } from 'node:test';
import { HttpApi } from '../src/api.js';
import { cliFetch } from '../src/cli-transport.js';
import { fakeRunner } from './fake.js';

test('requests go through "apify api" with method, path, params and body', async () => {
    const calls: string[] = [];
    const runner = fakeRunner(
        {
            'apify api -X GET /v2/acts -p {"my":"true","offset":"0","limit":"1000"}': { stdout: '{"data":{"items":[{"id":"a","name":"x"}],"total":1}}' },
            'apify api -X PUT /v2/acts/a -d {"title":"T"}': { stdout: '{"data":{"id":"a"}}' },
            'apify api -X DELETE /v2/actor-runs/r': { stdout: '' },
        },
        calls,
    );
    const api = new HttpApi({ token: '', fetch: cliFetch(runner, 'apify', '/w') });
    assert.deepEqual(await api.listActors(), [{ id: 'a', name: 'x' }]);
    await api.updateActor('a', { title: 'T' });
    await api.deleteRun('r');
    assert.equal(calls.length, 3);
    assert.ok(calls.every((c) => c.endsWith(' @ /w')));
});

test('HTTP errors keep their status; login problems are final; other failures are retried', async () => {
    const notFound = fakeRunner({ 'apify api*': { code: 1, stdout: '{"error":{"type":"record-not-found","message":"no"}}', stderr: 'Error: 404 Not Found\nDid you mean: ...' } });
    assert.equal(await new HttpApi({ token: '', fetch: cliFetch(notFound) }).getActor('x'), undefined);

    const loggedOut = fakeRunner({ 'apify api*': { code: 1, stderr: 'Warning: You are using an old version of Apify CLI\nYou are not logged in. Run apify login.' } });
    await assert.rejects(new HttpApi({ token: '', fetch: cliFetch(loggedOut) }).getActor('x'), /401 apify-cli: You are not logged in/);

    let attempt = 0;
    const flaky = async () => (++attempt === 1 ? { code: 1, stdout: '', stderr: 'refresh failed\n- Stdin data? Not read' } : { code: 0, stdout: '{"data":{"id":"x"}}', stderr: '' });
    const sleeps: number[] = [];
    const api = new HttpApi({ token: '', fetch: cliFetch(flaky), sleep: async (ms) => void sleeps.push(ms) });
    assert.deepEqual(await api.getActor('x'), { id: 'x' });
    assert.deepEqual(sleeps, [500]);

    const silent = fakeRunner({ 'apify api*': { code: 2 } });
    await assert.rejects(new HttpApi({ token: '', fetch: cliFetch(silent), retries: 0 }).getActor('x'), /503 apify-cli: apify exited with 2/);
});

test('Request objects are accepted', async () => {
    const calls: string[] = [];
    const f = cliFetch(fakeRunner({}, calls), 'apify', '/w');
    const r = await f(new Request('https://api.apify.com/v2/users/me'));
    assert.equal(r.status, 204);
    assert.equal(calls[0], 'apify api -X GET /v2/users/me @ /w');
});
