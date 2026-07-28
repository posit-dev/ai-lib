/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it, vi } from "vitest";

// Capture the options handed to `createOpenAICompatible` so we can exercise
// the `transformRequestBody` hook the client installs for the openai-chat path.
const { streamText, createOpenAICompatible, createAnthropic } = vi.hoisted(() => ({
	streamText: vi.fn(() => ({ fullStream: {} })),
	createOpenAICompatible: vi.fn(() => {
		const provider = { chatModel: vi.fn(() => ({})) };
		return provider;
	}),
	createAnthropic: vi.fn(() => vi.fn(() => ({}))),
}));

vi.mock("ai", () => ({ streamText }));
vi.mock("@ai-sdk/openai-compatible", () => ({ createOpenAICompatible }));
vi.mock("@ai-sdk/anthropic", () => ({ createAnthropic }));
vi.mock("../ai-sdk-helpers", () => ({
	convertAiSdkStreamToPlatform: vi.fn(() => (async function* () {})()),
	createAbortControllerFromToken: vi.fn(() => ({
		abortController: new AbortController(),
		cleanup: vi.fn(),
	})),
	createStepLogger: vi.fn(() => undefined),
}));

import type { CancellationToken, Logger } from "../../types";
import { PositAiClient } from "../PositAiClient";

const cancellationToken: CancellationToken = {
	isCancellationRequested: false,
	onCancellationRequested: () => ({ dispose() {} }),
};

const logger: Logger = {
	trace: () => {},
	debug: () => {},
	info: () => {},
	warn: () => {},
	error: () => {},
};

/** A request body as the AI SDK would produce it, with a `$ref` tool schema. */
function bodyWithRefTool(): Record<string, unknown> {
	return {
		model: "moonshotai/Kimi-K2.7-Code",
		messages: [{ role: "user", content: "hi" }],
		tools: [
			{
				type: "function",
				function: {
					name: "positronCommand",
					description: "Run a command.",
					parameters: {
						type: "object",
						properties: {
							args: { type: "array", items: { $ref: "#/definitions/json" } },
						},
						definitions: {
							json: {
								anyOf: [
									{ type: "string" },
									{ type: "array", items: { $ref: "#/definitions/json" } },
								],
							},
						},
					},
				},
			},
		],
	};
}

async function chatAndGetTransform(thinkingEffort?: string) {
	const client = new PositAiClient("token", "https://gateway.example.com", "test-agent", logger);
	await client.chat({
		model: "moonshotai/Kimi-K2.7-Code",
		messages: [],
		cancellationToken,
		protocol: "openai-chat",
		thinkingEffort,
		requiresChatTemplateKwargs: true,
	});
	const options = createOpenAICompatible.mock.calls.at(-1)?.[0] as
		| { transformRequestBody?: (body: Record<string, unknown>) => Record<string, unknown> }
		| undefined;
	return options?.transformRequestBody;
}

describe("PositAiClient openai-chat tool schemas", () => {
	it("dereferences $ref tool schemas when thinking is off", async () => {
		const transform = await chatAndGetTransform();
		expect(transform).toBeDefined();
		const out = transform!(bodyWithRefTool());
		expect(JSON.stringify(out)).not.toContain("$ref");
		expect(out.chat_template_kwargs).toBeUndefined();
	});

	it("dereferences $ref tool schemas and adds chat_template_kwargs when thinking is on", async () => {
		const transform = await chatAndGetTransform("on");
		expect(transform).toBeDefined();
		const out = transform!(bodyWithRefTool());
		expect(JSON.stringify(out)).not.toContain("$ref");
		expect(out.chat_template_kwargs).toEqual({ enable_thinking: true });
	});
});
