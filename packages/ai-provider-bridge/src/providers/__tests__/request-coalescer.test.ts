/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

/**
 * Behavioral tests for the registry-owned in-flight request coalescer,
 * exercised through real `createCachedModelFetcher` instances registered on a
 * real `ProviderRegistry` (only the HTTP layer is stubbed) — the same
 * composition LiteLLM's registrars produce.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

import type { Logger, ModelInfo } from "../../types";
import { createCachedModelFetcher } from "../cached-model-fetcher";
import { ProviderRegistry } from "../ProviderRegistry";

const logger: Logger = {
	info: vi.fn(),
	warn: vi.fn(),
	error: vi.fn(),
	debug: vi.fn(),
	trace: vi.fn(),
};

const GATEWAY_URL = "http://gateway.test/v1/model/info";

interface FetchCall {
	readonly signal: AbortSignal;
	readonly release: (body?: unknown) => void;
	readonly fail: (error: unknown) => void;
}

/** Controllable fetch stub: every call parks until the test releases it. */
function makeGatedFetch() {
	const calls: FetchCall[] = [];
	const mock = vi.fn((_url: unknown, options?: { signal?: AbortSignal }) => {
		let release!: (body?: unknown) => void;
		let fail!: (error: unknown) => void;
		const promise = new Promise<Response>((resolve, reject) => {
			release = (body: unknown = { models: ["model-a"] }) => resolve(Response.json(body));
			fail = reject;
			// Honor cooperative cancellation so timed-out flights settle.
			options?.signal?.addEventListener("abort", () =>
				reject(options.signal!.reason ?? new Error("aborted")),
			);
		});
		calls.push({ signal: options?.signal ?? new AbortController().signal, release, fail });
		return promise;
	});
	return { mock, calls };
}

function makeFetcher(
	registry: ProviderRegistry,
	providerId: string,
	options: { deadlineMs?: number } = {},
) {
	return createCachedModelFetcher({
		providerId,
		resolveUrl: () => GATEWAY_URL,
		hasCredentials: () => true,
		createHeaders: (credentials) =>
			credentials.apiKey ? { authorization: `Bearer ${credentials.apiKey}` } : {},
		requestCoalescer: registry,
		parseResponse: (data) =>
			((data as { models?: string[] }).models ?? []).map(
				(id) =>
					({
						id,
						name: id,
						providerId,
						vendor: "test",
					}) as ModelInfo,
			),
		fallbackModels: [],
		discoveryDeadlineMs: options.deadlineMs,
		logger,
	});
}

const credentials = (apiKey: string) =>
	({ type: "apikey", providerId: "litellm", apiKey, baseUrl: "http://gateway.test" }) as const;

async function waitFor(condition: () => boolean): Promise<void> {
	await vi.waitFor(condition, { interval: 1, timeout: 1000 });
}

