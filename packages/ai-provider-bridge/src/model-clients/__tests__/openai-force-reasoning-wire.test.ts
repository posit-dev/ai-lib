/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from "vitest";

import { createRawFetchCapture } from "../../../tests/helpers/raw-fetch-capture";
import type { CancellationToken } from "../../types";
import { OpenAIClient } from "../OpenAIClient";

const cancellationToken: CancellationToken = {
	isCancellationRequested: false,
	onCancellationRequested: () => ({ dispose() {} }),
};

async function captureRequest(options: {
	apiMode: "completions" | "responses";
	model: string;
	thinkingEffort: string;
}): Promise<Record<string, unknown>> {
	const fetchCapture = createRawFetchCapture(
		async () =>
			new Response("data: [DONE]\n\n", {
				status: 200,
				headers: { "content-type": "text/event-stream" },
			}),
	);
	const client = new OpenAIClient({
		apiKey: "sk-test",
		apiMode: options.apiMode,
		customFetch: () => fetchCapture.mock,
	});

	const stream = await client.chat({
		model: options.model,
		systemPrompt: "System instruction",
		messages: [{ role: "user", content: "Think about this" }],
		thinkingEffort: options.thinkingEffort,
		maxOutputTokens: 1024,
		cancellationToken,
	});
	for await (const _part of stream) {
		// Drain the minimal mocked event stream.
	}

	const [, init] = fetchCapture.single();
	return JSON.parse(String(init?.body));
}

// `@ai-sdk/openai` only treats `o\d+` / `gpt-5+` IDs as reasoning models; any other ID
// (Qwen, GLM, deployment names, …) drops the requested effort unless forced
// (posit-dev/positron#15967).
describe("OpenAI reasoning serialization for unrecognized model IDs", () => {
	it("sends the requested effort and encrypted-reasoning include on Responses", async () => {
		const requestBody = await captureRequest({
			apiMode: "responses",
			model: "qwen3-235b",
			thinkingEffort: "high",
		});

		expect(requestBody).toMatchObject({
			model: "qwen3-235b",
			store: false,
			reasoning: { effort: "high", summary: "detailed" },
			// Forcing reasoning also switches the system prompt to the developer role.
			input: [{ role: "developer", content: "System instruction" }, { role: "user" }],
		});
		expect(requestBody.include).toEqual(expect.arrayContaining(["reasoning.encrypted_content"]));
	});

	it("sends no reasoning fields on Responses when the effort is off", async () => {
		const requestBody = await captureRequest({
			apiMode: "responses",
			model: "qwen3-235b",
			thinkingEffort: "off",
		});

		expect(requestBody).toMatchObject({ model: "qwen3-235b" });
		expect(requestBody).not.toHaveProperty("reasoning");
		expect(requestBody).not.toHaveProperty("include");
		expect(requestBody).not.toHaveProperty("store");
	});

	// Chat already sends `reasoning_effort` unconditionally; forcing reasoning there would also
	// switch to the `developer` role and `max_completion_tokens`, which many compatible servers
	// reject.
	it("sends the requested effort on Chat Completions without forcing reasoning-model shaping", async () => {
		const requestBody = await captureRequest({
			apiMode: "completions",
			model: "qwen3-235b",
			thinkingEffort: "high",
		});

		expect(requestBody).toMatchObject({
			model: "qwen3-235b",
			reasoning_effort: "high",
			max_tokens: 1024,
			messages: [{ role: "system", content: "System instruction" }, { role: "user" }],
		});
		expect(requestBody).not.toHaveProperty("max_completion_tokens");
	});
});
