import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Report } from '../src/commands/types.js';
import { renderJson, renderTable } from '../src/render.js';
import { compareVersions, day, errorText, globToRegExp, lastLine, mapLimit, parseDuration, runProcess, time } from '../src/util.js';

test('mapLimit keeps order and caps concurrency', async () => {
    let active = 0;
    let peak = 0;
    const out = await mapLimit([5, 1, 3, 2], 2, async (n, i) => {
        peak = Math.max(peak, ++active);
        await new Promise((r) => setTimeout(r, n));
        active--;
        return n * 10 + i;
    });
    assert.deepEqual(out, [50, 11, 32, 23]);
    assert.equal(peak, 2);
    assert.deepEqual(await mapLimit([], 4, async () => 1), []);
});

test('durations', () => {
    assert.equal(parseDuration('30d'), 30 * 86_400_000);
    assert.equal(parseDuration('7'), 7 * 86_400_000);
    assert.equal(parseDuration('1.5h'), 5_400_000);
    assert.equal(parseDuration('90m'), 5_400_000);
    assert.equal(parseDuration(' 45s '), 45_000);
    assert.throws(() => parseDuration('3w'), /not a duration/);
});

test('globs', () => {
    assert.ok(globToRegExp('*-scraper').test('Jobs-Scraper'));
    assert.ok(globToRegExp('a?c').test('abc'));
    assert.ok(!globToRegExp('a.c').test('abc'));
    assert.ok(!globToRegExp('one').test('one-two'));
});

test('small helpers', () => {
    assert.equal(time(undefined), 0);
    assert.equal(time('garbage'), 0);
    assert.equal(day(undefined), '-');
    assert.equal(day('2026-01-02T03:04:05Z'), '2026-01-02');
    assert.equal(errorText(new Error('e')), 'e');
    assert.equal(errorText('s'), 's');
    assert.equal(lastLine({ code: 2, stdout: '', stderr: '' }), 'exit code 2');
    assert.equal(lastLine({ code: 1, stdout: 'a\n\n', stderr: ' b \r\n' }), 'b');
    assert.ok(compareVersions('0.10', '0.9') > 0);
    assert.ok(compareVersions('1.0', '1') === 0);
    assert.ok(compareVersions('0.1', '0.1.1') < 0);
});

test('runProcess captures output, exit code and spawn errors', async () => {
    const ok = await runProcess(process.execPath, ['-e', 'console.log("hi"); console.error("warn"); process.exit(3)'], process.cwd());
    assert.deepEqual(ok, { code: 3, stdout: 'hi\n', stderr: 'warn\n' });
    const missing = await runProcess('definitely-not-a-program-xyz', [], process.cwd());
    assert.notEqual(missing.code, 0);
});

const sample: Report = {
    command: 'sync',
    apply: false,
    columns: ['actor', 'status', 'empty', 'detail'],
    rows: [
        { actor: 'a', status: 'would-change', detail: 'x'.repeat(100) },
        { actor: 'longer-name', status: 'unchanged', detail: null as unknown as string },
    ],
    failed: 0,
    notes: ['note'],
};

test('table drops empty columns, cuts long cells, adds the dry-run hint', () => {
    const out = renderTable(sample, 20);
    const lines = out.split('\n');
    assert.equal(lines[0], 'actor        status        detail');
    assert.equal(lines[2], `a            would-change  ${'x'.repeat(17)}...`);
    assert.equal(lines[3], 'longer-name  unchanged');
    assert.match(out, /note\nDry run: nothing was changed/);
    assert.equal(renderTable({ ...sample, rows: [], notes: [] }), 'No Actors selected.\n');
    assert.doesNotMatch(renderTable({ ...sample, apply: true }), /Dry run/);
    assert.deepEqual(JSON.parse(renderJson(sample)), JSON.parse(JSON.stringify(sample)));
});
