/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

/**
 * Protocol and endpoint resolution helpers.
 *
 * Internal to the catalog builder and `resolveModels` — not part of the
 * public API surface.
 */

import type { ModelOverride, ResolvedConnection } from "./types";
import type { Protocol } from "./vocabulary";

/**
 * Resolve the wire protocol for a model.
 *
 * Precedence: model override protocol → provider protocol → undefined
 * (provider/bridge decides).
 */
export function resolveProtocol(
	modelOverride: Pick<ModelOverride, "protocol"> | undefined,
	providerConnection: ResolvedConnection | undefined,
): Protocol | undefined {
	return modelOverride?.protocol ?? providerConnection?.protocol ?? undefined;
}

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
