/**
 * A small client for the parts of the Apify API v2 the fleet commands need.
 *
 * Commands talk to the `FleetApi` interface, so tests (and other tools) can pass their own
 * implementation. `HttpApi` is the real one: built-in `fetch`, retries on 429 and 5xx with
 * backoff (honouring `Retry-After`), paging, and 404 on delete treated as already gone.
 */

import { VERSION } from './version.js';

export interface ActorSummary {
    id: string;
    name: string;
    username?: string;
    createdAt?: string;
    modifiedAt?: string;
}

export interface TaggedBuild {
    buildId?: string;
    buildNumber?: string;
    finishedAt?: string;
}

export interface RunOptions {
    build?: string;
    timeoutSecs?: number;
    memoryMbytes?: number;
    restartOnError?: boolean;
}

export interface ActorDetails extends ActorSummary {
    isPublic?: boolean;
    isDeprecated?: boolean;
    title?: string;
    description?: string;
    seoTitle?: string;
    seoDescription?: string;
    categories?: string[];
    defaultRunOptions?: RunOptions;
    actorStandby?: ({ isEnabled?: boolean } & Record<string, unknown>) | null;
    taggedBuilds?: Record<string, TaggedBuild | null> | null;
    versions?: { versionNumber: string; buildTag?: string }[];
    stats?: {
        totalUsers30Days?: number;
        lastRunStartedAt?: string;
        publicActorRunStats30Days?: Record<string, number>;
    };
}

export interface BuildItem {
    id: string;
    status: string;
    startedAt?: string;
    finishedAt?: string;
    buildNumber?: string;
}

export interface RunItem {
    id: string;
    status: string;
    startedAt?: string;
    finishedAt?: string;
    buildNumber?: string;
    defaultDatasetId?: string;
    defaultKeyValueStoreId?: string;
    defaultRequestQueueId?: string;
    usageTotalUsd?: number;
}

export type StorageKind = 'datasets' | 'key-value-stores' | 'request-queues';
export const STORAGE_KINDS: readonly StorageKind[] = ['datasets', 'key-value-stores', 'request-queues'];

export interface StorageItem {
    id: string;
    name?: string;
    createdAt?: string;
    modifiedAt?: string;
    accessedAt?: string;
}

/** Statuses after which a run or build no longer changes. */
export const TERMINAL = new Set(['SUCCEEDED', 'FAILED', 'ABORTED', 'TIMED-OUT']);

export interface FleetApi {
    /** Actors owned by the token's account. */
    listActors(): Promise<ActorSummary[]>;
    getActor(id: string): Promise<ActorDetails | undefined>;
    updateActor(id: string, fields: Record<string, unknown>): Promise<ActorDetails>;
    /** Newest first. */
    listBuilds(actorId: string): AsyncIterable<BuildItem>;
    deleteBuild(buildId: string): Promise<void>;
    startBuild(actorId: string, version: string, tag: string): Promise<BuildItem>;
    /** Waits up to `waitSecs` (max 60) for the build to finish. */
    getBuild(buildId: string, waitSecs: number): Promise<BuildItem | undefined>;
    /** Newest first. */
    listRuns(actorId: string): AsyncIterable<RunItem>;
    deleteRun(runId: string): Promise<void>;
    /** Named storages only. */
    listStorages(kind: StorageKind): AsyncIterable<StorageItem>;
    deleteStorage(kind: StorageKind, id: string): Promise<void>;
}

export class ApiError extends Error {
    constructor(
        readonly status: number,
        readonly type: string,
        message: string,
        readonly path: string,
    ) {
        super(`${status} ${type}: ${message} (${path})`);
        this.name = 'ApiError';
    }
}

export interface HttpApiOptions {
    token: string;
    baseUrl?: string;
    fetch?: typeof fetch;
    sleep?: (ms: number) => Promise<void>;
    /** Attempts after the first one, for 429, 5xx and network errors. */
    retries?: number;
    pageSize?: number;
}

type Query = Record<string, string | number | boolean | undefined>;

const realSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export class HttpApi implements FleetApi {
    private readonly token: string;
    private readonly baseUrl: string;
    private readonly fetchFn: typeof fetch;
    private readonly sleep: (ms: number) => Promise<void>;
    private readonly retries: number;
    private readonly pageSize: number;

    constructor(options: HttpApiOptions) {
        this.token = options.token;
        this.baseUrl = (options.baseUrl ?? 'https://api.apify.com').replace(/\/+$/, '');
        this.fetchFn = options.fetch ?? fetch;
        this.sleep = options.sleep ?? realSleep;
        this.retries = options.retries ?? 6;
        this.pageSize = options.pageSize ?? 1000;
    }

    async request(method: string, path: string, query: Query = {}, body?: unknown): Promise<unknown> {
        const url = new URL(`${this.baseUrl}/v2${path}`);
        for (const [key, value] of Object.entries(query)) {
            if (value !== undefined) url.searchParams.set(key, String(value));
        }
        const waitSecs = Number(query.waitForFinish ?? 0);
        for (let attempt = 0; ; attempt++) {
            let response: Response;
            try {
                response = await this.fetchFn(url, {
                    method,
                    headers: {
                        authorization: `Bearer ${this.token}`,
                        'user-agent': `apify-fleet/${VERSION}`,
                        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
                    },
                    body: body === undefined ? undefined : JSON.stringify(body),
                    signal: AbortSignal.timeout((60 + waitSecs) * 1000),
                });
            } catch (err) {
                if (attempt >= this.retries) throw err;
                await this.sleep(backoff(attempt));
                continue;
            }
            if ((response.status === 429 || response.status >= 500) && attempt < this.retries) {
                await response.body?.cancel();
                await this.sleep(retryAfter(response.headers.get('retry-after')) ?? backoff(attempt));
                continue;
            }
            const text = await response.text();
            const parsed: unknown = text ? safeJson(text) : undefined;
            if (!response.ok) {
                const error = (parsed as { error?: { type?: string; message?: string } } | undefined)?.error;
                throw new ApiError(response.status, error?.type ?? 'http-error', error?.message ?? text.slice(0, 200), path);
            }
            return (parsed as { data?: unknown } | undefined)?.data ?? parsed;
        }
    }

    private async *paginate<T>(path: string, query: Query = {}): AsyncIterable<T> {
        for (let offset = 0; ; ) {
            const page = (await this.request('GET', path, { ...query, offset, limit: this.pageSize })) as {
                items?: T[];
                total?: number;
            };
            const items = page?.items ?? [];
            yield* items;
            offset += items.length;
            if (items.length < this.pageSize || (page.total !== undefined && offset >= page.total)) return;
        }
    }

    private async getOrUndefined<T>(path: string, query: Query = {}): Promise<T | undefined> {
        try {
            return (await this.request('GET', path, query)) as T;
        } catch (err) {
            if (err instanceof ApiError && err.status === 404) return undefined;
            throw err;
        }
    }

    private async deleteIfPresent(path: string): Promise<void> {
        try {
            await this.request('DELETE', path);
        } catch (err) {
            if (!(err instanceof ApiError && err.status === 404)) throw err;
        }
    }

    async listActors(): Promise<ActorSummary[]> {
        const out: ActorSummary[] = [];
        for await (const actor of this.paginate<ActorSummary>('/acts', { my: true })) out.push(actor);
        return out;
    }

    getActor(id: string) {
        return this.getOrUndefined<ActorDetails>(`/acts/${encodeURIComponent(id)}`);
    }

    async updateActor(id: string, fields: Record<string, unknown>) {
        return (await this.request('PUT', `/acts/${encodeURIComponent(id)}`, {}, fields)) as ActorDetails;
    }

    listBuilds(actorId: string) {
        return this.paginate<BuildItem>(`/acts/${encodeURIComponent(actorId)}/builds`, { desc: true });
    }

    deleteBuild(buildId: string) {
        return this.deleteIfPresent(`/actor-builds/${encodeURIComponent(buildId)}`);
    }

    async startBuild(actorId: string, version: string, tag: string) {
        const path = `/acts/${encodeURIComponent(actorId)}/builds`;
        return (await this.request('POST', path, { version, tag })) as BuildItem;
    }

    getBuild(buildId: string, waitSecs: number) {
        const wait = Math.max(0, Math.min(60, Math.floor(waitSecs)));
        return this.getOrUndefined<BuildItem>(`/actor-builds/${encodeURIComponent(buildId)}`, {
            waitForFinish: wait || undefined,
        });
    }

    listRuns(actorId: string) {
        return this.paginate<RunItem>(`/acts/${encodeURIComponent(actorId)}/runs`, { desc: true });
    }

    deleteRun(runId: string) {
        return this.deleteIfPresent(`/actor-runs/${encodeURIComponent(runId)}`);
    }

    listStorages(kind: StorageKind) {
        return this.paginate<StorageItem>(`/${kind}`, { unnamed: false });
    }

    deleteStorage(kind: StorageKind, id: string) {
        return this.deleteIfPresent(`/${kind}/${encodeURIComponent(id)}`);
    }
}

function safeJson(text: string): unknown {
    try {
        return JSON.parse(text);
    } catch {
        return undefined;
    }
}

export function backoff(attempt: number): number {
    return Math.min(30_000, 500 * 2 ** attempt);
}

export function retryAfter(header: string | null): number | undefined {
    if (!header) return undefined;
    const secs = Number(header);
    if (Number.isFinite(secs) && secs >= 0) return Math.min(60_000, secs * 1000);
    const at = Date.parse(header);
    return Number.isNaN(at) ? undefined : Math.max(0, Math.min(60_000, at - Date.now()));
}

/** Collects an async iterable, stopping once `stop` returns true for an item (that item is dropped). */
export async function collect<T>(items: AsyncIterable<T>, stop?: (item: T) => boolean): Promise<T[]> {
    const out: T[] = [];
    for await (const item of items) {
        if (stop?.(item)) break;
        out.push(item);
    }
    return out;
}
