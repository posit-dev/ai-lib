/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import type { ModelMessage, ProviderMetadata } from "ai";
import { jsonSchema } from "ai";
import { afterEach, describe, expect, it, vi } from "vitest";

const { resolveBedrockTransport } = vi.hoisted(() => ({
	resolveBedrockTransport: vi.fn(async () => ({
		useFipsEndpoint: false,
		runtimeBaseUrl: "https://bedrock-runtime.us-east-2.amazonaws.com",
		mantleEnabled: true,
	})),
}));

vi.mock("../../providers/bedrock-transport", () => ({ resolveBedrockTransport }));

import {
	createRawFetchCapture,
	type RawFetchCapture,
} from "../../../tests/helpers/raw-fetch-capture";
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

function responsesSse(events: Record<string, unknown>[]): string {
	return events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("");
}

function requestBodyAt(capture: RawFetchCapture, index: number): Record<string, unknown> {
	return JSON.parse(String(capture.call(index)[1]?.body));
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
		accessKeyId: "AKIDEXAMPLE",
		secretAccessKey: "secret",
	});

	it("serializes the Responses reasoning contract and remains SigV4-only", async () => {
		let requestBody: Record<string, unknown> | undefined;
		let authorization: string | null = null;
		process.env.AWS_BEARER_TOKEN_BEDROCK = "stale-bearer-token";
		const fetchCapture = createRawFetchCapture(
			async (_input: RequestInfo | URL, init?: RequestInit) => {
				requestBody = JSON.parse(String(init?.body));
				authorization = new Headers(init?.headers).get("authorization");
				return new Response("data: [DONE]\n\n", {
					status: 200,
					headers: { "content-type": "text/event-stream" },
				});
			},
		);
		vi.stubGlobal("fetch", fetchCapture.mock);

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

	it("streams a reasoning summary and replays it with encrypted content", async () => {
		// store: false delivers encrypted_content only on the final output_item.done.
		const sse = responsesSse([
			{ type: "response.created", response: { id: "resp_1", created_at: 1, model: "m" } },
			{
				type: "response.output_item.added",
				output_index: 0,
				item: { type: "reasoning", id: "rs_1", encrypted_content: null, summary: [] },
			},
			{ type: "response.reasoning_summary_part.added", item_id: "rs_1", summary_index: 0 },
			...["**Planning** ", "Check the data first."].map((delta) => ({
				type: "response.reasoning_summary_text.delta",
				item_id: "rs_1",
				summary_index: 0,
				delta,
			})),
			{ type: "response.reasoning_summary_part.done", item_id: "rs_1", summary_index: 0 },
			{
				type: "response.output_item.done",
				output_index: 0,
				item: {
					type: "reasoning",
					id: "rs_1",
					encrypted_content: "enc-rs-1",
					summary: [{ type: "summary_text", text: "**Planning** Check the data first." }],
				},
			},
			{
				type: "response.output_item.added",
				output_index: 1,
				item: { type: "message", id: "msg_1", role: "assistant", content: [] },
			},
			{ type: "response.output_text.delta", item_id: "msg_1", output_index: 1, delta: "Done." },
			{
				type: "response.output_item.done",
				output_index: 1,
				item: {
					type: "message",
					id: "msg_1",
					role: "assistant",
					content: [{ type: "output_text", text: "Done.", annotations: [] }],
				},
			},
			{
				type: "response.completed",
				response: {
					incomplete_details: null,
					usage: {
						input_tokens: 10,
						output_tokens: 20,
						input_tokens_details: { cached_tokens: 0 },
						output_tokens_details: { reasoning_tokens: 12 },
					},
				},
			},
		]);
		const fetchCapture = createRawFetchCapture(
			async () =>
				new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } }),
		);
		vi.stubGlobal("fetch", fetchCapture.mock);

		const request = (messages: ModelMessage[]) =>
			client.chat({
				model: "openai.gpt-6.1-sol",
				protocol: "openai-responses",
				baseUrl: "https://bedrock-mantle.us-east-2.api.aws/openai/v1",
				messages,
				thinkingEffort: "high",
				cancellationToken,
			});

		const drain = async (messages: ModelMessage[]) => {
			const parts = [];
			for await (const part of await request(messages)) {
				parts.push(part);
			}
			return parts;
		};

		const firstTurn: ModelMessage[] = [{ role: "user", content: "Hello" }];
		const parts = await drain(firstTurn);
		expect(requestBodyAt(fetchCapture, 0)).toMatchObject({
			reasoning: { effort: "high", summary: "detailed" },
			include: ["reasoning.encrypted_content"],
		});
		expect(parts.filter((part) => part.type === "error")).toEqual([]);
		expect(parts.map((part) => part.type)).toContain("finish");

		// Accumulate reasoning the way core does: concatenate deltas and merge
		// provider metadata one level deep per provider key.
		let reasoningText = "";
		const reasoningOptions: ProviderMetadata = {};
		for (const part of parts) {
			if (part.type === "reasoning-delta") {
				reasoningText += part.text;
			}
			if (
				part.type === "reasoning-start" ||
				part.type === "reasoning-delta" ||
				part.type === "reasoning-end"
			) {
				for (const [provider, value] of Object.entries(part.providerMetadata ?? {})) {
					reasoningOptions[provider] = { ...reasoningOptions[provider], ...value };
				}
			}
		}
		expect(reasoningText).toBe("**Planning** Check the data first.");

		const replayParts = await drain([
			...firstTurn,
			{
				role: "assistant",
				content: [
					{ type: "reasoning", text: reasoningText, providerOptions: reasoningOptions },
					{ type: "text", text: "Done." },
				],
			},
			{ role: "user", content: "Continue" },
		]);

		expect(replayParts.filter((part) => part.type === "error")).toEqual([]);
		expect(requestBodyAt(fetchCapture, 1).input).toContainEqual({
			type: "reasoning",
			id: "rs_1",
			encrypted_content: "enc-rs-1",
			summary: [{ type: "summary_text", text: "**Planning** Check the data first." }],
		});
	});

	it("serializes GPT-5.6 cache options and a structured tool-result breakpoint", async () => {
		let requestBody: Record<string, unknown> | undefined;
		const fetchCapture = createRawFetchCapture(
			async (_input: RequestInfo | URL, init?: RequestInit) => {
				requestBody = JSON.parse(String(init?.body));
				return new Response("data: [DONE]\n\n", {
					status: 200,
					headers: { "content-type": "text/event-stream" },
				});
			},
		);
		vi.stubGlobal("fetch", fetchCapture.mock);

		const messages = markedContinuationMessages();
		await consumeIgnoringNetworkFailure(
			client.chat({
				model: "openai.gpt-5.6-sol",
				protocol: "openai-responses",
				baseUrl: "https://bedrock-mantle.us-east-2.api.aws/openai/v1",
				messages,
				metadata: { sessionId: "bedrock-conversation-1" },
				usesExplicitPromptCaching: true,
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

	it("bounds an over-long subagent session ID to a stable 64-char cache key", async () => {
		// A subagent's session ID is `rootUUID:subUUID` — 73 chars, over OpenAI's
		// 64-char `prompt_cache_key` limit, which used to 400 the request.
		const sessionId = "3f8b1c2d-4e5a-6b7c-8d9e-0f1a2b3c4d5e:9a8b7c6d-5e4f-3a2b-1c0d-9e8f7a6b5c4d";
		expect(sessionId).toHaveLength(73);

		const capturedKeys: unknown[] = [];
		const fetchCapture = createRawFetchCapture(
			async (_input: RequestInfo | URL, init?: RequestInit) => {
				capturedKeys.push(JSON.parse(String(init?.body)).prompt_cache_key);
				return new Response("data: [DONE]\n\n", {
					status: 200,
					headers: { "content-type": "text/event-stream" },
				});
			},
		);
		vi.stubGlobal("fetch", fetchCapture.mock);

		for (let turn = 0; turn < 2; turn++) {
			await consumeIgnoringNetworkFailure(
				client.chat({
					model: "openai.gpt-5.6-sol",
					protocol: "openai-responses",
					baseUrl: "https://bedrock-mantle.us-east-2.api.aws/openai/v1",
					messages: markedContinuationMessages(),
					metadata: { sessionId },
					usesExplicitPromptCaching: true,
					thinkingEffort: "high",
					allowSystemInMessages: true,
					cancellationToken,
				}),
			);
		}

		expect(typeof capturedKeys[0]).toBe("string");
		expect(String(capturedKeys[0]).length).toBeLessThanOrEqual(64);
		expect(capturedKeys[1]).toBe(capturedKeys[0]);
	});

	it("keeps explicit mode but strips key and markers without session metadata", async () => {
		let requestBody: Record<string, unknown> | undefined;
		const fetchCapture = createRawFetchCapture(
			async (_input: RequestInfo | URL, init?: RequestInit) => {
				requestBody = JSON.parse(String(init?.body));
				return new Response("data: [DONE]\n\n", {
					status: 200,
					headers: { "content-type": "text/event-stream" },
				});
			},
		);
		vi.stubGlobal("fetch", fetchCapture.mock);

		const messages = markedContinuationMessages();
		await consumeIgnoringNetworkFailure(
			client.chat({
				model: "openai.gpt-5.6-terra",
				protocol: "openai-responses",
				baseUrl: "https://bedrock-mantle.us-east-2.api.aws/openai/v1",
				messages,
				usesExplicitPromptCaching: true,
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

	it("vetoes the opt-in on the Chat route: no cache fields, no markers on the wire", async () => {
		let requestBody: Record<string, unknown> | undefined;
		const fetchCapture = createRawFetchCapture(
			async (_input: RequestInfo | URL, init?: RequestInit) => {
				requestBody = JSON.parse(String(init?.body));
				return new Response("data: [DONE]\n\n", {
					status: 200,
					headers: { "content-type": "text/event-stream" },
				});
			},
		);
		vi.stubGlobal("fetch", fetchCapture.mock);

		const messages = markedContinuationMessages();
		await consumeIgnoringNetworkFailure(
			client.chat({
				model: "openai.gpt-5.6-sol",
				protocol: "openai-chat",
				baseUrl: "https://bedrock-mantle.us-east-2.api.aws/v1",
				messages,
				metadata: { sessionId: "bedrock-conversation-1" },
				usesExplicitPromptCaching: true,
				maxOutputTokens: 16_384,
				thinkingEffort: "high",
				allowSystemInMessages: true,
				cancellationToken,
			}),
		);

		expect(requestBody).not.toHaveProperty("prompt_cache_key");
		expect(requestBody).not.toHaveProperty("prompt_cache_options");
		expect(breakpointPaths(requestBody)).toEqual([]);
		expect(messages[0].providerOptions).toEqual(breakpointProviderOptions);
	});

	it("serializes the hosted web_search tool with AWS-only retrieval by default", async () => {
		let requestBody: Record<string, unknown> | undefined;
		const fetchCapture = createRawFetchCapture(
			async (_input: RequestInfo | URL, init?: RequestInit) => {
				requestBody = JSON.parse(String(init?.body));
				return new Response("data: [DONE]\n\n", {
					status: 200,
					headers: { "content-type": "text/event-stream" },
				});
			},
		);
		vi.stubGlobal("fetch", fetchCapture.mock);

		await consumeIgnoringNetworkFailure(
			client.chat({
				model: "openai.gpt-5.6-sol",
				protocol: "openai-responses",
				baseUrl: "https://bedrock-mantle.us-east-2.api.aws/openai/v1",
				messages: [{ role: "user", content: "Hello" }],
				webSearchEnabled: true,
				cancellationToken,
			}),
		);

		// An omitted policy must serialize `false`: AWS defaults an absent
		// `external_web_access` to `true`, which would widen the egress boundary.
		expect(requestBody?.tools).toEqual([{ type: "web_search", external_web_access: false }]);
		expect(requestBody?.include).toContain("web_search_call.action.sources");
		expect(requestBody?.tool_choice).toBe("auto");
	});

	it("serializes external_web_access true when the host policy opts in", async () => {
		let requestBody: Record<string, unknown> | undefined;
		const fetchCapture = createRawFetchCapture(
			async (_input: RequestInfo | URL, init?: RequestInit) => {
				requestBody = JSON.parse(String(init?.body));
				return new Response("data: [DONE]\n\n", {
					status: 200,
					headers: { "content-type": "text/event-stream" },
				});
			},
		);
		vi.stubGlobal("fetch", fetchCapture.mock);

		await consumeIgnoringNetworkFailure(
			client.chat({
				model: "openai.gpt-5.6-sol",
				protocol: "openai-responses",
				baseUrl: "https://bedrock-mantle.us-east-2.api.aws/openai/v1",
				messages: [{ role: "user", content: "Hello" }],
				webSearchEnabled: true,
				bedrockExternalWebAccess: true,
				cancellationToken,
			}),
		);

		expect(requestBody?.tools).toEqual([{ type: "web_search", external_web_access: true }]);
	});

	it("merges the hosted tool alongside a local function tool", async () => {
		let requestBody: Record<string, unknown> | undefined;
		const fetchCapture = createRawFetchCapture(
			async (_input: RequestInfo | URL, init?: RequestInit) => {
				requestBody = JSON.parse(String(init?.body));
				return new Response("data: [DONE]\n\n", {
					status: 200,
					headers: { "content-type": "text/event-stream" },
				});
			},
		);
		vi.stubGlobal("fetch", fetchCapture.mock);

		await consumeIgnoringNetworkFailure(
			client.chat({
				model: "openai.gpt-5.6-sol",
				protocol: "openai-responses",
				baseUrl: "https://bedrock-mantle.us-east-2.api.aws/openai/v1",
				messages: [{ role: "user", content: "Hello" }],
				webSearchEnabled: true,
				tools: {
					lookup: {
						description: "Look up a value",
						inputSchema: jsonSchema({
							type: "object",
							properties: { query: { type: "string" } },
						}),
					},
				},
				cancellationToken,
			}),
		);

		expect(requestBody?.tools).toEqual([
			{
				type: "function",
				name: "lookup",
				description: "Look up a value",
				parameters: { type: "object", properties: { query: { type: "string" } } },
				strict: undefined,
			},
			{ type: "web_search", external_web_access: false },
		]);
	});

	it.each([
		["openai-chat", "https://bedrock-mantle.us-east-2.api.aws/v1"],
		["anthropic-messages", undefined],
		["bedrock-converse", undefined],
		[undefined, undefined],
	] as const)(
		"rejects webSearchEnabled on the %s route before any request",
		async (protocol, baseUrl) => {
			const fetchCapture = createRawFetchCapture(
				async () =>
					new Response("data: [DONE]\n\n", {
						status: 200,
						headers: { "content-type": "text/event-stream" },
					}),
			);
			vi.stubGlobal("fetch", fetchCapture.mock);

			await expect(
				client.chat({
					model:
						protocol === "anthropic-messages" ? "anthropic.claude-sonnet-4-5" : "openai.gpt-5.5",
					...(protocol !== undefined ? { protocol } : {}),
					...(baseUrl !== undefined ? { baseUrl } : {}),
					messages: [{ role: "user", content: "Hello" }],
					webSearchEnabled: true,
					cancellationToken,
				}),
			).rejects.toThrow(/Mantle Responses route/);
			expect(fetchCapture.mock).not.toHaveBeenCalled();
		},
	);

	it("keeps gpt-oss on Chat Completions with system roles and reasoning_effort", async () => {
		let requestBody: Record<string, unknown> | undefined;
		const fetchCapture = createRawFetchCapture(
			async (_input: RequestInfo | URL, init?: RequestInit) => {
				requestBody = JSON.parse(String(init?.body));
				return new Response("data: [DONE]\n\n", {
					status: 200,
					headers: { "content-type": "text/event-stream" },
				});
			},
		);
		vi.stubGlobal("fetch", fetchCapture.mock);

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
		const fetchCapture = createRawFetchCapture(
			async (_input: RequestInfo | URL, init?: RequestInit) => {
				requestBody = JSON.parse(String(init?.body));
				return new Response("data: [DONE]\n\n", {
					status: 200,
					headers: { "content-type": "text/event-stream" },
				});
			},
		);
		vi.stubGlobal("fetch", fetchCapture.mock);

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
		// GPT-6.1 Sol routes through Responses with forced reasoning. Its
		// metadata omits "off", so the client never receives "off" for it;
		// core's turn-setup tests cover that resolution.
		["openai.gpt-6.1-sol", "openai-responses", "low", "low"],
		["openai.gpt-oss-120b", "openai-chat", "low", "low"],
		["openai.gpt-oss-120b", "openai-chat", "medium", "medium"],
		["openai.gpt-oss-120b", "openai-chat", "high", "high"],
	] as const)(
		"serializes %s %s effort %s as %s",
		async (model, protocol, thinkingEffort, wireEffort) => {
			let requestBody: { reasoning?: { effort?: string }; reasoning_effort?: string } | undefined;
			const fetchCapture = createRawFetchCapture(
				async (_input: RequestInfo | URL, init?: RequestInit) => {
					requestBody = JSON.parse(String(init?.body));
					return new Response("data: [DONE]\n\n", {
						status: 200,
						headers: { "content-type": "text/event-stream" },
					});
				},
			);
			vi.stubGlobal("fetch", fetchCapture.mock);

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
			const fetchCapture = createRawFetchCapture(
				async (_input: RequestInfo | URL, init?: RequestInit) => {
					requestBody = JSON.parse(String(init?.body));
					return new Response("data: [DONE]\n\n", {
						status: 200,
						headers: { "content-type": "text/event-stream" },
					});
				},
			);
			vi.stubGlobal("fetch", fetchCapture.mock);

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
