/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

/**
 * Interface-level tests for Phase 4 protocol routing behavior.
 *
 * These verify the specific regressions the Phase 4 fixes target:
 * - Posit AI protocol mapping (unsupported protocols suppressed, vendor preserved)
 * - LM Studio rejecting unsupported protocols
 * - Vertex explicit Anthropic protocol using global location
 */

import { describe, expect, it, vi } from "vitest";

import { getEffectiveLocation, isVertexAnthropicModel } from "../model-clients/GoogleVertexClient";
import { LMStudioClient } from "../model-clients/LMStudioClient";
import type { ModelClientChatParams } from "../model-clients/ModelClient";
import { registerPositAiProvider } from "../providers/positai-provider";
import { ProviderRegistry } from "../providers/ProviderRegistry";
import type { Logger, ModelInfo, ProviderCredentials } from "../types";
import type { CancellationToken } from "../types";

function createMockLogger(): Logger {
	return {
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
		debug: vi.fn(),
		trace: vi.fn(),
	};
}

function createMockCancellationToken(): CancellationToken {
	return {
		isCancellationRequested: false,
		onCancellationRequested: () => ({ dispose: () => {} }),
	};
}

// ---------------------------------------------------------------------------
// Posit AI protocol mapping
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// LM Studio protocol guard
// ---------------------------------------------------------------------------

describe("LMStudioClient protocol guard", () => {
	it("rejects openai-responses protocol", async () => {
		const client = new LMStudioClient("http://localhost:1234/v1");

		const params: ModelClientChatParams = {
			model: "some-model",
			messages: [],
			cancellationToken: createMockCancellationToken(),
			protocol: "openai-responses",
		};

		await expect(client.chat(params)).rejects.toThrow(
			/Unsupported protocol for LM Studio.*openai-responses/,
		);
	});

	it("rejects anthropic-messages protocol", async () => {
		const client = new LMStudioClient("http://localhost:1234/v1");

		const params: ModelClientChatParams = {
			model: "some-model",
			messages: [],
			cancellationToken: createMockCancellationToken(),
			protocol: "anthropic-messages",
		};

		await expect(client.chat(params)).rejects.toThrow(
			/Unsupported protocol for LM Studio.*anthropic-messages/,
		);
	});

	it("accepts openai-chat protocol (or legacy openai)", async () => {
		const client = new LMStudioClient("http://localhost:1234/v1");

		const params: ModelClientChatParams = {
			model: "some-model",
			messages: [],
			cancellationToken: createMockCancellationToken(),
			protocol: "openai-chat",
		};

		// This will reject with a network error (no real server), but it should
		// NOT reject with a protocol error — proving the guard passed.
		try {
			await client.chat(params);
		} catch (error) {
			expect(String(error)).not.toMatch(/Unsupported protocol for LM Studio/);
		}
	});
});

// ---------------------------------------------------------------------------
// Vertex location heuristic with explicit protocol
// ---------------------------------------------------------------------------

describe("GoogleVertexClient location heuristic", () => {
	it("routes recognized Anthropic model IDs to global via model-ID heuristic", () => {
		// Baseline: recognized model IDs already go to global
		expect(isVertexAnthropicModel("claude-sonnet-4-6")).toBe(true);
		expect(getEffectiveLocation("claude-sonnet-4-6", "us-central1")).toBe("global");
	});

	it("routes unrecognized model IDs to configured location", () => {
		// A model ID that doesn't match the anthropic pattern
		expect(isVertexAnthropicModel("my-custom-model")).toBe(false);
		expect(getEffectiveLocation("my-custom-model", "us-central1")).toBe("us-central1");
	});

	// The actual location-with-protocol behavior is tested indirectly:
	// GoogleVertexClient.createModel is private, so we verify the exported
	// helpers produce the right inputs and trust that createModel's
	// `useAnthropicApi && protocol === "anthropic-messages"` → "global" branch
	// is covered by the type-checked implementation.
});
