/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

/**
 * Send-side sanitizer for tool-call IDs on the Anthropic Messages wire.
 *
 * The Anthropic Messages API validates `tool_use.id` / `tool_result.tool_use_id`
 * against `^[a-zA-Z0-9_-]+$`. Other wires (OpenAI Chat Completions, etc.) accept
 * arbitrary IDs — e.g. Kimi K3 emits `<toolName>:<counter>` like `ls:0`. When a
 * conversation that contains such IDs is replayed to an Anthropic-wire model
 * (model switch mid-conversation, `/compact` summarizing with Claude, etc.), the
 * API rejects the request with a 400.
 *
 * The constraint is a property of the *target wire*, so Anthropic-wire clients
 * sanitize outbound IDs unconditionally: conforming IDs pass through untouched
 * (pure-Claude histories are a zero-copy no-op), and non-conforming IDs are
 * rewritten deterministically.
 *
 * Rewriting scheme:
 * - Base: `[^a-zA-Z0-9_-]` → `-`; empty/missing IDs fall back to `call`.
 * - Uniqueness: rewritten ID = `<base>-<i>` where `i` is the message's index in
 *   the outbound array. Pairing is positional: a `tool-result` in a `tool`
 *   message at index `j` uses `j-1` (its call is always in the immediately
 *   preceding assistant message); a `tool-result` in an *assistant* message
 *   (provider-executed tools carry call and result together) uses its own index.
 *   Deterministic and prompt-cache-stable because history is append-only.
 * - Conforming but duplicate IDs (the same ID used by a call in an earlier
 *   message) are also index-suffixed, so per-request uniqueness is constructed,
 *   not trusted. Results mirror their call: a result keeps its ID iff the call
 *   at the paired index was the ID's first occurrence.
 * - Server-minted IDs (`srvtoolu_…`, e.g. web search / code execution) pass
 *   through verbatim: they always conform and are unique, and any rewrite
 *   would violate their stricter `^srvtoolu_[a-zA-Z0-9_]+$` wire pattern.
 *   This also sidesteps pairing ambiguity for provider-executed tools, whose
 *   result can land in a later assistant message than the call.
 *
 * Accepted residual risk: two *different* originals in the same message
 * sanitizing to the same base (`ls:0` + `ls-0`) collide. This requires mixed ID
 * formats in a single model response; collision-bumping would break positional
 * pairing, so we warn instead.
 */

import type * as ai from "ai";
import { streamText } from "ai";

import type { Logger } from "./types";

/** Anthropic's validation pattern for `tool_use.id` / `tool_result.tool_use_id`. */
const ANTHROPIC_TOOL_USE_ID_PATTERN = /^[a-zA-Z0-9_-]+$/;

/** Fallback base for empty/missing IDs. */
const EMPTY_ID_BASE = "call";

/**
 * Anthropic's validation pattern for server-minted tool IDs (web search,
 * code execution, etc.). Unlike client tool IDs, no `-` is allowed, so the
 * generic rewrite scheme can never produce a valid server-tool ID.
 */
const SERVER_TOOL_ID_PATTERN = /^srvtoolu_[a-zA-Z0-9_]+$/;

/**
 * Rewrite non-conforming tool-call IDs in a message list so they satisfy
 * Anthropic's `^[a-zA-Z0-9_-]+$` pattern and are unique within the request.
 *
 * @param messages - Outbound messages (AI SDK `ModelMessage` format)
 * @param logger - Optional logger for observability of rewrites and anomalies
 * @returns The input array by reference when nothing needed rewriting (no-op);
 *   otherwise a new array with rewritten `toolCallId`s.
 */
export function sanitizeToolCallIdsForAnthropic(
	messages: ai.ModelMessage[],
	logger?: Logger,
): ai.ModelMessage[] {
	// First message index at which each conforming ID was used by a tool-call.
	// Calls repeating an earlier ID get index-suffixed; results keep their ID
	// iff their paired call (at the positional index) was the first occurrence.
	const firstCallIndex = new Map<string, number>();
	const state: SanitizeState = { firstCallIndex, logger, messages };
	let anyChanged = false;

	const result = messages.map((message, index) => {
		if (message.role === "assistant" && typeof message.content !== "string") {
			// Provider-executed tools carry call and result in the same message,
			// so results pair at their own index.
			const newContent = sanitizeParts(message.content, index, index, state);
			if (!newContent) {
				return message;
			}
			anyChanged = true;
			return { ...message, content: newContent };
		}
		if (message.role === "tool") {
			// Results pair with the call in the immediately preceding assistant
			// message, hence `index - 1`.
			const newContent = sanitizeParts(message.content, index, index - 1, state);
			if (!newContent) {
				return message;
			}
			anyChanged = true;
			return { ...message, content: newContent };
		}
		return message;
	});

	return anyChanged ? result : messages;
}

