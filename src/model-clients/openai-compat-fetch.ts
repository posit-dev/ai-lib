/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

/**
 * Shared OpenAI-compatible fetch wrapper.
 *
 * Many OpenAI-compatible providers (Snowflake Cortex, MS Foundry, generic
 * endpoints) return responses that deviate from the OpenAI Chat Completions
 * spec in small but breaking ways. The AI SDK's Zod schema validation
 * rejects these malformed chunks, crashing the stream.
 *
 * This wrapper intercepts both request and response to paper over the
 * known deviations. It is a Node-side port of Positron's
 * `openai-fetch-utils.ts`, used by any provider that routes through
 * `@ai-sdk/openai`.
 *
 * ## Request transforms (outbound)
 *
 * 1. `max_tokens` → `max_completion_tokens`
 *    Many providers reject the deprecated `max_tokens` parameter.
 *    OpenAI themselves require `max_completion_tokens` for newer models.
 *
 * 2. `developer` role → `system` role
 *    The `developer` role is an OpenAI-specific alias for `system`
 *    introduced for newer models. Most compatible providers only accept
 *    `system`, `user`, `assistant`, `tool`, and `function`.
 *
 * 3. Remove `strict` from tool function definitions
 *    The `strict` field is an OpenAI extension for structured outputs.
 *    Non-OpenAI providers reject it as an unknown field.
 *
 * ## Response streaming transforms (inbound SSE)
 *
 * 4. Empty `role` `""` → `"assistant"` in delta chunks
 *    Spec requires `role` to be `"assistant"` when present. Some providers
 *    (e.g. Snowflake Cortex) send `""`. The AI SDK's Zod validation fails:
 *    `Invalid enum value. Expected 'assistant', received ''`.
 *
 * 5. Empty tool `arguments` `""` → `"{}"` for no-parameter tools
 *    When a tool has no parameters, the correct response is `arguments: "{}"`.
 *    Some providers send `""` instead, which fails JSON.parse in the SDK.
 *    Only fixed for tools identified as no-arg from the request — for tools
 *    WITH parameters, `""` is a valid streaming partial (arguments are
 *    streamed incrementally across chunks and concatenated by the SDK).
 *
 * 6. Empty tool `type` `""` → `"function"` in tool call chunks
 *    Spec requires `type` to be `"function"`. Some providers send `""`.
 *
 * ## Auth
 *
 * 7. Strip `Authorization` header when `apiKey === ""`
 *    For unauthenticated endpoints (e.g., local servers with no auth).
 *    Only matches empty string — `undefined` means the caller manages
 *    auth separately (e.g. Foundry injects its own token).
 */

// ---------------------------------------------------------------------------
// Types describing the possibly-malformed response shapes we receive.
//
// These mirror the OpenAI ChatCompletionChunk types but relax the fields
// that compatible providers are known to send incorrectly. They serve as
// documentation of what breaks and why — the actual runtime handling works
// on parsed JSON objects.
// ---------------------------------------------------------------------------

/**
 * A tool call function where `arguments` may be missing or empty string
 * instead of valid JSON. Correct per spec: `arguments: "{}"` for no-arg tools.
 */
interface MalformedToolCallFunction {
	name?: string;
	arguments?: string; // may be "" instead of "{}"
}

/**
 * A tool call where `type` may be empty string instead of `"function"`,
 * and `function.arguments` may be malformed.
 */
interface MalformedToolCall {
	index: number;
	id?: string;
	type?: "function" | ""; // may be "" instead of "function"
	function: MalformedToolCallFunction;
}

/**
 * A delta where `role` may be empty string instead of `"assistant"`,
 * and `tool_calls` may contain malformed entries.
 */
interface MalformedDelta {
	role?: "assistant" | ""; // may be "" instead of "assistant"
	content?: string | null;
	tool_calls?: MalformedToolCall[];
}

