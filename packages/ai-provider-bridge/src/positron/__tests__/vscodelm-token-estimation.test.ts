/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

/**
 * Tests for estimated token usage synthesis in VscodeLmClient and the
 * token-estimation helpers.
 */

import type * as ai from "ai";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as vscode from "vscode";

import type { Logger } from "../../types";

vi.mock("vscode", () => import("./vscode-mock"));

import {
	clearTokenEstimationCache,
	estimateInputTokens,
	serializeMessageForCounting,
} from "../token-estimation";
import { VscodeLmClient } from "../VscodeLmClient";
import * as vscodeMock from "./vscode-mock";

// ============================================================================
// Fakes
// ============================================================================

const testLogger: Logger = {
	info: vi.fn(),
	warn: vi.fn(),
	error: vi.fn(),
	debug: vi.fn(),
	trace: vi.fn(),
};

/** Deterministic token count: 1 token per 4 characters, minimum 1. */
function charCount(text: string): number {
	return Math.max(1, Math.ceil(text.length / 4));
}

interface FakeModelOptions {
	vendor: string;
	id?: string;
	/** Parts the response stream yields, in order. */
	streamParts: unknown[];
	/** Override countTokens behavior (e.g. to reject). */
	countTokens?: (text: string) => Promise<number>;
}

function makeFakeModel(options: FakeModelOptions) {
	const countTokensCalls: string[] = [];
	const fake = {
		id: options.id ?? "fake-model-1",
		vendor: options.vendor,
		name: "Fake Model",
		family: "fake",
		version: "1.0",
		maxInputTokens: 100_000,
		countTokens: vi.fn(async (text: string) => {
			countTokensCalls.push(text);
			if (options.countTokens) {
				return options.countTokens(text);
			}
			return charCount(text);
		}),
		sendRequest: vi.fn(async () => ({
			stream: (async function* () {
				for (const part of options.streamParts) {
					yield part;
				}
			})(),
			text: (async function* () {})(),
		})),
	};
	// The fake implements the runtime surface VscodeLmClient touches; the
	// declared vscode.LanguageModelChat type carries more members than any
	// test double needs, hence the two-step cast.
	return {
		model: fake as unknown as vscode.LanguageModelChat,
		countTokensCalls,
		sendRequest: fake.sendRequest,
	};
}

function userMessage(text: string): ai.ModelMessage {
	return { role: "user", content: [{ type: "text", text }] };
}

async function collectParts(stream: AsyncIterable<unknown>): Promise<Record<string, unknown>[]> {
	const parts: Record<string, unknown>[] = [];
	for await (const part of stream) {
		parts.push(part as Record<string, unknown>);
	}
	return parts;
}

const noopCancellation = {
	isCancellationRequested: false,
	onCancellationRequested: () => ({ dispose: () => {} }),
};

async function runChat(
	model: vscode.LanguageModelChat,
	params?: { messages?: ai.ModelMessage[]; systemPrompt?: string },
): Promise<Record<string, unknown>[]> {
	const client = new VscodeLmClient(model, testLogger);
	const stream = await client.chat({
		model: "fake-model-1",
		messages: params?.messages ?? [userMessage("Hello there")],
		systemPrompt: params?.systemPrompt,
		cancellationToken: noopCancellation,
	});
	return collectParts(stream);
}

function finishSteps(parts: Record<string, unknown>[]): Record<string, unknown>[] {
	return parts.filter((p) => p.type === "finish-step");
}

// ============================================================================
// Tests
// ============================================================================

beforeEach(() => {
	clearTokenEstimationCache();
	vi.clearAllMocks();
});

