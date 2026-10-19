/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { createHash } from "node:crypto";

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
		"mode" in breakpoint &&
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

/**
 * Whether the part can carry a breakpoint on a non-empty Responses block. Mantle
 * rejects a breakpoint on an exactly empty `input_text` (whitespace is fine).
 */
function canAnchorBreakpoint(part: ContentToolResultPart): boolean {
	switch (part.type) {
		case "text":
			return part.text !== "";
		case "image-data":
		case "image-url":
		case "image-file-id":
		case "file-data":
		case "file-url":
		case "file-id":
			return true;
		// Variants new in AI SDK 7 that the host does not produce.
		case "file":
		case "file-reference":
		case "image-file-reference":
		case "custom":
			return false;
	}
}

/** Strip breakpoints from parts that cannot anchor one, whatever placed them. */
function stripUnanchorableBreakpoints(output: ContentToolResultOutput): ContentToolResultOutput {
	return {
		...output,
		value: output.value.map((part) =>
			"providerOptions" in part && !canAnchorBreakpoint(part) ? stripValueBreakpoint(part) : part,
		),
	};
}

/** Whether the SDK serializes this scalar output as an empty string. */
function isEmptyScalarOutput(output: Exclude<ToolResultOutput, { type: "content" }>): boolean {
	switch (output.type) {
		case "text":
		case "error-text":
			return output.value === "";
		case "execution-denied":
			return output.reason === "";
		case "json":
		case "error-json":
			return false;
	}
}

/**
 * Responses can serialize cache markers only on structured input content, and
 * Bedrock Mantle rejects one on an exactly empty `input_text` block. The SDK
 * wraps marked scalar output as one `input_text` block itself, so scalar output
 * passes through unless it is empty. For `content` output, move the wrapper
 * marker onto the last block that can anchor it. A marker that cannot be
 * anchored is dropped, at the cost of a single cache write.
 */
function normalizeResponsesToolResult(part: ToolResultPart): ToolResultPart {
	if (part.output.type !== "content") {
		return isEmptyScalarOutput(part.output)
			? { ...stripValueBreakpoint(part), output: stripValueBreakpoint(part.output) }
			: part;
	}

	const output = stripUnanchorableBreakpoints(part.output);
	if (!hasExplicitBreakpoint(part.providerOptions)) {
		return { ...part, output };
	}

	let breakpointIndex = -1;
	for (let index = output.value.length - 1; index >= 0; index--) {
		if (canAnchorBreakpoint(output.value[index])) {
			breakpointIndex = index;
			break;
		}
	}
	return {
		...stripValueBreakpoint(part),
		output: {
			...output,
			value: output.value.map((contentPart, index) =>
				index === breakpointIndex && canAnchorBreakpoint(contentPart)
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

/** OpenAI rejects a `prompt_cache_key` longer than this with HTTP 400. */
const MAX_PROMPT_CACHE_KEY_LENGTH = 64;

/**
 * Project a session ID onto OpenAI's bounded `prompt_cache_key` space. Short IDs
 * pass through so keys stay readable and provider-side cache affinity survives;
 * longer ones (subagent lineages such as `rootId:subId`) become their SHA-256 hex
 * digest, which is exactly at the limit and stable across a conversation's turns.
 */
function toPromptCacheKey(sessionId: string): string {
	return sessionId.length <= MAX_PROMPT_CACHE_KEY_LENGTH
		? sessionId
		: createHash("sha256").update(sessionId).digest("hex");
}

/**
 * Prepare a request-local message copy and the matching cache key for explicit
 * OpenAI prompt caching. Clients call this unconditionally, passing their
 * already-resolved `enabled` decision (host opt-in plus any transport veto).
 *
 * Whenever the effective answer is "no explicit caching" — disabled, or enabled
 * without session metadata — every `openai.promptCacheBreakpoint` marker is
 * stripped from the copy and no key is returned, so a marker can never reach an
 * endpoint that was not opted in. Clients must send the returned key rather than
 * a raw session ID: the projection to OpenAI's 64-char limit lives here.
 */
export function prepareExplicitOpenAIRequest(
	messages: ModelMessage[],
	options: {
		enabled: boolean;
		apiMode: "completions" | "responses";
		sessionId: string | undefined;
	},
): { messages: ModelMessage[]; promptCacheKey: string | undefined } {
	if (!options.enabled || options.sessionId === undefined) {
		return { messages: messages.map(stripMessageBreakpoint), promptCacheKey: undefined };
	}

	return {
		messages: options.apiMode === "responses" ? messages.map(normalizeResponsesMessage) : messages,
		promptCacheKey: toPromptCacheKey(options.sessionId),
	};
}
