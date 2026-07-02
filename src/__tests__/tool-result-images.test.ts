/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import type * as ai from "ai";
import { describe, expect, it } from "vitest";

import {
	hasImagesInToolResults,
	transformToolResultImagesForCompletions,
} from "../tool-result-images";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeImageToolResult(
	toolName: string,
	toolCallId: string,
	imageData = "base64-png-data",
	mediaType = "image/png",
): ai.ToolModelMessage {
	return {
		role: "tool",
		content: [
			{
				type: "tool-result",
				toolCallId,
				toolName,
				output: {
					type: "content",
					value: [{ type: "image-data", data: imageData, mediaType }],
				},
			},
		],
	};
}

function makeMixedToolResult(
	toolName: string,
	toolCallId: string,
	textContent: string,
	imageData = "base64-png-data",
	mediaType = "image/png",
): ai.ToolModelMessage {
	return {
		role: "tool",
		content: [
			{
				type: "tool-result",
				toolCallId,
				toolName,
				output: {
					type: "content",
					value: [
						{ type: "text", text: textContent },
						{ type: "image-data", data: imageData, mediaType },
					],
				},
			},
		],
	};
}

function makeTextOnlyToolResult(
	toolName: string,
	toolCallId: string,
	text: string,
): ai.ToolModelMessage {
	return {
		role: "tool",
		content: [
			{
				type: "tool-result",
				toolCallId,
				toolName,
				output: { type: "text", value: text },
			},
		],
	};
}

function makeUserMessage(text: string): ai.UserModelMessage {
	return {
		role: "user",
		content: [{ type: "text", text }],
	};
}

function makeAssistantMessage(text: string): ai.AssistantModelMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
	};
}

