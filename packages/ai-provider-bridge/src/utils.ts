/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2025-2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

/**
 * Small, self-contained utilities used by provider-bridge.
 * Kept here to avoid depending on any consumer package.
 */

// ---------------------------------------------------------------------------
// Thinking effort
// ---------------------------------------------------------------------------

/** Whether a resolved thinking effort represents active thinking. */
export function isThinkingEnabled(effort: string | undefined): boolean {
	return effort !== undefined && effort !== "off";
}

/**
 * Request-body fields that enable thinking on an OpenAI-chat-protocol model.
 *
 * Named effort levels (anything but the binary `"on"`) go out as the OpenAI-style
 * top-level `reasoning_effort`. Binary-toggle models (`requiresChatTemplateKwargs`)
 * take the vLLM-style `chat_template_kwargs` instead.
 *
 * @returns Fields to merge into the request body, or `undefined` when thinking
 *          is off or the model has no way to enable it.
 */
export function thinkingRequestFields(
	effort: string | undefined,
	requiresChatTemplateKwargs: boolean,
): Record<string, unknown> | undefined {
	if (!isThinkingEnabled(effort)) {
		return undefined;
	}
	if (effort !== "on") {
		return { reasoning_effort: effort };
	}
	return requiresChatTemplateKwargs
		? { chat_template_kwargs: { enable_thinking: true } }
		: undefined;
}

export function positAiThinkingRequestFields(
	modelId: string,
	effort: string | undefined,
	requiresChatTemplateKwargs: boolean,
): Record<string, unknown> | undefined {
	if (effort === "off" && modelId === "deepseek-ai/DeepSeek-V4-Flash-0731") {
		return { reasoning_effort: "none" };
	}
	return thinkingRequestFields(effort, requiresChatTemplateKwargs);
}

// ---------------------------------------------------------------------------
// Model ID helpers
// ---------------------------------------------------------------------------

/**
 * Check if a model ID refers to a Claude (Anthropic) model.
 * Used by multi-protocol clients (PositAiClient, SnowflakeClient) to decide
 * whether to use the Anthropic Messages API or OpenAI Chat Completions API.
 */
export function isClaudeModel(modelId: string): boolean {
	return modelId.startsWith("claude");
}

/**
 * Whether a hosted model rejects the `eager_input_streaming` field that
 * @ai-sdk/anthropic adds to tool specs while streaming. Bedrock's Anthropic
 * schema and Snowflake Cortex return HTTP 400 for it
 * (tools.0.custom.eager_input_streaming: Extra inputs are not permitted) on
 * Opus 4.1 and the 4.5-generation models (Haiku/Sonnet/Opus 4.5); other
 * Anthropic models on those paths accept it, and the direct Anthropic and
 * Vertex APIs accept it for every model. Keep the affected-model list here so
 * the two clients can't drift.
 */
export function rejectsEagerInputStreaming(modelId: string): boolean {
	return (
		modelId.includes("claude-opus-4-1") ||
		modelId.includes("claude-haiku-4-5") ||
		modelId.includes("claude-sonnet-4-5") ||
		modelId.includes("claude-opus-4-5")
	);
}

// ---------------------------------------------------------------------------
// Snowflake / Databricks
// ---------------------------------------------------------------------------

// Re-exported from ai-credentials/types (single source of truth)
export {
	buildSnowflakeCortexUrl,
	buildSnowflakeCortexUrlFromHost,
	normalizeDatabricksHost,
} from "ai-credentials/types";

// ---------------------------------------------------------------------------
// Posit AI
// ---------------------------------------------------------------------------

/**
 * Check whether a response body indicates an agreement-required 403
 * (`prism_account_not_found`). Parses defensively: checks top-level
 * `error_type`, nested `error.error_type`, and falls back to a raw-text
 * `includes` check as a safety net against schema drift.
 */
export function isAgreementRequiredBody(responseBody: string | undefined): boolean {
	if (!responseBody) return false;
	const TARGET = "prism_account_not_found";
	try {
		const parsed: unknown = JSON.parse(responseBody);
		if (parsed && typeof parsed === "object") {
			const obj = parsed as Record<string, unknown>;
			if (obj.error_type === TARGET) return true;
			if (obj.error && typeof obj.error === "object") {
				if ((obj.error as Record<string, unknown>).error_type === TARGET) return true;
			}
		}
	} catch {
		// Not JSON — fall through to raw check
	}
	return responseBody.includes(TARGET);
}

// ---------------------------------------------------------------------------
// Base URL fallback for model discovery
// ---------------------------------------------------------------------------

/**
 * Resolve the base URL for a direct model-discovery fetch: the configured
 * value when set, else the versioned default (`host/version`).
 *
 * The configured value only gets a trailing-slash/whitespace trim — URL-joining
 * hygiene, since fetchers compose `${base}/models`. It is otherwise trusted as
 * given: a bare known host is NOT corrected here (that policy lives in
 * `base-url.ts` and is applied by consumers at the config seam).
 *
 * @param host Known public API host, no trailing slash (e.g. `https://api.anthropic.com`).
 * @param version Version segment of the default (e.g. `v1`, `v1beta`).
 */
export function normalizeProviderBaseUrl(
	baseUrl: string | undefined,
	host: string,
	version: string,
): string {
	// undefined, empty, and whitespace-only all count as "unset".
	const trimmed = baseUrl?.trim().replace(/\/+$/, "");
	return trimmed || `${host.replace(/\/+$/, "")}/${version}`;
}

// ---------------------------------------------------------------------------
// Path
// ---------------------------------------------------------------------------

/**
 * Join path segments into a single path.
 *
 * @param segments Path segments to join
 * @returns The joined path
 *
 * @example
 * joinPath("/home/user", "documents", "file.txt")
 * // Returns: "/home/user/documents/file.txt"
 */
export function joinPath(...segments: string[]): string {
	if (segments.length === 0) return "";

	// Filter out empty strings and normalize each segment
	const normalized = segments.filter((s) => s.length > 0).map((s) => s.replace(/\\/g, "/")); // Convert backslashes to forward slashes

	// Remove leading/trailing slashes from internal segments
	const parts: string[] = [];
	for (let i = 0; i < normalized.length; i++) {
		let part = normalized[i];

		// For the first segment, preserve leading slashes (absolute vs relative)
		if (i === 0) {
			// Remove only trailing slashes for now
			part = part.replace(/\/+$/, "");
		} else {
			// For other segments, remove leading and trailing slashes
			part = part.replace(/^\/+/, "").replace(/\/+$/, "");
		}

		if (part.length > 0) {
			parts.push(part);
		}
	}

	// Join with forward slashes
	return parts.join("/");
}
