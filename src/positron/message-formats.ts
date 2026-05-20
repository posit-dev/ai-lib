/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2025 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

/**
 * Message format conversion: AI SDK → VS Code Language Model
 *
 * This module handles converting Vercel AI SDK messages to VS Code Language
 * Model format. The reverse direction (VS Code → AI SDK) remains in the
 * Positron extension since it depends on @vscode/prompt-tsx.
 */

import type * as ai from "ai";
import * as vscode from "vscode";

import { cacheBreakpointPart, isCacheBreakpointPart } from "./lm-helpers";

// ============================================================================
// Options
// ============================================================================

export interface FromAiMessagesOptions {
	/** Whether to convert providerOptions to cache markers. Default: false. */
	preserveCacheMarkers?: boolean;
	/**
	 * Whether the target VS Code LM host supports images in tool results.
	 * When false, images in tool results are replaced with placeholder text.
	 * Default: true.
	 */
	supportsToolResultImages?: boolean;
}

// ============================================================================
// Cache control helpers (shared between from/to directions)
// ============================================================================

/**
 * Helper function to check if a part has an Anthropic cache control marker
 */
export function hasAnthropicCacheControl(part: unknown): boolean {
	if (typeof part !== "object" || part === null) {
		return false;
	}
	const partWithOptions = part as {
		providerOptions?: {
			anthropic?: {
				cacheControl?: { type?: string };
			};
		};
	};
	return partWithOptions.providerOptions?.anthropic?.cacheControl?.type === "ephemeral";
}

/**
 * Helper function to set Anthropic cache control on an AI SDK part
 */
export function setAnthropicCacheControl(part: unknown): void {
	if (typeof part !== "object" || part === null) {
		return;
	}
	const partWithOptions = part as {
		providerOptions?: {
			anthropic?: {
				cacheControl?: { type?: string };
			};
		};
	};
	partWithOptions.providerOptions = {
		anthropic: {
			cacheControl: { type: "ephemeral" },
		},
	};
}

// ============================================================================
// Convert from Vercel AI to VSCode Language Model
// ============================================================================

/**
 * Convert messages from Vercel AI format to VSCode Language Model format.
 */
export function fromAiMessages2(
	messages: Array<Readonly<ai.ModelMessage>>,
	options?: FromAiMessagesOptions,
): vscode.LanguageModelChatMessage2[] {
	const preserveCacheMarkers = options?.preserveCacheMarkers ?? false;
	const supportsToolResultImages = options?.supportsToolResultImages ?? true;
	const vscodeMessages: vscode.LanguageModelChatMessage2[] = [];

	// Process each message in sequence
	for (const message of messages) {
		if (message.role === "user") {
			vscodeMessages.push(aiUserMessageToLmUserMessage(message, preserveCacheMarkers));
		} else if (message.role === "assistant") {
			vscodeMessages.push(aiAssistantMessageToLmAssistantMessage(message, preserveCacheMarkers));
		} else if (message.role === "tool") {
			vscodeMessages.push(
				aiToolMessageToLmToolMessage(message, preserveCacheMarkers, supportsToolResultImages),
			);
		}
		// System messages are not supported in VS Code LLM format
	}

	return vscodeMessages;
}

/**
 * Convert a Vercel AI user message to a VS Code user message.
 */
function aiUserMessageToLmUserMessage(
	message: Readonly<ai.UserModelMessage>,
	preserveCacheMarkers: boolean,
): vscode.LanguageModelChatMessage2 {
	const contentParts = aiUserContentToLmParts(message.content, preserveCacheMarkers);
	return vscode.LanguageModelChatMessage2.User(contentParts);
}

/**
 * Convert a Vercel AI assistant message to a VS Code assistant message.
 */
