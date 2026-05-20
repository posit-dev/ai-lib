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

// ---------------------------------------------------------------------------
// Snowflake
// ---------------------------------------------------------------------------

/**
 * Construct the Snowflake Cortex REST API base URL from an account identifier.
 *
 * @param account - Snowflake account identifier (e.g., "myorg-myaccount")
 * @returns Full Cortex REST API base URL
 */
export function buildSnowflakeCortexUrl(account: string): string {
	return `https://${account}.snowflakecomputing.com/api/v2/cortex/v1`;
}

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
