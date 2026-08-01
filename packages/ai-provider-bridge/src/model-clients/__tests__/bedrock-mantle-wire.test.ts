/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import type { ModelMessage } from "ai";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { CancellationToken } from "../../types";
import { BedrockClient } from "../BedrockClient";

const cancellationToken: CancellationToken = {
	isCancellationRequested: false,
	onCancellationRequested: () => ({ dispose() {} }),
};

const breakpointProviderOptions = {
	openai: { promptCacheBreakpoint: { mode: "explicit" } },
};

function breakpointPaths(value: unknown, path = ""): string[] {
	if (Array.isArray(value)) {
		return value.flatMap((item, index) => breakpointPaths(item, `${path}[${index}]`));
	}
	if (value === null || typeof value !== "object") {
		return [];
	}

	const paths: string[] = [];
	for (const [key, child] of Object.entries(value)) {
		const childPath = path ? `${path}.${key}` : key;
		if (key === "prompt_cache_breakpoint") {
			paths.push(childPath);
		} else {
			paths.push(...breakpointPaths(child, childPath));
		}
	}
	return paths;
}

function markedContinuationMessages(): ModelMessage[] {
	return [
		{
			role: "system",
			content: "System instruction",
			providerOptions: breakpointProviderOptions,
		},
		{
			role: "user",
			content: [
				{
					type: "text",
					text: "Stable user input",
					providerOptions: breakpointProviderOptions,
				},
			],
		},
		{ role: "user", content: "Dynamic environment reminder" },
		{
			role: "assistant",
			content: [
				{
					type: "tool-call",
					toolCallId: "call-1",
					toolName: "lookup",
					input: { query: "cache" },
				},
			],
		},
		{
			role: "tool",
			content: [
				{
					type: "tool-result",
					toolCallId: "call-1",
					toolName: "lookup",
					output: { type: "json", value: { result: "cached" } },
					providerOptions: breakpointProviderOptions,
				},
			],
		},
	];
}

async function consumeIgnoringNetworkFailure(
	streamPromise: ReturnType<BedrockClient["chat"]>,
): Promise<void> {
	try {
		const stream = await streamPromise;
		for await (const _part of stream) {
			// Consume the minimal mocked event stream.
		}
	} catch {
		// Expected.
	}
}

afterEach(() => {
	vi.unstubAllGlobals();
	delete process.env.AWS_BEARER_TOKEN_BEDROCK;
});

