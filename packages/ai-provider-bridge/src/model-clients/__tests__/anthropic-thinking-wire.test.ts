/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

/**
 * Final-wire thinking config on the Anthropic Messages route. "off" must send
 * `thinking: {type: "disabled"}`: on models whose default is adaptive thinking
 * (Haiku 5.5, Opus 5), omitting `thinking` leaves thinking on. These run the
 * real `@ai-sdk/anthropic` serializer, so an SDK substitution of the
 * requested thinking mode would also fail here.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
	createRawFetchCapture,
	type RawFetchCapture,
} from "../../../tests/helpers/raw-fetch-capture";
import type { CancellationToken } from "../../types";
import { AnthropicClient } from "../AnthropicClient";

const cancellationToken: CancellationToken = {
	isCancellationRequested: false,
	onCancellationRequested: () => ({ dispose() {} }),
};

let fetchCapture: RawFetchCapture;

beforeEach(() => {
	fetchCapture = createRawFetchCapture(
		async () =>
			new Response("", {
				status: 200,
				headers: { "content-type": "text/event-stream" },
			}),
	);
	vi.stubGlobal("fetch", fetchCapture.mock);
});

afterEach(() => {
	vi.unstubAllGlobals();
});

/** Drive one chat request through the stubbed fetch and return its JSON body. */
async function requestBody(
	model: string,
	thinkingEffort: string | undefined,
): Promise<Record<string, unknown>> {
	try {
		const stream = await new AnthropicClient({ apiKey: "sk-test" }).chat({
			model,
			messages: [{ role: "user", content: "hello" }],
			maxOutputTokens: 1024,
			thinkingEffort,
			cancellationToken,
		});
		for await (const _part of stream) {
			// Drain the (empty) mocked event stream.
		}
	} catch {
		// The mocked stream is empty; only the request body matters.
	}
	const [, init] = fetchCapture.single();
	return JSON.parse(String(init?.body)) as Record<string, unknown>;
}

describe.each(["claude-haiku-5-5", "claude-opus-5", "claude-opus-4-8"])(
	"Anthropic thinking wire for %s",
	(model) => {
		it('sends thinking disabled and no effort for "off"', async () => {
			const body = await requestBody(model, "off");
			expect(body.thinking).toEqual({ type: "disabled" });
			expect(body.output_config).toBeUndefined();
		});

		it("sends summarized adaptive thinking with the effort for an active level", async () => {
			const body = await requestBody(model, "high");
			expect(body.thinking).toEqual({ type: "adaptive", display: "summarized" });
			expect(body.output_config).toEqual({ effort: "high" });
		});

		it("sends no thinking config or effort for the provider default", async () => {
			const body = await requestBody(model, undefined);
			expect(body.thinking).toBeUndefined();
			expect(body.output_config).toBeUndefined();
		});
	},
);
