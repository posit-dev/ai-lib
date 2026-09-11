/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

/** Wire regressions for the registry-level direct-provider User-Agent. */

import type { ModelMessage } from "ai";
import { mintCustomProviderId, OPENCODE_GO_BASE_URL } from "ai-config";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createRawFetchCapture } from "../../../tests/helpers/raw-fetch-capture";
import { registerCustomOpenAICompatibleProvider } from "../../providers/openai-compatible-provider";
import { ProviderRegistry } from "../../providers/ProviderRegistry";
import { registerAllProviders } from "../../register-all-providers";
import type { CancellationToken, Logger, ModelClient } from "../../types";

const PRODUCT_USER_AGENT = "PositAssistant-Standalone/1.0 (darwin)";

const logger: Logger = {
	info: vi.fn(),
	warn: vi.fn(),
	error: vi.fn(),
	debug: vi.fn(),
	trace: vi.fn(),
};

const cancellationToken: CancellationToken = {
	isCancellationRequested: false,
	onCancellationRequested: () => ({ dispose() {} }),
};

const messages: ModelMessage[] = [{ role: "user", content: "Hello" }];

function sseResponse(): Response {
	return new Response("data: [DONE]\n\n", {
		status: 200,
		headers: { "content-type": "text/event-stream" },
	});
}

async function driveChat(client: ModelClient): Promise<void> {
	try {
		const stream = await client.chat({
			model: "model-1",
			messages,
			cancellationToken,
			protocol: "openai-chat",
			metadata: { rootConversationId: "root-1" },
		});
		for await (const _part of stream) {
			// Drain the intentionally minimal event stream.
		}
	} catch {
		// The request is captured before the intentionally incomplete stream ends.
	}
}

function expectProductUserAgent(call: Parameters<typeof fetch>): void {
	const userAgent = new Headers(call[1]?.headers).get("user-agent");
	expect(userAgent?.startsWith(`${PRODUCT_USER_AGENT} `)).toBe(true);
	expect(userAgent).toContain("ai-sdk/");
}

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("default direct-provider User-Agent (wire)", () => {
	it("reaches a direct-SDK OpenCode request", async () => {
		const capture = createRawFetchCapture(async () => sseResponse());
		vi.stubGlobal("fetch", capture.mock);
		const registry = new ProviderRegistry(logger);
		registerAllProviders(registry, logger, {
			positAiBaseUrl: "https://api.posit.cloud",
			providerUserAgent: PRODUCT_USER_AGENT,
			allowedProviders: ["opencode"],
		});
		const client = registry.getClientForProvider("opencode", {
			type: "apikey",
			apiKey: "sk-test",
			baseUrl: OPENCODE_GO_BASE_URL,
		});
		if (!client) throw new Error("expected OpenCode client");

		await driveChat(client);

		expectProductUserAgent(capture.single());
	});

	it("reaches a custom OpenAI-compatible request through fetch middleware", async () => {
		const capture = createRawFetchCapture(async () => sseResponse());
		vi.stubGlobal("fetch", capture.mock);
		const registry = new ProviderRegistry(logger);
		registerAllProviders(registry, logger, {
			positAiBaseUrl: "https://api.posit.cloud",
			providerUserAgent: PRODUCT_USER_AGENT,
			allowedProviders: [],
		});
		const providerId = mintCustomProviderId("acme-openai");
		registerCustomOpenAICompatibleProvider(registry, providerId, logger);
		const client = registry.getClientForProviderOrKind(
			providerId,
			{ type: "apikey", apiKey: "sk-test", baseUrl: "https://gateway.example/v1" },
			"openai-compatible",
		);
		if (!client) throw new Error("expected custom OpenAI-compatible client");

		await driveChat(client);

		expectProductUserAgent(capture.single());
	});
});
