/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, describe, expect, it, vi } from "vitest";

import {
	createRawFetchCapture,
	type RawFetchCapture,
} from "../../../tests/helpers/raw-fetch-capture";
import { createOpenAICompatibleFetch } from "../openai-compat-fetch";

/**
 * Request transform 1 renames `max_tokens` to `max_completion_tokens`, which is
 * right for most OpenAI-compatible surfaces and wrong for at least one.
 * Databricks strict-decodes the Chat Completions body and answers
 * `400 Bad request: json: unknown field "max_completion_tokens"`, so the rename
 * has to be opt-out rather than unconditional.
 */
describe("createOpenAICompatibleFetch — max_tokens rename", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
		vi.restoreAllMocks();
	});

	function mockFetch(): RawFetchCapture {
		const capture = createRawFetchCapture(
			async () => new Response("{}", { headers: { "content-type": "application/json" } }),
		);
		vi.stubGlobal("fetch", capture.mock);
		return capture;
	}

	async function sentBody(
		fetchFn: ReturnType<typeof createOpenAICompatibleFetch>,
		capture: RawFetchCapture,
	) {
		await fetchFn("https://example.invalid/chat/completions", {
			method: "POST",
			body: JSON.stringify({ model: "m", max_tokens: 16384 }),
		});
		const [, init] = capture.single();
		return JSON.parse(init?.body as string);
	}

	it("renames by default, preserving behavior for other providers", async () => {
		const spy = mockFetch();
		const body = await sentBody(createOpenAICompatibleFetch("Test"), spy);

		expect(body.max_completion_tokens).toBe(16384);
		expect(body.max_tokens).toBeUndefined();
	});

	it("keeps max_tokens when the provider opts out", async () => {
		const spy = mockFetch();
		const body = await sentBody(
			createOpenAICompatibleFetch("Databricks", undefined, undefined, { renameMaxTokens: false }),
			spy,
		);

		expect(body.max_tokens).toBe(16384);
		expect(body.max_completion_tokens).toBeUndefined();
	});
});