function aiAssistantMessageToLmAssistantMessage(
	message: Readonly<ai.AssistantModelMessage>,
	preserveCacheMarkers: boolean,
): vscode.LanguageModelChatMessage2 {
	const contentParts = aiAssistantContentToLmParts(message.content, preserveCacheMarkers);
	return vscode.LanguageModelChatMessage2.Assistant(contentParts);
}

function aiToolMessageToLmToolMessage(
	message: Readonly<ai.ToolModelMessage>,
	preserveCacheMarkers: boolean,
	supportsToolResultImages: boolean,
): vscode.LanguageModelChatMessage2 {
	const contentParts = aiToolContentToLmParts(
		message.content,
		preserveCacheMarkers,
		supportsToolResultImages,
	);
	return vscode.LanguageModelChatMessage2.User(contentParts);
}

// ===========================================================================
// Content conversion functions
// ===========================================================================

/**
 * Convert Vercel AI user content to VS Code content parts.
 */
function aiUserContentToLmParts(
	content: string | ai.UserContent,
	preserveCacheMarkers: boolean,
): Array<
	vscode.LanguageModelTextPart | vscode.LanguageModelToolResultPart | vscode.LanguageModelDataPart
> {
	const parts: Array<
		vscode.LanguageModelTextPart | vscode.LanguageModelToolResultPart | vscode.LanguageModelDataPart
	> = [];

	if (typeof content === "string") {
		parts.push(new vscode.LanguageModelTextPart(content));
	} else {
		for (const part of content) {
			// Check if this is a cache breakpoint marker
			if (isCacheBreakpointPart(part)) {
				if (preserveCacheMarkers && parts.length > 0) {
					const previousPart = parts[parts.length - 1];
					if (
						previousPart instanceof vscode.LanguageModelTextPart ||
						previousPart instanceof vscode.LanguageModelDataPart
					) {
						setAnthropicCacheControl(previousPart);
					}
				}
				continue;
			}

			if (part.type === "text") {
				parts.push(new vscode.LanguageModelTextPart(part.text));

				// Check for cache control marker
				if (preserveCacheMarkers && hasAnthropicCacheControl(part)) {
					parts.push(cacheBreakpointPart());
				}
			} else if (part.type === "image") {
				// Convert image part to VS Code LanguageModelDataPart
				// The part.image can be a string (base64 or data URL), URL, or Uint8Array
				const mediaType = part.mediaType || "image/png";
				let imageData: Uint8Array;

				if (typeof part.image === "string") {
					// Base64 string - convert to buffer
					imageData = Buffer.from(part.image, "base64");
				} else if (part.image instanceof URL) {
					// URL - can't easily convert, fall back to placeholder
					parts.push(new vscode.LanguageModelTextPart(`[Image URL: ${part.image.toString()}]`));
					if (preserveCacheMarkers && hasAnthropicCacheControl(part)) {
						parts.push(cacheBreakpointPart());
					}
					continue;
				} else if (part.image instanceof Uint8Array) {
					imageData = part.image;
				} else {
					// ArrayBuffer - convert to Uint8Array
					imageData = new Uint8Array(part.image);
				}

				parts.push(new vscode.LanguageModelDataPart(imageData, mediaType));

				// Check for cache control marker
				if (preserveCacheMarkers && hasAnthropicCacheControl(part)) {
					parts.push(cacheBreakpointPart());
				}
			}
			// Note: Other part types are not currently supported by VS Code
		}
	}

	return parts;
}

/**
 * Convert Vercel AI assistant content to VS Code content parts.
 */
function aiAssistantContentToLmParts(
	content: string | ai.AssistantContent,
	preserveCacheMarkers: boolean,
): Array<
	vscode.LanguageModelTextPart | vscode.LanguageModelToolCallPart | vscode.LanguageModelDataPart
