/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { APICallError, RetryError } from "ai";
import { describe, expect, it } from "vitest";

import { clarifyBlankRequestError } from "../ai-sdk-helpers";

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

describe("clarifyBlankRequestError", () => {
	it("fills a blank APICallError message with status and body excerpt", () => {
		const error = blankApiCallError();
		clarifyBlankRequestError(error);
		expect(error.message).toBe(
			"Request to http://localhost:8787/v1/chat/completions failed with status 500: " +
				'{"status":"failure","message":"Something went wrong"}',
		);
	});

	it("fills both messages of a RetryError wrapping a blank APICallError", () => {
		// Retryable statuses (5xx) surface as a RetryError whose message was
		// composed from the then-blank last error.
		const inner = blankApiCallError();
		const retry = new RetryError({
			message: `Failed after 3 attempts. Last error: ${inner.message}`,
			reason: "maxRetriesExceeded",
			errors: [inner, inner, inner],
		});
		clarifyBlankRequestError(retry);
		expect(inner.message).toContain("status 500");
		expect(retry.message).toBe(`Failed after 3 attempts. Last error: ${inner.message}`);
	});

	it("leaves errors that already carry a message untouched", () => {
		const error = new APICallError({
			message: "Incorrect API key provided",
			url: "http://localhost:8787/v1/chat/completions",
			requestBodyValues: {},
			statusCode: 401,
			responseBody: '{"error":{"message":"Incorrect API key provided"}}',
		});
		clarifyBlankRequestError(error);
		expect(error.message).toBe("Incorrect API key provided");

		const plain = new Error("boom");
		clarifyBlankRequestError(plain);
		expect(plain.message).toBe("boom");
	});
});
