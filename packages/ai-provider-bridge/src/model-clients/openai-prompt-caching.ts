/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import type { ModelMessage } from "ai";

type ProviderOptions = NonNullable<ModelMessage["providerOptions"]>;
type ToolMessage = Extract<ModelMessage, { role: "tool" }>;
type ToolResultPart = Extract<ToolMessage["content"][number], { type: "tool-result" }>;
type ToolResultOutput = ToolResultPart["output"];
type ContentToolResultOutput = Extract<ToolResultOutput, { type: "content" }>;
type ContentToolResultPart = ContentToolResultOutput["value"][number];

const EXPLICIT_BREAKPOINT: { mode: "explicit" } = { mode: "explicit" };

function hasExplicitBreakpoint(providerOptions: ModelMessage["providerOptions"]): boolean {
	const breakpoint = providerOptions?.openai?.promptCacheBreakpoint;
	return (
		breakpoint !== null &&
		typeof breakpoint === "object" &&
		!Array.isArray(breakpoint) &&
		breakpoint.mode === "explicit"
	);
}

function addExplicitBreakpoint(providerOptions: ModelMessage["providerOptions"]): ProviderOptions {
	return {
		...providerOptions,
		openai: {
			...providerOptions?.openai,
			promptCacheBreakpoint: EXPLICIT_BREAKPOINT,
		},
	};
}

function stripExplicitBreakpoint(
	providerOptions: ModelMessage["providerOptions"],
): ModelMessage["providerOptions"] {
	if (!providerOptions?.openai || !("promptCacheBreakpoint" in providerOptions.openai)) {
		return providerOptions;
	}

	const { promptCacheBreakpoint: _breakpoint, ...openai } = providerOptions.openai;
	if (Object.keys(openai).length === 0) {
		const { openai: _openai, ...remaining } = providerOptions;
		return Object.keys(remaining).length === 0 ? undefined : remaining;
	}

	return { ...providerOptions, openai };
}

function stripValueBreakpoint<T extends { providerOptions?: ProviderOptions }>(value: T): T {
	return {
		...value,
		providerOptions: stripExplicitBreakpoint(value.providerOptions),
	};
}

function stripToolResultOutput(output: ToolResultOutput): ToolResultOutput {
	if (output.type !== "content") {
		return stripValueBreakpoint(output);
	}

	return {
		...output,
		value: output.value.map((part) =>
			"providerOptions" in part ? stripValueBreakpoint(part) : part,
		),
	};
}

function stripMessageBreakpoint(message: ModelMessage): ModelMessage {
	const strippedMessage = stripValueBreakpoint(message);
	if (typeof strippedMessage.content === "string") {
		return strippedMessage;
	}

	switch (strippedMessage.role) {
		case "system":
			return strippedMessage;
		case "user":
			return {
				...strippedMessage,
				content: strippedMessage.content.map((part) =>
					"providerOptions" in part ? stripValueBreakpoint(part) : part,
				),
			};
		case "assistant":
			return {
				...strippedMessage,
				content: strippedMessage.content.map((part) => {
					if (part.type === "tool-result") {
						const strippedPart = stripValueBreakpoint(part);
						return { ...strippedPart, output: stripToolResultOutput(strippedPart.output) };
					}
					return "providerOptions" in part ? stripValueBreakpoint(part) : part;
				}),
			};
		case "tool":
			return {
				...strippedMessage,
				content: strippedMessage.content.map((part) => {
					if (part.type !== "tool-result") {
						return part;
					}
					const strippedPart = stripValueBreakpoint(part);
					return { ...strippedPart, output: stripToolResultOutput(strippedPart.output) };
				}),
			};
	}
}

function isBreakpointContentPart(
	part: ContentToolResultPart,
): part is Exclude<ContentToolResultPart, { type: "media" | "file-id" }> {
	return (
		part.type === "text" ||
		part.type === "image-data" ||
		part.type === "image-url" ||
		part.type === "file-data" ||
		part.type === "file-url"
	);
}

function serializeToolResultOutput(output: Exclude<ToolResultOutput, { type: "content" }>): string {
	switch (output.type) {
		case "text":
		case "error-text":
			return output.value;
		case "json":
		case "error-json":
			return JSON.stringify(output.value);
		case "execution-denied":
			return output.reason ?? "Tool call execution denied.";
	}
}

/**
 * Responses can serialize cache markers only on structured input content.
 * Move a wrapper/output marker onto the last supported content block, converting
 * scalar tool output to one `input_text` block at request time when necessary.
 */
function normalizeResponsesToolResult(part: ToolResultPart): ToolResultPart {
	const wrapperHasBreakpoint =
		hasExplicitBreakpoint(part.providerOptions) ||
		("providerOptions" in part.output && hasExplicitBreakpoint(part.output.providerOptions));
	if (!wrapperHasBreakpoint) {
		return part;
	}

	const strippedPart = stripValueBreakpoint(part);
	const strippedOutput =
		strippedPart.output.type === "content"
			? strippedPart.output
			: stripValueBreakpoint(strippedPart.output);
	if (strippedOutput.type !== "content") {
		return {
			...strippedPart,
			output: {
				type: "content",
				value: [
					{
						type: "text",
						text: serializeToolResultOutput(strippedOutput),
						providerOptions: addExplicitBreakpoint(undefined),
					},
				],
			},
		};
	}

	let breakpointIndex = -1;
	for (let index = strippedOutput.value.length - 1; index >= 0; index--) {
		if (isBreakpointContentPart(strippedOutput.value[index])) {
			breakpointIndex = index;
			break;
		}
	}
	if (breakpointIndex === -1) {
		return part;
	}

	return {
		...strippedPart,
		output: {
			...strippedOutput,
			value: strippedOutput.value.map((contentPart, index) =>
				index === breakpointIndex && isBreakpointContentPart(contentPart)
					? {
							...contentPart,
							providerOptions: addExplicitBreakpoint(contentPart.providerOptions),
						}
					: contentPart,
			),
		},
	};
}

function normalizeResponsesMessage(message: ModelMessage): ModelMessage {
	if (message.role !== "tool") {
		return message;
	}

	return {
		...message,
		content: message.content.map((part) =>
			part.type === "tool-result" ? normalizeResponsesToolResult(part) : part,
		),
	};
}

/**
 * Prepare a request-local message copy for explicit OpenAI prompt caching.
 * Missing session metadata disables all explicit breakpoints defensively while
 * keeping request-wide explicit mode enabled in the client.
 */
export function prepareExplicitOpenAIMessages(
	messages: ModelMessage[],
	options: { apiMode: "completions" | "responses"; hasSessionId: boolean },
): ModelMessage[] {
	if (!options.hasSessionId) {
		return stripExplicitOpenAIBreakpoints(messages);
	}

	return options.apiMode === "responses" ? messages.map(normalizeResponsesMessage) : messages;
}

/**
 * Strip every explicit OpenAI cache-breakpoint marker from a request-local
 * message copy. Clients call this whenever they will not emit explicit cache
 * options, so a marker can never reach an endpoint that was not opted in.
 */
export function stripExplicitOpenAIBreakpoints(messages: ModelMessage[]): ModelMessage[] {
	return messages.map(stripMessageBreakpoint);
}
