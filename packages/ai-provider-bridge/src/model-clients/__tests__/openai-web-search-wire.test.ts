/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import type { ModelMessage } from "ai";
import { jsonSchema } from "ai";
import { describe, expect, it } from "vitest";

import { createRawFetchCapture } from "../../../tests/helpers/raw-fetch-capture";
import type { AiToolWithJsonSchema, CancellationToken } from "../../types";
import { OpenAIClient } from "../OpenAIClient";

const cancellationToken: CancellationToken = {
	isCancellationRequested: false,
	onCancellationRequested: () => ({ dispose() {} }),
};

const messages: ModelMessage[] = [{ role: "user", content: "Hello" }];

function localFunctionTool(): AiToolWithJsonSchema {
	return {
		description: "Look up a value",
		inputSchema: jsonSchema({
			type: "object",
			properties: { query: { type: "string" } },
		}),
	};
}

interface CaptureOptions {
	apiMode?: "completions" | "responses";
	protocol?: "openai-chat" | "openai-responses";
	webSearchEnabled?: boolean;
	tools?: Record<string, AiToolWithJsonSchema>;
}

/**
 * Drive a chat request through a raw-fetch capture and return the parsed
 * request body. The stream is intentionally incomplete; the body is captured
 * before it ends.
 */
async function captureRequest(options: CaptureOptions): Promise<Record<string, unknown>> {
	const fetchCapture = createRawFetchCapture(
		async () =>
			new Response("data: [DONE]\n\n", {
				status: 200,
				headers: { "content-type": "text/event-stream" },
			}),
	);
	const client = new OpenAIClient({
		apiKey: "sk-test",
		apiMode: options.apiMode ?? "responses",
		customFetch: () => fetchCapture.mock,
	});

	try {
		const stream = await client.chat({
			model: "gpt-5.6-sol",
			protocol: options.protocol,
			messages,
			webSearchEnabled: options.webSearchEnabled,
			tools: options.tools,
			cancellationToken,
		});
		for await (const _part of stream) {
			// Drain the minimal mocked event stream.
		}
	} catch {
		// The wire body is captured before the intentionally incomplete stream ends.
	}

	const [, init] = fetchCapture.single();
	return JSON.parse(String(init?.body));
}

describe("OpenAI web search wire requests", () => {
	it("serializes the hosted web_search tool with OpenAI default options", async () => {
		const requestBody = await captureRequest({ webSearchEnabled: true });

		expect(requestBody.tools).toEqual([{ type: "web_search" }]);
		// OpenAI defaults apply: no explicit external_web_access, no filters.
		expect(JSON.stringify(requestBody.tools)).not.toContain("external_web_access");
		// The SDK recognized the hosted tool and asked for its sources.
		expect(requestBody.include).toContain("web_search_call.action.sources");
		expect(requestBody.tool_choice).toBe("auto");
	});

	it("omits the tool entirely when search is disabled", async () => {
		const requestBody = await captureRequest({ webSearchEnabled: false });

		expect(requestBody).not.toHaveProperty("tools");
		expect(requestBody).not.toHaveProperty("tool_choice");
	});

	it("merges the hosted tool alongside a local function tool", async () => {
		const requestBody = await captureRequest({
			webSearchEnabled: true,
			tools: { lookup: localFunctionTool() },
		});

		expect(requestBody.tools).toEqual([
			{
				type: "function",
				name: "lookup",
				description: "Look up a value",
				parameters: { type: "object", properties: { query: { type: "string" } } },
				strict: undefined,
			},
			{ type: "web_search" },
		]);
	});

	it("keeps a local-only toolset when search is disabled", async () => {
		const requestBody = await captureRequest({
			webSearchEnabled: false,
			tools: { lookup: localFunctionTool() },
		});

		expect(requestBody.tools).toHaveLength(1);
		expect(JSON.stringify(requestBody.tools)).not.toContain("web_search");
	});

	it.each([
		["constructor default", { apiMode: "completions" as const }],
		["per-request protocol", { protocol: "openai-chat" as const }],
	])(
		"rejects webSearchEnabled on the Chat Completions route (%s) before any request",
		async (_name, route) => {
			const fetchCapture = createRawFetchCapture(async () => new Response());
			const client = new OpenAIClient({
				apiKey: "sk-test",
				apiMode: route.apiMode ?? "responses",
				customFetch: () => fetchCapture.mock,
			});

			await expect(
				client.chat({
					model: "gpt-5.6-sol",
					protocol: route.protocol,
					messages,
					webSearchEnabled: true,
					cancellationToken,
				}),
			).rejects.toThrow(/Responses API/);
			expect(fetchCapture.mock).not.toHaveBeenCalled();
		},
	);

	it("rejects webSearchEnabled on the MLflow Responses route before any request", async () => {
		// Databricks' MLflow route shares the Responses wire shape but not
		// OpenAI's hosted web_search tool.
		const fetchCapture = createRawFetchCapture(async () => new Response());
		const client = new OpenAIClient({
			apiKey: "sk-test",
			apiMode: "responses",
			customFetch: () => fetchCapture.mock,
		});

		await expect(
			client.chat({
				model: "gpt-5.6-sol",
				protocol: "mlflow-responses",
				messages,
				webSearchEnabled: true,
				cancellationToken,
			}),
		).rejects.toThrow(/MLflow/);
		expect(fetchCapture.mock).not.toHaveBeenCalled();
	});

	it("rejects a local tool occupying the reserved web_search key", async () => {
		const fetchCapture = createRawFetchCapture(async () => new Response());
		const client = new OpenAIClient({
			apiKey: "sk-test",
			apiMode: "responses",
			customFetch: () => fetchCapture.mock,
		});

		await expect(
			client.chat({
				model: "gpt-5.6-sol",
				messages,
				webSearchEnabled: true,
				tools: { web_search: localFunctionTool() },
				cancellationToken,
			}),
		).rejects.toThrow(/local tool named "web_search"/);
		expect(fetchCapture.mock).not.toHaveBeenCalled();
	});
});
