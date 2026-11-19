/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import type { ModelMessage } from "ai";
import { describe, expect, it } from "vitest";

import type { ChatRequestMetadata } from "../ModelClient";
import { prepareExplicitOpenAIRequest } from "../openai-prompt-caching";

const breakpointProviderOptions = {
	openai: { promptCacheBreakpoint: { mode: "explicit" } },
};

function markedMessages(): ModelMessage[] {
	return [
		{
			role: "system",
			content: "System instruction",
			providerOptions: breakpointProviderOptions,
		},
		{ role: "user", content: "Hello" },
	];
}

function keyFor(sessionId: string | undefined): string | undefined {
	return keyForMetadata({ sessionId });
}

function keyForMetadata(metadata: ChatRequestMetadata | undefined): string | undefined {
	return prepareExplicitOpenAIRequest(markedMessages(), {
		enabled: true,
		apiMode: "responses",
		metadata,
	}).promptCacheKey;
}

describe("prepareExplicitOpenAIRequest cache-key projection", () => {
	it("keys on the cache affinity ID when present, and on the session ID otherwise", () => {
		const shared = "conversation-1";
		expect(keyForMetadata({ sessionId: "conversation-2", cacheAffinityId: shared })).toBe(shared);
		expect(keyForMetadata({ sessionId: shared })).toBe(shared);
		expect(keyForMetadata({ cacheAffinityId: shared })).toBe(shared);
	});

	it("projects a long cache affinity ID like a long session ID", () => {
		const long = "conversation:".repeat(8);
		expect(keyForMetadata({ sessionId: "other", cacheAffinityId: long })).toBe(keyFor(long));
	});

	it("passes a session ID through at exactly the 64-char limit", () => {
		const sessionId = "a".repeat(64);
		expect(keyFor(sessionId)).toBe(sessionId);
	});

	it("projects a longer session ID onto a 64-char key", () => {
		const key = keyFor("a".repeat(65));
		expect(key).not.toBe("a".repeat(65));
		expect(key).toHaveLength(64);
	});

	it("is deterministic and produces different keys for distinct sample IDs", () => {
		const long = "conversation:".repeat(8);
		expect(keyFor(long)).toBe(keyFor(long));
		expect(keyFor(long)).not.toBe(keyFor(`${long}x`));
	});

	it("strips only the breakpoint from an empty tool-output text part on Responses", () => {
		const emptyPartProviderOptions = {
			anthropic: { cacheControl: { type: "ephemeral" } },
			openai: { promptCacheBreakpoint: { mode: "explicit" }, imageDetail: "low" },
		};
		const messages: ModelMessage[] = [
			{
				role: "tool",
				content: [
					{
						type: "tool-result",
						toolCallId: "call-1",
						toolName: "bash",
						output: {
							type: "content",
							value: [{ type: "text", text: "", providerOptions: emptyPartProviderOptions }],
						},
					},
				],
			},
		];

		const prepared = prepareExplicitOpenAIRequest(messages, {
			enabled: true,
			apiMode: "responses",
			metadata: { sessionId: "conversation-1" },
		});

		expect(prepared.messages[0]).toEqual({
			role: "tool",
			content: [
				{
					type: "tool-result",
					toolCallId: "call-1",
					toolName: "bash",
					output: {
						type: "content",
						value: [
							{
								type: "text",
								text: "",
								providerOptions: {
									anthropic: { cacheControl: { type: "ephemeral" } },
									openai: { imageDetail: "low" },
								},
							},
						],
					},
				},
			],
		});
		expect(messages[0]).toMatchObject({
			content: [{ output: { value: [{ providerOptions: emptyPartProviderOptions }] } }],
		});
	});

	it.each([
		["the metadata is absent", { enabled: true, metadata: undefined }],
		["the metadata has no identity", { enabled: true, metadata: { rootConversationId: "c" } }],
		["caching is disabled", { enabled: false, metadata: { sessionId: "conversation-1" } }],
	] as const)("emits no key and strips breakpoints when %s", (_label, options) => {
		const messages = markedMessages();
		const prepared = prepareExplicitOpenAIRequest(messages, {
			...options,
			apiMode: "responses",
		});

		expect(prepared.promptCacheKey).toBeUndefined();
		expect(prepared.messages[0].providerOptions).toBeUndefined();
		// The strip is request-local; caller messages keep their markers.
		expect(messages[0].providerOptions).toEqual(breakpointProviderOptions);
	});
});