describe("Bedrock Mantle wire requests", () => {
	const client = new BedrockClient({
		region: "us-east-2",
		promptCaching: "gpt-5.6-explicit",
		accessKeyId: "AKIDEXAMPLE",
		secretAccessKey: "secret",
	});

	it("serializes the Responses reasoning contract and remains SigV4-only", async () => {
		let requestBody: Record<string, unknown> | undefined;
		let authorization: string | null = null;
		process.env.AWS_BEARER_TOKEN_BEDROCK = "stale-bearer-token";
		vi.stubGlobal(
			"fetch",
			vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
				requestBody = JSON.parse(String(init?.body));
				authorization = new Headers(init?.headers).get("authorization");
				return new Response("data: [DONE]\n\n", {
					status: 200,
					headers: { "content-type": "text/event-stream" },
				});
			}),
		);

		await consumeIgnoringNetworkFailure(
			client.chat({
				model: "openai.gpt-5.5",
				protocol: "openai-responses",
				baseUrl: "https://bedrock-mantle.us-east-2.api.aws/openai/v1",
				messages: [{ role: "user", content: "Hello" }],
				thinkingEffort: "off",
				cancellationToken,
			}),
		);

		expect(requestBody).toMatchObject({
			model: "openai.gpt-5.5",
			store: false,
			reasoning: { effort: "none", summary: "detailed" },
			include: ["reasoning.encrypted_content"],
		});
		expect(requestBody).not.toHaveProperty("max_output_tokens");
		expect(requestBody).not.toHaveProperty("prompt_cache_key");
		expect(requestBody).not.toHaveProperty("prompt_cache_options");
		expect(authorization).toContain("/us-east-2/bedrock-mantle/aws4_request");
		expect(authorization).not.toContain("Bearer");
	});

	it("serializes GPT-5.6 cache options and a structured tool-result breakpoint", async () => {
		let requestBody: Record<string, unknown> | undefined;
		vi.stubGlobal(
			"fetch",
			vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
				requestBody = JSON.parse(String(init?.body));
				return new Response("data: [DONE]\n\n", {
					status: 200,
					headers: { "content-type": "text/event-stream" },
				});
			}),
		);

		const messages = markedContinuationMessages();
		await consumeIgnoringNetworkFailure(
			client.chat({
				model: "openai.gpt-5.6-sol",
				protocol: "openai-responses",
				baseUrl: "https://bedrock-mantle.us-east-2.api.aws/openai/v1",
				messages,
				metadata: { sessionId: "bedrock-conversation-1" },
				thinkingEffort: "high",
				allowSystemInMessages: true,
				cancellationToken,
			}),
		);

		expect(requestBody).toMatchObject({
			model: "openai.gpt-5.6-sol",
			prompt_cache_key: "bedrock-conversation-1",
			prompt_cache_options: { mode: "explicit", ttl: "30m" },
			store: false,
			reasoning: { effort: "high", summary: "detailed" },
		});
		expect(breakpointPaths(requestBody)).toEqual([
			"input[0].content[0].prompt_cache_breakpoint",
			"input[1].content[0].prompt_cache_breakpoint",
			"input[4].output[0].prompt_cache_breakpoint",
		]);
		expect(requestBody?.input).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					type: "function_call_output",
					output: [
						{
							type: "input_text",
							text: '{"result":"cached"}',
							prompt_cache_breakpoint: { mode: "explicit" },
						},
					],
				}),
			]),
		);
		expect(messages[4]).toMatchObject({
			content: [{ output: { type: "json", value: { result: "cached" } } }],
		});
	});

	it("keeps explicit mode but strips key and markers without session metadata", async () => {
		let requestBody: Record<string, unknown> | undefined;
		vi.stubGlobal(
			"fetch",
			vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
				requestBody = JSON.parse(String(init?.body));
				return new Response("data: [DONE]\n\n", {
					status: 200,
					headers: { "content-type": "text/event-stream" },
				});
			}),
		);

		const messages = markedContinuationMessages();
		await consumeIgnoringNetworkFailure(
			client.chat({
				model: "openai.gpt-5.6-terra",
				protocol: "openai-responses",
				baseUrl: "https://bedrock-mantle.us-east-2.api.aws/openai/v1",
				messages,
				thinkingEffort: "off",
				allowSystemInMessages: true,
				cancellationToken,
			}),
		);

		expect(requestBody?.prompt_cache_options).toEqual({ mode: "explicit", ttl: "30m" });
		expect(requestBody).not.toHaveProperty("prompt_cache_key");
		expect(breakpointPaths(requestBody)).toEqual([]);
		expect(messages[0].providerOptions).toEqual(breakpointProviderOptions);
	});

	it("keeps gpt-oss on Chat Completions with system roles and reasoning_effort", async () => {
		let requestBody: Record<string, unknown> | undefined;
		vi.stubGlobal(
			"fetch",
			vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
				requestBody = JSON.parse(String(init?.body));
				return new Response("data: [DONE]\n\n", {
					status: 200,
					headers: { "content-type": "text/event-stream" },
				});
			}),
		);

		await consumeIgnoringNetworkFailure(
			client.chat({
				model: "openai.gpt-oss-120b",
				protocol: "openai-chat",
				baseUrl: "https://bedrock-mantle.us-east-2.api.aws/v1",
				systemPrompt: "System instruction",
				messages: [{ role: "user", content: "Hello" }],
				maxOutputTokens: 16_384,
				thinkingEffort: "high",
				cancellationToken,
			}),
		);

		expect(requestBody).toMatchObject({
			model: "openai.gpt-oss-120b",
			max_tokens: 16_384,
			reasoning_effort: "high",
			messages: [
				{ role: "system", content: "System instruction" },
				{ role: "user", content: "Hello" },
			],
		});
	});

	it("keeps supported tool-result images native on Responses", async () => {
		let requestBody: { input?: unknown[] } | undefined;
		vi.stubGlobal(
			"fetch",
			vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
				requestBody = JSON.parse(String(init?.body));
				return new Response("data: [DONE]\n\n", {
					status: 200,
					headers: { "content-type": "text/event-stream" },
				});
			}),
		);

		await consumeIgnoringNetworkFailure(
			client.chat({
				model: "openai.gpt-5.5",
				protocol: "openai-responses",
				baseUrl: "https://bedrock-mantle.us-east-2.api.aws/openai/v1",
				supportsImages: true,
				supportsToolResultImages: true,
				messages: [
					{
						role: "assistant",
						content: [
							{
								type: "tool-call",
								toolCallId: "call-1",
								toolName: "render",
								input: {},
							},
						],
					},
					{
						role: "tool",
						content: [
							{
								type: "tool-result",
								toolCallId: "call-1",
								toolName: "render",
								output: {
									type: "content",
									value: [
										{
											type: "image-data",
											data: "aGVsbG8=",
											mediaType: "image/png",
										},
									],
								},
							},
						],
					},
				],
				cancellationToken,
			}),
		);

		expect(requestBody?.input).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					type: "function_call_output",
					output: expect.arrayContaining([
						expect.objectContaining({
							type: "input_image",
							image_url: "data:image/png;base64,aGVsbG8=",
						}),
					]),
				}),
			]),
		);
	});

	it.each([
		["openai.gpt-5.5", "openai-responses", "off", "none"],
		["openai.gpt-5.5", "openai-responses", "low", "low"],
		["openai.gpt-5.5", "openai-responses", "medium", "medium"],
		["openai.gpt-5.5", "openai-responses", "high", "high"],
		["openai.gpt-5.5", "openai-responses", "xhigh", "xhigh"],
		["openai.gpt-oss-120b", "openai-chat", "low", "low"],
		["openai.gpt-oss-120b", "openai-chat", "medium", "medium"],
		["openai.gpt-oss-120b", "openai-chat", "high", "high"],
	] as const)(
		"serializes %s %s effort %s as %s",
		async (model, protocol, thinkingEffort, wireEffort) => {
			let requestBody: { reasoning?: { effort?: string }; reasoning_effort?: string } | undefined;
			vi.stubGlobal(
				"fetch",
				vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
					requestBody = JSON.parse(String(init?.body));
					return new Response("data: [DONE]\n\n", {
						status: 200,
						headers: { "content-type": "text/event-stream" },
					});
				}),
			);

			await consumeIgnoringNetworkFailure(
				client.chat({
					model,
					protocol,
					baseUrl:
						protocol === "openai-responses"
							? "https://bedrock-mantle.us-east-2.api.aws/openai/v1"
							: "https://bedrock-mantle.us-east-2.api.aws/v1",
					messages: [{ role: "user", content: "Hello" }],
					maxOutputTokens: protocol === "openai-chat" ? 16_384 : undefined,
					thinkingEffort,
					cancellationToken,
				}),
			);

			expect(
				protocol === "openai-responses"
					? requestBody?.reasoning?.effort
					: requestBody?.reasoning_effort,
			).toBe(wireEffort);
		},
	);

	it.each([
		[true, true],
		[false, false],
	] as const)(
		"transforms Chat tool-result images when supportsImages=%s",
		async (supportsImages, expectsFollowUpImage) => {
			let requestBody: Record<string, unknown> | undefined;
			vi.stubGlobal(
				"fetch",
				vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
					requestBody = JSON.parse(String(init?.body));
					return new Response("data: [DONE]\n\n", {
						status: 200,
						headers: { "content-type": "text/event-stream" },
					});
				}),
			);

			await consumeIgnoringNetworkFailure(
				client.chat({
					model: "openai.gpt-oss-120b",
					protocol: "openai-chat",
					baseUrl: "https://bedrock-mantle.us-east-2.api.aws/v1",
					supportsImages,
					supportsToolResultImages: false,
					messages: [
						{
							role: "assistant",
							content: [
								{
									type: "tool-call",
									toolCallId: "call-1",
									toolName: "render",
									input: {},
								},
							],
						},
						{
							role: "tool",
							content: [
								{
									type: "tool-result",
									toolCallId: "call-1",
									toolName: "render",
									output: {
										type: "content",
										value: [
											{
												type: "image-data",
												data: "aGVsbG8=",
												mediaType: "image/png",
											},
										],
									},
								},
							],
						},
					],
					maxOutputTokens: 16_384,
					thinkingEffort: "high",
					cancellationToken,
				}),
			);

			const serialized = JSON.stringify(requestBody);
			expect(serialized.includes("data:image/png;base64,aGVsbG8=")).toBe(expectsFollowUpImage);
			expect(serialized).toContain(
				supportsImages ? "Retrieved. Image follows." : "does not support image input",
			);
		},
	);
});