/** A ChatCompletionChunk choice with a possibly-malformed delta. */
interface MalformedChoice {
	index: number;
	delta: MalformedDelta;
	finish_reason?: string | null;
}

/**
 * A ChatCompletionChunk that may contain malformed fields.
 * This is what we actually receive from providers like Snowflake Cortex
 * before fixing it up to match the spec.
 */
interface MalformedChatCompletionChunk {
	id: string;
	object: string;
	created: number;
	model: string;
	choices: MalformedChoice[];
	[key: string]: unknown; // service_tier, system_fingerprint, usage, etc.
}

// ---------------------------------------------------------------------------

type FetchFn = (url: string | URL | globalThis.Request, init?: RequestInit) => Promise<Response>;

/**
 * Create a custom fetch function that applies OpenAI-compatible transforms.
 *
 * @param providerName - Provider name for logging
 * @param apiKey - API key; when empty string, Authorization header is stripped
 */
export function createOpenAICompatibleFetch(providerName: string, apiKey?: string): FetchFn {
	return async (url: string | URL | globalThis.Request, init?: RequestInit): Promise<Response> => {
		const modifiedInit = { ...init };

		// Strip Authorization header for unauthenticated endpoints
		if (apiKey === "") {
			const headers = new Headers(modifiedInit.headers);
			headers.delete("Authorization");
			modifiedInit.headers = headers;
		}

		// Apply request body transforms and identify no-arg tools.
		// No-arg tools need special handling in the response: some providers
		// return arguments: "" for them, which must be fixed to "{}".
		// We only fix empty arguments for these specific tools — for tools
		// WITH parameters, an empty string is a valid streaming partial.
		let noArgTools: string[] = [];
		if (modifiedInit.body && typeof modifiedInit.body === "string") {
			try {
				const body = JSON.parse(modifiedInit.body);
				noArgTools = extractNoArgTools(body);
				transformRequestBody(body);
				modifiedInit.body = JSON.stringify(body);
			} catch {
				// Not JSON, pass through unchanged
			}
		}

		const response = await globalThis.fetch(url, modifiedInit);

		// Only transform streaming responses (SSE)
		const contentType = response.headers.get("content-type") || "";
		if (!contentType.includes("text/event-stream") || !response.body) {
			return response;
		}

		// Wrap the streaming body with response transforms
		const transformedBody = transformSSEStream(response.body, noArgTools);
		return new Response(transformedBody, {
			status: response.status,
			statusText: response.statusText,
			headers: response.headers,
		});
	};
}

/**
 * Identify tools that take no arguments from the request body.
 *
 * These tools may receive `arguments: ""` in the response instead of the
 * correct `arguments: "{}"`. We track them here so the response transform
 * can fix only these tools — for tools WITH parameters, `""` is a valid
 * initial streaming partial that the SDK concatenates across chunks.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function extractNoArgTools(body: any): string[] {
	if (!Array.isArray(body.tools)) return [];
	return body.tools
		.filter((t: { function?: { parameters?: { properties?: Record<string, unknown> } } }) => {
			const params = t.function?.parameters;
			return !params || !params.properties || Object.keys(params.properties).length === 0;
		})
		.map((t: { function?: { name?: string } }) => t.function?.name)
		.filter(Boolean) as string[];
}

/**
 * Apply request body transforms in-place.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function transformRequestBody(body: any): void {
	// Transform 1: max_tokens → max_completion_tokens.
	// The old parameter name is rejected by newer models.
	if ("max_tokens" in body && !("max_completion_tokens" in body)) {
		body.max_completion_tokens = body.max_tokens;
		delete body.max_tokens;
	}

	// Transform 2: developer role → system role.
	// Most compatible providers only support the standard role set.
	if (Array.isArray(body.messages)) {
		for (const msg of body.messages) {
			if (msg.role === "developer") {
				msg.role = "system";
			}
		}
	}

	// Transform 3: Remove strict from tool function definitions.
	// This is an OpenAI-only extension that other providers reject.
	if (Array.isArray(body.tools)) {
		for (const tool of body.tools) {
			if (tool.function && "strict" in tool.function) {
				delete tool.function.strict;
			}
		}
	}
}

/**
 * Transform an SSE stream, buffering across chunk boundaries to ensure
 * complete JSON lines before parsing. Each `data:` line is parsed,
 * fixed via {@link fixMalformedChunk}, and re-serialized.
 */
