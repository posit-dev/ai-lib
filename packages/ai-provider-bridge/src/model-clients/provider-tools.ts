/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import type * as ai from "ai";

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
