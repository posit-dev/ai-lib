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

export interface PositAiErrorDetails {
	errorType?: string;
	errorId?: string;
}

const POSIT_AI_ERROR_FIELD_MAX_LENGTH = 128;
const STRUCTURED_ERROR_TOKEN = /^[A-Za-z0-9._:-]+$/;

/** Validate an opaque support identifier without interpreting its contents. */
export function sanitizePositAiErrorId(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	return trimmed.length > 0 &&
		trimmed.length <= POSIT_AI_ERROR_FIELD_MAX_LENGTH &&
		STRUCTURED_ERROR_TOKEN.test(trimmed)
		? trimmed
		: undefined;
}

function structuredErrorField(
	outer: Record<string, unknown>,
	nested: Record<string, unknown> | undefined,
	field: "error_type" | "error_id",
): string | undefined {
	const value = outer[field] ?? nested?.[field];
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	return trimmed.length > 0 && trimmed.length <= POSIT_AI_ERROR_FIELD_MAX_LENGTH
		? trimmed
		: undefined;
}

/** Parse the documented structured fields without retaining the response body. */
export function parsePositAiErrorBody(responseBody: string | undefined): PositAiErrorDetails {
	if (!responseBody) return {};
	try {
		const parsed: unknown = JSON.parse(responseBody);
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};

		const outer = parsed as Record<string, unknown>;
		const nested =
			outer.error && typeof outer.error === "object" && !Array.isArray(outer.error)
				? (outer.error as Record<string, unknown>)
				: undefined;
		const candidateErrorType = structuredErrorField(outer, nested, "error_type");
		const errorType =
			candidateErrorType && STRUCTURED_ERROR_TOKEN.test(candidateErrorType)
				? candidateErrorType
				: undefined;
		const errorId = sanitizePositAiErrorId(structuredErrorField(outer, nested, "error_id"));
		return { errorType, errorId };
	} catch {
		return {};
	}
}

/** Check only the gateway's precise agreement-required signal. */
export function isAgreementRequiredBody(responseBody: string | undefined): boolean {
	return parsePositAiErrorBody(responseBody).errorType === "agreement_required";
}

/** Check the current and legacy neutral no-account gateway signals. */
export function isAccountUnavailableBody(responseBody: string | undefined): boolean {
	const errorType = parsePositAiErrorBody(responseBody).errorType;
	return errorType === "account_not_found" || errorType === "prism_account_not_found";
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
