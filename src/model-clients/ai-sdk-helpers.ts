/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2025 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

/**
 * AI SDK Helper Utilities
 *
 * Shared utilities for AI SDK integration across multiple providers.
 * Used by: AnthropicClient, OpenAIClient, and future providers using AI SDK.
 */

import { randomUUID } from "crypto";

import type { LanguageModelUsage, TextStreamPart } from "ai";

import type { StepLogger } from "../StepLogger";
import type { AiToolWithJsonSchema, CancellationToken, LMStreamPart } from "../types";

/**
 * Convert AI SDK stream to platform-agnostic LMStreamPart format.
 * The cleanup function is called when the stream completes (normally, via error,
 * or when the consumer breaks early) to prevent EventEmitter memory leaks.
 */
export async function* convertAiSdkStreamToPlatform(
	stream: AsyncIterable<TextStreamPart<Record<string, AiToolWithJsonSchema>>>,
	cleanup: () => void,
): AsyncIterable<LMStreamPart> {
	// For now the platform-agnostic LMStreamPart format is just the same as the AI SDK TextStreamPart
	// format, so we will just yield the chunks as-is.
	try {
		for await (const chunk of stream) {
			yield chunk;
		}
	} finally {
		cleanup();
	}
}

/**
 * Create abort controller from platform CancellationToken
 * Used by: All clients that need cancellation support
 *
 * Returns both the abort controller and a cleanup function that must be called
 * when the stream is finished to prevent EventEmitter memory leaks.
 */
export function createAbortControllerFromToken(cancellationToken: CancellationToken): {
	abortController: AbortController;
	cleanup: () => void;
} {
	const abortController = new AbortController();
	const disposable = cancellationToken.onCancellationRequested(() => {
		abortController.abort();
	});
	return {
		abortController,
		cleanup: () => disposable.dispose(),
	};
}

/**
 * Create step logger callback with call ID and step index tracking
 *
 * Returns a closure that maintains callId and stepIndex state across multiple
 * onStepFinish invocations within a single streamText call.
 *
 * Calls all loggers in parallel and handles errors gracefully (one logger
 * failure won't stop others).
 *
 * @param stepLoggers - Array of logger instances to call
 * @param provider - Provider name (e.g., "anthropic", "openai")
 * @param model - Model identifier
 * @returns Async callback function for streamText's onStepFinish parameter
 */
export function createStepLogger(
	stepLoggers: StepLogger[],
	provider: string,
	model: string,
): (stepResult: {
	request: { body?: unknown };
	response: { body?: unknown; headers?: Record<string, string>; messages: unknown[] };
	finishReason: string;
	usage: LanguageModelUsage;
	providerMetadata?: Record<string, unknown>;
}) => Promise<void> {
	// Return no-op if no loggers
	if (stepLoggers.length === 0) {
		return async () => {};
	}

	// Generate unique call ID for this streamText invocation
	const callId = randomUUID();
	let stepIndex = 0;

	// Return closure that logs each step
	return async (stepResult) => {
		const logData = {
			callId,
			stepIndex: stepIndex++,
			provider,
			model,
			request: stepResult.request.body || null,
			response: {
				body: stepResult.response.body || null,
				messages: stepResult.response.messages,
				finishReason: stepResult.finishReason,
			},
			usage: stepResult.usage,
			providerMetadata: stepResult.providerMetadata,
			headers: stepResult.response.headers || {},
		};

		// Call all loggers in parallel, handle errors individually
		await Promise.all(
			stepLoggers.map(async (logger) => {
				try {
					await logger.logStep(logData);
				} catch {
					// Silent failure - one logger failure shouldn't stop others
				}
			}),
		);
	};
}
