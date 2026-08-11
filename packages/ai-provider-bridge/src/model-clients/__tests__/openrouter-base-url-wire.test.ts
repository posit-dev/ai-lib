/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { beforeEach, describe, expect, it, vi } from "vitest";

const { createOpenRouter, streamText } = vi.hoisted(() => {
	const chat = vi.fn(() => ({}));
	return {
		createOpenRouter: vi.fn(() => ({ chat })),
		streamText: vi.fn(() => ({ fullStream: {} })),
	};
});

vi.mock("@openrouter/ai-sdk-provider", () => ({ createOpenRouter }));
vi.mock("ai", () => ({ streamText }));
vi.mock("../ai-sdk-helpers", () => ({
	convertAiSdkStreamToPlatform: vi.fn(() => (async function* () {})()),
	createAbortControllerFromToken: vi.fn(() => ({
		abortController: new AbortController(),
		cleanup: vi.fn(),
	})),
	createStepLogger: vi.fn(() => undefined),
}));

import { registerCustomOpenRouterProvider } from "../../providers/openrouter-provider";
import { ProviderRegistry } from "../../providers/ProviderRegistry";
import type { CancellationToken, Logger } from "../../types";

const cancellationToken: CancellationToken = {
	isCancellationRequested: false,
	onCancellationRequested: () => ({ dispose() {} }),
};

describe("OpenRouterClient base URL routing", () => {
	beforeEach(() => vi.clearAllMocks());

	it("routes custom chat through the kind factory to the custom canonical API root", async () => {
		const logger: Logger = {
			info: vi.fn(),
			warn: vi.fn(),
			error: vi.fn(),
			debug: vi.fn(),
			trace: vi.fn(),
		};
		const registry = new ProviderRegistry(logger);
		registerCustomOpenRouterProvider(registry, "acme-router", logger);
		const client = registry.getClientForProviderOrKind(
			"acme-router",
			{
				type: "apikey",
				apiKey: "sk-or-test",
				baseUrl: "https://router.example.com",
				customHeaders: { "x-tenant": "acme" },
			},
			"openrouter",
		);
		if (!client) throw new Error("expected the custom OpenRouter kind factory");
		await client.chat({
			model: "anthropic/claude-sonnet-4.6",
			messages: [{ role: "user", content: "hello" }],
			maxOutputTokens: 100,
			cancellationToken,
		});

		expect(createOpenRouter).toHaveBeenCalledWith(
			expect.objectContaining({
				apiKey: "sk-or-test",
				baseURL: "https://router.example.com/api/v1",
				headers: { "x-tenant": "acme" },
			}),
		);
	});
});
