/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import type * as ai from "ai";
import { describe, expect, it, vi } from "vitest";

import { sanitizeToolCallIdsForAnthropic } from "../tool-call-ids";
import type { Logger } from "../types";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function assistantWithToolCalls(...ids: string[]): ai.AssistantModelMessage {
	return {
		role: "assistant",
		content: ids.map((id, i) => ({
			type: "tool-call" as const,
			toolCallId: id,
			toolName: `tool${i}`,
			input: {},
		})),
	};
}

function toolResults(...ids: string[]): ai.ToolModelMessage {
	return {
		role: "tool",
		content: ids.map((id, i) => ({
			type: "tool-result" as const,
			toolCallId: id,
			toolName: `tool${i}`,
			output: { type: "text" as const, value: "ok" },
		})),
	};
}

function makeLogger(): Logger & { warn: ReturnType<typeof vi.fn> } {
	return {
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
		debug: vi.fn(),
		trace: vi.fn(),
	};
}

function allToolCallIds(messages: ai.ModelMessage[]): string[] {
	const ids: string[] = [];
	for (const message of messages) {
		if (typeof message.content === "string") continue;
		for (const part of message.content) {
			if (part.type === "tool-call" || part.type === "tool-result") {
				ids.push(part.toolCallId);
			}
		}
	}
	return ids;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("sanitizeToolCallIdsForAnthropic", () => {
	it("returns the input array by reference when all IDs conform (no-op)", () => {
		const messages: ai.ModelMessage[] = [
			{ role: "user", content: "hi" },
			assistantWithToolCalls("call_abc123", "toolu_01X-y_Z"),
			toolResults("call_abc123", "toolu_01X-y_Z"),
		];

		const result = sanitizeToolCallIdsForAnthropic(messages);

		expect(result).toBe(messages);
		expect(allToolCallIds(result)).toEqual([
			"call_abc123",
			"toolu_01X-y_Z",
			"call_abc123",
			"toolu_01X-y_Z",
		]);
	});

	it("rewrites non-conforming IDs deterministically with the message index", () => {
		// Kimi K3 format: `<toolName>:<counter>` — the colon violates the pattern.
		const messages: ai.ModelMessage[] = [
			{ role: "user", content: "what's here?" },
			assistantWithToolCalls("ls:0"),
			toolResults("ls:0"),
		];

		const result = sanitizeToolCallIdsForAnthropic(messages);

		expect(result).not.toBe(messages);
		// Call at index 1 → ls-0-1; result at index 2 pairs positionally via 2-1.
		expect(allToolCallIds(result)).toEqual(["ls-0-1", "ls-0-1"]);
	});

	it("gives cross-turn duplicate originals distinct IDs (Kimi counter resets per turn)", () => {
		const messages: ai.ModelMessage[] = [
			assistantWithToolCalls("ls:0"),
			toolResults("ls:0"),
			{ role: "user", content: "and now?" },
			assistantWithToolCalls("ls:0"),
			toolResults("ls:0"),
		];

		const result = sanitizeToolCallIdsForAnthropic(messages);

		expect(allToolCallIds(result)).toEqual(["ls-0-0", "ls-0-0", "ls-0-3", "ls-0-3"]);
		// Unique per request across assistant messages
		const callIds = allToolCallIds(result).filter((_, i) => i !== 1 && i !== 3);
		expect(new Set(callIds).size).toBe(callIds.length);
	});

	it("handles same-turn parallel calls (ls:0 + ls:1 in one message)", () => {
		const messages: ai.ModelMessage[] = [
			assistantWithToolCalls("ls:0", "ls:1"),
			toolResults("ls:0", "ls:1"),
		];

		const result = sanitizeToolCallIdsForAnthropic(messages);

		expect(allToolCallIds(result)).toEqual(["ls-0-0", "ls-1-0", "ls-0-0", "ls-1-0"]);
	});

	it("suffixes conforming but duplicate IDs via the seen set", () => {
		const messages: ai.ModelMessage[] = [
			assistantWithToolCalls("call_1"),
			toolResults("call_1"),
			assistantWithToolCalls("call_1"),
			toolResults("call_1"),
		];

		const result = sanitizeToolCallIdsForAnthropic(messages);

		expect(allToolCallIds(result)).toEqual(["call_1", "call_1", "call_1-2", "call_1-2"]);
	});

	it("falls back to `call-<i>` for empty IDs", () => {
		const messages: ai.ModelMessage[] = [assistantWithToolCalls(""), toolResults("")];

		const result = sanitizeToolCallIdsForAnthropic(messages);

		expect(allToolCallIds(result)).toEqual(["call-0", "call-0"]);
	});

	it("rewrites provider-executed tool-results in assistant messages using their own index", () => {
		const assistant: ai.AssistantModelMessage = {
			role: "assistant",
			content: [
				{
					type: "tool-call",
					toolCallId: "search:0",
					toolName: "web_search",
					input: {},
					providerExecuted: true,
				},
				{
					type: "tool-result",
					toolCallId: "search:0",
					toolName: "web_search",
					output: { type: "text", value: "results" },
				},
			],
		};
		const messages: ai.ModelMessage[] = [{ role: "user", content: "go" }, assistant];

		const result = sanitizeToolCallIdsForAnthropic(messages);

		expect(allToolCallIds(result)).toEqual(["search-0-1", "search-0-1"]);
	});

	it("logs a warning for each non-conforming ID", () => {
		const logger = makeLogger();
		const messages: ai.ModelMessage[] = [assistantWithToolCalls("ls:0"), toolResults("ls:0")];

		sanitizeToolCallIdsForAnthropic(messages, logger);

		expect(logger.warn).toHaveBeenCalled();
		expect(logger.warn.mock.calls.flat().join(" ")).toContain("ls:0");
	});

	it("warns on orphan tool-results with no matching call in the preceding message", () => {
		const logger = makeLogger();
		const messages: ai.ModelMessage[] = [{ role: "user", content: "hi" }, toolResults("ls:0")];

		sanitizeToolCallIdsForAnthropic(messages, logger);

		expect(logger.warn.mock.calls.flat().join(" ")).toContain("Orphan tool-result");
	});

	it("warns on same-message base collisions between different originals", () => {
		const logger = makeLogger();
		// `ls:0` and `ls/0` both sanitize to base `ls-0` in the same message.
		const messages: ai.ModelMessage[] = [assistantWithToolCalls("ls:0", "ls/0")];

		sanitizeToolCallIdsForAnthropic(messages, logger);

		expect(logger.warn.mock.calls.flat().join(" ")).toContain("collision");
	});

	it("passes server-minted `srvtoolu_` IDs through untouched when the result lands in a later assistant message", () => {
		// Observed on the wire (Posit AI Pass, Opus 5 + web search): web_search
		// is provider-executed, and the AI SDK places the call in one assistant
		// message and its result in the *next* assistant message. Anthropic
		// validates these IDs against `^srvtoolu_[a-zA-Z0-9_]+$`, so any
		// duplicate-suffixing breaks the request with a 400.
		const serverId = "srvtoolu_01NbdBmHttmKrT7PeoMS19nH";
		const messages: ai.ModelMessage[] = [
			{ role: "user", content: "search for pricing" },
			assistantWithToolCalls("toolu_01BbAey45cCT9SBNRQ1qcc22", serverId),
			toolResults("toolu_01BbAey45cCT9SBNRQ1qcc22"),
			{
				role: "assistant",
				content: [
					{
						type: "tool-result" as const,
						toolCallId: serverId,
						toolName: "web_search",
						output: { type: "text" as const, value: "results" },
					},
					{
						type: "tool-call" as const,
						toolCallId: "toolu_018x2fkqPC424Z2tUAP8Mi7k",
						toolName: "tool0",
						input: {},
					},
				],
			},
		];

		const result = sanitizeToolCallIdsForAnthropic(messages);

		expect(result).toBe(messages);
		expect(allToolCallIds(result).filter((id) => id === serverId)).toHaveLength(2);
	});

	it("produces only pattern-conforming IDs for a mixed history", () => {
		const pattern = /^[a-zA-Z0-9_-]+$/;
		const messages: ai.ModelMessage[] = [
			assistantWithToolCalls("ls:0", "read file/1"),
			toolResults("ls:0", "read file/1"),
			assistantWithToolCalls("call_ok"),
			toolResults("call_ok"),
		];

		const result = sanitizeToolCallIdsForAnthropic(messages);

		for (const id of allToolCallIds(result)) {
			expect(id).toMatch(pattern);
		}
	});
});