/** Collect all image-type content parts from a message array. */
function collectImageParts(
	messages: ai.ModelMessage[],
): Array<{ type: "image"; image: string; mediaType: string }> {
	const images: Array<{ type: "image"; image: string; mediaType: string }> = [];
	for (const msg of messages) {
		if (msg.role === "user" && Array.isArray(msg.content)) {
			for (const part of msg.content) {
				if (typeof part === "object" && "type" in part && part.type === "image") {
					images.push(part as { type: "image"; image: string; mediaType: string });
				}
			}
		}
		if (msg.role === "tool" && Array.isArray(msg.content)) {
			for (const part of msg.content) {
				if (
					typeof part === "object" &&
					"type" in part &&
					part.type === "tool-result" &&
					part.output.type === "content"
				) {
					for (const item of part.output.value) {
						if (item.type === "image-data") {
							images.push({
								type: "image",
								image: (item as { data: string }).data,
								mediaType: (item as { mediaType: string }).mediaType,
							});
						}
					}
				}
			}
		}
	}
	return images;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("hasImagesInToolResults", () => {
	it("returns true when tool results contain images", () => {
		const messages: ai.ModelMessage[] = [makeImageToolResult("executeCode", "call1")];
		expect(hasImagesInToolResults(messages)).toBe(true);
	});

	it("returns false for text-only tool results", () => {
		const messages: ai.ModelMessage[] = [makeTextOnlyToolResult("search", "call1", "results")];
		expect(hasImagesInToolResults(messages)).toBe(false);
	});

	it("returns false for non-tool messages", () => {
		const messages: ai.ModelMessage[] = [makeUserMessage("hello"), makeAssistantMessage("hi")];
		expect(hasImagesInToolResults(messages)).toBe(false);
	});
});

describe("transformToolResultImagesForCompletions", () => {
	describe("supportsImages: true", () => {
		it("moves image from tool result to a follow-up user message", () => {
			const messages: ai.ModelMessage[] = [makeImageToolResult("executeCode", "call1")];
			const result = transformToolResultImagesForCompletions(messages, true);

			// Should have 2 messages: transformed tool result + follow-up user message
			expect(result).toHaveLength(2);

			// Tool result should have placeholder text
			const toolMsg = result[0] as ai.ToolModelMessage;
			expect(toolMsg.role).toBe("tool");
			const toolResult = toolMsg.content[0];
			expect(toolResult.type).toBe("tool-result");
			expect(toolResult.output.type).toBe("text");
			expect(toolResult.output.value).toBe("Retrieved. Image follows.");

			// Follow-up user message should contain the image
			const userMsg = result[1] as ai.UserModelMessage;
			expect(userMsg.role).toBe("user");
			expect(Array.isArray(userMsg.content)).toBe(true);
			const parts = userMsg.content as Array<{ type: string }>;
			expect(parts).toHaveLength(2); // text + image
			expect(parts[0]).toEqual({
				type: "text",
				text: "Here is the image from the executeCode tool:",
			});
			expect(parts[1]).toEqual({
				type: "image",
				image: "base64-png-data",
				mediaType: "image/png",
			});
		});

		it("preserves non-image content alongside placeholder in mixed tool results", () => {
			const messages: ai.ModelMessage[] = [
				makeMixedToolResult("executeCode", "call1", "Some text output"),
			];
			const result = transformToolResultImagesForCompletions(messages, true);

			expect(result).toHaveLength(2);

			// Tool result should keep text and add placeholder
			const toolMsg = result[0] as ai.ToolModelMessage;
			const toolResult = toolMsg.content[0];
			expect(toolResult.output.type).toBe("content");
			if (toolResult.output.type === "content") {
				expect(toolResult.output.value).toHaveLength(2);
				expect(toolResult.output.value[0]).toEqual({ type: "text", text: "Some text output" });
				expect(toolResult.output.value[1]).toEqual({
					type: "text",
					text: "Retrieved. Image follows.",
				});
			}

			// Follow-up should have the image
			const userMsg = result[1] as ai.UserModelMessage;
			expect(userMsg.role).toBe("user");
		});

		it("does not modify messages without tool-result images", () => {
			const messages: ai.ModelMessage[] = [
				makeUserMessage("hello"),
				makeAssistantMessage("hi"),
				makeTextOnlyToolResult("search", "call1", "no images here"),
			];
			const result = transformToolResultImagesForCompletions(messages, true);
			expect(result).toEqual(messages);
		});
	});

	describe("supportsImages: false", () => {
		it("strips images without creating a follow-up user message", () => {
			const messages: ai.ModelMessage[] = [makeImageToolResult("executeCode", "call1")];
			const result = transformToolResultImagesForCompletions(messages, false);

			// Should have only 1 message: the transformed tool result (no follow-up)
			expect(result).toHaveLength(1);

			// Tool result should have explanatory note
			const toolMsg = result[0] as ai.ToolModelMessage;
			const toolResult = toolMsg.content[0];
			expect(toolResult.output.type).toBe("text");
			expect(toolResult.output.value).toContain("does not support image input");
			expect(toolResult.output.value).toContain("executeCode");
		});

		it("produces no image content parts anywhere in the output", () => {
			const messages: ai.ModelMessage[] = [
				makeImageToolResult("executeCode", "call1"),
				makeMixedToolResult("plot", "call2", "Plot data"),
			];
			const result = transformToolResultImagesForCompletions(messages, false);
			const images = collectImageParts(result);
			expect(images).toHaveLength(0);
		});

		it("preserves non-image content alongside explanatory note in mixed results", () => {
			const messages: ai.ModelMessage[] = [
				makeMixedToolResult("executeCode", "call1", "Console output here"),
			];
			const result = transformToolResultImagesForCompletions(messages, false);

			expect(result).toHaveLength(1);

			const toolMsg = result[0] as ai.ToolModelMessage;
			const toolResult = toolMsg.content[0];
			expect(toolResult.output.type).toBe("content");
			if (toolResult.output.type === "content") {
				expect(toolResult.output.value).toHaveLength(2);
				expect(toolResult.output.value[0]).toEqual({
					type: "text",
					text: "Console output here",
				});
				expect(toolResult.output.value[1]).toEqual({
					type: "text",
					text: expect.stringContaining("does not support image input"),
				});
			}
		});

		it("does not modify messages without tool-result images", () => {
			const messages: ai.ModelMessage[] = [
				makeUserMessage("hello"),
				makeAssistantMessage("hi"),
				makeTextOnlyToolResult("search", "call1", "no images here"),
			];
			const result = transformToolResultImagesForCompletions(messages, false);
			expect(result).toEqual(messages);
		});
	});

	describe("multiple tool calls with images in one turn", () => {
		it("supportsImages: true — creates follow-up user messages for each tool message", () => {
			const messages: ai.ModelMessage[] = [
				makeImageToolResult("executeCode", "call1", "img1"),
				makeImageToolResult("plot", "call2", "img2"),
			];
			const result = transformToolResultImagesForCompletions(messages, true);

			// 2 tool messages + 2 follow-up user messages
			expect(result).toHaveLength(4);
			expect(result[0].role).toBe("tool");
			expect(result[1].role).toBe("user");
			expect(result[2].role).toBe("tool");
			expect(result[3].role).toBe("user");

			// Each user message should reference the correct tool
			const user1Content = (result[1] as ai.UserModelMessage).content as Array<{
				type: string;
				text?: string;
			}>;
			expect(user1Content[0].text).toContain("executeCode");

			const user2Content = (result[3] as ai.UserModelMessage).content as Array<{
				type: string;
				text?: string;
			}>;
			expect(user2Content[0].text).toContain("plot");
		});

		it("supportsImages: false — strips all images, no follow-up messages", () => {
			const messages: ai.ModelMessage[] = [
				makeImageToolResult("executeCode", "call1", "img1"),
				makeImageToolResult("plot", "call2", "img2"),
			];
			const result = transformToolResultImagesForCompletions(messages, false);

			// Only the 2 transformed tool messages
			expect(result).toHaveLength(2);
			expect(result.every((m) => m.role === "tool")).toBe(true);

			// No image parts anywhere
			const images = collectImageParts(result);
			expect(images).toHaveLength(0);
		});
	});

	describe("mixed image and text-only tool results in one turn", () => {
		it("supportsImages: true — only creates follow-up for tool results that had images", () => {
			const messages: ai.ModelMessage[] = [
				makeTextOnlyToolResult("search", "call1", "search results"),
				makeImageToolResult("executeCode", "call2"),
				makeTextOnlyToolResult("readFile", "call3", "file contents"),
			];
			const result = transformToolResultImagesForCompletions(messages, true);

			// 3 tool messages + 1 follow-up user message (for executeCode only)
			expect(result).toHaveLength(4);
			expect(result[0].role).toBe("tool");
			expect(result[1].role).toBe("tool"); // executeCode (transformed)
			expect(result[2].role).toBe("user"); // follow-up with image
			expect(result[3].role).toBe("tool"); // readFile (unchanged)
		});

		it("supportsImages: false — text-only tool results are unchanged, image tool results stripped", () => {
			const messages: ai.ModelMessage[] = [
				makeTextOnlyToolResult("search", "call1", "search results"),
				makeImageToolResult("executeCode", "call2"),
				makeTextOnlyToolResult("readFile", "call3", "file contents"),
			];
			const result = transformToolResultImagesForCompletions(messages, false);

			// All 3 tool messages, no follow-ups
			expect(result).toHaveLength(3);
			expect(result.every((m) => m.role === "tool")).toBe(true);

			// First and third are unchanged
			expect(result[0]).toEqual(messages[0]);
			expect(result[2]).toEqual(messages[2]);

			// Second has the explanatory note
			const toolResult = (result[1] as ai.ToolModelMessage).content[0];
			expect(toolResult.output.type).toBe("text");
			expect(toolResult.output.value).toContain("does not support image input");
		});
	});

	describe("no-images no-op case", () => {
		it("supportsImages: true — passes through unchanged", () => {
			const messages: ai.ModelMessage[] = [
				makeUserMessage("hello"),
				makeAssistantMessage("hi"),
				makeTextOnlyToolResult("search", "call1", "results"),
			];
			const result = transformToolResultImagesForCompletions(messages, true);
			expect(result).toEqual(messages);
		});

		it("supportsImages: false — passes through unchanged", () => {
			const messages: ai.ModelMessage[] = [
				makeUserMessage("hello"),
				makeAssistantMessage("hi"),
				makeTextOnlyToolResult("search", "call1", "results"),
			];
			const result = transformToolResultImagesForCompletions(messages, false);
			expect(result).toEqual(messages);
		});
	});
});
