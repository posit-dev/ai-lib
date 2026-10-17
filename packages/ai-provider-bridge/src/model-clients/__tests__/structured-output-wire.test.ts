/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

/**
 * Final-wire structured output (`responseSchema`) behavior: the schema must
 * reach the provider's enforcement mechanism on every wired route, and routes
 * that cannot enforce must fail closed before any request.
 */

import type { ModelMessage } from "ai";
import { describe, expect, it, vi, afterEach } from "vitest";

import { createRawFetchCapture } from "../../../tests/helpers/raw-fetch-capture";
import type { CancellationToken } from "../../types";
import { rejectUnenforceableResponseFormat } from "../ai-sdk-helpers";
import { AnthropicClient } from "../AnthropicClient";
import { DeepSeekClient } from "../DeepSeekClient";
import type { ResponseSchemaSpec } from "../ModelClient";
import { OpenAIClient } from "../OpenAIClient";

const cancellationToken: CancellationToken = {
	isCancellationRequested: false,
	onCancellationRequested: () => ({ dispose() {} }),
};

afterEach(() => {
	vi.unstubAllGlobals();
});

const messages: ModelMessage[] = [{ role: "user", content: "Hello" }];

const responseSchema: ResponseSchemaSpec = {
	name: "classifier_decision",
	schema: {
		type: "object",
		properties: {
			decision: { type: "string", enum: ["allow", "block"] },
			reason: { type: "string" },
		},
		required: ["decision", "reason"],
		additionalProperties: false,
	},
};

/** Drive a request through a stubbed fetch and return the parsed request body. */
async function captureBody(
	chat: (fetchCapture: ReturnType<typeof createRawFetchCapture>) => Promise<unknown>,
): Promise<Record<string, unknown>> {
	const fetchCapture = createRawFetchCapture(
		async () =>
			new Response("data: [DONE]\n\n", {
				status: 200,
				headers: { "content-type": "text/event-stream" },
			}),
	);
	try {
		const stream = (await chat(fetchCapture)) as AsyncIterable<unknown>;
		for await (const _part of stream) {
			// Drain the minimal mocked event stream.
		}
	} catch {
		// The wire body is captured before the intentionally incomplete stream ends.
	}
	const [, init] = fetchCapture.single();
	return JSON.parse(String(init?.body));
}

describe("structured output wire requests", () => {
	it("sends response_format json_schema on the OpenAI Chat Completions route", async () => {
		const client = new OpenAIClient({ apiKey: "sk-test", apiMode: "completions" });
		const body = await captureBody((fetchCapture) => {
			vi.stubGlobal("fetch", fetchCapture.mock);
			return client.chat({ model: "gpt-5.6-sol", messages, responseSchema, cancellationToken });
		});

		expect(body.response_format).toMatchObject({
			type: "json_schema",
			json_schema: {
				name: "classifier_decision",
				schema: responseSchema.schema,
			},
		});
	});

	it("sends text.format json_schema on the OpenAI Responses route", async () => {
		const client = new OpenAIClient({ apiKey: "sk-test", apiMode: "responses" });
		const body = await captureBody((fetchCapture) => {
			vi.stubGlobal("fetch", fetchCapture.mock);
			return client.chat({ model: "gpt-5.6-sol", messages, responseSchema, cancellationToken });
		});

		expect(body.text).toMatchObject({
			format: {
				type: "json_schema",
				name: "classifier_decision",
				schema: responseSchema.schema,
			},
		});
	});

	it("sends no response format when no schema is requested", async () => {
		const client = new OpenAIClient({ apiKey: "sk-test", apiMode: "completions" });
		const body = await captureBody((fetchCapture) => {
			vi.stubGlobal("fetch", fetchCapture.mock);
			return client.chat({ model: "gpt-5.6-sol", messages, cancellationToken });
		});

		expect(body).not.toHaveProperty("response_format");
	});

	it("constrains output on the Anthropic route (native output_config or schema tool)", async () => {
		const body = await captureBody((fetchCapture) => {
			vi.stubGlobal("fetch", fetchCapture.mock);
			return new AnthropicClient({ apiKey: "sk-test" }).chat({
				model: "claude-sonnet-4-5",
				messages,
				responseSchema,
				cancellationToken,
			});
		});

		// The SDK picks the mechanism per model; both put the schema on the wire.
		const serialized = JSON.stringify(body);
		expect(serialized).toContain('"allow"');
		expect(serialized).toContain('"block"');
	});
});

describe("structured output fail-closed", () => {
	it("DeepSeek rejects a response schema before any request", async () => {
		const fetchCapture = createRawFetchCapture(async () => new Response());
		vi.stubGlobal("fetch", fetchCapture.mock);

		await expect(
			new DeepSeekClient("sk-test").chat({
				model: "deepseek-chat",
				messages,
				responseSchema,
				cancellationToken,
			}),
		).rejects.toThrow(/cannot enforce/);
		expect(fetchCapture.mock).not.toHaveBeenCalled();
	});
});

describe("rejectUnenforceableResponseFormat", () => {
	const noopCleanup = () => {};

	it("is a no-op when no schema was requested", async () => {
		await expect(
			rejectUnenforceableResponseFormat(
				{ warnings: Promise.resolve([{ type: "unsupported", feature: "responseFormat" }]) },
				undefined,
				noopCleanup,
			),
		).resolves.toBeUndefined();
	});

	it("ignores warnings for other features", async () => {
		await expect(
			rejectUnenforceableResponseFormat(
				{
					warnings: Promise.resolve([
						{ type: "unsupported", feature: "tools" },
						{ type: "other", message: "something" },
					]),
				},
				responseSchema,
				noopCleanup,
			),
		).resolves.toBeUndefined();
	});

	it("throws on an unsupported responseFormat warning and runs cleanup", async () => {
		const cleanup = vi.fn();
		await expect(
			rejectUnenforceableResponseFormat(
				{
					warnings: Promise.resolve([
						{
							type: "unsupported",
							feature: "responseFormat",
							details: "JSON response format is not supported.",
						},
					]),
				},
				responseSchema,
				cleanup,
			),
		).rejects.toThrow(/cannot enforce.*classifier_decision/);
		expect(cleanup).toHaveBeenCalledOnce();
	});

	it("throws on a compatibility responseFormat warning (schema injected into prompt)", async () => {
		await expect(
			rejectUnenforceableResponseFormat(
				{
					warnings: Promise.resolve([
						{
							type: "compatibility",
							feature: "responseFormat JSON schema",
							details: "JSON response schema is injected into the system message.",
						},
					]),
				},
				responseSchema,
				noopCleanup,
			),
		).rejects.toThrow(/cannot enforce/);
	});
});
