/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

/**
 * Raw-wire evidence that the `xhigh` thinking level the Gemini 4 profiles
 * advertise survives @ai-sdk/google's provider-option validation on both
 * APIs. Before 4.0.119 the SDK rejected `xhigh` ("invalid google provider
 * options") without sending a request, so advertising it was a guaranteed
 * failure.
 */

import { createGoogle } from "@ai-sdk/google";
import { streamText, type LanguageModel } from "ai";
import { getGeminiGenerateContentProfile } from "ai-config";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createRawFetchCapture } from "../../../tests/helpers/raw-fetch-capture";
import { buildInteractionsOptions } from "../GeminiClient";
import { buildGenerateContentOptions } from "../GeminiGenerateContentClient";

const MODEL_ID = "gemini-4-neon";

/** Drive one `streamText` request through a stubbed fetch and return the raw body. */
async function captureBody(
	model: LanguageModel,
	providerOptions: Parameters<typeof streamText>[0]["providerOptions"],
): Promise<unknown> {
	const rawFetch = createRawFetchCapture(
		async () => new Response("", { status: 200, headers: { "content-type": "text/event-stream" } }),
	);
	vi.stubGlobal("fetch", rawFetch.mock);
	try {
		const result = streamText({
			model,
			messages: [{ role: "user", content: "hi" }],
			providerOptions,
		});
		for await (const _part of result.stream) {
			// Drain the (empty) mocked event stream.
		}
	} catch {
		// The mocked stream is minimal; only the serialized request matters.
	}
	const [, init] = rawFetch.single();
	return JSON.parse(String(init?.body));
}

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("Gemini 4 xhigh wire serialization", () => {
	it("sends thinking_level xhigh on the Interactions API", async () => {
		const provider = createGoogle({ apiKey: "test-key" });
		const body = await captureBody(
			provider.interactions(MODEL_ID),
			buildInteractionsOptions({
				thinkingEffort: "xhigh",
				modelId: MODEL_ID,
				previousInteractionId: null,
			}),
		);
		expect(body).toMatchObject({ generation_config: { thinking_level: "xhigh" } });
	});

	it("sends thinkingLevel xhigh on generateContent", async () => {
		const profile = getGeminiGenerateContentProfile(MODEL_ID);
		if (!profile) throw new Error(`Expected a generateContent profile for ${MODEL_ID}`);
		const provider = createGoogle({ apiKey: "test-key" });
		const body = await captureBody(
			provider(MODEL_ID),
			buildGenerateContentOptions({ thinkingEffort: "xhigh", profile }),
		);
		expect(body).toMatchObject({
			generationConfig: { thinkingConfig: { thinkingLevel: "xhigh" } },
		});
	});
});
