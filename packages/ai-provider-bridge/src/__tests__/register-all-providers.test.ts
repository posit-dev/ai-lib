/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, describe, expect, it, vi } from "vitest";

import { ProviderRegistry } from "../providers/ProviderRegistry";
import { registerAllProviders } from "../register-all-providers";
import type { Logger } from "../types";

function logger(): Logger {
	return {
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
		debug: vi.fn(),
		trace: vi.fn(),
	};
}

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("registerAllProviders", () => {
	it("registers all providers by default and honors an explicit allow-list", () => {
		const credentials = { type: "apikey", apiKey: "test" } as const;
		const all = new ProviderRegistry(logger());
		registerAllProviders(all, logger(), { positAiBaseUrl: "https://api.posit.cloud" });

		expect(all.getClientForProvider("anthropic", credentials)).not.toBeNull();
		expect(all.getClientForProvider("openai", credentials)).not.toBeNull();

		const selected = new ProviderRegistry(logger());
		registerAllProviders(selected, logger(), {
			positAiBaseUrl: "https://api.posit.cloud",
			allowedProviders: ["anthropic"],
		});

		expect(selected.getClientForProvider("anthropic", credentials)).not.toBeNull();
		expect(selected.getClientForProvider("openai", credentials)).toBeNull();
	});

	it("registers nothing for an empty allow-list", () => {
		const registry = new ProviderRegistry(logger());
		registerAllProviders(registry, logger(), {
			positAiBaseUrl: "https://api.posit.cloud",
			allowedProviders: [],
		});

		expect(
			registry.getClientForProvider("anthropic", { type: "apikey", apiKey: "test" }),
		).toBeNull();
	});

	it("resolves a function-form Posit AI base URL when models are fetched", async () => {
		let baseUrl = "https://first.example.com";
		const fetchMock = vi.fn(
			async () => new Response(JSON.stringify({ chat: [] }), { status: 200 }),
		);
		vi.stubGlobal("fetch", fetchMock);

		const registry = new ProviderRegistry(logger());
		registerAllProviders(registry, logger(), {
			positAiBaseUrl: () => baseUrl,
			allowedProviders: ["positai"],
		});

		baseUrl = "https://second.example.com";
		await registry.getModelsForProvider("positai", {
			type: "oauth",
			accessToken: "token",
		});

		expect(fetchMock).toHaveBeenCalledWith("https://second.example.com/models", expect.any(Object));
	});
});
