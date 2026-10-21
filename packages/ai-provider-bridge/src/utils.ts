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

// Type aliases, not interfaces: the SDK's `providerOptions` is an index-signature
// JSON type, which interfaces are not assignable to.

/** Client-specific `anthropic` provider options merged over the thinking options. */
export type AnthropicClientOptions = {
	/** `false` opts out of `eager_input_streaming` (see `rejectsEagerInputStreaming`). */
	toolStreaming?: false;
};

/**
 * Host policy for Anthropic thinking-block binding (the prefix check on replayed
 * thinking). The host decides whether a model gets a policy at all; see
 * `ModelClientChatParams.thinkingBlockBinding`.
 *
 * - `"error"`: `prefix_mismatch_behavior: "error"`; a prefix change is a 400.
 * - `"drop_block"`: drop each mismatched block and every later one; the request
 *   succeeds and `input_transformations` lists the drops.
 * - `"header-only"`: send only the beta header, no body field. Accounts that are
 *   not enforced by default then report mismatches as
 *   `thinking_mismatch_allowed` without enforcing them.
 */
export type ThinkingBlockBinding = "error" | "drop_block" | "header-only";

/** Beta that enables `thinking.block_binding` and `input_transformations`. */
export const THINKING_BINDING_BETA = "thinking-binding-controls-2026-08-01";

/** The transport a request on the Anthropic Messages wire travels over. */
export type AnthropicTransport = "anthropic" | "bedrock" | "vertex" | "positai" | "snowflake";

/**
 * Transports whose endpoint rejects or drops thinking-block binding. Requests
 * over them never carry the beta or the body field. Add a transport here when
 * live verification shows it fails; see
 * plans/2026-10-09-1737-preserved-thinking-sequencing.md (phase 0).
 *
 * - `positai`: the gateway rejects the request with 400 `disallowed
 *   Anthropic-Beta value: "thinking-binding-controls-2026-08-01"` (verified
 *   2026-10-12 against staging). Remove once the gateway allows the beta.
 */
const TRANSPORTS_WITHOUT_BLOCK_BINDING: ReadonlySet<AnthropicTransport> = new Set(["positai"]);

type AnthropicThinkingOptions = {
	thinking?:
		| { type: "disabled" }
		| {
				type: "adaptive";
				display: "summarized";
				blockBinding?: { prefixMismatchBehavior: "error" | "drop_block" };
		  };
	effort?: string;
};

/** Provider options and extra request headers for one Anthropic Messages request. */
export type AnthropicRequestOptions = {
	providerOptions: { anthropic: AnthropicThinkingOptions & AnthropicClientOptions } | undefined;
	headers: Record<string, string> | undefined;
};

/**
 * Request options for the Anthropic Messages wire, shared by every Claude
 * client so the thinking mapping cannot drift between routes:
 *
 * - `undefined` effort (provider default): no thinking type or effort, so the
 *   model's own default applies.
 * - `"off"`: `thinking: {type: "disabled"}` with no effort. Omitting `thinking`
 *   is not "off" on models whose default is adaptive (Haiku 5.5, Opus 5).
 *   Capability rules offer "off" only where the API accepts `disabled`.
 * - Any other level: adaptive thinking with that effort. `display: "summarized"`
 *   is required to receive thinking text; Opus 4.7+/Fable 5 default to
 *   `"omitted"`, which streams signature-only blocks and shows no <thinking>.
 *
 * `blockBinding` applies only with adaptive thinking: the API rejects
 * `block_binding` next to `disabled`, and with the provider default PA replays
 * no thinking, so there is nothing to bind. A transport in
 * `TRANSPORTS_WITHOUT_BLOCK_BINDING` vetoes it. `"error"` and `"drop_block"`
 * set the body field (the SDK adds the beta header); `"header-only"` adds only
 * the beta header.
 *
 * `clientOptions` are merged on top.
 */
export function anthropicRequestOptions(request: {
	effort: string | undefined;
	transport: AnthropicTransport;
	blockBinding: ThinkingBlockBinding | undefined;
	clientOptions: AnthropicClientOptions;
}): AnthropicRequestOptions {
	const { effort, transport, clientOptions } = request;
	const adaptive = isThinkingEnabled(effort);
	const blockBinding =
		adaptive && !TRANSPORTS_WITHOUT_BLOCK_BINDING.has(transport) ? request.blockBinding : undefined;
	const thinkingOptions: AnthropicThinkingOptions =
		effort === undefined
			? {}
			: effort === "off"
				? { thinking: { type: "disabled" } }
				: {
						thinking: {
							type: "adaptive",
							display: "summarized",
							...(blockBinding === "error" || blockBinding === "drop_block"
								? { blockBinding: { prefixMismatchBehavior: blockBinding } }
								: {}),
						},
						effort,
					};
	const anthropic = { ...thinkingOptions, ...clientOptions };
	return {
		providerOptions: Object.keys(anthropic).length > 0 ? { anthropic } : undefined,
		headers:
			blockBinding === "header-only" ? { "anthropic-beta": THINKING_BINDING_BETA } : undefined,
	};
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

const DEEPSEEK_MODEL_APIS_IDS = new Set([
	"deepseek-ai/DeepSeek-V4-Flash-0731",
	"deepseek-ai/DeepSeek-V4.1-Flash-1017",
]);

export function positAiThinkingRequestFields(
	modelId: string,
	effort: string | undefined,
	requiresChatTemplateKwargs: boolean,
): Record<string, unknown> | undefined {
	if (DEEPSEEK_MODEL_APIS_IDS.has(modelId) && effort === "off") {
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
// Posit AI Pass
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
