/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it, vi } from "vitest";

import type { ApiKeyCredentials, Logger, ModelInfo } from "../../types";
import { createCachedModelFetcher } from "../cached-model-fetcher";

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
