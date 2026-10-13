/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { openai } from "@ai-sdk/openai";
import type * as ai from "ai";
import { jsonSchema } from "ai";

import type { AiToolWithJsonSchema } from "../types";

/**
 * Attach provider-defined (server-side) tools to a request's toolset.
 *
 * Provider tools occupy fixed names dictated by the provider's API
 * (`web_search` for Anthropic, `google_search` for Google) and are merged
 * over the local toolset, so this merge is the first point where the exact
 * local tool map and the specific provider tool being attached are both
 * known. A plain spread would silently overwrite a local tool occupying one
 * of those names; reject that collision instead, naming both occupants,
 * rather than letting which tool runs depend on merge order.
 */
export function mergeProviderTools(
	localTools: Record<string, AiToolWithJsonSchema> | undefined,
	providerTools: Record<string, ai.Tool>,
): Record<string, ai.Tool> {
	const merged: Record<string, ai.Tool> = { ...localTools };
	for (const [name, providerTool] of Object.entries(providerTools)) {
		if (merged[name] !== undefined) {
			throw new Error(
				`Cannot attach provider tool "${name}": the request toolset already contains ` +
					`a local tool named "${name}". Rename the local tool or disable the provider tool.`,
			);
		}
		merged[name] = providerTool;
	}
	return merged;
}

/**
 * Options for the OpenAI Responses `web_search` hosted tool.
 *
 * Only the options a caller is allowed to steer appear here; everything else
 * keeps the provider's defaults.
 */
export interface OpenAIWebSearchToolOptions {
	/**
	 * Serialized as the tool's `external_web_access` flag. Bedrock Mantle
	 * requires an explicit boolean (its default is `true`, which changes the
	 * egress boundary), so Mantle callers always pass one. Direct OpenAI
	 * callers omit it to keep OpenAI's own default.
	 */
	externalWebAccess?: boolean;
}

/**
 * Attach the OpenAI Responses hosted `web_search` tool to a request's
 * toolset, merging through {@link mergeProviderTools} so a local tool
 * occupying the reserved `web_search` key is rejected rather than silently
 * overwritten.
 *
 * Both OpenAI Responses transports (direct OpenAI and Bedrock Mantle) run the
 * AI SDK's `OpenAIResponsesLanguageModel`, so the SDK's provider tool
 * serializes correctly on either route.
 *
 * Returns the merged record, or the caller's toolset unchanged when search is
 * disabled — `undefined` in, `undefined` out, so callers can derive
 * `toolChoice` from the single returned value.
 */
export function mergeOpenAIWebSearchTool(
	localTools: Record<string, AiToolWithJsonSchema> | undefined,
	enabled: boolean,
	options: OpenAIWebSearchToolOptions = {},
): Record<string, ai.Tool> | undefined {
	if (!enabled) {
		return localTools;
	}
	return mergeProviderTools(localTools, { web_search: createOpenAIWebSearchTool(options) });
}

/**
 * Create the OpenAI Responses hosted `web_search` provider tool.
 *
 * The SDK factory (`openai.tools.webSearch`) remains the source of the tool
 * identity and args, but its return type is branded by `@ai-sdk/openai`'s
 * pinned `@ai-sdk/provider-utils` copy, which differs from the copy `ai`
 * pins — the two `Tool` types are structurally identical yet nominally
 * incompatible across the unique-symbol schema brand. The tool is therefore
 * re-wrapped into this package's `ai.Tool`: provider tools serialize from
 * `id` and `args` alone (see `prepareToolsAndToolChoice`), so rebuilding the
 * never-serialized empty input schema loses nothing. The schema is created
 * lazily so suites that mock the `ai` module keep importing this module.
 */
function createOpenAIWebSearchTool(options: OpenAIWebSearchToolOptions): ai.Tool {
	const sdkTool = openai.tools.webSearch(
		options.externalWebAccess === undefined ? {} : { externalWebAccess: options.externalWebAccess },
	);
	if (sdkTool.type !== "provider") {
		throw new Error("openai.tools.webSearch did not return a provider-defined tool");
	}
	return {
		type: "provider",
		id: sdkTool.id,
		args: sdkTool.args,
		// The SDK factory's own input schema is an empty object schema
		// (`z.object({})`); provider tools take no model-generated input.
		inputSchema: jsonSchema({ type: "object", properties: {} }),
	};
}
