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
import { APICallError, RetryError } from "ai";

import type { StepLogger } from "../StepLogger";
import type { AiToolWithJsonSchema, CancellationToken, LMStreamPart } from "../types";

/** Cap the response body excerpt included in synthesized error messages. */
const MAX_ERROR_BODY_CHARS = 500;

function apiCallFailureMessage(error: APICallError): string {
	const status = error.statusCode !== undefined ? ` status ${error.statusCode}` : "";
	const body = error.responseBody?.trim();
	const bodyExcerpt = body ? `: ${body.slice(0, MAX_ERROR_BODY_CHARS)}` : "";
	return `Request to ${error.url} failed with${status}${bodyExcerpt}`;
}

/**
 * Give blank failed-request errors a usable message, in place.
 *
 * The AI SDK's per-provider error parsers fall back to the HTTP `statusText`
 * when a response's error body doesn't match the provider's error schema —
 * and gateways can produce both conditions at once (e.g. Portkey's OSS
 * gateway returns `{"html-message": "..."}` on upstream 401s and
 * `{"status":"failure","message":"..."}` for gateway-level failures, and
 * HTTP/2 responses carry no reason phrase). The result is an `APICallError`
 * — or a `RetryError` wrapping one — whose message is empty, which consumers
 * would surface verbatim. Synthesize a message from the status code and a
 * best-effort body excerpt instead.
 *
 * Mutates `message` on the existing error objects (never replaces them) so
 * error identity and structured fields (`statusCode`, `responseBody`, …)
 * that consumers key on are preserved. Errors that already carry a message
 * are left untouched.
 */
function clarifyBlankRequestError(error: unknown): void {
	if (APICallError.isInstance(error) && error.message.trim().length === 0) {
		error.message = apiCallFailureMessage(error);
		return;
	}
	if (
		RetryError.isInstance(error) &&
		APICallError.isInstance(error.lastError) &&
		error.lastError.message.trim().length === 0
	) {
		error.lastError.message = apiCallFailureMessage(error.lastError);
		// The RetryError composed its own message from the then-blank last
		// error ("Failed after N attempts. Last error: ") — re-append.
		error.message = `${error.message}${error.lastError.message}`;
	}
}

/**
 * Disable AI SDK's default `console.error` side channel for stream failures.
 * Errors still flow through `fullStream`, where callers handle and report them.
 */
export function suppressAiSdkDefaultErrorLogging(): void {}

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
			// Chunks pass through as-is, including null/non-object values some
			// upstream mocks and tolerant streams produce — guard before probing.
			if (chunk !== null && typeof chunk === "object" && chunk.type === "error") {
				clarifyBlankRequestError(chunk.error);
			}
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
