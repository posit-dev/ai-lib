/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, describe, expect, it, vi } from "vitest";

import type { ApiKeyCredentials, Logger, ModelInfo } from "../../types";
import type { CachedModelFetcherFetchFreshConfig } from "../cached-model-fetcher";
import { createCachedModelFetcher, DEFAULT_DISCOVERY_DEADLINE_MS } from "../cached-model-fetcher";

const logger: Logger = {
	info: vi.fn(),
	warn: vi.fn(),
	error: vi.fn(),
	debug: vi.fn(),
	trace: vi.fn(),
};

function model(id: string): ModelInfo {
	return {
		id,
		name: id,
		providerId: "openai-compatible",
		vendor: "test",
		supportsTools: true,
		supportsImages: false,
		supportsToolResultImages: false,
		supportsWebSearch: false,
		maxContextLength: 128_000,
	};
}

const credentials: ApiKeyCredentials = { type: "apikey", apiKey: "sk-test" };

describe("createCachedModelFetcher — fetchFresh variant", () => {
	it("keeps the fresh → stale-cache → fallback policy", async () => {
		let failing = false;
		const fetchFresh = vi.fn(async (): Promise<ModelInfo[]> => {
			if (failing) throw new Error("gateway unreachable");
			return [model("fresh")];
		});
		const fetcher = createCachedModelFetcher<ApiKeyCredentials>({
			providerId: "test-provider",
			hasCredentials: (creds) => Boolean(creds.apiKey),
			fetchFresh,
			fallbackModels: [model("fallback")],
			ttl: 0, // every call re-fetches, exercising the stale path
			logger,
		});

		// Level 1: fresh fetch.
		expect((await fetcher(credentials)).map((m) => m.id)).toEqual(["fresh"]);

		// Level 2: fresh fetch fails → stale cache.
		failing = true;
		expect((await fetcher(credentials)).map((m) => m.id)).toEqual(["fresh"]);
		expect(fetchFresh).toHaveBeenCalledTimes(2);

		// Level 3: no cache and fresh fetch fails → static fallback.
		fetcher.clearCache?.();
		expect((await fetcher(credentials)).map((m) => m.id)).toEqual(["fallback"]);
	});

	it("returns fallback without invoking fetchFresh when credentials are absent", async () => {
		const fetchFresh = vi.fn(async () => [model("fresh")]);
		const fetcher = createCachedModelFetcher<ApiKeyCredentials>({
			providerId: "test-provider",
			hasCredentials: (creds) => Boolean(creds.apiKey),
			fetchFresh,
			fallbackModels: [],
			logger,
		});

		expect(await fetcher({ type: "apikey", apiKey: "" })).toEqual([]);
		expect(fetchFresh).not.toHaveBeenCalled();
	});
});

