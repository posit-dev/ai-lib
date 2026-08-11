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

import type { CancellationToken } from "../../types";
import { OpenRouterClient } from "../OpenRouterClient";

const cancellationToken: CancellationToken = {
	isCancellationRequested: false,
	onCancellationRequested: () => ({ dispose() {} }),
};

describe("OpenRouterClient base URL routing", () => {
	beforeEach(() => vi.clearAllMocks());

	it("passes a custom canonical API root to the SDK", async () => {
		const client = new OpenRouterClient("sk-or-test", "https://router.example.com/api/v1", {
			"x-tenant": "acme",
		});
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
