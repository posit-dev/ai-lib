/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

/**
 * Wire regression for the auto-mode classifier's two-part user message on the
 * Anthropic-wire transports (direct Messages API and Bedrock InvokeModel):
 * the ephemeral breakpoint must serialize onto the system block and the first
 * user content block (the stable transcript prefix), and nowhere else. The
 * unrelated marker namespaces core also places on the part (`bedrock`,
 * `openai`) must not leak onto the Anthropic wire.
 */

import type { ModelMessage } from "ai";
import { afterEach, describe, expect, it, vi } from "vitest";

const { resolveBedrockTransport } = vi.hoisted(() => ({
	resolveBedrockTransport: vi.fn(async () => ({
		useFipsEndpoint: false,
		runtimeBaseUrl: "https://bedrock-runtime.us-east-2.amazonaws.com",
		mantleEnabled: true,
	})),
}));

vi.mock("../../providers/bedrock-transport", () => ({ resolveBedrockTransport }));

import type { CancellationToken } from "../../types";
import { AnthropicClient } from "../AnthropicClient";
import { BedrockClient } from "../BedrockClient";

const cancellationToken: CancellationToken = {
	isCancellationRequested: false,
	onCancellationRequested: () => ({ dispose() {} }),
};

/** The marker shape core places on the classifier's system message and part 1. */
const classifierProviderOptions = {
	anthropic: { cacheControl: { type: "ephemeral" } },
	bedrock: { cachePoint: { type: "default" } },
};

/**
 * The exact message shape `prepareClassifierRequest` produces for an
 * Anthropic-route classifier: marked system message, then a two-part user
 * message with the breakpoint on part 1 (stable prefix) only.
 */
function classifierShapedMessages(): ModelMessage[] {
	return [
		{
			role: "system",
			content: "You are a classifier.",
			providerOptions: classifierProviderOptions,
		},
		{
			role: "user",
			content: [
				{
					type: "text",
					text: "<workspace>\n(none)\n</workspace>\n\n--- Conversation ---\n(empty)",
					providerOptions: classifierProviderOptions,
				},
				{
					type: "text",
					text: '--- Tool call to evaluate ---\nbash({"command":"ls"})\n\nShould this tool call be allowed? Respond with JSON only.',
				},
			],
		},
	];
}

/** Recursively collect JSON paths of every `cache_control` key in the body. */
function cacheControlPaths(value: unknown, path = ""): string[] {
	if (Array.isArray(value)) {
		return value.flatMap((item, index) => cacheControlPaths(item, `${path}[${index}]`));
	}
	if (value === null || typeof value !== "object") {
		return [];
	}
	const paths: string[] = [];
	for (const [key, child] of Object.entries(value)) {
		const childPath = path ? `${path}.${key}` : key;
		if (key === "cache_control") {
			paths.push(childPath);
		} else {
			paths.push(...cacheControlPaths(child, childPath));
		}
	}
	return paths;
}

function stubFetchCapture(): { body: () => Record<string, unknown> } {
	let requestBody: Record<string, unknown> | undefined;
	vi.stubGlobal(
		"fetch",
		vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
			requestBody = JSON.parse(String(init?.body));
			return new Response("", {
				status: 200,
				headers: { "content-type": "text/event-stream" },
			});
		}),
	);
	return {
		body: () => {
			if (!requestBody) throw new Error("request was not captured");
			return requestBody;
		},
	};
}

async function consumeIgnoringStreamFailure(
	streamPromise: Promise<AsyncIterable<unknown>>,
): Promise<void> {
	try {
		const stream = await streamPromise;
		for await (const _part of stream) {
			// Drain the minimal mocked event stream.
		}
	} catch {
		// The mocked stream is minimal; stream errors are fine — we only care
		// about the serialized request body.
	}
}

/** Assert the classifier breakpoint contract on an Anthropic-wire body. */
function expectClassifierBreakpoints(body: Record<string, unknown>): void {
	// Breakpoints on the system block and user content part 1 only.
	expect(cacheControlPaths(body)).toEqual([
		"system[0].cache_control",
		"messages[0].content[0].cache_control",
	]);

	const messages = body.messages as Array<{ content: Array<Record<string, unknown>> }>;
	expect(messages[0].content).toHaveLength(2);
	expect(messages[0].content[0].cache_control).toEqual({ type: "ephemeral" });
	expect(messages[0].content[1]).not.toHaveProperty("cache_control");
	// The evaluation section survives intact after the marked prefix.
	expect(messages[0].content[1].text).toContain("--- Tool call to evaluate ---");

	// Unrelated marker namespaces must not leak onto the Anthropic wire.
	const serialized = JSON.stringify(body);
	expect(serialized).not.toContain("cachePoint");
	expect(serialized).not.toContain("prompt_cache_breakpoint");
}

afterEach(() => {
	vi.unstubAllGlobals();
	delete process.env.AWS_BEARER_TOKEN_BEDROCK;
});

describe("AnthropicClient classifier cache breakpoints", () => {
	const client = new AnthropicClient({ apiKey: "sk-ant-test" });

	it("serializes the breakpoint after user part 1, leaving part 2 unmarked", async () => {
		const capture = stubFetchCapture();

		await consumeIgnoringStreamFailure(
			client.chat({
				model: "claude-sonnet-4-5",
				messages: classifierShapedMessages(),
				maxOutputTokens: 256,
				allowSystemInMessages: true,
				cancellationToken,
			}),
		);

		expectClassifierBreakpoints(capture.body());
	});
});

describe("BedrockClient Anthropic-route classifier cache breakpoints", () => {
	const client = new BedrockClient({
		region: "us-east-2",
		accessKeyId: "AKIDEXAMPLE",
		secretAccessKey: "secret",
	});

	it("serializes the breakpoint after user part 1 on the InvokeModel transport", async () => {
		const capture = stubFetchCapture();

		await consumeIgnoringStreamFailure(
			client.chat({
				model: "us.anthropic.claude-sonnet-4-5-20250929-v1:0",
				messages: classifierShapedMessages(),
				maxOutputTokens: 256,
				allowSystemInMessages: true,
				cancellationToken,
			}),
		);

		expectClassifierBreakpoints(capture.body());
	});
});
