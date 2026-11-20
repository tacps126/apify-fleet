// Release checks shared by CI and the release workflow.
//
// node scripts/release-info.mjs check    versions agree and the changelog has the version
// node scripts/release-info.mjs version  print the version
// node scripts/release-info.mjs notes    print the changelog section for the version

import { readFileSync } from 'node:fs';

const root = new URL('../', import.meta.url);
const read = (path) => readFileSync(new URL(path, root), 'utf8');

const versions = {
    'package.json': JSON.parse(read('package.json')).version,
    'package-lock.json': JSON.parse(read('package-lock.json')).version,
    'src/version.ts': /VERSION = '([^']+)'/.exec(read('src/version.ts'))?.[1] ?? '',
};

function notes(version) {
    const escaped = version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const m = new RegExp(`^## ${escaped}\\s*$([\\s\\S]*?)(?=^## |(?![\\s\\S]))`, 'm').exec(read('CHANGELOG.md'));
    return m ? m[1].trim() : undefined;
}

const cmd = process.argv[2] ?? 'check';
const distinct = new Set(Object.values(versions));
if (distinct.size !== 1) {
    console.error('versions differ:', versions);
    process.exit(1);
}
const [version] = distinct;
if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?$/.test(version)) {
    console.error(`not a semantic version: ${version}`);
    process.exit(1);
}
const body = notes(version);
if (cmd === 'version') console.log(version);
else if (cmd === 'notes') console.log(body ?? '');
else if (!body) {
    console.error(`CHANGELOG.md has no '## ${version}' section`);
    process.exit(1);
} else console.log(`release ${version}: versions agree, changelog ok`);