describe("VscodeLmClient estimated usage synthesis", () => {
	it("synthesizes an estimated finish-step when the stream has no usage data part", async () => {
		const { model } = makeFakeModel({
			vendor: "copilot",
			streamParts: [
				new vscodeMock.LanguageModelTextPart("Hello "),
				new vscodeMock.LanguageModelTextPart("world"),
			],
		});

		const parts = await runChat(model, { systemPrompt: "SYSTEM PROMPT" });
		const finishes = finishSteps(parts);
		expect(finishes).toHaveLength(1);

		const finish = finishes[0];
		const usage = finish.usage as {
			inputTokens: number;
			outputTokens: number;
			totalTokens: number;
		};
		expect(usage.inputTokens).toBeGreaterThan(0);
		expect(usage.outputTokens).toBe(charCount("Hello world"));
		expect(usage.totalTokens).toBe(usage.inputTokens + usage.outputTokens);

		const metadata = finish.providerMetadata as {
			positai?: { usage?: { isEstimated?: boolean } };
		};
		expect(metadata.positai?.usage?.isEstimated).toBe(true);
	});

	it("counts the Copilot system prompt exactly once (via the prepended user message)", async () => {
		const { model, countTokensCalls } = makeFakeModel({
			vendor: "copilot",
			streamParts: [new vscodeMock.LanguageModelTextPart("ok")],
		});

		await runChat(model, { systemPrompt: "UNIQUE_SYSTEM_MARKER" });

		const callsWithMarker = countTokensCalls.filter((text) =>
			text.includes("UNIQUE_SYSTEM_MARKER"),
		);
		// Counted once, inside the serialized prepended user message — never as
		// a bare separate system-parameter count.
		expect(callsWithMarker).toHaveLength(1);
		expect(callsWithMarker[0]).not.toBe("UNIQUE_SYSTEM_MARKER");
	});

	it("counts the system parameter separately for non-copilot vendors", async () => {
		const { model, countTokensCalls } = makeFakeModel({
			vendor: "some-other-vendor",
			streamParts: [new vscodeMock.LanguageModelTextPart("ok")],
		});

		await runChat(model, { systemPrompt: "UNIQUE_SYSTEM_MARKER" });

		expect(countTokensCalls).toContain("UNIQUE_SYSTEM_MARKER");
	});

	it("does not estimate when a real usage data part arrives", async () => {
		const { model, countTokensCalls } = makeFakeModel({
			vendor: "anthropic-api",
			streamParts: [
				new vscodeMock.LanguageModelTextPart("hi"),
				vscodeMock.LanguageModelDataPart.json({
					type: "usage",
					data: { inputTokens: 58, outputTokens: 7, cachedTokens: 30284 },
				}),
			],
		});

		const parts = await runChat(model);
		const finishes = finishSteps(parts);
		expect(finishes).toHaveLength(1);

		const usage = finishes[0].usage as { inputTokens: number; outputTokens: number };
		expect(usage.inputTokens).toBe(58);
		expect(usage.outputTokens).toBe(7);

		const metadata = finishes[0].providerMetadata as
			| { positai?: { usage?: { isEstimated?: boolean } } }
			| undefined;
		expect(metadata?.positai?.usage?.isEstimated).toBeUndefined();

		// The lazy estimation thunk was never invoked.
		expect(countTokensCalls).toHaveLength(0);
	});

	it("memoizes per-message input counts across requests", async () => {
		const streamParts = () => [new vscodeMock.LanguageModelTextPart("out")];
		const first = makeFakeModel({ vendor: "copilot", streamParts: streamParts() });
		await runChat(first.model);
		const firstCallCount = first.countTokensCalls.length;
		expect(firstCallCount).toBeGreaterThan(1);

		// Same model id and messages: input counts come from the module-level
		// cache; only the (uncached) output text is counted again.
		const second = makeFakeModel({ vendor: "copilot", streamParts: streamParts() });
		await runChat(second.model);
		expect(second.countTokensCalls).toHaveLength(1);
		expect(second.countTokensCalls[0]).toBe("out");
	});

	it("marks the synthesized finish-step as tool-calls when the stream emitted a tool call", async () => {
		const { model } = makeFakeModel({
			vendor: "copilot",
			streamParts: [
				new vscodeMock.LanguageModelTextPart("let me check"),
				new vscodeMock.LanguageModelToolCallPart("call-1", "get_weather", {
					location: "SF",
				}),
			],
		});

		const finishes = finishSteps(await runChat(model));
		expect(finishes).toHaveLength(1);
		expect(finishes[0].finishReason).toBe("tool-calls");
		expect(finishes[0].rawFinishReason).toBe("tool-calls");
	});

	it("marks the synthesized finish-step as stop when no tool call was emitted", async () => {
		const { model } = makeFakeModel({
			vendor: "copilot",
			streamParts: [new vscodeMock.LanguageModelTextPart("all done")],
		});

		const finishes = finishSteps(await runChat(model));
		expect(finishes).toHaveLength(1);
		expect(finishes[0].finishReason).toBe("stop");
		expect(finishes[0].rawFinishReason).toBe("stop");
	});

	it("marks the real-usage finish-step as tool-calls when the stream emitted a tool call", async () => {
		const { model } = makeFakeModel({
			vendor: "anthropic-api",
			streamParts: [
				new vscodeMock.LanguageModelToolCallPart("call-1", "get_weather", { location: "SF" }),
				vscodeMock.LanguageModelDataPart.json({
					type: "usage",
					data: { inputTokens: 58, outputTokens: 7, cachedTokens: 0 },
				}),
			],
		});

		const finishes = finishSteps(await runChat(model));
		expect(finishes).toHaveLength(1);
		expect(finishes[0].finishReason).toBe("tool-calls");
		expect(finishes[0].rawFinishReason).toBe("tool-calls");
	});

	it("ends the stream without usage when countTokens fails, without failing the request", async () => {
		const { model } = makeFakeModel({
			vendor: "copilot",
			streamParts: [new vscodeMock.LanguageModelTextPart("hello")],
			countTokens: async () => {
				throw new Error("tokenizer unavailable");
			},
		});

		const parts = await runChat(model);
		expect(parts.some((p) => p.type === "text-delta")).toBe(true);
		expect(finishSteps(parts)).toHaveLength(0);
		expect(testLogger.warn).toHaveBeenCalled();
	});
});

