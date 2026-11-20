/** In-memory FleetApi for tests: no network, records every change. */

import type { AccountLimits, ActorDetails, BuildItem, FleetApi, RunItem, StorageItem, StorageKind } from '../src/api.js';
import type { ExecResult, Runner } from '../src/util.js';

export const NOW = Date.parse('2026-06-30T12:00:00Z');
export const daysAgo = (n: number) => new Date(NOW - n * 86_400_000).toISOString();

export class FakeApi implements FleetApi {
    actors = new Map<string, ActorDetails>();
    builds = new Map<string, BuildItem[]>();
    runs = new Map<string, RunItem[]>();
    storages: Record<StorageKind, StorageItem[]> = { datasets: [], 'key-value-stores': [], 'request-queues': [] };
    calls: string[] = [];
    failOn = new Set<string>();
    buildSteps: string[] = ['RUNNING', 'SUCCEEDED'];
    limits?: AccountLimits;

    add(actor: Partial<ActorDetails> & { id: string; name: string }, builds: BuildItem[] = [], runs: RunItem[] = []) {
        this.actors.set(actor.id, { username: 'me', ...actor });
        this.builds.set(actor.id, builds);
        this.runs.set(actor.id, runs);
        return this;
    }

    private check(call: string) {
        this.calls.push(call);
        for (const f of this.failOn) if (call.startsWith(f)) throw new Error(`boom: ${call}`);
    }

    async accountLimits() {
        this.check('accountLimits');
        return this.limits;
    }

    async listActors() {
        this.check('listActors');
        return [...this.actors.values()].map(({ id, name, username }) => ({ id, name, username }));
    }

    async getActor(id: string) {
        this.check(`getActor ${id}`);
        const a = this.actors.get(id);
        return a && structuredClone(a);
    }

    async updateActor(id: string, fields: Record<string, unknown>) {
        this.check(`updateActor ${id} ${JSON.stringify(fields)}`);
        const a = { ...(this.actors.get(id) as ActorDetails), ...fields };
        this.actors.set(id, a);
        return a;
    }

    async *listBuilds(actorId: string) {
        this.check(`listBuilds ${actorId}`);
        yield* [...(this.builds.get(actorId) ?? [])].sort((a, b) => Date.parse(b.startedAt ?? '') - Date.parse(a.startedAt ?? ''));
    }

    async deleteBuild(buildId: string) {
        this.check(`deleteBuild ${buildId}`);
        for (const [k, list] of this.builds) this.builds.set(k, list.filter((b) => b.id !== buildId));
    }

    async startBuild(actorId: string, version: string, tag: string) {
        this.check(`startBuild ${actorId} ${version} ${tag}`);
        return { id: `b-${actorId}-new`, status: 'READY', buildNumber: `${version}.9` };
    }

    async getBuild(buildId: string, waitSecs: number) {
        this.check(`getBuild ${buildId} ${waitSecs}`);
        const status = this.buildSteps.shift() ?? 'SUCCEEDED';
        return { id: buildId, status, buildNumber: '0.1.9' };
    }

    async *listRuns(actorId: string) {
        this.check(`listRuns ${actorId}`);
        yield* [...(this.runs.get(actorId) ?? [])].sort((a, b) => Date.parse(b.startedAt ?? '') - Date.parse(a.startedAt ?? ''));
    }

    async deleteRun(runId: string) {
        this.check(`deleteRun ${runId}`);
        for (const [k, list] of this.runs) this.runs.set(k, list.filter((r) => r.id !== runId));
    }

    async *listStorages(kind: StorageKind) {
        this.check(`listStorages ${kind}`);
        yield* this.storages[kind];
    }

    async deleteStorage(kind: StorageKind, id: string) {
        this.check(`deleteStorage ${kind} ${id}`);
        this.storages[kind] = this.storages[kind].filter((s) => s.id !== id);
    }
}

export function build(id: string, ageDays: number, status = 'SUCCEEDED'): BuildItem {
    return { id, status, startedAt: daysAgo(ageDays), finishedAt: daysAgo(ageDays), buildNumber: `0.1.${id}` };
}

export function run(id: string, ageDays: number, status = 'SUCCEEDED', secs = 60, usd = 0.01): RunItem {
    const start = NOW - ageDays * 86_400_000;
    return {
        id,
        status,
        startedAt: new Date(start).toISOString(),
        finishedAt: status === 'RUNNING' ? undefined : new Date(start + secs * 1000).toISOString(),
        usageTotalUsd: usd,
        defaultDatasetId: `ds-${id}`,
        defaultKeyValueStoreId: `kv-${id}`,
        defaultRequestQueueId: `rq-${id}`,
    };
}

/** Runner that answers from a table keyed by "cmd args...", recording calls. */
export function fakeRunner(answers: Record<string, Partial<ExecResult>> = {}, calls: string[] = []): Runner {
    return async (cmd, args, cwd) => {
        const key = [cmd, ...args].join(' ');
        calls.push(`${key} @ ${cwd}`);
        const hit = answers[key] ?? Object.entries(answers).find(([k]) => k.endsWith('*') && key.startsWith(k.slice(0, -1)))?.[1];
        return { code: 0, stdout: '', stderr: '', ...hit };
    };
}