describe("createCachedModelFetcher — discovery deadline", () => {
	afterEach(() => {
		vi.useRealTimers();
		vi.unstubAllGlobals();
		vi.clearAllMocks();
	});

	/** Track whether a promise has settled without awaiting it. */
	function trackSettlement(promise: Promise<unknown>): { settled: () => boolean } {
		let settled = false;
		void promise.then(
			() => {
				settled = true;
			},
			() => {
				settled = true;
			},
		);
		return { settled: () => settled };
	}

	function deferred<T>(): {
		promise: Promise<T>;
		resolve: (value: T) => void;
		reject: (reason?: unknown) => void;
	} {
		let resolve!: (value: T) => void;
		let reject!: (reason?: unknown) => void;
		const promise = new Promise<T>((res, rej) => {
			resolve = res;
			reject = rej;
		});
		return { promise, resolve, reject };
	}

	function hangingFetchFresh() {
		return vi.fn(
			(_creds: ApiKeyCredentials, _signal: AbortSignal) => new Promise<ModelInfo[]>(() => {}),
		);
	}

	function createHangingFetcher(
		overrides?: Partial<CachedModelFetcherFetchFreshConfig<ApiKeyCredentials>>,
	) {
		return createCachedModelFetcher<ApiKeyCredentials>({
			providerId: "test-provider",
			hasCredentials: (creds) => Boolean(creds.apiKey),
			fetchFresh: hangingFetchFresh(),
			fallbackModels: [model("fallback")],
			ttl: 0,
			logger,
			...overrides,
		});
	}

	it("bounds fresh discovery by the 15-second default deadline", async () => {
		vi.useFakeTimers();
		expect(DEFAULT_DISCOVERY_DEADLINE_MS).toBe(15_000);
		const fetcher = createHangingFetcher();

		const promise = fetcher(credentials);
		const status = trackSettlement(promise);

		await vi.advanceTimersByTimeAsync(DEFAULT_DISCOVERY_DEADLINE_MS - 1);
		expect(status.settled()).toBe(false);

		await vi.advanceTimersByTimeAsync(1);
		expect(status.settled()).toBe(true);
		expect((await promise).map((m) => m.id)).toEqual(["fallback"]);
		expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("timed out after 15000ms"));
	});

	it("honors an explicit discoveryDeadlineMs", async () => {
		vi.useFakeTimers();
		const fetcher = createHangingFetcher({ discoveryDeadlineMs: 500 });

		const promise = fetcher(credentials);
		const status = trackSettlement(promise);

		await vi.advanceTimersByTimeAsync(499);
		expect(status.settled()).toBe(false);

		await vi.advanceTimersByTimeAsync(1);
		expect(status.settled()).toBe(true);
		expect((await promise).map((m) => m.id)).toEqual(["fallback"]);
		expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("timed out after 500ms"));
	});

	it("passes the abort signal to fetchFresh and aborts it at the deadline", async () => {
		vi.useFakeTimers();
		let observedSignal: AbortSignal | undefined;
		const fetchFresh = vi.fn((creds: ApiKeyCredentials, signal: AbortSignal) => {
			observedSignal = signal;
			// Cooperative cancellation: reject as soon as the deadline aborts.
			return new Promise<ModelInfo[]>((_, reject) => {
				signal.addEventListener("abort", () => reject(signal.reason), { once: true });
			});
		});
		const fetcher = createHangingFetcher({ fetchFresh });

		const promise = fetcher(credentials);
		expect(observedSignal).toBeInstanceOf(AbortSignal);
		expect(observedSignal!.aborted).toBe(false);

		await vi.advanceTimersByTimeAsync(DEFAULT_DISCOVERY_DEADLINE_MS);
		expect(observedSignal!.aborted).toBe(true);
		expect((await promise).map((m) => m.id)).toEqual(["fallback"]);
		expect(fetchFresh).toHaveBeenCalledTimes(1);
	});

	it("bounds the request variant's fetch and passes it the abort signal", async () => {
		vi.useFakeTimers();
		let observedSignal: AbortSignal | undefined;
		const fetchMock = vi.fn(
			(_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
				observedSignal = init?.signal ?? undefined;
				return new Promise<Response>(() => {}); // hung request
			},
		);
		vi.stubGlobal("fetch", fetchMock);

		const fetcher = createCachedModelFetcher<ApiKeyCredentials>({
			providerId: "test-provider",
			hasCredentials: (creds) => Boolean(creds.apiKey),
			apiUrl: "https://example.test/models",
			createHeaders: () => ({ Authorization: "Bearer test" }),
			parseResponse: () => [model("fresh")],
			fallbackModels: [model("fallback")],
			logger,
		});

		const promise = fetcher(credentials);
		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(observedSignal).toBeInstanceOf(AbortSignal);

		await vi.advanceTimersByTimeAsync(DEFAULT_DISCOVERY_DEADLINE_MS);
		expect(observedSignal!.aborted).toBe(true);
		expect((await promise).map((m) => m.id)).toEqual(["fallback"]);
	});

	it("bounds the enrichment pass within the same deadline", async () => {
		vi.useFakeTimers();
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => ({ ok: true, json: async () => ({}) }) as unknown as Response),
		);

		let observedSignal: AbortSignal | undefined;
		const fetcher = createCachedModelFetcher<ApiKeyCredentials>({
			providerId: "test-provider",
			hasCredentials: (creds) => Boolean(creds.apiKey),
			apiUrl: "https://example.test/models",
			createHeaders: () => ({}),
			parseResponse: () => [model("fresh")],
			enrichModels: (_models, _creds, signal) => {
				observedSignal = signal;
				return new Promise<ModelInfo[]>(() => {}); // hung enrichment
			},
			fallbackModels: [model("fallback")],
			logger,
		});

		const promise = fetcher(credentials);
		const status = trackSettlement(promise);

		// Let the base request and the enrichment handoff settle (microtask-only
		// work) before approaching the deadline.
		await vi.advanceTimersByTimeAsync(0);
		expect(observedSignal).toBeInstanceOf(AbortSignal);

		// The base request succeeds immediately; the enrichment hang must still
		// be bounded by the one discovery deadline.
		await vi.advanceTimersByTimeAsync(DEFAULT_DISCOVERY_DEADLINE_MS - 1);
		expect(status.settled()).toBe(false);

		await vi.advanceTimersByTimeAsync(1);
		expect(status.settled()).toBe(true);
		expect(observedSignal!.aborted).toBe(true);
		expect((await promise).map((m) => m.id)).toEqual(["fallback"]);
	});

	it("returns the stale cache when a refresh times out", async () => {
		vi.useFakeTimers();
		let hanging = false;
		const fetchFresh = vi.fn(async (): Promise<ModelInfo[]> => {
			if (hanging) {
				return new Promise<ModelInfo[]>(() => {});
			}
			return [model("fresh")];
		});
		const fetcher = createHangingFetcher({ fetchFresh });

		// Populate the cache.
		expect((await fetcher(credentials)).map((m) => m.id)).toEqual(["fresh"]);

		// ttl: 0 — the next call re-fetches, hits the deadline, and must fall
		// back to the stale cache rather than the static fallback.
		hanging = true;
		const promise = fetcher(credentials);
		await vi.advanceTimersByTimeAsync(DEFAULT_DISCOVERY_DEADLINE_MS);
		expect((await promise).map((m) => m.id)).toEqual(["fresh"]);
		expect(fetchFresh).toHaveBeenCalledTimes(2);
	});

	it("never lets a late-settling timed-out operation overwrite a newer cache", async () => {
		vi.useFakeTimers();
		const slow = deferred<ModelInfo[]>();
		let call = 0;
		const fetchFresh = vi.fn((): Promise<ModelInfo[]> => {
			call += 1;
			return call === 1 ? slow.promise : Promise.resolve([model("fresh-2")]);
		});
		const fetcher = createCachedModelFetcher<ApiKeyCredentials>({
			providerId: "test-provider",
			hasCredentials: (creds) => Boolean(creds.apiKey),
			fetchFresh,
			fallbackModels: [model("fallback")],
			ttl: 60_000,
			logger,
		});

		// Call 1 times out and falls back (cache is still empty).
		const first = fetcher(credentials);
		await vi.advanceTimersByTimeAsync(DEFAULT_DISCOVERY_DEADLINE_MS);
		expect((await first).map((m) => m.id)).toEqual(["fallback"]);

		// Call 2 completes within its deadline and populates the cache.
		expect((await fetcher(credentials)).map((m) => m.id)).toEqual(["fresh-2"]);

		// The timed-out operation settles late; it must not overwrite the
		// newer cache entry.
		slow.resolve([model("late")]);
		await vi.advanceTimersByTimeAsync(0);

		// Within the TTL: a cache hit proves what the cache holds.
		expect((await fetcher(credentials)).map((m) => m.id)).toEqual(["fresh-2"]);
		expect(fetchFresh).toHaveBeenCalledTimes(2);
	});

	it("handles a late rejection of a timed-out operation without leaking it", async () => {
		vi.useFakeTimers();
		const slow = deferred<ModelInfo[]>();
		const fetcher = createHangingFetcher({ fetchFresh: () => slow.promise });

		const first = fetcher(credentials);
		await vi.advanceTimersByTimeAsync(DEFAULT_DISCOVERY_DEADLINE_MS);
		expect((await first).map((m) => m.id)).toEqual(["fallback"]);

		// A late rejection is consumed by the race, not surfaced as an
		// unhandled rejection, and does not populate the cache.
		slow.reject(new Error("late failure"));
		await vi.advanceTimersByTimeAsync(0);

		const second = fetcher(credentials);
		await vi.advanceTimersByTimeAsync(DEFAULT_DISCOVERY_DEADLINE_MS);
		expect((await second).map((m) => m.id)).toEqual(["fallback"]);
	});

	it("cleans up its deadline timer on both success and timeout", async () => {
		vi.useFakeTimers();
		const baseline = vi.getTimerCount();

		const succeeding = createHangingFetcher({ fetchFresh: async () => [model("fresh")] });
		expect((await succeeding(credentials)).map((m) => m.id)).toEqual(["fresh"]);
		expect(vi.getTimerCount()).toBe(baseline);

		const hanging = createHangingFetcher();
		const promise = hanging(credentials);
		expect(vi.getTimerCount()).toBe(baseline + 1);
		await vi.advanceTimersByTimeAsync(DEFAULT_DISCOVERY_DEADLINE_MS);
		expect((await promise).map((m) => m.id)).toEqual(["fallback"]);
		expect(vi.getTimerCount()).toBe(baseline);
	});

	it("does not repopulate the cache when clearCache runs during an in-flight fetch", async () => {
		vi.useFakeTimers();
		const inFlight = deferred<ModelInfo[]>();
		const fetchFresh = vi.fn((): Promise<ModelInfo[]> => {
			return fetchFresh.mock.calls.length === 1
				? inFlight.promise
				: Promise.resolve([model("fresh-2")]);
		});
		const fetcher = createHangingFetcher({ fetchFresh, ttl: 60_000 });

		const first = fetcher(credentials);
		fetcher.clearCache?.();

		// The in-flight fetch still answers its own caller...
		inFlight.resolve([model("fresh-1")]);
		expect((await first).map((m) => m.id)).toEqual(["fresh-1"]);

		// ...but must not repopulate the cleared cache: the next call fetches
		// again instead of serving fresh-1 from the cache.
		expect((await fetcher(credentials)).map((m) => m.id)).toEqual(["fresh-2"]);
		expect(fetchFresh).toHaveBeenCalledTimes(2);
	});

	it("serves the cache within the TTL without starting a new discovery", async () => {
		vi.useFakeTimers();
		const fetchFresh = vi.fn(async () => [model("fresh")]);
		const fetcher = createHangingFetcher({ fetchFresh, ttl: 60_000 });

		expect((await fetcher(credentials)).map((m) => m.id)).toEqual(["fresh"]);
		expect((await fetcher(credentials)).map((m) => m.id)).toEqual(["fresh"]);
		expect(fetchFresh).toHaveBeenCalledTimes(1);
	});
});
