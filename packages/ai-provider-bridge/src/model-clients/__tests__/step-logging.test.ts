/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import type { LanguageModelV4StreamPart } from "@ai-sdk/provider";
import { streamText } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, it, vi } from "vitest";

import type { StepLogData } from "../../StepLogger";
import { stepLoggingOptions } from "../ai-sdk-helpers";

const REQUEST_BODY = { model: "mock", input: "Hello" };

function mockModel() {
	const parts: LanguageModelV4StreamPart[] = [
		{ type: "stream-start", warnings: [] },
		{ type: "text-start", id: "t1" },
		{ type: "text-delta", id: "t1", delta: "Hi" },
		{ type: "text-end", id: "t1" },
		{
			type: "finish",
			finishReason: { unified: "stop", raw: "stop" },
			usage: {
				inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
				outputTokens: { total: 1, text: 1, reasoning: undefined },
			},
		},
	];
	return new MockLanguageModelV4({
		doStream: async () => ({
			request: { body: REQUEST_BODY },
			stream: new ReadableStream<LanguageModelV4StreamPart>({
				start(controller) {
					for (const part of parts) controller.enqueue(part);
					controller.close();
				},
			}),
		}),
	});
}

describe("stepLoggingOptions", () => {
	it("logs the step's request body through streamText", async () => {
		const logged: StepLogData[] = [];
		const logStep = vi.fn(async (data: StepLogData) => {
			logged.push(data);
		});

		const result = streamText({
			model: mockModel(),
			prompt: "Hello",
			...stepLoggingOptions([{ logStep }], "mock", "mock-model"),
		});
		await result.consumeStream();

		expect(logged).toHaveLength(1);
		expect(logged[0].request).toEqual(REQUEST_BODY);
	});

	it("leaves streamText options untouched without loggers", () => {
		expect(stepLoggingOptions([], "mock", "mock-model")).toEqual({});
	});
});