describe("registry-owned in-flight request coalescer", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("joins an identical in-flight request and stamps each provider's own id", async () => {
		const { mock, calls } = makeGatedFetch();
		vi.stubGlobal("fetch", mock);
		const registry = new ProviderRegistry(logger);
		registry.registerModelFetcher("litellm", makeFetcher(registry, "litellm"));
		registry.registerModelFetcher("acme-litellm", makeFetcher(registry, "acme-litellm"));

		const first = registry.getModelsForProvider("litellm", credentials("sk-same"));
		const second = registry.getModelsForProvider("acme-litellm", credentials("sk-same"));
		await waitFor(() => calls.length === 1);

		// One HTTP request for two concurrent identical discoveries.
		expect(calls).toHaveLength(1);
		calls[0].release();

		const [firstModels, secondModels] = await Promise.all([first, second]);
		// The shared payload is parsed and stamped per provider.
		expect(firstModels.map((m) => `${m.providerId}:${m.id}`)).toEqual(["litellm:model-a"]);
		expect(secondModels.map((m) => `${m.providerId}:${m.id}`)).toEqual(["acme-litellm:model-a"]);

		// Completed results live in each fetcher's own TTL: no new request.
		await registry.getModelsForProvider("litellm", credentials("sk-same"));
		expect(calls).toHaveLength(1);
	});

	it("does not share a flight across different credentials at one URL", async () => {
		const { mock, calls } = makeGatedFetch();
		vi.stubGlobal("fetch", mock);
		const registry = new ProviderRegistry(logger);
		registry.registerModelFetcher("litellm", makeFetcher(registry, "litellm"));
		registry.registerModelFetcher("acme-litellm", makeFetcher(registry, "acme-litellm"));

		const first = registry.getModelsForProvider("litellm", credentials("sk-one"));
		const second = registry.getModelsForProvider("acme-litellm", credentials("sk-two"));
		await waitFor(() => calls.length === 2);

		calls[0].release();
		calls[1].release();
		await Promise.all([first, second]);
		expect(calls).toHaveLength(2);
	});

	it("never retains a failed flight: a later call re-executes", async () => {
		const { mock, calls } = makeGatedFetch();
		vi.stubGlobal("fetch", mock);
		const registry = new ProviderRegistry(logger);
		registry.registerModelFetcher("litellm", makeFetcher(registry, "litellm"));

		const failed = registry.getModelsForProvider("litellm", credentials("sk-one"));
		await waitFor(() => calls.length === 1);
		calls[0].fail(new Error("boom"));
		// The fetcher falls back (no stale cache → fallbackModels).
		await expect(failed).resolves.toEqual([]);

		const retried = registry.getModelsForProvider("litellm", credentials("sk-one"));
		await waitFor(() => calls.length === 2);
		calls[1].release();
		const models = await retried;
		expect(models.map((m) => m.id)).toEqual(["model-a"]);
	});

	it("never retains a timed-out flight: detaching all callers aborts it and a later call re-executes", async () => {
		const { mock, calls } = makeGatedFetch();
		vi.stubGlobal("fetch", mock);
		const registry = new ProviderRegistry(logger);
		registry.registerModelFetcher("litellm", makeFetcher(registry, "litellm", { deadlineMs: 30 }));

		// The fetch never resolves on its own; the caller's deadline races out.
		const timedOut = registry.getModelsForProvider("litellm", credentials("sk-one"));
		await waitFor(() => calls.length === 1);
		await expect(timedOut).resolves.toEqual([]);
		// Once the only participant detached, the flight's own signal aborted.
		expect(calls[0].signal.aborted).toBe(true);
		await waitFor(() => calls.length === 1); // settled and removed

		const retried = registry.getModelsForProvider("litellm", credentials("sk-one"));
		await waitFor(() => calls.length === 2);
		calls[1].release();
		const models = await retried;
		expect(models.map((m) => m.id)).toEqual(["model-a"]);
	});

	it("one caller's deadline does not cancel a shared flight's other caller", async () => {
		const { mock, calls } = makeGatedFetch();
		vi.stubGlobal("fetch", mock);
		const registry = new ProviderRegistry(logger);
		registry.registerModelFetcher("litellm", makeFetcher(registry, "litellm", { deadlineMs: 30 }));
		registry.registerModelFetcher(
			"acme-litellm",
			makeFetcher(registry, "acme-litellm", { deadlineMs: 10_000 }),
		);

		const shortDeadline = registry.getModelsForProvider("litellm", credentials("sk-same"));
		const longDeadline = registry.getModelsForProvider("acme-litellm", credentials("sk-same"));
		await waitFor(() => calls.length === 1);

		// The short-deadline caller times out and detaches; the flight lives on.
		await expect(shortDeadline).resolves.toEqual([]);
		expect(calls[0].signal.aborted).toBe(false);

		calls[0].release();
		const models = await longDeadline;
		expect(models.map((m) => `${m.providerId}:${m.id}`)).toEqual(["acme-litellm:model-a"]);
		expect(calls).toHaveLength(1);
	});

	it("a provider clear retires its flights: pre-clear joiners finish, post-clear calls start fresh", async () => {
		const { mock, calls } = makeGatedFetch();
		vi.stubGlobal("fetch", mock);
		const registry = new ProviderRegistry(logger);
		registry.registerModelFetcher("litellm", makeFetcher(registry, "litellm"));
		registry.registerModelFetcher("acme-litellm", makeFetcher(registry, "acme-litellm"));

		const preClearA = registry.getModelsForProvider("litellm", credentials("sk-same"));
		const preClearB = registry.getModelsForProvider("acme-litellm", credentials("sk-same"));
		await waitFor(() => calls.length === 1);

		registry.clearModelCache("litellm");

		// A post-clear call for the cleared provider must not join the
		// pre-clear flight.
		const postClear = registry.getModelsForProvider("litellm", credentials("sk-same"));
		await waitFor(() => calls.length === 2);

		// Clearing one provider did not cancel the other provider's caller.
		expect(calls[0].signal.aborted).toBe(false);
		calls[0].release();
		const [modelsA, modelsB] = await Promise.all([preClearA, preClearB]);
		expect(modelsA.map((m) => m.id)).toEqual(["model-a"]);
		expect(modelsB.map((m) => `${m.providerId}:${m.id}`)).toEqual(["acme-litellm:model-a"]);

		calls[1].release();
		const freshModels = await postClear;
		expect(freshModels.map((m) => `${m.providerId}:${m.id}`)).toEqual(["litellm:model-a"]);
		expect(calls).toHaveLength(2);
	});

	it("clear-all retires every flight without cancelling attached callers", async () => {
		const { mock, calls } = makeGatedFetch();
		vi.stubGlobal("fetch", mock);
		const registry = new ProviderRegistry(logger);
		registry.registerModelFetcher("litellm", makeFetcher(registry, "litellm"));

		const inFlight = registry.getModelsForProvider("litellm", credentials("sk-one"));
		await waitFor(() => calls.length === 1);

		registry.clearAllModelCaches();

		const postClear = registry.getModelsForProvider("litellm", credentials("sk-one"));
		await waitFor(() => calls.length === 2);

		expect(calls[0].signal.aborted).toBe(false);
		calls[0].release();
		calls[1].release();
		await Promise.all([inFlight, postClear]);
		expect(calls).toHaveLength(2);
	});

	it("a re-registered provider cannot join its retired pre-registration flight", async () => {
		const { mock, calls } = makeGatedFetch();
		vi.stubGlobal("fetch", mock);
		const registry = new ProviderRegistry(logger);
		registry.registerModelFetcher("litellm", makeFetcher(registry, "litellm"));

		const preRegistration = registry.getModelsForProvider("litellm", credentials("sk-one"));
		await waitFor(() => calls.length === 1);

		registry.registerModelFetcher("litellm", makeFetcher(registry, "litellm"));

		const postRegistration = registry.getModelsForProvider("litellm", credentials("sk-one"));
		await waitFor(() => calls.length === 2);

		calls[0].release();
		calls[1].release();
		await Promise.all([preRegistration, postRegistration]);
		expect(calls).toHaveLength(2);
	});

	it("isolates flights per registry: a second registry never joins the first's flight", async () => {
		const { mock, calls } = makeGatedFetch();
		vi.stubGlobal("fetch", mock);
		const registryA = new ProviderRegistry(logger);
		const registryB = new ProviderRegistry(logger);
		registryA.registerModelFetcher("litellm", makeFetcher(registryA, "litellm"));
		registryB.registerModelFetcher("litellm", makeFetcher(registryB, "litellm"));

		const first = registryA.getModelsForProvider("litellm", credentials("sk-same"));
		const second = registryB.getModelsForProvider("litellm", credentials("sk-same"));
		await waitFor(() => calls.length === 2);

		calls[0].release();
		calls[1].release();
		await Promise.all([first, second]);
		expect(calls).toHaveLength(2);
	});
});
