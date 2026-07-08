/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

/**
 * Token usage estimation for vscode.lm providers that report no usage.
 *
 * Some vscode.lm providers (notably GitHub Copilot) never emit the Positron
 * usage data part, so requests end with no token usage at all. This module
 * estimates usage locally with `LanguageModelChat.countTokens()`, which for
 * Copilot is backed by a bundled tiktoken tokenizer running in a worker
 * thread — a few IPC hops per call, no network request.
 *
 * The counts are estimates: message framing overhead is approximated with a
 * per-message constant, images/binary parts are represented by a short
 * placeholder, and non-OpenAI models are tokenized with an approximating
 * tokenizer on the provider side. Consumers must present these numbers as
 * approximate.
 */

import * as vscode from "vscode";

import type { Logger } from "../types";

/**
 * Tokens added per message to approximate chat framing overhead (role
 * markers and separators) that countTokens() on the bare content misses.
 */
const MESSAGE_FRAMING_TOKENS = 4;

/**
 * Minimal surface of vscode.LanguageModelChat needed for estimation.
 * Narrow on purpose so tests can supply a fake without the full class.
 */
export interface EstimationModel {
	readonly id: string;
	countTokens(text: string, token?: vscode.CancellationToken): Thenable<number>;
}

// ============================================================================
// Bounded LRU memo for per-message token counts
// ============================================================================

/**
 * Module-level because VscodeLmClient instances are per-request — a
 * per-instance cache would never hit. Entries are integers keyed by
 * model id + content hash, so the memory bound is small.
 */
const MAX_CACHE_ENTRIES = 500;
const tokenCountCache = new Map<string, number>();

/** FNV-1a 32-bit hash, hex-encoded. Length is included in the cache key to further reduce collision risk. */
function fnv1a(text: string): string {
	let hash = 0x811c9dc5;
	for (let i = 0; i < text.length; i++) {
		hash ^= text.charCodeAt(i);
		hash = Math.imul(hash, 0x01000193);
	}
	return (hash >>> 0).toString(16);
}

function cacheKey(modelId: string, text: string): string {
	return `${modelId}:${text.length}:${fnv1a(text)}`;
}

/** Exposed for tests. */
export function clearTokenEstimationCache(): void {
	tokenCountCache.clear();
}

async function countTextCached(model: EstimationModel, text: string): Promise<number> {
	const key = cacheKey(model.id, text);
	const cached = tokenCountCache.get(key);
	if (cached !== undefined) {
		// Refresh recency (Map iteration order is insertion order).
		tokenCountCache.delete(key);
		tokenCountCache.set(key, cached);
		return cached;
	}
	const count = await model.countTokens(text);
	if (tokenCountCache.size >= MAX_CACHE_ENTRIES) {
		const oldest = tokenCountCache.keys().next();
		if (!oldest.done) {
			tokenCountCache.delete(oldest.value);
		}
	}
	tokenCountCache.set(key, count);
	return count;
}

// ============================================================================
// Message serialization for counting
// ============================================================================

/**
 * Serialize a final (post-transform) VS Code message for token counting.
 * Includes the role so identical text in different roles never shares a
 * cached count. Binary/data parts contribute a short placeholder — their
 * true token cost is provider-specific and unknowable here.
 */
export function serializeMessageForCounting(
	message: vscode.LanguageModelChatMessage | vscode.LanguageModelChatMessage2,
): string {
	const pieces: string[] = [`role:${message.role}`];
	for (const part of message.content) {
		if (part instanceof vscode.LanguageModelTextPart) {
			pieces.push(part.value);
		} else if (part instanceof vscode.LanguageModelToolCallPart) {
			pieces.push(part.name, JSON.stringify(part.input));
		} else if (
			part instanceof vscode.LanguageModelToolResultPart2 ||
			part instanceof vscode.LanguageModelToolResultPart
		) {
			for (const inner of part.content) {
				if (inner instanceof vscode.LanguageModelTextPart) {
					pieces.push(inner.value);
				} else {
					pieces.push("[data]");
				}
			}
		} else if (part instanceof vscode.LanguageModelDataPart) {
			pieces.push(`[data:${part.mimeType}]`);
		}
	}
	return pieces.join("\n");
}

// ============================================================================
// Input estimation
// ============================================================================

export interface EstimateInputTokensParams {
	model: EstimationModel;
	/** The final, post-transform payload passed to sendRequest(). */
	messages: ReadonlyArray<vscode.LanguageModelChatMessage | vscode.LanguageModelChatMessage2>;
	/**
	 * The separate system parameter, only for vendors where it is NOT already
	 * folded into `messages` (for Copilot the system prompt is prepended as a
	 * user message, so passing it here too would double-count it).
	 */
	systemPrompt?: string;
	tools?: ReadonlyArray<vscode.LanguageModelChatTool>;
	logger: Logger;
}

/**
 * Estimate input tokens for the final request payload.
 *
 * Never rejects: estimation must never fail a request, and the resulting
 * promise may be awaited long after creation (at stream end), so a rejection
 * here could otherwise surface as an unhandled rejection mid-stream.
 *
 * @returns The estimate, or undefined if estimation failed.
 */
export async function estimateInputTokens(
	params: EstimateInputTokensParams,
): Promise<number | undefined> {
	try {
		const counts = await Promise.all([
			...params.messages.map((m) => countTextCached(params.model, serializeMessageForCounting(m))),
			params.systemPrompt ? countTextCached(params.model, params.systemPrompt) : 0,
			params.tools && params.tools.length > 0
				? countTextCached(params.model, JSON.stringify(params.tools))
				: 0,
		]);
		const framing = params.messages.length * MESSAGE_FRAMING_TOKENS;
		return counts.reduce((sum, c) => sum + c, framing);
	} catch (e) {
		params.logger.warn("Token usage estimation failed for input payload", e);
		return undefined;
	}
}

/**
 * Count tokens in accumulated output text. Never rejects.
 *
 * @returns The estimate, or undefined if counting failed.
 */
export async function estimateOutputTokens(
	model: EstimationModel,
	outputText: string,
	logger: Logger,
): Promise<number | undefined> {
	if (outputText === "") {
		return 0;
	}
	try {
		// No memoization: output text is unique per response, so caching it
		// would only churn the LRU.
		return await model.countTokens(outputText);
	} catch (e) {
		logger.warn("Token usage estimation failed for output text", e);
		return undefined;
	}
}
