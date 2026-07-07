/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

/**
 * Utilities for handling images in tool results for Chat Completions API compatibility.
 *
 * The OpenAI Chat Completions API (and OpenAI-compatible providers like Snowflake, OpenRouter)
 * don't support images in tool results - only in user messages. This module provides utilities
 * to transform messages so images are moved from tool results to user messages.
 */

import type * as ai from "ai";

/**
 * Image data extracted from a tool result.
 */
interface ExtractedImage {
	type: "image-data";
	data: string;
	mediaType: string;
}

/**
 * Result of extracting images from a tool message.
 */
interface ExtractionResult {
	/** The transformed tool message with images replaced by placeholder text */
	transformedMessage: ai.ToolModelMessage;
	/** The extracted images, if any */
	extractedImages: readonly ExtractedImage[];
	/** Tool names that had images extracted (for the follow-up user message) */
	toolNamesWithImages: readonly string[];
}

/**
 * Transform tool results containing images for Chat Completions API compatibility.
 *
 * The Chat Completions API doesn't support images in tool results, only in user messages.
 * This function handles two cases based on the model's image support:
 *
 * - **`supportsImages: true`** — Replaces image content in tool results with placeholder
 *   text ("Retrieved. Image follows.") and adds a follow-up user message containing the
 *   extracted images so the model can still "see" them.
 * - **`supportsImages: false`** — Strips images from tool results entirely, replacing them
 *   with a text-only note explaining an image was generated but the model cannot accept
 *   image input. No follow-up user message is added and no `image` content parts appear
 *   in the output.
 *
 * @param messages - The messages to transform
 * @param supportsImages - Whether the target model supports image input at all.
 *   When `false`, images are stripped without creating a follow-up user message.
 * @returns The transformed messages with images handled according to model capability
 */
export function transformToolResultImagesForCompletions(
	messages: ai.ModelMessage[],
	supportsImages: boolean,
): ai.ModelMessage[] {
	const result: ai.ModelMessage[] = [];

	for (const message of messages) {
		if (message.role === "tool") {
			const { transformedMessage, extractedImages, toolNamesWithImages } =
				extractImagesFromToolMessage(message, supportsImages);
			result.push(transformedMessage);

			// Only add a follow-up user message with the extracted images when the
			// model supports image input. For text-only models the images have already
			// been stripped and replaced with an explanatory note in the tool result.
			if (supportsImages && extractedImages.length > 0) {
				const toolDescription =
					toolNamesWithImages.length === 1
						? `the ${toolNamesWithImages[0]} tool`
						: `tools (${toolNamesWithImages.join(", ")})`;

				result.push({
					role: "user",
					content: [
						{
							type: "text",
							text: `Here is the image from ${toolDescription}:`,
						},
						...extractedImages.map((img) => ({
							type: "image" as const,
							image: img.data,
							mediaType: img.mediaType,
						})),
					],
				});
			}
		} else {
			result.push(message);
		}
	}

	return result;
}

/**
 * Extract images from a tool message.
 *
 * For each tool result containing images:
 * - When `supportsImages` is true: replaces image content with placeholder text
 *   ("Retrieved. Image follows.") and collects the extracted images for a follow-up
 *   user message.
 * - When `supportsImages` is false: strips images and replaces them with a text-only
 *   note. No images are collected (the caller will not emit a follow-up user message).
 *
 * @param message - The tool message to extract images from
 * @param supportsImages - Whether the target model supports image input
 * @returns The transformed message and extracted images
 */
function extractImagesFromToolMessage(
	message: ai.ToolModelMessage,
	supportsImages: boolean,
): ExtractionResult {
	const extractedImages: ExtractedImage[] = [];
	const toolNamesWithImages: string[] = [];

	const transformedContent = message.content.map((part) => {
		if (part.type !== "tool-result") {
			return part;
		}

		const output = part.output;

		// Only "content" type outputs can contain images
		if (output.type !== "content") {
			return part;
		}

		// Check if there are any images in this tool result
		const imageItems = output.value.filter(
			(item): item is { type: "image-data"; data: string; mediaType: string } =>
				item.type === "image-data",
		);

		if (imageItems.length === 0) {
			return part;
		}

		// Only collect images for the follow-up user message when the model can
		// actually accept image input.
		if (supportsImages) {
			for (const imageItem of imageItems) {
				extractedImages.push({
					type: "image-data",
					data: imageItem.data,
					mediaType: imageItem.mediaType,
				});
			}
		}
		toolNamesWithImages.push(part.toolName);

		// Get non-image content
		const nonImageItems = output.value.filter((item) => item.type !== "image-data");

		// Choose placeholder text based on model capability
		const placeholderText = supportsImages
			? "Retrieved. Image follows."
			: `An image was generated by the ${part.toolName} tool, but the current model does not support image input, so it could not be shown.`;

		// Create transformed output
		let newOutput: ai.ToolResultPart["output"];

		if (nonImageItems.length > 0) {
			// Keep non-image content and add placeholder
			newOutput = {
				type: "content",
				value: [...nonImageItems, { type: "text" as const, text: placeholderText }],
			};
		} else {
			// Only had images, use text placeholder
			newOutput = {
				type: "text",
				value: placeholderText,
			};
		}

		return {
			...part,
			output: newOutput,
		};
	});

	return {
		transformedMessage: {
			...message,
			content: transformedContent,
		},
		extractedImages,
		toolNamesWithImages,
	};
}

/**
 * Check if any messages contain images in tool results.
 *
 * This can be used to determine if transformation is needed.
 *
 * @param messages - The messages to check
 * @returns True if any tool results contain images
 */
export function hasImagesInToolResults(messages: ai.ModelMessage[]): boolean {
	for (const message of messages) {
		if (message.role !== "tool") {
			continue;
		}

		for (const part of message.content) {
			if (part.type !== "tool-result") {
				continue;
			}

			const output = part.output;
			if (output.type !== "content") {
				continue;
			}

			if (output.value.some((item) => item.type === "image-data")) {
				return true;
			}
		}
	}

	return false;
}
