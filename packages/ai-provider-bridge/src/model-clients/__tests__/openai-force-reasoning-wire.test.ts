/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from "vitest";

import { createRawFetchCapture } from "../../../tests/helpers/raw-fetch-capture";
import type { CancellationToken, Protocol } from "../../types";
import { OpenAIClient } from "../OpenAIClient";

const cancellationToken: CancellationToken = {
	isCancellationRequested: false,
	onCancellationRequested: () => ({ dispose() {} }),
};

async function captureRequest(options: {
	apiMode: "completions" | "responses";
	/** Per-request protocol; when set it overrides the constructor `apiMode`. */
	protocol?: Protocol;
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
		protocol: options.protocol,
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

function expectForcedResponsesReasoning(requestBody: Record<string, unknown>): void {
	expect(requestBody).toMatchObject({
		model: "qwen3-235b",
		store: false,
		reasoning: { effort: "high", summary: "detailed" },
		// Forcing reasoning also switches the system prompt to the developer role.
		input: [{ role: "developer", content: "System instruction" }, { role: "user" }],
	});
	expect(requestBody.include).toEqual(expect.arrayContaining(["reasoning.encrypted_content"]));
}

function expectConservativeChatShape(requestBody: Record<string, unknown>): void {
	expect(requestBody).toMatchObject({
		model: "qwen3-235b",
		reasoning_effort: "high",
		max_tokens: 1024,
		messages: [{ role: "system", content: "System instruction" }, { role: "user" }],
	});
	expect(requestBody).not.toHaveProperty("max_completion_tokens");
}

// On Responses, `@ai-sdk/openai` only treats `o\d+` / `gpt-5+` IDs as reasoning models; any
// other ID (Qwen, GLM, deployment names, …) drops `reasoning` and the encrypted-content include
// unless forced (posit-dev/positron#15967).
describe("OpenAI reasoning serialization for unrecognized model IDs", () => {
	it("sends the requested effort and encrypted-reasoning include on Responses", async () => {
		expectForcedResponsesReasoning(
			await captureRequest({ apiMode: "responses", model: "qwen3-235b", thinkingEffort: "high" }),
		);
	});

	// Gateways like LiteLLM construct one Chat-mode client and select Responses per request.
	it("forces reasoning when the request protocol selects Responses over a Chat-mode client", async () => {
		expectForcedResponsesReasoning(
			await captureRequest({
				apiMode: "completions",
				protocol: "openai-responses",
				model: "qwen3-235b",
				thinkingEffort: "high",
			}),
		);
	});

	// Databricks' unified MLflow Responses route serves non-OpenAI families (Qwen, Llama).
	it("forces reasoning on the Databricks MLflow Responses protocol", async () => {
		expectForcedResponsesReasoning(
			await captureRequest({
				apiMode: "completions",
				protocol: "mlflow-responses",
				model: "qwen3-235b",
				thinkingEffort: "high",
			}),
		);
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
		expectConservativeChatShape(
			await captureRequest({ apiMode: "completions", model: "qwen3-235b", thinkingEffort: "high" }),
		);
	});

	it("keeps Chat shaping when the request protocol selects Chat over a Responses-mode client", async () => {
		expectConservativeChatShape(
			await captureRequest({
				apiMode: "responses",
				protocol: "openai-chat",
				model: "qwen3-235b",
				thinkingEffort: "high",
			}),
		);
	});
});
