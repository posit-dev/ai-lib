/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

/**
 * SDK-level raw-wire evidence for Google Search grounding on the Interactions
 * API: passing `{ google_search: provider.tools.googleSearch({}) }` to
 * `streamText` must serialize onto the wire as a `tools` **array** entry
 * `{ type: "google_search" }` (the keyed JavaScript toolset is not the REST
 * body).
 *
 * Two shapes matter, because the SDK drops `tool_choice` when the resolved
 * tool list contains no `function` tools (the Interactions API rejects
 * `tool_choice` without function declarations):
 *
 * - search-only: `tools: [{ type: "google_search" }]`, no `tool_choice`
 * - search + local function tool: both entries present, `tool_choice` kept
 */

import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { jsonSchema, streamText, tool } from "ai";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createRawFetchCapture } from "../../../tests/helpers/raw-fetch-capture";

interface CapturedBody {
	tools?: Array<Record<string, unknown>>;
	generation_config?: { tool_choice?: unknown };
	[key: string]: unknown;
}

/** Drive one `streamText` request through a stubbed fetch and return the body. */
async function captureRequestBody(
	tools: Parameters<typeof streamText>[0]["tools"],
	toolChoice?: "auto",
): Promise<{
	url: string;
	body: CapturedBody;
}> {
	const rawFetch = createRawFetchCapture(
		async () =>
			new Response("", {
				status: 200,
				headers: { "content-type": "text/event-stream" },
			}),
	);
	vi.stubGlobal("fetch", rawFetch.mock);

	const provider = createGoogleGenerativeAI({ apiKey: "test-key" });

	try {
		const result = streamText({
			model: provider.interactions("gemini-3.8-flash"),
			messages: [{ role: "user", content: "What is the weather in Paris today?" }],
			tools,
			// GeminiClient sends toolChoice: "auto" whenever tools are present.
			...(toolChoice !== undefined && { toolChoice }),
		});
		for await (const _part of result.fullStream) {
			// Drain the (empty) mocked event stream.
		}
	} catch {
		// The mocked stream is minimal; stream errors are fine — we only care
		// about the serialized request.
	}

	const [input, init] = rawFetch.single();
	return {
		url: String(input),
		body: JSON.parse(String(init?.body)) as CapturedBody,
	};
}

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("Google Search grounding wire serialization (Interactions API)", () => {
	it("serializes a search-only request as tools: [{ type: 'google_search' }] with no tool_choice", async () => {
		const provider = createGoogleGenerativeAI({ apiKey: "test-key" });
		const { url, body } = await captureRequestBody({
			google_search: provider.tools.googleSearch({}),
		});

		expect(url).toContain("/v1beta/interactions");
		expect(body.tools).toEqual([{ type: "google_search" }]);
		// The Interactions API rejects tool_choice without function
		// declarations, so the SDK must omit it on a search-only request.
		expect(body.generation_config?.tool_choice).toBeUndefined();
	});

	it("keeps tool_choice and both tool entries when a local function tool accompanies search", async () => {
		const provider = createGoogleGenerativeAI({ apiKey: "test-key" });
		const localTool = tool({
			description: "Get the current weather in a city",
			inputSchema: jsonSchema({
				type: "object",
				properties: { city: { type: "string" } },
				required: ["city"],
			}),
		});
		const { body } = await captureRequestBody(
			{
				get_weather: localTool,
				google_search: provider.tools.googleSearch({}),
			},
			"auto",
		);

		expect(body.tools).toHaveLength(2);
		expect(body.tools).toContainEqual({ type: "google_search" });
		expect(body.tools).toContainEqual(
			expect.objectContaining({ type: "function", name: "get_weather" }),
		);
		// With a function tool present, tool_choice survives onto the wire.
		expect(body.generation_config?.tool_choice).toBe("auto");
	});
});