> {
	const parts: Array<
		vscode.LanguageModelTextPart | vscode.LanguageModelToolCallPart | vscode.LanguageModelDataPart
	> = [];

	if (typeof content === "string") {
		parts.push(new vscode.LanguageModelTextPart(content));
	} else {
		for (const part of content) {
			// Check if this is a cache breakpoint marker
			if (isCacheBreakpointPart(part)) {
				if (preserveCacheMarkers && parts.length > 0) {
					const previousPart = parts[parts.length - 1];
					if (
						previousPart instanceof vscode.LanguageModelTextPart ||
						previousPart instanceof vscode.LanguageModelToolCallPart
					) {
						setAnthropicCacheControl(previousPart);
					}
				}
				continue;
			}

			if (part.type === "text") {
				parts.push(new vscode.LanguageModelTextPart(part.text));

				// Check for cache control marker
				if (preserveCacheMarkers && hasAnthropicCacheControl(part)) {
					parts.push(cacheBreakpointPart());
				}
			} else if (part.type === "tool-call") {
				// Create a tool call part
				parts.push(
					new vscode.LanguageModelToolCallPart(
						part.toolCallId,
						part.toolName,
						part.input as object,
					),
				);

				// Check for cache control marker
				if (preserveCacheMarkers && hasAnthropicCacheControl(part)) {
					parts.push(cacheBreakpointPart());
				}
			}
			// Note: Other part types are not currently supported by VS Code
		}
	}

	return parts;
}

/**
 * Convert Vercel AI tool content to VS Code tool result parts.
 */
function aiToolContentToLmParts(
	content: ai.ToolContent,
	preserveCacheMarkers: boolean,
	supportsToolResultImages: boolean,
): Array<vscode.LanguageModelToolResultPart2 | vscode.LanguageModelDataPart> {
	const parts: Array<vscode.LanguageModelToolResultPart2 | vscode.LanguageModelDataPart> = [];

	for (const part of content) {
		if (part.type === "tool-result") {
			parts.push(aiToolResultPartToLmToolResult2Part(part, supportsToolResultImages));

			// Check for cache control marker
			if (preserveCacheMarkers && hasAnthropicCacheControl(part)) {
				parts.push(cacheBreakpointPart());
			}
		}
		// Note: Other part types are not currently supported
	}

	return parts;
}

/**
 * Convert a Vercel AI tool result part to a VS Code tool result part.
 *
 * @param part - The AI tool result part to convert
 * @param supportsToolResultImages - Whether the target supports images in tool results
 * @returns A VS Code tool result part
 */
function aiToolResultPartToLmToolResult2Part(
	part: ai.ToolResultPart,
	supportsToolResultImages: boolean,
): vscode.LanguageModelToolResultPart2 {
	let newContent: Array<vscode.LanguageModelTextPart | vscode.LanguageModelDataPart>;

	const output = part.output;

	if (output.type === "text") {
		newContent = [new vscode.LanguageModelTextPart(output.value)];
	} else if (output.type === "json") {
		newContent = [new vscode.LanguageModelTextPart(JSON.stringify(output.value))];
	} else if (output.type === "error-text") {
		newContent = [new vscode.LanguageModelTextPart(output.value)];
	} else if (output.type === "error-json") {
		newContent = [new vscode.LanguageModelTextPart(JSON.stringify(output.value))];
	} else if (output.type === "content") {
		newContent = output.value.map((item) => {
			if (item.type === "text") {
				return new vscode.LanguageModelTextPart(item.text);
			} else if (item.type === "media" || item.type === "image-data") {
				// Handle both "media" (deprecated in AI SDK v6) and "image-data" (AI SDK v6+)
				if (!supportsToolResultImages) {
					return new vscode.LanguageModelTextPart("[This is a placeholder for an image]");
				}

				return new vscode.LanguageModelDataPart(Buffer.from(item.data, "base64"), item.mediaType);
			} else {
				throw new Error(`Unsupported part type in tool result content: ${item}`);
			}
		});
	} else {
		throw new Error(`Unsupported part type in tool result: ${output}`);
	}

	return new vscode.LanguageModelToolResultPart2(part.toolCallId, newContent);
}
