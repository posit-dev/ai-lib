/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it, vi } from "vitest";

import type { Logger, ProviderCredentials } from "../../types";
import { registerPositAiProvider } from "../positai-provider";
import { ProviderRegistry } from "../ProviderRegistry";

function createMockLogger(): Logger {
	return {
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
		debug: vi.fn(),
		trace: vi.fn(),
	};
}

describe("Posit AI protocol mapping", () => {
	it("maps anthropic-messages protocol and sets vendor to anthropic", async () => {
		const logger = createMockLogger();
		const registry = new ProviderRegistry(logger);
		registerPositAiProvider(registry, "https://api.posit.cloud", "test/1.0", logger);

		// Mock the /models endpoint
		const mockResponse = {
			chat: [
				{
					id: "claude-sonnet-4-6",
					display_name: "Claude Sonnet 4.6",
					endpoints: [{ path: "/anthropic/v1", protocol: "anthropic-messages" }],
					max_context_length: 200000,
				},
			],
		};

		vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
			new Response(JSON.stringify(mockResponse), { status: 200 }),
		);

		const models = await registry.getModelsForProvider("positai", {
			type: "oauth",
			accessToken: "test-token",
		} as ProviderCredentials);

		expect(models).toHaveLength(1);
		expect(models[0].protocol).toBe("anthropic-messages");
		expect(models[0].vendor).toBe("anthropic");
		expect(models[0].supportsWebSearch).toBe(true);

		vi.restoreAllMocks();
	});

	it("maps openai-chat protocol and sets vendor to openai", async () => {
		const logger = createMockLogger();
		const registry = new ProviderRegistry(logger);
		registerPositAiProvider(registry, "https://api.posit.cloud", "test/1.0", logger);

		const mockResponse = {
			chat: [
				{
					id: "gpt-5.4",
					display_name: "GPT-5.4",
					endpoints: [{ path: "/openai/v1", protocol: "openai-chat" }],
					max_context_length: 128000,
				},
			],
		};

		vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
			new Response(JSON.stringify(mockResponse), { status: 200 }),
		);

		const models = await registry.getModelsForProvider("positai", {
			type: "oauth",
			accessToken: "test-token",
		} as ProviderCredentials);

		expect(models).toHaveLength(1);
		expect(models[0].protocol).toBe("openai-chat");
		expect(models[0].vendor).toBe("openai");
		expect(models[0].supportsWebSearch).toBe(false);

		vi.restoreAllMocks();
	});

	it("suppresses openai-responses protocol but preserves openai vendor", async () => {
		const logger = createMockLogger();
		const registry = new ProviderRegistry(logger);
		registerPositAiProvider(registry, "https://api.posit.cloud", "test/1.0", logger);

		const mockResponse = {
			chat: [
				{
					id: "gpt-5.4-responses",
					display_name: "GPT-5.4 Responses",
					endpoints: [{ path: "/openai/v1", protocol: "openai-responses" }],
					max_context_length: 128000,
				},
			],
		};

		vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
			new Response(JSON.stringify(mockResponse), { status: 200 }),
		);

		const models = await registry.getModelsForProvider("positai", {
			type: "oauth",
			accessToken: "test-token",
		} as ProviderCredentials);

		expect(models).toHaveLength(1);
		// Protocol should be undefined (suppressed), NOT "openai-responses"
		expect(models[0].protocol).toBeUndefined();
		// Vendor should still be "openai", NOT "unknown"
		expect(models[0].vendor).toBe("openai");

		vi.restoreAllMocks();
	});
});
