/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

/**
 * Endpoint resolution helper.
 *
 * Internal to the catalog builder and `resolveModels`.
 */

import type { ResolvedConnection } from "./types";
import type { Protocol } from "./vocabulary";

/**
 * Resolve the base URL / endpoint for a model + protocol combination.
 *
 * Precedence:
 * 1. Model-level `baseUrl` (from override or custom model)
 * 2. Provider `endpoints[resolvedProtocol]`
 * 3. Provider `baseUrl`
 * 4. undefined (caller falls back to built-in defaults)
 */
export function resolveEndpoint(
	modelBaseUrl: string | undefined,
	providerConnection: ResolvedConnection | undefined,
	resolvedProtocol: Protocol | undefined,
): string | undefined {
	// 1. Model-level override
	if (modelBaseUrl) {
		return modelBaseUrl;
	}

	// 2. Per-protocol endpoint
	if (resolvedProtocol && providerConnection?.endpoints) {
		const perProtocol = providerConnection.endpoints[resolvedProtocol];
		if (perProtocol) {
			return perProtocol;
		}
	}

	// 3. Provider baseUrl
	return providerConnection?.baseUrl ?? undefined;
}