describe("token-estimation helpers", () => {
	it("keys the cache on role, so identical text in different roles is counted separately", async () => {
		const countTokens = vi.fn(async (text: string) => charCount(text));
		const model = { id: "m1", countTokens };

		const asUser = vscodeMock.LanguageModelChatMessage2.User("same text");
		const asAssistant = vscodeMock.LanguageModelChatMessage2.Assistant("same text");

		expect(serializeMessageForCounting(toVscodeMessage(asUser))).not.toBe(
			serializeMessageForCounting(toVscodeMessage(asAssistant)),
		);

		await estimateInputTokens({
			model,
			messages: [toVscodeMessage(asUser), toVscodeMessage(asAssistant)],
			logger: testLogger,
		});
		expect(countTokens).toHaveBeenCalledTimes(2);
	});

	it("includes tool definitions in the input estimate", async () => {
		const countTokens = vi.fn(async (text: string) => charCount(text));
		const model = { id: "m1", countTokens };

		const withoutTools = await estimateInputTokens({
			model,
			messages: [toVscodeMessage(vscodeMock.LanguageModelChatMessage2.User("hi"))],
			logger: testLogger,
		});
		const withTools = await estimateInputTokens({
			model,
			messages: [toVscodeMessage(vscodeMock.LanguageModelChatMessage2.User("hi"))],
			tools: [
				{
					name: "get_weather",
					description: "Get the weather for a location",
					inputSchema: { type: "object", properties: { location: { type: "string" } } },
				},
			],
			logger: testLogger,
		});

		expect(withoutTools).toBeDefined();
		expect(withTools).toBeDefined();
		expect(withTools!).toBeGreaterThan(withoutTools!);
	});
});

/** The mock message class satisfies the runtime shape the serializer walks. */
function toVscodeMessage(
	message: vscodeMock.LanguageModelChatMessage2,
): vscode.LanguageModelChatMessage2 {
	return message as unknown as vscode.LanguageModelChatMessage2;
}
