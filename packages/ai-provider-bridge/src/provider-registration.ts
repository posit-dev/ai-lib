/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

/**
 * Shared contract for the provider-registration orchestrator.
 *
 * The internal (register-all-providers.ts) and external (register-all-providers-external.ts)
 * build variants both depend on this leaf -- and on nothing of each other's. That is the whole
 * point: the external variant must never import the internal one, or esbuild would drag every
 * provider SDK into the lightweight external bundle. Housing the config interface, the
 * orchestrator signature, and the allow-list predicate here lets both variants share one
 * definition without a cross-reference.
 *
 * Only `isProviderAllowed` is runtime code (a one-liner). Every other import below is
 * `import type`, which esbuild erases, so this leaf contributes no SDK/runtime code to the
 * external bundle.
 */

import type { BedrockProviderCallbacks } from "./providers/bedrock-provider";
import type { GoogleVertexProviderCallbacks } from "./providers/google-vertex-provider";
import type { ProviderRegistry } from "./providers/ProviderRegistry";
import type { Logger, ProviderId } from "./types";

export interface ProviderRegistrationConfig {
	/**
	 * Posit AI base URL. Accepts a getter so callers can resolve it lazily at fetch time --
	 * Positron reads the `authentication.positai.baseUrl` setting this way, so changes take
	 * effect without a reload. Flows straight through to `registerPositAiProvider`, which
	 * accepts both forms.
	 */
	positAiBaseUrl: string | (() => string);
	userAgent?: string;
	/** If set, only these providers register; otherwise all of them. */
	allowedProviders?: ProviderId[];
	/** Pre-built by the caller. The bridge must NOT construct these. */
	bedrockCallbacks?: BedrockProviderCallbacks;
	googleVertexCallbacks?: GoogleVertexProviderCallbacks;
}

/**
 * Shared signature for the registration orchestrator. Both build variants annotate their
 * `registerAllProviders` export with this, so the compiler -- not a comment -- prevents the
 * internal and external functions from drifting in arity or return type.
 */
export type RegisterAllProviders = (
	registry: ProviderRegistry,
	logger: Logger,
	config: ProviderRegistrationConfig,
) => void;

/**
 * Whether `id` should register, given an optional allow-list.
 *
 * - omitted/undefined: every provider is allowed.
 * - empty array: nothing is allowed.
 * - otherwise: only ids present in the array are allowed.
 */
export function isProviderAllowed(id: ProviderId, allowedProviders?: ProviderId[]): boolean {
	return !allowedProviders || allowedProviders.includes(id);
}
