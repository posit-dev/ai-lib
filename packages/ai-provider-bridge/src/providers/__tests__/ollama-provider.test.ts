/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, describe, expect, it, vi } from "vitest";

import type { LocalCredentials, Logger } from "../../types";
import { DEFAULT_DISCOVERY_DEADLINE_MS } from "../cached-model-fetcher";
import { registerOllamaProvider } from "../ollama-provider";
import { ProviderRegistry } from "../ProviderRegistry";

const logger: Logger = {
	info: vi.fn(),
	warn: vi.fn(),
	error: vi.fn(),
	debug: vi.fn(),
	trace: vi.fn(),
};

afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllGlobals();
	vi.clearAllMocks();
});

const CREDENTIALS: LocalCredentials = { type: "local", endpoint: "http://localhost:11434" };

const TAGS_RESPONSE = {
	models: [{ name: "llama3.2:latest", size: 1, details: { family: "llama" } }],
};

function urlOf(input: string | URL | Request): string {
	return typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
}

describe("ollama model fetcher — enrichment signal propagation", () => {
	it("passes the discovery-deadline abort signal to the /api/show enrichment requests", async () => {
		const showSignals: (AbortSignal | undefined)[] = [];
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
				if (urlOf(input).endsWith("/api/show")) {
					showSignals.push(init?.signal ?? undefined);
					return Response.json({
						capabilities: ["completion", "tools", "thinking"],
						model_info: { "llama.context_length": 128_000 },
					});
				}
				return Response.json(TAGS_RESPONSE);
			}),
		);

		const registry = new ProviderRegistry(logger);
		registerOllamaProvider(registry, logger);
		const models = await registry.getModelsForProvider("ollama", CREDENTIALS);

		expect(models).toHaveLength(1);
		expect(models[0].supportsTools).toBe(true);
		expect(models[0].maxContextLength).toBe(128_000);
		expect(showSignals).toHaveLength(1);
		expect(showSignals[0]).toBeInstanceOf(AbortSignal);
		expect(showSignals[0]!.aborted).toBe(false);
	});

	it("bounds a hung /api/show enrichment by the discovery deadline", async () => {
		vi.useFakeTimers();
		const showSignals: (AbortSignal | undefined)[] = [];
		vi.stubGlobal(
			"fetch",
			vi.fn((input: string | URL | Request, init?: RequestInit) => {
				if (urlOf(input).endsWith("/api/show")) {
					showSignals.push(init?.signal ?? undefined);
					return new Promise<Response>(() => {}); // hung enrichment request
				}
				return Promise.resolve(Response.json(TAGS_RESPONSE));
			}),
		);

		const registry = new ProviderRegistry(logger);
		registerOllamaProvider(registry, logger);
		const promise = registry.getModelsForProvider("ollama", CREDENTIALS);

		// Let /api/tags complete and the /api/show enrichment start.
		await vi.advanceTimersByTimeAsync(0);
		expect(showSignals).toHaveLength(1);

		// Ollama's static fallback is empty: a deadline-bound enrichment must
		// not hold the caller past the shared discovery deadline.
		await vi.advanceTimersByTimeAsync(DEFAULT_DISCOVERY_DEADLINE_MS);
		await expect(promise).resolves.toEqual([]);
		expect(showSignals[0]!.aborted).toBe(true);
	});
});
