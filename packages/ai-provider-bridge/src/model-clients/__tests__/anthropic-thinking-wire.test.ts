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
import { THINKING_BINDING_BETA, type ThinkingBlockBinding } from "../../utils";
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

/** Drive one chat request through the stubbed fetch and return its JSON body and betas. */
async function wireRequest(
	model: string,
	thinkingEffort: string | undefined,
	thinkingBlockBinding?: ThinkingBlockBinding,
): Promise<{ body: Record<string, unknown>; betas: string[] }> {
	try {
		const stream = await new AnthropicClient({ apiKey: "sk-test" }).chat({
			model,
			messages: [{ role: "user", content: "hello" }],
			maxOutputTokens: 1024,
			thinkingEffort,
			thinkingBlockBinding,
			cancellationToken,
		});
		for await (const _part of stream) {
			// Drain the (empty) mocked event stream.
		}
	} catch {
		// The mocked stream is empty; only the request body matters.
	}
	const [, init] = fetchCapture.single();
	const beta = new Headers(init?.headers).get("anthropic-beta");
	return {
		body: JSON.parse(String(init?.body)) as Record<string, unknown>,
		betas: beta ? beta.split(",") : [],
	};
}

async function requestBody(
	model: string,
	thinkingEffort: string | undefined,
): Promise<Record<string, unknown>> {
	return (await wireRequest(model, thinkingEffort)).body;
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

/**
 * Block binding on the final wire: `error`/`drop_block` set the body field (and
 * the SDK adds the beta), `header-only` sends only the beta, and nothing binds
 * unless thinking is adaptive.
 */
describe("Anthropic thinking block binding wire", () => {
	const model = "claude-haiku-5-5";

	it.each(["error", "drop_block"] as const)(
		"sends block_binding %s and the beta with adaptive thinking",
		async (binding) => {
			const { body, betas } = await wireRequest(model, "high", binding);
			expect(body.thinking).toEqual({
				type: "adaptive",
				display: "summarized",
				block_binding: { prefix_mismatch_behavior: binding },
			});
			expect(betas).toContain(THINKING_BINDING_BETA);
		},
	);

	it("sends only the beta for header-only", async () => {
		const { body, betas } = await wireRequest(model, "high", "header-only");
		expect(body.thinking).toEqual({ type: "adaptive", display: "summarized" });
		expect(betas).toContain(THINKING_BINDING_BETA);
	});

	it("sends neither without a policy", async () => {
		const { body, betas } = await wireRequest(model, "high", undefined);
		expect(body.thinking).toEqual({ type: "adaptive", display: "summarized" });
		expect(betas).not.toContain(THINKING_BINDING_BETA);
	});

	it.each(["error", "drop_block", "header-only"] as const)(
		"binds nothing for %s when thinking is off",
		async (binding) => {
			const { body, betas } = await wireRequest(model, "off", binding);
			expect(body.thinking).toEqual({ type: "disabled" });
			expect(betas).not.toContain(THINKING_BINDING_BETA);
		},
	);

	it.each(["error", "drop_block", "header-only"] as const)(
		"binds nothing for %s with the provider-default effort",
		async (binding) => {
			const { body, betas } = await wireRequest(model, undefined, binding);
			expect(body.thinking).toBeUndefined();
			expect(betas).not.toContain(THINKING_BINDING_BETA);
		},
	);
});
