import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Makes a temp folder tree; `files` maps relative paths to contents (objects are JSON). */
export function tree(files: Record<string, unknown>): string {
    const root = mkdtempSync(join(tmpdir(), 'fleet-'));
    for (const [path, content] of Object.entries(files)) {
        const full = join(root, path);
        mkdirSync(join(full, '..'), { recursive: true });
        writeFileSync(full, typeof content === 'string' ? content : JSON.stringify(content));
    }
    return root;
}

export function actorJson(name: string, version = '0.1') {
    return { actorSpecification: 1, name, version };
}