function transformSSEStream(
	body: ReadableStream<Uint8Array>,
	noArgTools: string[],
): ReadableStream<Uint8Array> {
	const decoder = new TextDecoder();
	const encoder = new TextEncoder();
	let buffer = "";

	return new ReadableStream<Uint8Array>({
		async start(controller) {
			const reader = body.getReader();
			try {
				while (true) {
					const { done, value } = await reader.read();
					if (done) {
						if (buffer.length > 0) {
							controller.enqueue(encoder.encode(buffer));
						}
						controller.close();
						return;
					}

					buffer += decoder.decode(value, { stream: true });

					// Process complete SSE lines. The last element may be an
					// incomplete line split across network chunks — keep it
					// in the buffer for the next iteration.
					const lines = buffer.split("\n");
					buffer = lines.pop() || "";

					for (const line of lines) {
						const transformed = transformSSELine(line, noArgTools);
						controller.enqueue(encoder.encode(transformed + "\n"));
					}
				}
			} catch (err) {
				controller.error(err);
			}
		},
	});
}

/**
 * Transform a single SSE `data:` line by parsing the JSON payload,
 * fixing known malformations, and re-serializing.
 */
function transformSSELine(line: string, noArgTools: string[]): string {
	if (!line.startsWith("data: ") || line === "data: [DONE]") {
		return line;
	}

	try {
		const chunk = JSON.parse(line.slice(6)) as MalformedChatCompletionChunk;
		fixMalformedChunk(chunk, noArgTools);
		return "data: " + JSON.stringify(chunk);
	} catch {
		// Not valid JSON, pass through unchanged
		return line;
	}
}

/**
 * Fix a possibly-malformed ChatCompletionChunk in place.
 *
 * See the {@link MalformedChatCompletionChunk} type for the specific
 * deviations from the OpenAI spec that providers are known to send.
 */
function fixMalformedChunk(chunk: MalformedChatCompletionChunk, noArgTools: string[]): void {
	if (!chunk.choices) return;

	for (const choice of chunk.choices) {
		const delta = choice.delta;
		if (!delta) continue;

		// Transform 4: Empty role → "assistant".
		// Spec: role must be "assistant" when present on delta chunks.
		// Broken: Snowflake Cortex sends `"role": ""`.
		// Impact: AI SDK Zod validation throws AI_TypeValidationError.
		if (delta.role === "") {
			delta.role = "assistant";
		}

		if (!Array.isArray(delta.tool_calls)) continue;

		for (const tc of delta.tool_calls) {
			// Transform 5: Empty tool arguments → "{}" (no-arg tools only).
			// Spec: arguments is a JSON string, e.g. `"{}"` for no-arg tools.
			// Broken: some providers send `""` instead of `"{}"`.
			// Impact: SDK calls JSON.parse("") which throws.
			// IMPORTANT: Only fix for tools with no parameters. For tools
			// WITH parameters, `""` is a valid initial streaming partial —
			// the SDK concatenates argument chunks across delta events.
			if (
				tc.function &&
				tc.function.arguments === "" &&
				tc.function.name &&
				noArgTools.includes(tc.function.name)
			) {
				tc.function.arguments = "{}";
			}

			// Transform 6: Empty tool type → "function".
			// Spec: type must be "function" when present.
			// Broken: some providers send `"type": ""`.
			if (tc.type === "") {
				tc.type = "function";
			}
		}
	}
}