interface SanitizeState {
	firstCallIndex: Map<string, number>;
	logger?: Logger;
	messages: ai.ModelMessage[];
}

/**
 * Rewrite tool-call/-result IDs in one message's content. Returns `null` when
 * nothing changed so callers can preserve the original message reference.
 */
function sanitizeParts<TPart extends { type: string }>(
	content: TPart[],
	messageIndex: number,
	resultIndex: number,
	state: SanitizeState,
): TPart[] | null {
	const { firstCallIndex, logger, messages } = state;

	// Track sanitized bases within this message to detect same-message
	// collisions between different originals (see module docstring).
	const rewrittenBases = new Map<string, string>();
	let changed = false;

	const newContent = content.map((part) => {
		if (part.type !== "tool-call" && part.type !== "tool-result") {
			return part;
		}
		const toolPart = part as TPart & { toolCallId: string };

		const id = toolPart.toolCallId;

		// Server-minted IDs must round-trip verbatim: they already conform,
		// are inherently unique, and any rewrite would break the stricter
		// server-tool wire pattern (see SERVER_TOOL_ID_PATTERN).
		if (SERVER_TOOL_ID_PATTERN.test(id)) {
			return part;
		}

		const partIndex = part.type === "tool-call" ? messageIndex : resultIndex;
		const conforming = ANTHROPIC_TOOL_USE_ID_PATTERN.test(id);

		if (part.type === "tool-result" && resultIndex !== messageIndex) {
			warnIfOrphanResult(messages, messageIndex, id, logger);
		}

		let rewritten: string;
		if (conforming) {
			if (part.type === "tool-call") {
				if (!firstCallIndex.has(id)) {
					firstCallIndex.set(id, messageIndex);
					return part;
				}
				rewritten = `${id}-${messageIndex}`;
			} else {
				const first = firstCallIndex.get(id);
				if (first === undefined || first === partIndex) {
					return part;
				}
				rewritten = `${id}-${partIndex}`;
			}
		} else {
			logger?.warn(
				`[tool-call-ids] Non-conforming tool-call ID "${id}" rewritten for ` +
					`Anthropic Messages API (message index ${partIndex}).`,
			);
			rewritten = `${baseOf(id)}-${partIndex}`;
		}

		// Same-message base-collision check (only meaningful for rewrites).
		const base = conforming ? id : baseOf(id);
		const previousOriginal = rewrittenBases.get(base);
		if (previousOriginal !== undefined && previousOriginal !== id) {
			logger?.warn(
				`[tool-call-ids] Same-message tool-call ID collision: ` +
					`"${previousOriginal}" and "${id}" both sanitize to "${base}" ` +
					`(message index ${messageIndex}). Tool-call/result pairing may be ambiguous.`,
			);
		}
		rewrittenBases.set(base, id);

		changed = true;
		return { ...toolPart, toolCallId: rewritten };
	});

	return changed ? newContent : null;
}

/**
 * `streamText` wrapper for Anthropic-wire endpoints. Sanitizes tool-call IDs
 * before delegating, so every Anthropic-wire path gets conformance by default.
 */
export function streamTextAnthropicWire(
	options: Parameters<typeof streamText>[0],
	logger?: Logger,
): ReturnType<typeof streamText> {
	// `messages` and `prompt` are mutually exclusive in the options union;
	// branching (rather than spreading) preserves the narrowing.
	if (options.messages) {
		return streamText({
			...options,
			messages: sanitizeToolCallIdsForAnthropic(options.messages, logger),
		});
	}
	return streamText(options);
}

/** Deterministic character replacement; empty/missing IDs fall back to `call`. */
function baseOf(id: string): string {
	const base = (id || "").replace(/[^a-zA-Z0-9_-]/g, "-");
	return base.length > 0 ? base : EMPTY_ID_BASE;
}

/** Warn when a `tool` message's result has no matching call in the preceding message. */
function warnIfOrphanResult(
	messages: ai.ModelMessage[],
	index: number,
	toolCallId: string,
	logger?: Logger,
): void {
	const preceding = index > 0 ? messages[index - 1] : undefined;
	const hasMatchingCall =
		preceding?.role === "assistant" &&
		typeof preceding.content !== "string" &&
		preceding.content.some((part) => part.type === "tool-call" && part.toolCallId === toolCallId);
	if (!hasMatchingCall) {
		logger?.warn(
			`[tool-call-ids] Orphan tool-result "${toolCallId}" at message index ${index}: ` +
				`no matching tool-call in the preceding message. ID pairing may be broken.`,
		);
	}
}
