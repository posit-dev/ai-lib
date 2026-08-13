/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { APICallError, RetryError } from "ai";
import { describe, expect, it } from "vitest";

import { convertAiSdkStreamToPlatform } from "../ai-sdk-helpers";

function blankApiCallError(): APICallError {
	// What the AI SDK produces when a response's error body doesn't match the
	// provider's error schema and the response carries no statusText (HTTP/2
	// has no reason phrase): message falls back to "".
	return new APICallError({
		message: "",
		url: "http://localhost:8787/v1/chat/completions",
		requestBodyValues: {},
		statusCode: 500,
		responseBody: '{"status":"failure","message":"Something went wrong"}',
	});
}

async function passThroughError(error: unknown): Promise<void> {
	async function* errorStream(): AsyncGenerator<{ type: "error"; error: unknown }> {
		yield { type: "error", error };
	}
	for await (const _part of convertAiSdkStreamToPlatform(errorStream(), () => {})) {
		// Drain the public stream adapter; it clarifies error chunks in place.
	}
}

describe("AI SDK stream error messages", () => {
	it("fills a blank APICallError message with status and body excerpt", async () => {
		const error = blankApiCallError();
		await passThroughError(error);
		expect(error.message).toBe(
			"Request to http://localhost:8787/v1/chat/completions failed with status 500: " +
				'{"status":"failure","message":"Something went wrong"}',
		);
	});

	it("fills both messages of a RetryError wrapping a blank APICallError", async () => {
		// Retryable statuses (5xx) surface as a RetryError whose message was
		// composed from the then-blank last error.
		const inner = blankApiCallError();
		const retry = new RetryError({
			message: `Failed after 3 attempts. Last error: ${inner.message}`,
			reason: "maxRetriesExceeded",
			errors: [inner, inner, inner],
		});
		await passThroughError(retry);
		expect(inner.message).toContain("status 500");
		expect(retry.message).toBe(`Failed after 3 attempts. Last error: ${inner.message}`);
	});

	it("leaves errors that already carry a message untouched", async () => {
		const error = new APICallError({
			message: "Incorrect API key provided",
			url: "http://localhost:8787/v1/chat/completions",
			requestBodyValues: {},
			statusCode: 401,
			responseBody: '{"error":{"message":"Incorrect API key provided"}}',
		});
		await passThroughError(error);
		expect(error.message).toBe("Incorrect API key provided");

		const plain = new Error("boom");
		await passThroughError(plain);
		expect(plain.message).toBe("boom");
	});
});
